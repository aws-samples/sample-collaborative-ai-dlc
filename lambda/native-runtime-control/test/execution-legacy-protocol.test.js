import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeServer } from './fixtures/legacy-native/runtime-server.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { createNativeExecutionSupervisor, readNativeRuntimeReport } from '../execution-worker.js';
import { executionIdentity } from '../execution-runtime.js';

describe('pinned legacy native HTTP protocol', () => {
  it('uses the exact retained pre-generation HTTP server source', async () => {
    const source = await readFile(
      new URL('./fixtures/legacy-native/runtime-server.js', import.meta.url),
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'a257b863d8d9715317fb4584575bad474f49e21b3ee128d3b30a67a4fa605bf6',
    );
  });
  it.each([true, false])(
    'uses generation-less transport for a legacy row against the real old router (cold=%s)',
    async (cold) => {
      const f = serialFixture();
      // Seed the real protected-store fixture with the pre-generation schema.
      // Subsequent writes still use the current production store and CAS logic.
      f.hooks.before = async (command) => {
        for (const operation of command.input?.TransactItems ?? []) {
          const item = operation.Put?.Item;
          if (item?.sk === 'EXECUTION' && item.version === 1) delete item.writerGeneration;
        }
      };
      await f.ready();
      await f.publish();
      await f.respond();
      const original = f.row();
      expect(original.writerGeneration).toBeUndefined();
      const identity = executionIdentity(original);
      const env = {
        NATIVE_EXECUTION_ENABLED: 'true',
        NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
        NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
        NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
        NATIVE_EXECUTION_ATTEMPT_ID: identity.attemptId,
        NATIVE_EXECUTION_EPOCH: String(identity.epoch),
        NATIVE_EXECUTION_RUNTIME_SESSION_ID: identity.runtimeSessionId,
      };
      const executor = {
        isBusy: () => false,
        settle: async () => {},
        start: vi.fn(async () => {
          throw new Error('No new legacy Start');
        }),
        continue: vi.fn(async (payload) => ({
          ...identity,
          sequence: payload.sequence,
          requestId: payload.requestId,
          status: 'preparing',
        })),
        status: vi.fn(async () => ({
          ...identity,
          status: 'publication_ready',
          sequence: original.publication.sequence,
          nativeSessionId: original.publication.nativeSessionId,
          receipt: original.publication,
          interaction: original.interaction,
          ...(cold ? { recovered: true } : {}),
        })),
        cancel: vi.fn(async () => ({ ...identity, status: 'cancelling' })),
      };
      const server = createNativeRuntimeServer({
        env,
        checkWorkspace: async () => {},
        createExecutor: async () => executor,
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = `http://127.0.0.1:${server.address().port}/invocations`;
      const request = (payload) =>
        fetch(address, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      try {
        // This is the actual compatibility failure, not a reimplemented parser.
        for (const command of ['native-status', 'native-cancel']) {
          const rejected = await request({ command, ...identity, writerGeneration: 1 });
          expect(rejected.status).toBe(400);
          expect(await rejected.json()).toMatchObject({ code: 'native_execution_request_invalid' });
        }
        const invoke = vi.fn(async ({ payload }) => {
          const response = await request(payload);
          return readNativeRuntimeReport({
            statusCode: response.status,
            contentType: response.headers.get('content-type'),
            response: Readable.from([Buffer.from(await response.arrayBuffer())]),
          });
        });
        const stop = vi.fn(async () => ({
          confirmed: true,
          runtimeSessionId: identity.runtimeSessionId,
        }));
        const reconcile = createNativeExecutionSupervisor({
          store: f.store,
          preparationStore: f.preparationStore,
          now: f.now,
          publications: f.publications,
          interactions: f.interactions,
          authorize: async () => {},
          fence: { ensureActive: async () => {}, suspend: async () => {}, cancel: async () => {} },
          stop,
          invoke,
          credentials: async () => ({
            ok: true,
            ...identity,
            source: { commit: original.sourceCommit, branch: original.sourceBranch },
            model: { provider: 'bedrock', value: 'fresh-test-token' },
            git: { username: 'git', password: 'fresh-git-token' },
          }),
        });
        await reconcile(f.identity);
        expect(invoke.mock.calls[0][0].payload).toEqual({ command: 'native-status', ...identity });
        expect(executor.start).not.toHaveBeenCalled();
        expect(f.row().target).toEqual(original.target);
        expect(f.row().configuration.image).toEqual(original.configuration.image);
        if (cold) {
          expect(f.row()).toMatchObject({
            status: 'RECOVERY_REQUIRED',
            recovery: { reason: 'CHECKPOINT_UNAVAILABLE', canRecover: false },
          });
          expect(executor.continue).not.toHaveBeenCalled();
          expect(stop).toHaveBeenCalledOnce();
        } else {
          expect(f.row()).toMatchObject({
            status: 'RUNNING',
            response: { deliveryStatus: 'delivered' },
          });
          expect(executor.continue).toHaveBeenCalledOnce();
          expect(executor.continue.mock.calls[0][0]).not.toHaveProperty('writerGeneration');
          expect(stop).not.toHaveBeenCalled();
        }
        expect(f.row().writerGeneration).toBeUndefined();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
