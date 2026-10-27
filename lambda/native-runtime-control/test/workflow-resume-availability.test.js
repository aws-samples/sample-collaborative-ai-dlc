import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { nativeExecutionView } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { nativeWriterGeneration } from '../execution-store.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../../shared/native-recovery-mode.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { memoryNativeObjects } from './memory-objects.js';

// Real conditional authority, fence and immutable history codecs. Only runtime
// observation and AWS transport are substituted; filesystem observation is
// exercised by the real-executor workspace-resume journey.
const fixture = async (workflowResumeState) => {
  const f = serialFixture({
    harness: 'claude',
    recoveryMode: NATIVE_WORKSPACE_RECOVERY,
    packageVersion: '2.11.1',
  });
  await f.ready();
  const publication = await f.publish({
    text: 'Choose a plan before creating the workflow: express or feature?',
    files: [{ path: 'aidlc/active-space', role: 'state', content: Buffer.from('default\n') }],
  });
  const accepted = await f.respond(
    f.replyRequest({ text: 'Hold implementation and ask before choosing a plan.' }),
  );
  const original = f.row();
  const storage = {
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  };
  const memory = memoryNativeObjects(storage);
  const fence = { ...createNativeExecutionFence({ ...storage, s3: memory.s3 }) };
  await fence.ensureActive(executionIdentity(original), { writerGeneration: 1 });
  const suspend = vi.spyOn(fence, 'suspend');
  const activate = vi.spyOn(fence, 'activate');
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    authorize: vi.fn(async () => {}),
    credentials: vi.fn(async (row) => ({
      ok: true,
      ...executionIdentity(row),
      model: { provider: 'bedrock', value: 'fixture-model-token' },
      git: { username: 'fixture', password: 'fixture-git' },
      source: { branch: row.sourceBranch, commit: row.sourceCommit },
    })),
    fence,
    invoke: vi.fn(async ({ execution }) => ({
      ...executionIdentity(execution),
      writerGeneration: nativeWriterGeneration(execution),
      status: 'publication_ready',
      recovered: true,
      sequence: publication.receipt.sequence,
      nativeSessionId: publication.receipt.nativeSessionId,
      receipt: publication.receipt,
      interaction: publication.interactionReceipt,
      ...(workflowResumeState === undefined ? {} : { workflowResumeState }),
    })),
    stop: vi.fn(async ({ execution }) => {
      const stoppedFence = await fence.read(executionIdentity(execution));
      expect(['FENCED', 'CANCELLED']).toContain(stoppedFence.state);
      expect(stoppedFence.writerGeneration).toBe(nativeWriterGeneration(execution));
      return { confirmed: true, runtimeSessionId: execution.runtimeSessionId };
    }),
  };
  return {
    ...f,
    accepted,
    original,
    publication,
    ports,
    suspend,
    activate,
    reconcile: createNativeExecutionSupervisor(ports),
    recover: () =>
      f.api.recover(
        f.prepared,
        {
          requestId: randomUUID(),
          recoveryId: f.row().recovery.id,
          confirmWorkspaceResume: true,
        },
        f.recheck,
      ),
  };
};

describe('created-workflow recovery availability', () => {
  it.each([
    ['not_created', 'INTAKE_UNAVAILABLE'],
    ['unavailable', 'WORKFLOW_STATE_UNAVAILABLE'],
    [undefined, 'WORKFLOW_STATE_UNAVAILABLE'],
    ['unrecognized', 'WORKFLOW_STATE_UNAVAILABLE'],
  ])('stops and preserves intake history without resuming state %s', async (state, reason) => {
    const f = await fixture(state);
    expect(await f.reconcile(f.identity)).toEqual({
      pending: false,
      status: 'RECOVERY_REQUIRED',
      reason,
    });
    const row = f.row();
    expect(row).toMatchObject({
      attemptId: f.original.attemptId,
      epoch: f.original.epoch,
      writerGeneration: 1,
      configuration: f.original.configuration,
      publication: f.original.publication,
      response: f.original.response,
      recovery: {
        reason,
        canRecover: false,
        workflowResumeState: state === 'not_created' ? 'not_created' : 'unavailable',
      },
      stopConfirmation: { writerGeneration: 1, runtimeSessionId: f.original.runtimeSessionId },
    });
    expect(await f.store.response(row, f.accepted.response.interactionId)).toEqual(
      f.accepted.response,
    );
    const history = await f.api.interaction(f.prepared, f.recheck);
    expect(history.response).toMatchObject({
      id: f.accepted.response.commandId,
      text: f.accepted.response.text,
      actorId: f.accepted.response.actorId,
      acceptedAt: new Date(f.accepted.response.acceptedAt).toISOString(),
    });
    expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
      'native-status',
    ]);
    expect(f.suspend).toHaveBeenCalledOnce();
    expect(f.ports.stop).toHaveBeenCalledOnce();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
    await expect(f.recover()).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    expect(f.row()).toEqual(row);
    expect(nativeExecutionView(row).recovery).toMatchObject({ reason, canRecover: false });
  });

  it('can resume a currently created workflow even when its last publication was an intake offer', async () => {
    const f = await fixture('created');
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'SESSION_LOST',
    });
    expect(nativeExecutionView(f.row()).recovery).toMatchObject({
      canRecover: true,
      workflowResumeState: 'created',
    });
    expect((await f.recover()).execution.status).toBe('RECOVERING');
    expect(f.row().response).toBeUndefined();
    expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toMatchObject(
      f.accepted.response,
    );
    expect(f.ports.invoke).toHaveBeenCalledOnce();
    expect(f.ports.credentials).not.toHaveBeenCalled();
  });

  it.each(['writerGeneration', 'attemptId', 'runtimeSessionId'])(
    'never grants recovery from a status with a foreign %s',
    async (field) => {
      const f = await fixture('created');
      const originalInvoke = f.ports.invoke.getMockImplementation();
      f.ports.invoke.mockImplementation(async (input) => ({
        ...(await originalInvoke(input)),
        [field]: field === 'writerGeneration' ? 2 : randomUUID(),
      }));
      await f.reconcile(f.identity);
      expect(f.row().recovery?.canRecover).not.toBe(true);
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toEqual(
        f.accepted.response,
      );
    },
  );

  it('keeps an old EFS recovery record readable but rejects its unproven canRecover bit', async () => {
    const f = await fixture('created');
    await f.reconcile(f.identity);
    const row = f.row();
    const stored = [...f.rows.values()].find((item) => item.pk === row.pk && item.sk === row.sk);
    delete stored.recovery.workflowResumeState;
    expect(stored.recovery.canRecover).toBe(true);
    const retained = await f.store.get(f.identity);
    expect(nativeExecutionView(retained).recovery).toMatchObject({
      reason: 'WORKFLOW_STATE_UNAVAILABLE',
      canRecover: false,
    });
    await expect(f.recover()).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    expect(f.row()).toEqual(retained);
    expect(await f.store.response(retained, f.accepted.response.interactionId)).toEqual(
      f.accepted.response,
    );
  });

  it.each(['FENCING', 'RESTORING'])(
    'closes a retained %s recovery without creation proof before admitting a writer',
    async (phase) => {
      const f = await fixture('created');
      await f.reconcile(f.identity);
      await f.recover();
      if (phase === 'RESTORING') await f.reconcile(f.identity);
      const row = f.row();
      const stored = [...f.rows.values()].find((item) => item.pk === row.pk && item.sk === row.sk);
      delete stored.recovery.workflowResumeState;
      expect((await f.store.get(f.identity)).recovery.phase).toBe(phase);
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'WORKFLOW_STATE_UNAVAILABLE',
      });
      expect(f.row().recovery).toMatchObject({
        canRecover: false,
        workflowResumeState: 'unavailable',
      });
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
        'native-status',
      ]);
      expect(await f.ports.fence.read(executionIdentity(f.row()))).toMatchObject({
        state: 'FENCED',
        writerGeneration: 1,
        workflowResumeState: 'unavailable',
      });
      expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toMatchObject(
        f.accepted.response,
      );
      expect(f.row().workspaceResume).toEqual(
        phase === 'FENCING' ? undefined : row.workspaceResume,
      );
      const history = await f.store.historicalAnswer(f.row(), {
        identity: executionIdentity(f.original),
        runtimeSessionId: f.original.runtimeSessionId,
        receipt: f.original.publication,
        interaction: f.original.interaction,
        interactionContentSha256: f.original.interactionContentSha256,
      });
      expect(history.response).toMatchObject(f.accepted.response);
      expect(history.retained.delivery).toBe('undelivered');
      expect(history.publication).toBeNull();
    },
  );

  it('retains exact fenced creation proof across a lost stop acknowledgement without starting another runtime', async () => {
    const f = await fixture('created');
    f.ports.stop.mockRejectedValueOnce(
      Object.assign(new Error('Stop completed but its acknowledgement was lost'), {
        code: 'ECONNRESET',
      }),
    );
    expect(await f.reconcile(f.identity)).toMatchObject({ pending: true });
    const fence = await f.ports.fence.read(executionIdentity(f.row()));
    expect(fence).toMatchObject({
      state: 'FENCED',
      writerGeneration: 1,
      reason: 'SESSION_LOST',
      workflowResumeState: 'created',
    });
    expect(f.row().recovery).toBeUndefined();
    expect(await f.reconcile(f.identity)).toEqual({
      pending: false,
      status: 'RECOVERY_REQUIRED',
      reason: 'SESSION_LOST',
    });
    expect(f.row().recovery).toMatchObject({
      id: fence.recoveryId,
      canRecover: true,
      workflowResumeState: 'created',
    });
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
    expect(f.ports.stop.mock.calls.map(([input]) => input.recoveryId)).toEqual([
      fence.recoveryId,
      fence.recoveryId,
    ]);
    expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
      'native-status',
    ]);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
  });

  it.each([
    ['complete', {}],
    ['missing proof', { workflowResumeState: undefined }],
    ['invalid proof', { workflowResumeState: 'unknown' }],
    ['foreign episode', { recoveryId: '55555555-5555-4555-8555-555555555555' }],
    ['foreign writer', { writerGeneration: 3 }],
    ['accepted acknowledgement', { accepted: true }],
    ['missing duplicate denial', { duplicate: undefined }],
    ['different runtime code', { code: 'native_execution_owner_conflict' }],
    ['different status', { status: 'failed' }],
  ])('uses only an exact denied cold-resume observation: %s', async (kind, patch) => {
    const f = await fixture('created');
    await f.reconcile(f.identity);
    await f.recover();
    await f.reconcile(f.identity);
    f.ports.invoke.mockImplementationOnce(async ({ execution, payload }) => ({
      ...executionIdentity(execution),
      writerGeneration: nativeWriterGeneration(execution),
      status: 'stopped_needs_review',
      code: 'native_execution_existing_owner',
      accepted: false,
      duplicate: true,
      recoveryId: payload.recoveryId,
      workflowResumeState: 'created',
      ...patch,
    }));
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: kind === 'complete' ? 'RESTORE_FAILED' : 'WORKFLOW_STATE_UNAVAILABLE',
    });
    expect(f.row().recovery).toMatchObject({
      canRecover: kind === 'complete',
      workflowResumeState: kind === 'complete' ? 'created' : 'unavailable',
    });
    expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
      'native-status',
      'native-resume',
    ]);
    expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toMatchObject(
      f.accepted.response,
    );
  });

  it.each([
    ['native_execution_workflow_not_created', 'INTAKE_UNAVAILABLE', 'not_created'],
    ['native_execution_workflow_state_unavailable', 'WORKFLOW_STATE_UNAVAILABLE', 'unavailable'],
  ])(
    'records runtime admission denial %s without starting or replaying a turn',
    async (code, reason, state) => {
      const f = await fixture('created');
      await f.reconcile(f.identity);
      await f.recover();
      await f.reconcile(f.identity);
      f.ports.invoke.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason,
      });
      expect(f.row()).toMatchObject({
        writerGeneration: 2,
        recovery: { reason, canRecover: false, workflowResumeState: state },
        stopConfirmation: { writerGeneration: 2 },
      });
      expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
        'native-status',
        'native-resume',
      ]);
      expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toMatchObject(
        f.accepted.response,
      );
    },
  );

  it.each([
    ['native_execution_workflow_not_created', 'INTAKE_UNAVAILABLE', 'not_created'],
    ['native_execution_workflow_state_unavailable', 'WORKFLOW_STATE_UNAVAILABLE', 'unavailable'],
  ])(
    'records pre-spawn failure %s after acknowledgement as unavailable recovery',
    async (code, reason, state) => {
      const f = await fixture('created');
      await f.reconcile(f.identity);
      await f.recover();
      await f.reconcile(f.identity);
      f.ports.invoke.mockImplementationOnce(async ({ execution, payload }) => ({
        ...executionIdentity(execution),
        writerGeneration: nativeWriterGeneration(execution),
        status: 'preparing',
        sequence: payload.sequence,
        recoveryId: payload.recoveryId,
        requestId: payload.recoveryId,
      }));
      await f.reconcile(f.identity);
      expect(f.row().status).toBe('RUNNING');
      f.ports.invoke.mockImplementationOnce(async ({ execution }) => ({
        ...executionIdentity(execution),
        writerGeneration: nativeWriterGeneration(execution),
        status: 'failed',
        code,
        sequence: execution.turnSequence,
        workflowResumeState: state,
      }));
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason,
      });
      expect(f.row().recovery).toMatchObject({
        reason,
        canRecover: false,
        workflowResumeState: state,
      });
      expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
        'native-status',
        'native-resume',
        'native-status',
      ]);
      expect(await f.store.response(f.row(), f.accepted.response.interactionId)).toMatchObject(
        f.accepted.response,
      );
    },
  );
});
