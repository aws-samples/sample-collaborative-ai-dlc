import { describe, expect, it, vi } from 'vitest';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';

const COMMIT = 'e'.repeat(40);
const make = async () => {
  const f = executionFixture();
  await f.start();
  let fenced = false;
  const publication = {
    id: 'a'.repeat(64),
    sequence: 1,
    manifest: {
      key: 'native-executions/v1/manifest.json',
      versionId: 'immutable',
      sha256: 'a'.repeat(64),
      bytes: 1000,
    },
    outcome: 'WAITING_FOR_INPUT',
    nativeSessionId: 'native-session',
    question: { path: 'aidlc/questions.md', sha256: 'c'.repeat(64) },
    filesCount: 1,
  };
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    fence: {
      ensureActive: vi.fn(async () => {
        if (fenced)
          throw Object.assign(new Error('closed'), { code: 'NATIVE_EXECUTION_CANCELLED' });
        return { state: 'ACTIVE' };
      }),
      cancel: vi.fn(async () => {
        fenced = true;
        return { state: 'CANCELLED' };
      }),
      suspend: vi.fn(async () => {
        fenced = true;
        return { state: 'FENCED' };
      }),
    },
    upgrade: vi.fn(async ({ execution }) => ({ ready: true, target: f.target(execution) })),
    authorize: vi.fn(async () => {}),
    credentials: vi.fn(async (row) => ({
      ok: true,
      ...executionIdentity(row),
      model: { provider: 'bedrock', value: 'private-model-value' },
      git: { username: 'test', password: 'private-git-value' },
      source: { commit: COMMIT, branch: 'develop' },
    })),
    invoke: vi.fn(async ({ execution, payload }) => ({
      ...executionIdentity(execution),
      writerGeneration: 1,
      sequence: 1,
      status: payload.command === 'native-start' ? 'preparing' : 'publication_ready',
      ...(payload.command === 'native-status' ? { receipt: publication } : {}),
    })),
    stop: vi.fn(async ({ execution }) => ({
      confirmed: true,
      runtimeSessionId: execution.runtimeSessionId,
    })),
    publications: {
      read: vi.fn(async () => ({
        packageId: f.configuration.packageId,
        repository: { commit: COMMIT, branch: 'develop' },
      })),
    },
    project: vi.fn(async () => {}),
  };
  const reconcile = createNativeExecutionSupervisor(ports);
  const dispatch = async () => {
    for (let n = 0; n < 4; n++) await reconcile(f.identity);
  };
  return { ...f, ports, reconcile, dispatch, publication };
};

describe('connected native supervisor', () => {
  it('upgrades, pins commit before dispatch, starts once, verifies files then commits and projects', async () => {
    const f = await make();
    await f.dispatch();
    expect(f.row().status).toBe('RUNNING');
    expect(f.ports.invoke).toHaveBeenCalledTimes(1);
    const payload = f.ports.invoke.mock.calls[0][0].payload;
    expect(payload.command).toBe('native-start');
    expect(payload.configuration.prompt).toBe(f.prepared.request.prompt);
    expect(payload.configuration.repository).toMatchObject({ branch: 'develop', commit: COMMIT });
    expect(payload.package.archiveReceipt).toEqual(f.prepared.archiveReceipt);
    expect(JSON.stringify(f.row())).not.toContain('private-model-value');
    expect(JSON.stringify(f.row())).not.toContain('private-git-value');
    await f.reconcile(f.identity);
    expect(f.ports.publications.read).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 1 }),
      f.publication,
      { verifyFiles: true },
    );
    expect(f.row()).toMatchObject({
      status: 'WAITING_FOR_INPUT',
      publication: f.publication,
      publicationEpoch: 1,
      projectionStatus: 'pending',
    });
    expect(f.ports.project).not.toHaveBeenCalled();
    await f.reconcile(f.identity);
    expect(f.row().projectionStatus).toBe('pending');
    await f.reconcile(f.identity);
    expect(f.ports.project).not.toHaveBeenCalled();
    expect(
      f.ports.invoke.mock.calls.filter(([v]) => v.payload.command === 'native-start'),
    ).toHaveLength(1);
  });

  it('does not issue a second attempt or invoke while another controller owns the lease', async () => {
    const f = await make();
    const owner = await f.store.claim(f.bindingIdentity);
    expect(owner.kind).toBe('claimed');
    expect(await f.reconcile(f.identity)).toMatchObject({ pending: true, status: 'busy' });
    expect(f.ports.invoke).not.toHaveBeenCalled();
    f.tick();
    await f.reconcile(f.identity);
    expect(f.row().attemptId).toBe(owner.row.attemptId);
    expect(f.row().runtimeSessionId).toBe(owner.row.runtimeSessionId);
  });

  it('reconciles an uncertain invocation by status without resending the model command', async () => {
    const f = await make();
    for (let n = 0; n < 3; n++) await f.reconcile(f.identity);
    f.ports.invoke.mockRejectedValueOnce(new Error('connection lost after write'));
    await expect(f.reconcile(f.identity)).rejects.toThrow();
    const first = f.ports.invoke.mock.calls[0][0].payload;
    f.tick();
    await f.reconcile(f.identity);
    const second = f.ports.invoke.mock.calls[1][0].payload;
    expect(second).toEqual({
      command: 'native-status',
      ...executionIdentity(f.row()),
      writerGeneration: 1,
    });
    expect(second.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(
      f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-start'),
    ).toHaveLength(1);
    expect(f.row().status).toBe('RUNNING');
  });

  it('fences publication immediately when cancellation races file verification', async () => {
    const f = await make();
    await f.dispatch();
    f.ports.publications.read.mockImplementationOnce(async () => {
      await f.store.cancel(f.bindingIdentity);
      return {
        packageId: f.configuration.packageId,
        repository: { commit: COMMIT, branch: 'develop' },
      };
    });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_LEASE_LOST',
    });
    expect(f.row()).toMatchObject({ status: 'CANCEL_REQUESTED', epoch: 2 });
    expect(f.row().publication).toBeUndefined();
    await f.reconcile(f.identity);
    expect(f.row().status).toBe('CANCELLED');
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
  });

  it('does not make a question visible when exact byte verification fails', async () => {
    const f = await make();
    await f.dispatch();
    f.ports.publications.read.mockRejectedValueOnce(
      Object.assign(new Error('corrupt'), { code: 'NATIVE_PUBLICATION_INVALID' }),
    );
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_publication_invalid',
    });
    expect(f.row().publication).toBeUndefined();
    expect(f.ports.project).not.toHaveBeenCalled();
    expect(f.ports.stop).toHaveBeenCalled();
  });

  it('leaves committed projection to its independent worker', async () => {
    const f = await make();
    await f.dispatch();
    await f.reconcile(f.identity);
    f.ports.project.mockRejectedValueOnce(new Error('graph temporarily unavailable'));
    await expect(f.reconcile(f.identity)).resolves.toMatchObject({ pending: false });
    expect(f.row()).toMatchObject({ publication: f.publication, projectionStatus: 'pending' });
    f.tick();
    await f.reconcile(f.identity);
    expect(f.row().projectionStatus).toBe('pending');
    expect(
      f.ports.invoke.mock.calls.filter(([v]) => v.payload.command === 'native-start'),
    ).toHaveLength(1);
  });

  it('keeps polling a busy model without changing attempt, credentials or imposing a turn deadline', async () => {
    const f = await make();
    await f.dispatch();
    const original = f.row();
    f.ports.invoke.mockImplementation(async ({ execution }) => ({
      ...executionIdentity(execution),
      writerGeneration: 1,
      sequence: 1,
      status: 'running',
    }));
    for (let n = 0; n < 10; n++) {
      f.tick(3600000);
      await f.reconcile(f.identity);
    }
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      attemptId: original.attemptId,
      runtimeSessionId: original.runtimeSessionId,
      epoch: 1,
    });
    expect(f.ports.credentials).toHaveBeenCalledTimes(2);
    expect(f.ports.stop).not.toHaveBeenCalled();
  });

  it('does not deliver credentials when the private facade returns another attempt', async () => {
    const f = await make();
    for (let n = 0; n < 2; n++) await f.reconcile(f.identity);
    f.ports.credentials.mockImplementationOnce(async (row) => ({
      ok: true,
      ...executionIdentity(row),
      attemptId: 'another-attempt',
      model: { provider: 'bedrock', value: 'private' },
      git: { username: 'git', password: 'private' },
      source: { commit: COMMIT, branch: 'develop' },
    }));
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_runtime_mismatch',
    });
    expect(f.ports.invoke).not.toHaveBeenCalled();
  });

  it('retains a retryable attempt when credential retrieval is temporarily unavailable', async () => {
    const f = await make();
    for (let n = 0; n < 2; n++) await f.reconcile(f.identity);
    f.ports.credentials.mockResolvedValueOnce({
      ok: false,
      code: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
    });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
    });
    expect(f.row().status).toBe('UPGRADING');
    expect(f.ports.invoke).not.toHaveBeenCalled();
  });

  it('checks lease expiry before delivery, even without a competing worker', async () => {
    const f = await make();
    for (let n = 0; n < 3; n++) await f.reconcile(f.identity);
    const original = f.ports.credentials.getMockImplementation();
    f.ports.credentials.mockImplementationOnce(async (row) => {
      const value = await original(row);
      f.tick();
      return value;
    });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_LEASE_LOST',
    });
    expect(f.ports.invoke).not.toHaveBeenCalled();
  });

  it('fences and stops a dispatch whose acknowledgement arrives after cancellation completed', async () => {
    const f = await make();
    for (let n = 0; n < 3; n++) await f.reconcile(f.identity);
    f.ports.invoke.mockImplementationOnce(async ({ execution }) => {
      await f.store.cancel(f.bindingIdentity);
      await f.reconcile(f.identity);
      expect(f.row().status).toBe('CANCELLED');
      expect(f.ports.fence.cancel).toHaveBeenCalled();
      return {
        ...executionIdentity(execution),
        writerGeneration: 1,
        sequence: 1,
        status: 'preparing',
      };
    });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_LEASE_LOST',
    });
    expect(f.ports.fence.cancel).toHaveBeenCalledTimes(2);
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
    expect(f.row()).toMatchObject({ status: 'CANCELLED', epoch: 2 });
  });

  it('finishes interrupted failure cleanup without reopening a closed dispatch fence', async () => {
    const f = await make();
    await f.dispatch();
    f.ports.publications.read.mockRejectedValue(
      Object.assign(new Error('corrupt publication'), { code: 'NATIVE_PUBLICATION_INVALID' }),
    );
    f.ports.stop.mockRejectedValueOnce(new Error('temporary stop failure'));
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
    expect(f.row().status).toBe('RUNNING');
    f.tick();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_publication_invalid',
    });
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
    expect(
      f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-start'),
    ).toHaveLength(1);
  });

  it('releases an uncertain transport attempt for a short retry without starting another session', async () => {
    const f = await make();
    for (let n = 0; n < 3; n++) await f.reconcile(f.identity);
    f.ports.invoke.mockRejectedValueOnce(
      Object.assign(new Error('SDK transport timeout'), { name: 'TimeoutError' }),
    );
    const before = f.row();
    expect(await f.reconcile(f.identity)).toMatchObject({ pending: true, status: 'DISPATCHING' });
    expect(f.row().leaseToken).toBeUndefined();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      attemptId: before.attemptId,
      runtimeSessionId: before.runtimeSessionId,
    });
    expect(f.ports.invoke.mock.calls[1][0].payload.command).toBe('native-status');
    expect(
      f.ports.invoke.mock.calls.filter(([call]) => call.payload.command === 'native-start'),
    ).toHaveLength(1);
  });
});

describe('administrator image revocation in the supervisor', () => {
  const revokedPolicy = (revoked) => ({
    revocation: vi.fn(async (digest) => (revoked.has(digest) ? { digest } : null)),
  });

  it('fences, stops and fails an active run whose pinned image was revoked', async () => {
    const f = await make();
    const revoked = new Set();
    const reconcile = createNativeExecutionSupervisor({
      ...f.ports,
      imagePolicy: revokedPolicy(revoked),
    });
    for (let n = 0; n < 4; n++) await reconcile(f.identity);
    expect(f.row().status).toBe('RUNNING');
    revoked.add(f.row().configuration.image.digest);
    const invocations = f.ports.invoke.mock.calls.length;
    expect(await reconcile(f.identity)).toEqual({
      pending: false,
      status: 'FAILED',
      failureCode: 'native_execution_image_revoked',
    });
    expect(f.ports.fence.cancel).toHaveBeenCalledTimes(1);
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
    // No status read, dispatch or recovery step runs after the revocation.
    expect(f.ports.invoke.mock.calls.length).toBe(invocations);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_image_revoked',
    });
  });

  it('blocks the first dispatch when the pin is revoked before credentials are requested', async () => {
    const f = await make();
    const revoked = new Set([f.row().configuration.image.digest]);
    const reconcile = createNativeExecutionSupervisor({
      ...f.ports,
      imagePolicy: revokedPolicy(revoked),
    });
    await reconcile(f.identity);
    expect(f.row().failureCode).toBe('native_execution_image_revoked');
    expect(f.ports.credentials).not.toHaveBeenCalled();
    expect(f.ports.invoke).not.toHaveBeenCalled();
  });

  it('fails a dispatch whose credential renewal reports an image revocation', async () => {
    const f = await make();
    f.ports.credentials.mockResolvedValue({
      ok: false,
      code: 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED',
    });
    for (let n = 0; n < 3; n++) await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_image_revoked',
    });
    expect(f.ports.invoke).not.toHaveBeenCalled();
  });

  it('leaves committed results readable when a revoked image has pending projection', async () => {
    const f = await make();
    await f.dispatch();
    await f.reconcile(f.identity);
    expect(f.row().projectionStatus).toBe('pending');
    const reconcile = createNativeExecutionSupervisor({
      ...f.ports,
      imagePolicy: revokedPolicy(new Set([f.row().configuration.image.digest])),
    });
    await reconcile(f.identity);
    expect(f.row().projectionStatus).toBe('pending');
    expect(f.ports.project).not.toHaveBeenCalled();
  });
});

describe('native activity terminal drain', () => {
  it('drains more than four full batches across wakeups before admitting publication', async () => {
    const { createNativeActivityLog } = await import('../../agentcore/native/activity.js');
    const { createNativeActivityStore } = await import('../activity-store.js');
    const { TABLE } = await import('./fixtures.js');
    const f = await make();
    await f.dispatch();
    const log = createNativeActivityLog({ writerGeneration: 1, now: f.now });
    const turn = log.turn({ sequence: 1, harness: 'codex' });
    for (let n = 0; n < 325; n++)
      turn.write(
        Buffer.from(
          JSON.stringify({
            type: 'item.completed',
            item: { id: `m${n}`, type: 'agent_message', text: `Public message ${n}` },
          }) + '\n',
        ),
      );
    turn.close();
    const activity = createNativeActivityStore({ ddb: f.ddb, tableName: TABLE, now: f.now });
    const invoke = f.ports.invoke.getMockImplementation();
    f.ports.invoke.mockImplementation(async (input) =>
      input.payload.command === 'native-activity'
        ? { ...executionIdentity(input.execution), ...log.pull(input.payload.after) }
        : { ...(await invoke(input)), capabilities: ['activity-v1'] },
    );
    const reconcile = createNativeExecutionSupervisor({ ...f.ports, activity });
    await reconcile(f.identity);
    expect(f.row().status).toBe('RUNNING');
    expect(await activity.cursor(f.row())).toBe(256);
    expect(f.ports.publications.read).not.toHaveBeenCalled();
    await reconcile(f.identity);
    expect(await activity.cursor(f.row())).toBe(325);
    expect(log.pull(325)).toMatchObject({ events: [], complete: true });
    expect(f.row().status).toBe('WAITING_FOR_INPUT');
    expect(
      f.ports.invoke.mock.calls.filter(([input]) => input.payload.command === 'native-start'),
    ).toHaveLength(1);
  });

  it('waits for timer-held output and closure, then acknowledges it before publication', async () => {
    const { createNativeActivityLog } = await import('../../agentcore/native/activity.js');
    const f = await make();
    await f.dispatch();
    const log = createNativeActivityLog({ writerGeneration: 1 });
    const turn = log.turn({
      sequence: 1,
      harness: 'codex',
      forbiddenBytes: ['abcdefghijklmnopqrstuvwxyz0123456789'],
    });
    turn.write(
      Buffer.from(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Final output pending' },
        }) + '\n',
      ),
    );
    let durable = 0;
    const persisted = [];
    const activity = {
      cursor: vi.fn(async () => durable),
      ingest: vi.fn(async (_row, batch) => {
        persisted.push(...batch.events);
        durable = batch.events.at(-1)?.index ?? durable;
        return durable;
      }),
    };
    const invoke = f.ports.invoke.getMockImplementation();
    f.ports.invoke.mockImplementation(async (input) =>
      input.payload.command === 'native-activity'
        ? { ...executionIdentity(input.execution), ...log.pull(input.payload.after) }
        : { ...(await invoke(input)), capabilities: ['activity-v1'] },
    );
    const reconcile = createNativeExecutionSupervisor({ ...f.ports, activity });
    await reconcile(f.identity);
    expect(f.row().status).toBe('RUNNING');
    expect(f.ports.publications.read).not.toHaveBeenCalled();
    turn.close();
    await reconcile(f.identity);
    expect(persisted.map((r) => r.index)).toEqual([1]);
    expect(durable).toBe(1);
    expect(log.pull(1).events).toEqual([]);
    expect(f.row().status).toBe('WAITING_FOR_INPUT');
    expect(
      f.ports.invoke.mock.calls.filter(([input]) => input.payload.command === 'native-start'),
    ).toHaveLength(1);
  });

  it('retries activity transport without reissuing the model command', async () => {
    const f = await make();
    await f.dispatch();
    const invoke = f.ports.invoke.getMockImplementation();
    let failed = false;
    f.ports.invoke.mockImplementation(async (input) => {
      if (input.payload.command !== 'native-activity')
        return { ...(await invoke(input)), capabilities: ['activity-v1'] };
      if (!failed) {
        failed = true;
        throw Object.assign(new Error('transport'), { name: 'TimeoutError' });
      }
      return {
        ...executionIdentity(input.execution),
        writerGeneration: 1,
        after: 0,
        events: [],
        complete: true,
      };
    });
    const activity = { cursor: async () => 0, ingest: async () => 0 };
    const reconcile = createNativeExecutionSupervisor({ ...f.ports, activity });
    await reconcile(f.identity);
    expect(f.row().status).toBe('RUNNING');
    await reconcile(f.identity);
    expect(f.row().status).toBe('WAITING_FOR_INPUT');
    expect(
      f.ports.invoke.mock.calls.filter(([input]) => input.payload.command === 'native-start'),
    ).toHaveLength(1);
  });
});
