import { describe, expect, it, vi } from 'vitest';
import { createRemoteProcessStore, misconfiguredProcessStore } from '../engine-data-client.js';
import { ENGINE_DATA_STORE_METHODS } from '../../shared/engine-data-ops.js';
import { isTransactionConflict } from '../../shared/v2-process-store.js';

describe('createRemoteProcessStore', () => {
  it('sends the op, positional args and the current grant', async () => {
    let grant = 'g-1';
    const invoke = vi.fn(async () => ({ ok: true, result: { id: 1 } }));
    const store = createRemoteProcessStore({ invoke, grant: () => grant });
    await expect(store.getStage('e1', 's1', { consistentRead: true })).resolves.toEqual({ id: 1 });
    grant = 'g-2';
    await store.listEvents('e1');
    expect(invoke.mock.calls).toEqual([
      [{ op: 'store.getStage', args: ['e1', 's1', { consistentRead: true }], grant: 'g-1' }],
      [{ op: 'store.listEvents', args: ['e1'], grant: 'g-2' }],
    ]);
  });

  it('returns undefined for methods without a result', async () => {
    const store = createRemoteProcessStore({
      invoke: async () => ({ ok: true }),
      grant: () => 'g',
    });
    await expect(store.markLoopBackArchived({})).resolves.toBeUndefined();
  });

  it('rehydrates store errors by name and keeps transaction conflicts recognizable', async () => {
    const errors = [
      { name: 'ConditionalCheckFailedException', code: null, message: 'nope', conflict: false },
      { name: 'TransactionCanceledException', code: null, message: 'busy', conflict: true },
    ];
    const store = createRemoteProcessStore({
      invoke: async () => ({ error: errors.shift() }),
      grant: () => 'g',
    });
    await expect(store.getStage('e1', 's1')).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
      message: 'nope',
    });
    const conflict = await store.getStage('e1', 's1').catch((e) => e);
    expect(isTransactionConflict(conflict)).toBe(true);
  });

  it('rejects an unreadable response', async () => {
    const store = createRemoteProcessStore({ invoke: async () => ({}), grant: () => 'g' });
    await expect(store.getStage('e1', 's1')).rejects.toMatchObject({
      code: 'ENGINE_DATA_BAD_RESPONSE',
    });
  });

  it('refuses every call in a misconfigured deployment', async () => {
    const store = misconfiguredProcessStore('Engine data requires the MCP Gateway');
    expect(Object.keys(store).toSorted()).toEqual(ENGINE_DATA_STORE_METHODS.toSorted());
    await expect(store.getExecution('e1')).rejects.toMatchObject({
      code: 'ENGINE_DATA_MISCONFIGURED',
    });
  });
});
