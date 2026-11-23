import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nativeEngineIdentity } from '../workflow-engine/store.js';
import { createNativeEngineJobs } from '../workflow-engine/jobs.js';
import { prepareNativeEngineClient } from '../../agentcore/native/workflow-client.js';
import {
  NATIVE_ENGINE_PROFILE,
  engineDigest,
  engineFailure,
} from '../../shared/native-workflow-protocol.js';
import { buildNativePendingInput, nativeAnswerText } from '../../shared/native-pending-input.js';
import {
  capturedPlanAsk,
  capturedPlanFormSpec,
} from '../../shared/test/fixtures/native-plan-ask.js';
import { setupNativeWorkflowEngine as setup } from './workflow-engine-service-fixture.js';

const gate = () =>
  buildNativePendingInput({
    gate: { stage: 'build' },
    spec: {
      version: 2,
      questions: [
        {
          prompt: 'build complete. How would you like to proceed?',
          options: [{ label: 'Approve' }, { label: 'Request Changes' }],
        },
      ],
    },
  });
const toGate = async (t) => {
  expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
  t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
  expect((await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode).toBe(
    0,
  );
  const reported = await t.command([
    'engine',
    'orchestrate',
    'report',
    '--stage',
    'build',
    '--result',
    'awaiting-approval',
  ]);
  expect(reported.result.exitCode).toBe(0);
  return t.publish(gate());
};
const approve = async (t, opened) => {
  await t.admit(opened);
  const selection = { answers: [{ selectedOptions: [0] }] };
  await t.execution.respond({
    ...t.f.bindingIdentity,
    actorId: 'responding-member',
    request: {
      requestId: randomUUID(),
      interactionId: opened.interactionReceipt.id,
      contentSha256: opened.body.contentSha256,
      text: nativeAnswerText(gate(), selection),
      selection,
    },
  });
  const claim = await t.execution.claim(t.f.bindingIdentity);
  await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
};

const stopForWorkspaceRecovery = async (t) => {
  const claimed = await t.execution.claim(t.f.bindingIdentity);
  return t.execution.recoveryRequired({
    row: claimed.row,
    reason: 'DELIVERY_UNCERTAIN',
    workflowResumeState: 'created',
    stoppedSessionId: claimed.row.runtimeSessionId,
  });
};
const confirmWorkspaceRecovery = async (t, stopped) => {
  await t.execution.recover({
    ...t.f.bindingIdentity,
    request: {
      requestId: randomUUID(),
      recoveryId: stopped.recovery.id,
      confirmWorkspaceResume: true,
    },
  });
  return t.execution.claim(t.f.bindingIdentity);
};

const journalWrite = (command, body) =>
  command.input.TransactItems?.find(
    (item) => item.Put?.Item.requestId === body.requestId && item.Put.Item.sk.includes('#OP#'),
  )?.Put.Item.status;
const conflict = (command) =>
  Object.assign(new Error('Journal contention'), {
    name: 'TransactionCanceledException',
    CancellationReasons: command.input.TransactItems.map((_, i) => ({
      Code: i === 0 ? 'TransactionConflict' : 'None',
    })),
  });
const timeout = () => Object.assign(new Error('Lost acknowledgement'), { name: 'TimeoutError' });
const journalStatus = async (t) =>
  t.handler(
    { schemaVersion: 1, identity: await t.identity(), action: 'status' },
    await t.context(),
  );
const interruptFinish = (t, body) => {
  t.f.hooks.before = (command) => {
    if (['completed', 'failed'].includes(journalWrite(command, body))) throw timeout();
  };
};
const recoveryCommand = async (t, action, operation, identity) =>
  t.handler(
    {
      schemaVersion: 1,
      identity: identity ?? (await t.identity()),
      action,
      ...(operation ? { operation } : {}),
    },
    await t.context(),
  );
const pendingOperation = async (t) => (await recoveryCommand(t, 'pending')).operation;
const abandon = (t, operation, identity) => recoveryCommand(t, 'abandon', operation, identity);
const operationRow = (t, requestId) =>
  [...t.f.rows.values()].find((row) => row.sk.endsWith(`#OP#${requestId}`));
const useCheckJob = (t, send, sign = async () => 'https://fixture.invalid/job') => {
  t.hooks.jobsFactory = (input) =>
    createNativeEngineJobs({
      ...input,
      codebuild: { send },
      s3: t.s3,
      objects: t.objects,
      journal: t.journal,
      workspace: { ...input.workspace, inspectionFiles: input.workspace.publicFiles },
      env: { NATIVE_WORKFLOW_JOB_PROJECT: 'fixture', NATIVE_WORKFLOW_CHECK_ROLE: 'fixture-role' },
      sign,
    });
};

describe('explicit abandonment of a protected engine operation', () => {
  it.each(['timeout', 'uncertain job', 'cancelled operation'])(
    'continues from the prior snapshot after %s with no new decision or check receipt',
    async (fault) => {
      const t = await setup();
      await t.command([]);
      t.project.set('src/app.js', Buffer.from('export default 1'));
      const identity = nativeEngineIdentity(await t.row());
      const prior = await t.journal.get(identity);
      const body = await t.request('execute', {
        args: ['engine', 'sensor', 'fire', '--stage', 'build'],
      });
      const sendBuild = vi.fn(async () => {
        throw timeout();
      });
      useCheckJob(t, sendBuild);
      if (fault === 'timeout')
        t.hooks.tool = () => {
          throw timeout();
        };
      let context;
      if (fault === 'cancelled operation') {
        context = { getRemainingTimeInMillis: () => 60_001 };
        t.hooks.jobsFactory = ({ signal }) => ({
          check: async () => {
            if (!signal.aborted)
              await new Promise((resolve) =>
                signal.addEventListener('abort', resolve, { once: true }),
              );
            throw new DOMException('Operation interrupted', 'AbortError');
          },
        });
      }
      const interruption =
        fault === 'timeout'
          ? 'NATIVE_ENGINE_TIMEOUT'
          : fault === 'uncertain job'
            ? 'NATIVE_ENGINE_JOB_UNCERTAIN'
            : 'NATIVE_ENGINE_CANCELLED';
      await expect(t.send(body, context)).rejects.toMatchObject({ code: interruption });
      expect((await t.send(body)).response.status).toBe('pending');
      await expect(t.command(['next'])).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      const operation = await pendingOperation(t);
      expect(operation).toMatchObject({
        requestId: body.requestId,
        expectedVersion: prior.version,
        sequence: 1,
        writerGeneration: 1,
      });
      for (const changed of [
        { requestId: randomUUID() },
        { token: randomUUID() },
        { attemptId: randomUUID() },
        { epoch: 2 },
        { sequence: 2 },
        { writerGeneration: 2 },
        { expectedVersion: 0 },
      ])
        await expect(abandon(t, { ...operation, ...changed })).rejects.toMatchObject({
          code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
        });
      t.access.allowed = false;
      await expect(abandon(t, operation)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_FORBIDDEN',
      });
      t.access.allowed = true;
      t.f.hooks.after = (command) => {
        if (
          command.input.TransactItems?.some(
            (item) => item.Update?.ExpressionAttributeValues?.[':abandoned'],
          )
        )
          throw timeout();
      };
      const receipt = await abandon(t, operation);
      expect(receipt).toMatchObject({
        status: 'abandoned',
        requestId: body.requestId,
        version: prior.version + 1,
        abandonedAt: t.f.now(),
      });
      t.f.hooks.after = null;
      const row = operationRow(t, body.requestId);
      expect(row).toMatchObject({
        identity,
        abandonedBy: identity,
        abandonedAt: receipt.abandonedAt,
        status: 'abandoned',
      });
      expect(row).not.toHaveProperty('result');
      expect(row).not.toHaveProperty('snapshot');
      if (fault === 'uncertain job') {
        expect(Object.values(row.jobs)).toMatchObject([{ status: 'uncertain' }]);
        const [jobId] = Object.keys(row.jobs);
        await expect(
          t.journal.recordJob(row, jobId, { status: 'finished' }, 'uncertain'),
        ).rejects.toThrow();
      }
      expect(sendBuild).toHaveBeenCalledTimes(Number(fault === 'uncertain job'));
      expect((await t.journal.get(identity)).snapshot).toEqual(prior.snapshot);
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
      t.hooks.tool = null;
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toMatchObject({
        stage: 'build',
        gate: true,
      });
      expect(await abandon(t, operation)).toEqual(receipt);
      const proof = await t.proof(await t.publish());
      expect(proof).toMatchObject({
        workflowCompletion: 'not_verified',
        requiredChecks: 'incomplete',
        engineApplication: [],
      });
      expect(sendBuild).toHaveBeenCalledTimes(Number(fault === 'uncertain job'));
      expect(operationRow(t, body.requestId)).toEqual(row);
    },
  );
  it.each(['original', 'replay'])(
    'lets a late %s win the abandonment transaction',
    async (winner) => {
      const t = await setup();
      const body = await t.request('execute');
      const paused = Promise.withResolvers();
      const release = Promise.withResolvers();
      const saved = Promise.withResolvers();
      const acknowledged = Promise.withResolvers();
      t.hooks.afterPut = async ({ Key }) => {
        if (winner === 'replay' && Key.endsWith('/result.json.gz')) {
          saved.resolve();
          await acknowledged.promise;
        }
      };
      t.hooks.tool = () => {
        paused.resolve();
        return release.promise;
      };
      const original = t.send(body);
      await paused.promise;
      const target = await pendingOperation(t);
      t.f.hooks.before = async (command) => {
        if (
          command.input.TransactItems?.some(
            (item) => item.Update?.ExpressionAttributeValues?.[':abandoned'],
          )
        ) {
          release.resolve();
          if (winner === 'replay') {
            await saved.promise;
            expect((await t.send(body)).response.status).toBe('completed');
            acknowledged.resolve();
          }
          await original;
        }
      };
      await expect(abandon(t, target)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_HEAD_CHANGED',
      });
      expect(await t.send(body)).toEqual(await original);
      expect(operationRow(t, body.requestId)).toMatchObject({ status: 'completed' });
      expect(t.calls).toHaveLength(1);
    },
  );
  it.each(['before launch', 'during launch'])(
    'fences the isolated job %s and rejects its late acknowledgement',
    async (phase) => {
      const t = await setup();
      await t.command([]);
      t.project.set('src/app.js', Buffer.from('export default 1'));
      const body = await t.request('execute', {
        args: ['engine', 'sensor', 'fire', '--stage', 'build'],
      });
      const discard = async () => abandon(t, await pendingOperation(t));
      const send = vi.fn(async (command) => {
        if (command.constructor.name === 'StopBuildCommand') {
          expect(command.input.id).toBe('fixture:old');
          return {};
        }
        expect(command.constructor.name).toBe('StartBuildCommand');
        await discard();
        return { build: { id: 'fixture:old' } };
      });
      useCheckJob(t, send, async (_s3, command) => {
        if (phase === 'before launch' && command.constructor.name === 'PutObjectCommand')
          await discard();
        return 'https://fixture.invalid/job';
      });
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
      expect(send).toHaveBeenCalledTimes(phase === 'before launch' ? 0 : 2);
      expect(Object.values(operationRow(t, body.requestId).jobs).map((job) => job.status)).toEqual(
        phase === 'before launch' ? [] : ['prepared'],
      );
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
      expect(await t.proof(await t.publish())).toMatchObject({
        requiredChecks: 'incomplete',
        workflowCompletion: 'not_verified',
      });
    },
  );
  it('keeps an abandoned finalize and its late evidence out of the same and later publications', async () => {
    const t = await setup();
    const prior = await toGate(t);
    await approve(t, prior);
    const history = await t.proof(prior);
    const produced = await t.f.turn(2);
    const body = await t.request('finalize', {
      publication: produced.receipt,
      interaction: produced.interactionReceipt,
    });
    let receipt;
    t.hooks.beforeObject = async (command) => {
      if (
        command.constructor.name === 'PutObjectCommand' &&
        command.input.Key.endsWith(`${body.requestId}/result.json.gz`)
      ) {
        receipt = await abandon(t, await pendingOperation(t));
      }
    };
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
    await expect(
      t.send({ ...body, requestId: randomUUID(), expectedVersion: receipt.version }),
    ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_PUBLICATION_ABANDONED' });
    expect(await t.proof(produced)).toBeNull();
    expect(await t.proof(prior)).toEqual(history);
    expect(
      [...t.f.rows.values()]
        .filter((row) => row.sk.includes('#PUBLICATION#'))
        .map((row) => row.publicationId),
    ).toEqual([prior.receipt.id]);
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    const late = await t.objects.observeOperationObject(body.identity, body.requestId, 'result');
    const later = await t.f.turn(2, {
      files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
    });
    const next = await t.request('finalize', {
      publication: later.receipt,
      interaction: later.interactionReceipt,
    });
    const finish = t.journal.finish;
    t.journal.finish = (input) =>
      finish({ ...input, publication: { ...input.publication, evidence: late.value.evidence } });
    await expect(t.send(next)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_PUBLICATION_INVALID' });
    expect(await t.proof(later)).toBeNull();
    t.journal.finish = finish;
    expect((await t.send(next)).response.status).toBe('completed');
    expect(await t.proof(later)).toMatchObject({ publicationId: later.receipt.id });
    expect(await t.proof(produced)).toBeNull();
  });
  it('holds saved output or an inconclusive lookup for ordinary exact-request recovery', async () => {
    const t = await setup();
    const body = await t.request('execute');
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    // V4/V5 operation rows predate the optional action / publication identity.
    delete operationRow(t, body.requestId).action;
    const target = await pendingOperation(t);
    t.hooks.checksum = () => '';
    await expect(abandon(t, target)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_OBJECT_INVALID',
    });
    t.hooks.checksum = null;
    await expect(abandon(t, target)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_RESULT_SAVED' });
    expect(await pendingOperation(t)).toEqual(target);
    t.f.hooks.before = null;
    expect((await t.send(body)).response.status).toBe('completed');
    expect(t.calls).toHaveLength(1);
  });
  it.each(['interrupted', 'saved'])(
    'admits the replacement CLI after confirmation to discard an %s command and resume the open gate',
    async (fault) => {
      const t = await setup();
      const prior = await toGate(t);
      await approve(t, prior);
      const history = await t.proof(prior);
      const body = await t.request('execute', { args: ['next'] });
      const committed = (await t.journal.get(nativeEngineIdentity(await t.row()))).snapshot;
      if (fault === 'saved') {
        interruptFinish(t, body);
        await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
        t.f.hooks.before = null;
        await expect(abandon(t, await pendingOperation(t))).rejects.toMatchObject({
          code: 'NATIVE_ENGINE_RESULT_SAVED',
        });
      } else {
        t.hooks.tool = () => {
          throw timeout();
        };
        await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_TIMEOUT' });
        t.hooks.tool = null;
      }
      const original = await pendingOperation(t);
      const stopped = await stopForWorkspaceRecovery(t);
      const request = {
        requestId: randomUUID(),
        recoveryId: stopped.recovery.id,
        confirmWorkspaceResume: true,
      };
      t.f.authorization.member = false;
      await expect(t.f.api.recover(t.f.prepared, request, t.f.recheck)).rejects.toMatchObject({
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
      t.f.authorization.member = true;
      await t.f.api.recover(t.f.prepared, request, t.f.recheck);
      await expect(abandon(t, original)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_WRITER_CHANGED',
      });
      const replacement = await t.execution.claim(t.f.bindingIdentity);
      const restoring = await t.execution.recoveryStopped({ row: replacement.row });
      await expect(abandon(t, original, body.identity)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_FORBIDDEN',
      });
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      await expect(t.send({ ...body, identity: await t.identity() })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'native-abandon-')));
      try {
        const project = join(root, 'project');
        await mkdir(project, { mode: 0o700 });
        let loseReply = true;
        const { client } = await prepareNativeEngineClient({
          project,
          control: join(root, 'control'),
          s3: t.s3,
          forbiddenBytes: [],
          payload: {
            ...(await t.identity()),
            command: 'native-resume',
            configuration: { workflowEngine: t.pin },
          },
          env: {
            NATIVE_RUNTIME_ACCOUNT_ID: t.f.configuration.accountId,
            NATIVE_PUBLICATION_BUCKET: t.f.configuration.publicationBucket,
          },
          lambda: {
            send: async ({ input }) => {
              const request = JSON.parse(input.Payload);
              const reply = await t.handler(
                request,
                await t.context({ invokedFunctionArn: input.FunctionName }),
              );
              if (request.action === 'abandon' && loseReply) {
                loseReply = false;
                throw timeout();
              }
              return { Payload: Buffer.from(JSON.stringify(reply)) };
            },
          },
        });
        const { stdout } = await client.command(['engine', 'operation', 'pending']);
        expect(JSON.parse(stdout)).toEqual(original);
        const cmd = ['engine', 'operation', 'abandon', stdout];
        await expect(client.command(cmd)).rejects.toThrow('Lost acknowledgement');
        const abandoned = await client.command(cmd);
        expect(JSON.parse(abandoned.stdout)).toMatchObject({
          status: 'abandoned',
          requestId: body.requestId,
        });
        expect(await client.command(cmd)).toEqual(abandoned);
        const operation = operationRow(t, body.requestId);
        if (fault === 'saved') {
          for (const name of ['snapshot', 'result']) {
            const observed = await t.objects.observeOperationObject(
              operation.identity,
              body.requestId,
              name,
            );
            expect(operation.discarded[name]).toEqual(observed.receipt);
          }
        }
        expect(operation).not.toHaveProperty('result');
        expect((await t.journal.get(nativeEngineIdentity(restoring))).snapshot).toEqual(committed);
        expect(operation.abandonedBy).toEqual(nativeEngineIdentity(restoring));
        expect(JSON.parse((await client.command(['next', '--resume'])).stdout)).toMatchObject({
          stage: 'build',
          gate: true,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
      expect(await t.proof(prior)).toEqual(history);
      expect(await t.proof(await t.publish(gate()))).toMatchObject({
        humanApproval: 'incomplete',
        workflowCompletion: 'not_verified',
        engineApplication: [],
      });
    },
  );
  it('cannot abandon or resume a terminally cancelled execution', async () => {
    const t = await setup();
    const body = await t.request('execute');
    t.hooks.tool = () => {
      throw timeout();
    };
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_TIMEOUT' });
    const target = await pendingOperation(t);
    t.f.hooks.before = async (command) => {
      if (
        command.input.TransactItems?.some(
          (item) => item.Update?.ExpressionAttributeValues?.[':abandoned'],
        )
      ) {
        t.f.hooks.before = null;
        await t.execution.cancel(t.f.bindingIdentity);
      }
    };
    await expect(abandon(t, target)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    const stopper = await t.execution.claim(t.f.bindingIdentity);
    const cancelled = await t.execution.advance({
      row: stopper.row,
      patch: { status: 'CANCELLED' },
    });
    expect(cancelled.epoch).toBe(body.identity.epoch + 1);
    await expect(abandon(t, target, body.identity)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_FORBIDDEN',
    });
    await expect(abandon(t, target)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    await expect(
      t.f.api.recover(
        t.f.prepared,
        { requestId: randomUUID(), recoveryId: randomUUID(), confirmWorkspaceResume: true },
        t.f.recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CANCELLED' });
    expect(operationRow(t, body.requestId).status).toBe('running');
  });
});
describe('protected workflow engine journal recovery', () => {
  it('retries rejected begin and finish transactions without dispatching the sensor twice', async () => {
    const t = await setup();
    await t.command([]);
    t.project.set('src/app.js', Buffer.from('export default 1'));
    t.jobs.check = vi.fn(t.jobs.check);
    const body = await t.request('execute', {
      args: ['engine', 'sensor', 'fire', '--stage', 'build'],
    });
    const attempts = { running: 0, completed: 0 };
    t.f.hooks.before = (command) => {
      const phase = journalWrite(command, body);
      if (phase && ++attempts[phase] === 1) throw conflict(command);
    };
    const first = await t.send(body);
    expect(first.result.exitCode).toBe(0);
    expect(await t.send(body)).toEqual(first);
    expect(attempts).toEqual({ running: 2, completed: 2 });
    expect(t.jobs.check).toHaveBeenCalledTimes(1);
    expect(t.calls).toHaveLength(2);
    expect(await journalStatus(t)).toEqual({ ok: true, version: 2, pending: null });

    const next = await t.request('execute', { args: body.args });
    t.f.hooks.before = (command) => {
      if (journalWrite(command, next) === 'completed') throw conflict(command);
    };
    await expect(t.send(next)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(await journalStatus(t)).toMatchObject({ version: 2, pending: next.requestId });
    t.f.hooks.before = null;
    expect((await t.send(next)).response).toMatchObject({ status: 'completed', version: 3 });
    expect(t.jobs.check).toHaveBeenCalledTimes(2);
    expect(t.calls).toHaveLength(3);
  });

  it('recognizes its own begin token and finished result after both write replies are lost', async () => {
    const t = await setup();
    const body = await t.request('execute');
    const writes = [];
    t.f.hooks.after = (command) => {
      const phase = journalWrite(command, body);
      if (phase) {
        writes.push(phase);
        throw timeout();
      }
    };
    const first = await t.send(body);
    expect(first.response).toMatchObject({ status: 'completed', version: 1 });
    expect(await t.send(body)).toEqual(first);
    expect(writes).toEqual(['running', 'completed']);
    expect(t.calls).toHaveLength(1);
  });

  it('keeps a concurrent duplicate pending before output and lets both finish from the same saved versions', async () => {
    const t = await setup();
    const body = await t.request('execute');
    const competitor = await t.request('mirror');
    t.hooks.tool = async () => {
      expect(await t.send(body)).toMatchObject({ response: { status: 'pending' } });
      await expect(t.send(competitor)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      await expect(t.send({ ...body, args: ['next'] })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });
    };
    let recovered;
    t.hooks.afterPut = async (input) => {
      if (input.Key.endsWith('/result.json.gz')) recovered = await t.send(body);
    };
    const original = await t.send(body);
    expect(recovered).toEqual(original);
    expect(original.response).toMatchObject({ status: 'completed', version: 1 });
    expect(t.calls).toHaveLength(1);
    expect(t.memberMessages()).toBe(1);
  });

  it.each([
    ['execute', ['next'], 'completed', 0],
    ['mirror', [], 'completed', 0],
    ['finalize', [], 'completed', 0],
    ['execute', ['next', '--force'], 'failed', 1],
    ['execute', ['engine', 'state', 'get'], 'completed', 2],
  ])('recovers persisted %s %j as %s with exitCode %i', async (action, args, status, exitCode) => {
    const t = await setup();
    await t.command([]);
    let produced;
    if (action === 'finalize')
      produced = await t.f.turn(1, {
        files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
      });
    const body = await t.request(
      action,
      produced
        ? { publication: produced.receipt, interaction: produced.interactionReceipt }
        : { args },
    );
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(await journalStatus(t)).toMatchObject({ version: 1, pending: body.requestId });
    if (produced) expect(await t.proof(produced)).toBeNull();
    const calls = t.calls.length;
    t.f.hooks.before = null;
    t.hooks.archive = vi.fn();
    t.hooks.afterPut = vi.fn();
    const recovered = await t.send(body);
    expect(recovered.response).toMatchObject({ status, version: 2 });
    expect(recovered.result).toMatchObject({ requestId: body.requestId, exitCode });
    if (produced)
      expect(await t.proof(produced)).toMatchObject({ publicationId: produced.receipt.id });
    expect(await t.send(body)).toEqual(recovered);
    expect(t.calls).toHaveLength(calls);
    expect(t.hooks.archive).not.toHaveBeenCalled();
    expect(t.hooks.afterPut).not.toHaveBeenCalled();
    expect(await journalStatus(t)).toMatchObject({ version: 2, pending: null });
  });

  it.each([false, true])(
    'retains the previous snapshot for a saved failure before workspace creation (prior workspace %s)',
    async (prior) => {
      const t = await setup();
      if (prior) await t.command([]);
      const identity = nativeEngineIdentity(await t.row());
      const previous = (await t.journal.get(identity))?.snapshot ?? null;
      t.hooks.archive = () => {
        throw engineFailure('NATIVE_ENGINE_ARCHIVE_UNAVAILABLE');
      };
      const body = await t.request('execute');
      interruptFinish(t, body);
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
      t.f.hooks.before = null;
      const resumed = await t.send(body);
      expect(resumed.response.status).toBe('failed');
      expect(resumed.result.failure).toBe('NATIVE_ENGINE_ARCHIVE_UNAVAILABLE');
      expect((await t.journal.get(identity)).snapshot).toEqual(previous);
      expect(t.calls).toHaveLength(Number(prior));
    },
  );

  it('requires a readable result and snapshot before clearing a pending command', async () => {
    const t = await setup();
    const body = await t.request('execute');
    t.hooks.beforeObject = (command) => {
      if (
        command.constructor.name === 'PutObjectCommand' &&
        command.input.Key.endsWith('/result.json.gz')
      )
        throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    expect((await t.send(body)).response.status).toBe('pending');
    expect(t.calls).toHaveLength(1);
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
  });

  it('recovers a lost S3 result write acknowledgement only after exact version readback succeeds', async () => {
    const t = await setup();
    const body = await t.request('execute');
    t.hooks.afterPut = (input) => {
      if (input.Key.endsWith('/result.json.gz')) throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    t.hooks.beforeObject = (command) => {
      if (command.input.Key?.endsWith('/snapshot.json.gz')) throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
    t.hooks.beforeObject = null;
    expect(await t.send(body)).toMatchObject({
      response: { status: 'completed', version: 1 },
      result: { exitCode: 0 },
    });
    expect(t.calls).toHaveLength(1);
  });

  it.each([
    ['missing snapshot', 'NATIVE_ENGINE_STATE_UNAVAILABLE'],
    ['invalid checksum', 'NATIVE_ENGINE_OBJECT_INVALID'],
    ['delete marker', 'NATIVE_ENGINE_OBJECT_INVALID'],
    ['ambiguous listing', 'NATIVE_ENGINE_OBJECT_INVALID'],
    ['foreign result', 'NATIVE_ENGINE_RESULT_INVALID'],
  ])('holds the pending head with %s', async (fault, code) => {
    const t = await setup();
    const body = await t.request('execute');
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    t.f.hooks.before = null;
    const identity = nativeEngineIdentity(await t.row());
    if (fault === 'foreign result') {
      await t.objects.write(
        identity,
        body.requestId,
        'result',
        {
          schemaVersion: 1,
          identity: { ...identity, sequence: identity.sequence + 1 },
          requestId: body.requestId,
          exitCode: 0,
          stdout: '',
          stderr: '',
          patches: [],
        },
        'output',
      );
    } else if (fault === 'missing snapshot') {
      t.hooks.beforeObject = ({ input }) => {
        if (input.Prefix?.endsWith('/snapshot.json.gz')) return { IsTruncated: false };
      };
    } else if (fault === 'delete marker' || fault === 'ambiguous listing') {
      t.hooks.beforeObject = ({ input }) => {
        if (input.Prefix?.endsWith('/result.json.gz'))
          return fault === 'delete marker'
            ? { IsTruncated: false, DeleteMarkers: [{ Key: input.Prefix, IsLatest: true }] }
            : { IsTruncated: false, Versions: [null] };
      };
    } else t.hooks.checksum = () => '';
    await expect(t.send(body)).rejects.toMatchObject({ code });
    const stopped = await stopForWorkspaceRecovery(t);
    const replacement = await confirmWorkspaceRecovery(t, stopped);
    await t.execution.recoveryStopped({ row: replacement.row });
    await expect(abandon(t, await pendingOperation(t))).rejects.toMatchObject({ code });
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
    expect(t.calls).toHaveLength(1);
  });

  it.each(['current', 'historical', 'historical evidence only'])(
    'discards a predecessor finalize (%s), retaining the previous publication and refusing backfill',
    async (shape) => {
      const t = await setup();
      const prior = await toGate(t);
      await approve(t, prior);
      const history = await t.proof(prior);
      const publication = await t.f.turn(2);
      const body = await t.request('finalize', {
        publication: publication.receipt,
        interaction: publication.interactionReceipt,
      });
      if (shape === 'historical evidence only') {
        t.hooks.afterPut = ({ Key }) => {
          if (Key.endsWith('/evidence.json.gz')) throw timeout();
        };
        await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_TIMEOUT' });
        t.hooks.afterPut = null;
      } else {
        interruptFinish(t, body);
        await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
        t.f.hooks.before = null;
      }
      if (shape !== 'current') {
        delete operationRow(t, body.requestId).action;
        delete operationRow(t, body.requestId).publicationId;
      }
      const target = await pendingOperation(t);
      const stopped = await stopForWorkspaceRecovery(t);
      const claim = await confirmWorkspaceRecovery(t, stopped);
      const restoring = await t.execution.recoveryStopped({ row: claim.row });
      await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
      await expect(abandon(t, { ...target, token: randomUUID() })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });
      t.access.allowed = false;
      await expect(abandon(t, target)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      t.access.allowed = true;
      let receipt;
      if (shape === 'historical evidence only') {
        const original = async (originalRequest) =>
          t.handler(
            {
              schemaVersion: 1,
              identity: await t.identity(),
              action: 'abandon',
              operation: target,
              originalRequest,
            },
            await t.context(),
          );
        await expect(abandon(t, target)).rejects.toMatchObject({
          code: 'NATIVE_ENGINE_ORIGINAL_REQUEST_REQUIRED',
        });
        await expect(original({ ...body, publication: prior.receipt })).rejects.toMatchObject({
          code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
        });
        receipt = await original(body);
      } else receipt = await abandon(t, target);
      const discarded = operationRow(t, body.requestId).discarded;
      expect(discarded.publicationId).toBe(publication.receipt.id);
      if (shape === 'historical evidence only') expect(discarded).not.toHaveProperty('evidence');
      else
        expect(await t.objects.read(body.identity, discarded.evidence, 'output')).toMatchObject({
          publicationId: publication.receipt.id,
          identity: { writerGeneration: 1 },
        });
      await expect(
        t.send({
          ...body,
          identity: await t.identity(),
          requestId: randomUUID(),
          expectedVersion: receipt.version,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_PUBLICATION_ABANDONED' });
      expect((await t.command(['next', '--resume'])).result.exitCode).toBe(0);
      expect(await abandon(t, target)).toEqual(receipt);
      expect(await t.proof(publication)).toBeNull();
      expect(await t.proof(prior)).toEqual(history);
    },
  );

  it('requires the stopped episode at commit and rejects a predecessor operation from a future turn', async () => {
    const t = await setup();
    const body = await t.request('execute');
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    t.f.hooks.before = null;
    const stopped = await stopForWorkspaceRecovery(t);
    const claim = await confirmWorkspaceRecovery(t, stopped);
    const restoring = await t.execution.recoveryStopped({ row: claim.row });
    await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
    const target = await pendingOperation(t);
    const operation = operationRow(t, target.requestId);
    operation.identity.sequence++;
    await expect(pendingOperation(t)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
    });
    operation.identity.sequence--;
    t.f.hooks.before = (command) => {
      if (
        command.input.TransactItems?.some(
          (item) => item.Update?.ExpressionAttributeValues?.[':abandoned'],
        )
      ) {
        const row = [...t.f.rows.values()].find(
          (item) => item.lastRecoveryId === stopped.recovery.id,
        );
        delete row.stopConfirmation;
      }
    };
    await expect(abandon(t, target)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    expect(await pendingOperation(t)).toEqual(target);
    await expect(abandon(t, target)).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
  });

  it.each(['token', 'requestId', 'version', 'producerSha256', 'cancel'])(
    'fences a saved result when %s changes between its recovery read and commit',
    async (field) => {
      const t = await setup();
      const body = await t.request('execute');
      interruptFinish(t, body);
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
      t.f.hooks.before = async (command) => {
        if (journalWrite(command, body) !== 'completed') return;
        t.f.hooks.before = null;
        if (field === 'cancel') return t.execution.cancel(t.f.bindingIdentity);
        const head = [...t.f.rows.values()].find((item) => item.sk.endsWith('#HEAD'));
        if (field === 'token' || field === 'requestId') head.pending[field] = randomUUID();
        else head[field] = field === 'version' ? 3 : engineDigest('another producer');
      };
      await expect(t.send(body)).rejects.toMatchObject({
        code: field === 'cancel' ? 'NATIVE_ENGINE_WRITER_CHANGED' : 'NATIVE_ENGINE_HEAD_CHANGED',
      });
      const operation = [...t.f.rows.values()].find((item) => item.sk.endsWith(body.requestId));
      expect(operation.status).toBe('running');
      expect(t.calls).toHaveLength(1);
    },
  );
});
describe('protected workflow engine service', () => {
  it('delivers intake only to the scheduler and re-presents its retained request before an intent exists', async () => {
    const t = await setup();
    const intake = {
      kind: 'print',
      message: 'Run aidlc engine orchestrate next --propose <plan> --request 1234abcd',
    };
    t.hooks.orchestrate = (args) =>
      args[1] === '--' ? intake : { kind: 'error', message: 'No active intent' };
    for (const args of [
      ['engine', 'adapter', 'codex', 'session-start'],
      ['engine', 'adapter', 'codex', 'record-human-turn'],
      ['next', '--', 'substitute intent'],
      ['next', '--project-dir', '/another/project'],
    ])
      expect((await t.command(args)).result).toMatchObject({
        failure: 'NATIVE_ENGINE_COMMAND_DENIED',
        stdout: '',
      });
    expect(t.calls).toHaveLength(0);
    await t.command(['engine', 'state', 'get']);
    expect(t.calls).toEqual([['aidlc-state.ts', 'get']]);
    expect(t.memberMessages()).toBe(0);
    const first = await t.request('execute', { args: ['engine', 'orchestrate', 'next'] });
    const received = await t.send(first);
    expect(JSON.parse(received.result.stdout)).toEqual(intake);
    expect(await t.send(first)).toEqual(received);
    expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual(intake);
    expect(t.calls).toHaveLength(2);
    expect(t.memberMessages()).toBe(1);
  });

  it('resumes the open stage only for the confirmed writer and turn, without replaying its lost approval', async () => {
    const t = await setup();
    const opened = await toGate(t);
    // The member submitted an approval, but its delivery became uncertain.
    await approve(t, opened);
    const previous = await t.request('execute', { args: ['next', '--resume'] });
    const stopped = await stopForWorkspaceRecovery(t);
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
    const replacement = await confirmWorkspaceRecovery(t, stopped);
    await expect(t.request('execute', { args: ['next', '--resume'] })).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    const restoring = await t.execution.recoveryStopped({ row: replacement.row });
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
    const memberMessages = t.memberMessages();
    const resumed = await t.command(['engine', 'orchestrate', 'next', '--resume']);
    expect(resumed.result.exitCode).toBe(0);
    expect(JSON.parse(resumed.result.stdout)).toMatchObject({ stage: 'build', gate: true });
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);

    await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
    expect((await t.command(['next', '--resume'])).result.exitCode).toBe(0);
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);
    expect(t.memberMessages()).toBe(memberMessages);
    const held = await t.publish(gate());
    expect(await t.proof(held)).toMatchObject({
      humanApproval: 'incomplete',
      workflowCompletion: 'not_verified',
      engineApplication: [],
    });

    await approve(t, held);
    expect((await t.command(['next', '--resume'])).result.failure).toBe(
      'NATIVE_ENGINE_COMMAND_DENIED',
    );
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    expect(await t.proof(await t.publish())).toMatchObject({ humanApproval: 'applied' });
  });
  it.each(['no snapshot', 'intake only'])(
    'cannot restart intake on recovery with %s',
    async (scenario) => {
      const t = await setup();
      if (scenario === 'intake only') {
        t.hooks.orchestrate = () => ({ kind: 'print', message: 'Choose a plan.' });
        await t.command([]);
      }
      const replacement = await confirmWorkspaceRecovery(t, await stopForWorkspaceRecovery(t));
      await t.execution.recoveryStopped({ row: replacement.row });
      const priorCalls = t.calls.length;
      expect((await t.command(['next', '--resume'])).result.failure).toBe(
        'NATIVE_ENGINE_STATE_UNAVAILABLE',
      );
      expect(t.calls).toHaveLength(priorCalls);
      expect(t.memberMessages()).toBe(scenario === 'no snapshot' ? 0 : 1);
    },
  );
  it('does not let a later command supply the base that preparation could not observe', async () => {
    const t = await setup({ git: true });
    const initial = await t.request('mirror');
    const { files, filesSha256, schemaVersion } = await t.objects.read(
      initial.identity,
      initial.input,
      'input',
    );
    initial.input = await t.objects.write(
      initial.identity,
      initial.requestId,
      'files',
      { files: files.map(({ mode: _mode, ...file }) => file), filesSha256, schemaVersion },
      'input',
    );
    expect((await t.send(initial)).result.exitCode).toBe(0);
    const opened = await toGate(t);
    await approve(t, opened);
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    const done = await t.publish();
    await t.admit(done);
    expect((await t.sourceView(done)).gitChangeSet).toMatchObject({
      workflowCompletion: 'complete',
      terminal: 'not_recorded',
      review: 'not_required',
    });
  });

  it('binds a gated no-review plan to the admitted modes and explicit deletions and preserves historical proof', async () => {
    const t = await setup({ git: true });
    expect((await t.send(await t.request('mirror'))).result.exitCode).toBe(0);
    t.modes.set('README.md', '100755');
    t.project.delete('removed.bin');
    const input = await t.request('mirror');
    const submitted = await t.objects.read(input.identity, input.input, 'input');
    expect(submitted.git.deleted).toEqual(['removed.bin']);
    for (const [modify, failure] of [
      [
        (body) => {
          body.git.deleted = [];
        },
        'NATIVE_ENGINE_INPUT_INVALID',
      ],
      [
        (body) => {
          body.files.find((file) => file.path === 'README.md').mode = '100644';
        },
        'NATIVE_ENGINE_INPUT_INVALID',
      ],
      [
        (body) => {
          body.sourceBaseline.receipt.manifest.versionId = 'wrong';
        },
        'NATIVE_ENGINE_SOURCE_MISMATCH',
      ],
    ]) {
      const request = await t.request('mirror');
      const value = structuredClone(submitted);
      modify(value);
      request.input = await t.objects.write(
        request.identity,
        request.requestId,
        'files',
        value,
        'input',
      );
      expect((await t.send(request)).result.failure).toBe(failure);
    }
    const opened = await toGate(t);
    await approve(t, opened);
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    const owner = nativeEngineIdentity(await t.row());
    const head = await t.journal.get(owner);
    const snapshot = await t.objects.read(owner, head.snapshot);
    expect(snapshot.state.terminalResult.gitDelta).toMatchObject({
      sourceBaseline: { id: t.sourceBaseline.receipt.id },
      repository: { commit: t.f.configuration.repository.commit },
      changes: expect.arrayContaining([
        { path: 'removed.bin', before: expect.objectContaining({ bytes: 2 }), after: null },
      ]),
    });
    const completed = await t.publish();
    const manifest = await t.f.publications.read(await t.identity(), completed.receipt);
    const wrongBase = structuredClone(t.sourceBaseline);
    wrongBase.receipt.manifest.versionId = 'another-source-version';
    const divergent = await t.f.turn(completed.receipt.sequence, {
      sourceBaseline: wrongBase,
      git: manifest.git,
      filesystemPolicy: manifest.filesystemPolicy,
      files: manifest.files.map((file) => ({ ...file, content: t.project.get(file.path) })),
    });
    const refused = await t.send(
      await t.request('finalize', {
        publication: divergent.receipt,
        interaction: divergent.interactionReceipt,
      }),
    );
    expect(refused.result.failure).toBe('NATIVE_ENGINE_PUBLICATION_INVALID');
    expect(await t.proof(divergent)).toBeNull();
    await t.admit(completed);
    const result = (await t.sourceView(completed)).gitChangeSet;
    expect(result).toMatchObject({
      terminal: 'matched',
      review: 'not_required',
      reviews: [],
      workflowCompletion: 'complete',
      sourceBaselineId: t.sourceBaseline.receipt.id,
    });
    expect(result.changes.find((change) => change.path === 'README.md')).toMatchObject({
      before: { mode: '100644' },
      after: { mode: '100755' },
    });
    expect(result.changes.find((change) => change.path === 'removed.bin').after).toBeNull();
    expect((await t.sourceView(opened)).gitChangeSet).toMatchObject({
      terminal: 'not_recorded',
      review: 'not_verified',
    });
    const nextTurn = async () => {
      await t.f.respond();
      const claim = await t.execution.claim(t.f.bindingIdentity);
      await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
    };
    await nextTurn();
    const excludedPath = 'aidlc/work/.aidlc-engine/diagnostic.json';
    t.project.set(excludedPath, Buffer.from('{}'));
    const excluded = await t.publish();
    await t.admit(excluded);
    expect((await t.sourceView(excluded)).gitChangeSet).toMatchObject({
      sha256: result.sha256,
      terminal: 'matched',
      workflowCompletion: 'not_verified',
    });
    await nextTurn();
    t.project.delete(excludedPath);
    t.modes.set('README.md', '100644');
    const late = await t.publish();
    await t.admit(late);
    expect((await t.sourceView(late)).gitChangeSet).toMatchObject({
      workflowCompletion: 'complete',
      terminal: 'stale',
      review: 'not_required',
    });
    expect((await t.sourceView(completed)).gitChangeSet).toEqual(result);
    const target = {
      publicationId: completed.receipt.id,
      publicationSequence: completed.receipt.sequence,
      source: true,
    };
    const evidence = await t.proof(completed);
    const readWith = (completionProof) =>
      t.f.makeApi(true, completionProof).revision(t.f.prepared, target, t.f.recheck);
    expect(
      (
        await readWith(async () => ({
          ...evidence,
          gitObservation: { ...evidence.gitObservation, publicationSha256: '0'.repeat(64) },
        }))
      ).gitChangeSet,
    ).toMatchObject({ review: 'not_verified', reason: 'proof_mismatch' });
    expect(
      (
        await readWith(async () => {
          throw new Error('temporarily unavailable');
        })
      ).gitChangeSet,
    ).toMatchObject({
      review: 'not_verified',
      reason: 'proof_unavailable',
      changes: result.changes,
    });
    const legacy = { ...evidence };
    delete legacy.gitObservation;
    expect((await readWith(async () => legacy)).gitChangeSet).toMatchObject({
      review: 'not_verified',
      terminal: 'not_recorded',
    });
    await expect(
      readWith(async () => {
        t.f.authorization.member = false;
        return evidence;
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_FORBIDDEN' });
  });

  it('reports completion only from applied gates, observed checks and the exact published files', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      // A stopped turn waiting at its own gate is published, never complete.
      const waiting = await t.proof(opened);
      expect(waiting).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'required_evidence_incomplete',
        requiredChecks: 'passed',
        humanApproval: 'incomplete',
        terminalOutcome: null,
      });
      expect(waiting.checks).toMatchObject([
        { stage: 'build', sensor: 'unit-tests', status: 'passed', buildId: expect.any(String) },
      ]);
      // The coding process cannot approve its own gate or finish the workflow.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });
      // The operation is answered as recorded; what raised it is reported once, beside it.
      expect(t.failures).toEqual([
        { thrown: 'NATIVE_ENGINE_COMMAND_DENIED', code: 'NATIVE_ENGINE_COMMAND_DENIED' },
      ]);

      await approve(t, opened);
      // An accepted selection alone changes nothing until the engine applies it.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');
      const applied = await t.request('execute', { args: ['next'] });
      const before = t.calls.length;
      const first = await t.send(applied);
      expect(JSON.parse(first.result.stdout)).toEqual({ kind: 'done' });
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
        '--user-input',
        'Approve',
      ]);
      // A lost acknowledgement is answered from the journal, not by rerunning.
      const ran = t.calls.length;
      expect(ran).toBe(before + 1);
      const replayed = await t.send(applied);
      expect(replayed.response).toEqual(first.response);
      expect(t.calls).toHaveLength(ran);
      await expect(t.send({ ...applied, args: ['engine', 'state', 'get'] })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });

      const completed = await t.publish();
      const evidence = await t.proof(completed);
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        requiredChecks: 'passed',
        finalReview: 'not_required',
        humanApproval: 'applied',
        publicationId: completed.receipt.id,
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect(evidence.gates).toMatchObject([{ stage: 'build', status: 'applied' }]);
      // The earlier revision keeps its own outcome.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');

      // Bytes changed after the terminal outcome never inherit verification.
      t.project.set('src/app.js', Buffer.from('export const answer = 43;\n'));
      const changed = await t.publish();
      expect(await t.proof(changed)).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'result_files_changed',
      });
      expect((await t.proof(completed)).workflowCompletion).toBe('complete');

      // Members read the same outcomes through the revision API.
      await t.admit(completed);
      expect(await t.view(completed)).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        policy: 'pinned_workflow',
        policyStatus: 'protected_engine',
        requirementsStatus: 'captured',
        requiredChecks: 'passed',
        humanApproval: 'applied',
        effectivePlan: { scope: 'express', stages: [{ id: 'build', state: 'completed' }] },
        engineApplication: [{ application: 'applied', effect: 'GATE_APPROVED' }],
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
        producer: { profileId: NATIVE_ENGINE_PROFILE.id, functionVersion: t.pin.version },
        filesSha256: evidence.filesSha256,
        checks: [{ sensor: 'unit-tests', status: 'passed' }],
        gates: [{ stage: 'build', status: 'applied' }],
      });
      expect((await t.view(completed, false)).verification).toMatchObject({
        workflowCompletion: 'complete',
        publicationId: completed.receipt.id,
      });
      expect(await t.view(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        policyStatus: 'protected_engine',
        humanApproval: 'incomplete',
        terminalOutcome: 'not_recorded',
      });
      // Access is still checked for every read.
      t.f.authorization.member = false;
      await expect(t.view(completed)).rejects.toMatchObject({
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
    } finally {
      await t.close();
    }
  });

  it('applies a gate only from the answer to a recorded question, never from an approval typed as a written reply', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      expect(
        (await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode,
      ).toBe(0);
      const report = (result, ...rest) => [
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        result,
        ...rest,
      ];
      expect((await t.command(report('awaiting-approval'))).result.exitCode).toBe(0);
      // The agent ends its turn at the gate in prose: no question was recorded.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      expect((await t.proof(prose)).workflowCompletion).toBe('not_verified');
      await t.admit(prose);
      // The application still accepts a written reply to that turn.
      const accepted = await t.f.api.respond(
        t.f.prepared,
        'responding-member',
        {
          requestId: randomUUID(),
          interactionId: prose.interactionReceipt.id,
          contentSha256: prose.body.contentSha256,
          text: 'Approve',
        },
        t.f.recheck,
      );
      expect(accepted.response).toMatchObject({ kind: 'user_reply', text: 'Approve' });
      const deliver = async () => {
        const claim = await t.execution.claim(t.f.bindingIdentity);
        await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
      };
      await deliver();
      // It names no question the engine recorded, so it approves nothing.
      const typed = await t.command(report('approved', '--user-input', 'Approve'));
      expect(typed.result.exitCode).toBe(1);
      expect(typed.result.failure).toMatch(/^NATIVE_ENGINE_(DECISION_MISMATCH|COMMAND_DENIED)$/);
      expect(t.calls.some((call) => call.includes('approved'))).toBe(false);
      // The refusal is a finished operation: nothing is left pending.
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      const refused = await t.publish();
      expect(await t.proof(refused)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
      });

      // Presented again as a question, the same gate is applied from its answer.
      await t.admit(refused);
      await t.execution.respond({
        ...t.f.bindingIdentity,
        actorId: 'responding-member',
        request: {
          requestId: randomUUID(),
          interactionId: refused.interactionReceipt.id,
          contentSha256: refused.body.contentSha256,
          text: 'Show the approval as a question.',
        },
      });
      await deliver();
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
      });
      // Only the answer to the recorded question is a member decision.
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
    } finally {
      await t.close();
    }
  });

  // NE-24. A reply that names no question the engine recorded carries no
  // member authority. It no longer makes the engine refuse the turn.
  const NOT_APPLIED = 'NATIVE_ENGINE_REPLY_NOT_APPLIED';
  const reply = async (t, produced, text, selection) => {
    const accepted = await t.f.api.respond(
      t.f.prepared,
      'responding-member',
      {
        requestId: randomUUID(),
        interactionId: produced.interactionReceipt.id,
        contentSha256: produced.body.contentSha256,
        text,
        ...(selection ? { selection } : {}),
      },
      t.f.recheck,
    );
    const claim = await t.execution.claim(t.f.bindingIdentity);
    await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
    // The accepted reply as the application shows it, with the command the row names.
    return { ...accepted.response, commandId: (await t.row()).response.commandId };
  };
  const report = (result, ...rest) => [
    'engine',
    'orchestrate',
    'report',
    '--stage',
    'build',
    '--result',
    result,
    ...rest,
  ];

  it('applies the commands that need no member after a reply to a turn without a question, tells the agent why nothing was decided, and completes verified in the same attempt', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      // The agent ends its turn with a question in prose: no question file, no form.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      await t.admit(prose);
      const attempt = (await t.row()).attemptId;
      const written = await reply(t, prose, 'Yes, go ahead and approve the build.');
      expect(written).toMatchObject({ kind: 'user_reply', deliveryStatus: 'pending' });
      const spoken = t.memberMessages();
      const before = t.calls.length;

      // Asking for the directive again, running a check and reporting the stage
      // as waiting need no member. They reach the pinned engine and succeed.
      const again = await t.command(['next']);
      expect(again.response.status).toBe('completed');
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toMatchObject({ kind: 'run-stage', stage: 'build' });
      // The agent is told why no decision was taken and what to do instead.
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      expect(again.result.stderr).toContain('was not applied as a workflow decision');
      expect(again.result.stderr).toContain('.native-control/pending-question.json');
      expect(again.result.stderr).toContain('run aidlc next to read the current directive again');
      // Nothing of the member's words is repeated to the agent by the engine.
      expect(again.result.stderr).not.toContain('go ahead');
      let applied;
      for (const args of [
        ['engine', 'sensor', 'fire', '--stage', 'build'],
        report('awaiting-approval'),
      ]) {
        applied = await t.command(args);
        expect(applied.response.status).toBe('completed');
        expect(applied.result.exitCode).toBe(0);
        expect(applied.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      }
      // Once the stage waits at its gate, the engine names the approval it holds.
      expect(applied.result.stderr).toContain('The engine holds an open approval for stage build.');
      expect(t.calls.length).toBe(before + 3);
      // The reply never reached the pinned engine as a person's words.
      expect(t.memberMessages()).toBe(spoken);
      expect(t.failures).toEqual([]);

      // The revision in between is not verified, decides nothing, and says so.
      const between = await t.publish(gate());
      expect(between.finalized.result.exitCode).toBe(0);
      const unapplied = [
        {
          commandId: written.commandId,
          interactionId: prose.interactionReceipt.id,
          actorId: 'responding-member',
          sequence: 2,
          reason: 'no_recorded_question',
        },
      ];
      expect(await t.proof(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      // The open question was presented again as a form the engine recorded.
      // Its answer is a decision, and the run completes in the same attempt.
      await approve(t, between);
      // The member reads in that revision's completion report that the written
      // reply was not applied as a decision.
      expect(await t.view(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      const done = await t.command(['next']);
      expect(JSON.parse(done.result.stdout)).toEqual({ kind: 'done' });
      // A turn that starts with an answer to a recorded question carries no notice.
      expect(done.result.stderr).toBe('');
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
        unappliedReplies: unapplied,
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect((await t.row()).attemptId).toBe(attempt);
    } finally {
      await t.close();
    }
  });

  it('still refuses an answer, an approval and a plan selection after such a reply, with the reason, and implies none of them', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      const spoken = t.memberMessages();
      const before = t.calls.length;
      for (const args of [
        report('approved', '--user-input', 'Approve'),
        report('approved'),
        ['engine', 'log', 'answer', '--stage', 'build', '--details', 'Approve'],
        [
          'engine',
          'intent',
          'create',
          '--scope',
          'express',
          '--request',
          'abcd1234',
          '--label',
          'x',
        ],
      ]) {
        const refused = await t.command(args);
        expect(refused.response.status).toBe('failed');
        expect(refused.result).toMatchObject({
          exitCode: 1,
          stdout: '',
          failure: 'NATIVE_ENGINE_COMMAND_DENIED',
          patches: [],
        });
        // The refusal names its code first, then why the reply decided nothing
        // and which approval the engine holds open.
        expect(refused.result.stderr.split('\n').slice(0, 2)).toEqual([
          'NATIVE_ENGINE_COMMAND_DENIED',
          NOT_APPLIED,
        ]);
        expect(refused.result.stderr).toContain(
          'The engine holds an open approval for stage build.',
        );
      }
      // The pinned engine saw neither a command nor a person's words.
      expect(t.calls.length).toBe(before);
      expect(t.memberMessages()).toBe(spoken);
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      expect(await t.proof(await t.publish())).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        gates: [{ stage: 'build', status: 'not_recorded' }],
        engineApplication: [],
        unappliedReplies: [{ actorId: 'responding-member', reason: 'no_recorded_question' }],
      });
    } finally {
      await t.close();
    }
  });

  it('records such a reply when the turn runs no workflow command at all', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      const written = await reply(t, prose, 'Show the approval as a question.');
      // The agent only presents the gate as a form and ends its turn.
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      expect(await t.proof(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: written.commandId, sequence: 2 }],
      });
      // The same reply is recorded once, however often the turn is observed.
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence.unappliedReplies).toHaveLength(1);
      expect(evidence.workflowCompletion).toBe('complete');
    } finally {
      await t.close();
    }
  });

  it('treats an answer to a form that was not the engine’s question the same way and hands the agent the question it holds', async () => {
    const t = await setup();
    try {
      // The pinned engine offers a plan before any workflow state exists and
      // repeats that offer whenever it is asked again.
      const offer = capturedPlanAsk;
      t.hooks.orchestrate = (args) =>
        args.includes('--scope') ? null : args[0] === 'next' ? offer : null;
      expect(JSON.parse((await t.command([])).result.stdout)).toEqual(offer);
      // The agent paraphrases the offer. The engine does not record that form.
      const paraphrased = buildNativePendingInput({ spec: capturedPlanFormSpec });
      const shown = await t.publish(paraphrased);
      expect(shown.finalized.result.failure).toBe('NATIVE_ENGINE_PRESENTATION_MISMATCH');
      await t.admit(shown);
      const selection = { answers: [{ selectedOptions: [0] }] };
      const picked = await reply(t, shown, nativeAnswerText(paraphrased, selection), selection);
      const spoken = t.memberMessages();

      // The offer can be read again from the engine.
      const again = await t.command(['next']);
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toEqual(offer);
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      // Choosing the plan on the member's behalf stays refused, and the refusal
      // carries the question the engine holds, to be presented unchanged.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'next',
        '--scope',
        'poc',
        '--request',
        '6b26fb88',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });
      expect(forged.result.stderr).toContain(NOT_APPLIED);
      const lines = forged.result.stderr.split('\n');
      const held = lines.findIndex((line) => line.includes('{"version":3,"ask":<this object>}'));
      expect(JSON.parse(lines[held + 1])).toEqual(offer);
      expect(t.memberMessages()).toBe(spoken);

      // Presented unchanged, the offer is a question the engine records, and
      // the member's selection of it is applied.
      const asked = await t.publish(undefined, { spec: null, reason: 'absent' });
      const form = asked.body.pendingInput;
      expect(form.questions[0].prompt).toBe(offer.question);
      expect(asked.finalized.result.exitCode).toBe(0);
      expect(await t.proof(asked)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: picked.commandId, reason: 'no_recorded_question' }],
      });
      await t.admit(asked);
      await reply(t, asked, nativeAnswerText(form, selection), selection);
      const chosen = await t.command(['next']);
      expect(chosen.result.exitCode).toBe(0);
      expect(chosen.result.stderr).toBe('');
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'next',
        '--scope',
        'poc',
        '--request',
        '6b26fb88',
      ]);
      expect(t.memberMessages()).toBe(spoken + 1);
      expect((await t.proof(await t.publish())).engineApplication).toMatchObject([
        { application: 'applied', effect: 'PLAN_PROPOSAL_APPLIED' },
      ]);
    } finally {
      await t.close();
    }
  });

  it('keeps refusing a reply whose record does not match the turn it is delivered to', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      // The stored reply no longer has the words the member's digest names.
      t.hooks.response = (value) => ({ ...value, text: 'Approve everything' });
      const refused = await t.command(['next']);
      expect(refused.result).toMatchObject({
        exitCode: 1,
        failure: 'NATIVE_ENGINE_DECISION_MISMATCH',
        stderr: 'NATIVE_ENGINE_DECISION_MISMATCH\n',
      });
      // Nor is it recorded as a reply that merely decided nothing.
      expect((await t.proof(await t.publish())).unappliedReplies).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('keeps the confirmed plan picker answerable once after recovering its saved finalization', async () => {
    const t = await setup();
    t.hooks.orchestrate = (args) =>
      args[0] === 'next' && !args.includes('--scope') ? capturedPlanAsk : null;
    await t.command([]);
    const mirror = await t.send(await t.request('mirror'));
    const form = mirror.result.pendingInput;
    expect(form.questions[0].prompt).toBe(capturedPlanAsk.question);
    const shown = await t.f.turn(1, {
      files: [...t.project].map(([path, content]) => ({
        path,
        content,
        role: path.startsWith('aidlc/') ? 'artifact' : 'code',
      })),
      pendingInput: form,
    });
    const request = await t.request('finalize', {
      publication: shown.receipt,
      interaction: shown.interactionReceipt,
    });
    interruptFinish(t, request);
    await expect(t.send(request)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(await t.proof(shown)).toBeNull();
    t.f.hooks.before = null;
    const recovered = await t.send(request);
    expect(recovered.result.presentedInteractionId).toBe(shown.interactionReceipt.id);
    expect(await t.send(request)).toEqual(recovered);
    await t.admit(shown);
    const selection = { answers: [{ selectedOptions: [0] }] };
    const member = await reply(t, shown, nativeAnswerText(form, selection), selection);
    const spoken = t.memberMessages();
    for (const args of [
      ['engine', 'adapter', 'codex', 'record-human-turn'],
      ['next', '--scope', 'feature', '--request', 'abcd1234'],
    ])
      expect((await t.command(args)).result.failure).toBe('NATIVE_ENGINE_COMMAND_DENIED');
    await t.command(['engine', 'state', 'get']);
    expect(t.memberMessages()).toBe(spoken);
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    expect(t.memberMessages()).toBe(spoken + 1);
    expect((await t.proof(await t.publish())).engineApplication).toMatchObject([
      { commandId: member.commandId, application: 'applied', effect: 'PLAN_PROPOSAL_APPLIED' },
    ]);
  });

  it('refuses an altered plan selection before recording the member or running a command', async () => {
    const t = await setup();
    t.hooks.orchestrate = () => capturedPlanAsk;
    await t.command([]);
    const shown = await t.publish(undefined, { spec: capturedPlanFormSpec });
    await t.admit(shown);
    const selection = { answers: [{ selectedOptions: [0] }] };
    await reply(t, shown, nativeAnswerText(shown.body.pendingInput, selection), selection);
    t.hooks.response = (value) => ({
      ...value,
      selection: { answers: [{ selectedOptions: [2] }] },
    });
    const messages = t.memberMessages();
    const commands = t.calls.length;
    const refused = await t.command(['next']);
    expect(refused.result.failure).toBe('NATIVE_ENGINE_COMMAND_DENIED');
    expect(t.memberMessages()).toBe(messages);
    expect(t.calls).toHaveLength(commands);
  });

  it('does not register the picker in the partial snapshot when saving its evidence fails', async () => {
    const t = await setup();
    t.hooks.orchestrate = () => capturedPlanAsk;
    await t.command([]);
    const write = t.objects.write;
    const store = vi.spyOn(t.objects, 'write').mockImplementation((...args) => {
      if (args[2] === 'evidence') throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
      return write(...args);
    });
    const shown = await t.publish(undefined, { spec: capturedPlanFormSpec });
    store.mockRestore();
    expect(shown.finalized.result.exitCode).toBe(1);
    // Even if an older runtime admitted the rejected candidate, its answer
    // cannot be consumed as a member decision.
    await t.admit(shown);
    const selection = { answers: [{ selectedOptions: [0] }] };
    await reply(t, shown, nativeAnswerText(shown.body.pendingInput, selection), selection);
    const before = t.memberMessages();
    expect((await t.command(['next'])).result.stderr).toContain(NOT_APPLIED);
    expect(t.memberMessages()).toBe(before);
  });

  it('refuses callers outside the current binding, writer and membership before any journal write', async () => {
    const t = await setup();
    try {
      const body = await t.request('execute', { args: [] });
      const denied = async (work) =>
        expect(work).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      await denied(t.handler(body, await t.context({ invokedFunctionArn: t.pin.functionArn })));
      await denied(
        t.handler(
          body,
          await t.context({ invokedFunctionArn: `${t.pin.functionArn}:native_${'0'.repeat(32)}` }),
        ),
      );
      await denied(t.handler(body, await t.context({ functionVersion: '8' })));
      for (const key of ['writerGeneration', 'sequence', 'epoch'])
        await denied(
          t.handler(
            { ...body, identity: { ...body.identity, [key]: body.identity[key] + 1 } },
            await t.context(),
          ),
        );
      await denied(
        t.handler(
          { ...body, identity: { ...body.identity, bindingId: randomUUID() } },
          await t.context(),
        ),
      );
      t.access.allowed = false;
      await denied(t.handler(body, await t.context()));
      t.access.allowed = true;
      expect(t.calls).toHaveLength(0);
      expect(
        await t.journal.get({
          ...body.identity,
          configurationSha256: (await t.row()).configurationSha256,
        }),
      ).toBeNull();
      // Membership lost during the operation leaves it unfinished and unproven.
      t.hooks.tool = () => {
        t.access.allowed = false;
      };
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      t.access.allowed = true;
      t.hooks.tool = null;
      expect(
        await t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).toEqual({ ok: true, version: 0, pending: body.requestId });
    } finally {
      await t.close();
    }
  });

  it('never lets a stale writer or an uncertain job record a verified outcome', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      // The previous turn's identity is no longer admitted after the reply.
      const previous = { ...(await t.identity()), sequence: 1 };
      await expect(
        t.handler({ schemaVersion: 1, identity: previous, action: 'status' }, await t.context()),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      // An isolated job with an unknown outcome is never retried or passed.
      t.jobs.check = async () => {
        throw engineFailure('NATIVE_ENGINE_JOB_UNCERTAIN');
      };
      const uncertain = await t.request('execute', {
        args: ['engine', 'sensor', 'fire', '--stage', 'build'],
      });
      await expect(t.send(uncertain)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_JOB_UNCERTAIN',
      });
      expect(await t.send(uncertain)).toMatchObject({
        response: { ok: true, status: 'pending', requestId: uncertain.requestId },
      });
      await expect(t.request('execute', { args: ['next'] })).resolves.toMatchObject({
        expectedVersion: expect.any(Number),
      });
      await expect(t.send(await t.request('execute', { args: ['next'] }))).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_BUSY',
      });
      // A publication made while the journal is unfinished has no proof.
      const produced = await t.f.turn(2, {
        files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
      });
      await expect(
        t.send(
          await t.request('finalize', {
            publication: produced.receipt,
            interaction: produced.interactionReceipt,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      expect(await t.proof(produced)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('drops an operation whose execution is cancelled before its commit', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      const turn = await t.row();
      t.hooks.tool = async () => {
        await t.execution.cancel(t.f.bindingIdentity);
      };
      const body = await t.request('execute', { args: ['next'] });
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
      t.hooks.tool = null;
      // The scripted engine reached its terminal event, yet nothing was committed.
      await expect(
        t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      const journalRows = [...t.f.rows.values()].filter((item) => item.sk.startsWith('ENGINE#'));
      expect(journalRows.find((item) => item.requestId === body.requestId)).toMatchObject({
        status: 'running',
      });
      expect(journalRows.filter((item) => item.sk.includes('#PUBLICATION#'))).toHaveLength(1);
      // The gate publication admitted before cancellation keeps its own proof.
      expect(await t.proof(opened, turn)).toMatchObject({ workflowCompletion: 'not_verified' });
    } finally {
      await t.close();
    }
  });
});

it('keeps a proposed tool check under the admitted turn without installing its speculative state', async () => {
  const t = await setup();
  await t.command([]);
  const owner = nativeEngineIdentity(await t.row());
  const snapshot = async () => t.objects.read(owner, (await t.journal.get(owner)).snapshot);
  const before = await snapshot();
  const guard = { tool: 'Write', path: 'src/test.js', content: 'proposed' };
  t.hooks.guard = vi.fn((state, submitted) => {
    expect(submitted.guard).toEqual(guard);
    state.engine.messages++;
  });
  const body = await t.request('guard', { guard });
  await expect(
    t.send({
      ...body,
      identity: { ...body.identity, writerGeneration: body.identity.writerGeneration + 1 },
    }),
  ).rejects.toHaveProperty('code', 'NATIVE_ENGINE_FORBIDDEN');
  t.access.allowed = false;
  await expect(t.send(body)).rejects.toHaveProperty('code', 'NATIVE_ENGINE_FORBIDDEN');
  t.access.allowed = true;
  const checked = await t.send(body);
  expect(checked.result).toMatchObject({ exitCode: 0, patches: [], stdout: '', stderr: '' });
  expect(await snapshot()).toEqual(before);
  expect(await t.send(body)).toEqual(checked);
  expect(t.hooks.guard).toHaveBeenCalledOnce();
});
