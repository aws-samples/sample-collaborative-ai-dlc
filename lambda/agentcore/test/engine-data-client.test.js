import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteGraphAccess,
  createRemoteProcessStore,
  graphSelector,
  misconfiguredProcessStore,
} from '../engine-data-client.js';
import { localEngineGraph } from '../engine-graph.js';
import { ENGINE_DATA_GRAPH_OPS, ENGINE_DATA_STORE_METHODS } from '../../shared/engine-data-ops.js';
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

describe('createRemoteGraphAccess', () => {
  const SCOPE = { projectId: 'p1', intentId: 'i1', executionId: 'e1' };

  it('exposes exactly the allowed graph operations plus close, like the local adapter', async () => {
    const graph = await createRemoteGraphAccess({ invoke: vi.fn(), grant: () => 'g' })(SCOPE);
    const local = await localEngineGraph({ openGraph: async () => null })(SCOPE);
    expect(Object.keys(graph).toSorted()).toEqual([...ENGINE_DATA_GRAPH_OPS, 'close'].toSorted());
    expect(Object.keys(local).toSorted()).toEqual(Object.keys(graph).toSorted());
    await expect(graph.close()).resolves.toBeUndefined();
  });

  it('sends [selector, input] with the grant current at each call', async () => {
    let grant = 'g-1';
    const invoke = vi.fn(async () => ({ ok: true, result: [] }));
    const graph = await createRemoteGraphAccess({ invoke, grant: () => grant })({
      ...SCOPE,
      stageInstanceId: 'si-1',
    });
    await graph.lookupArtifacts({ artifactType: 'requirements' });
    grant = 'g-2';
    await graph.readCurrentArtifactHeadHashes();
    const selector = { ...SCOPE, stageInstanceId: 'si-1' };
    expect(invoke.mock.calls).toEqual([
      [
        {
          op: 'graph.lookupArtifacts',
          args: [selector, { artifactType: 'requirements' }],
          grant: 'g-1',
        },
      ],
      [{ op: 'graph.readCurrentArtifactHeadHashes', args: [selector, {}], grant: 'g-2' }],
    ]);
  });

  it('fails a call made outside a granted invocation without invoking engine-data', async () => {
    const invoke = vi.fn();
    const graph = await createRemoteGraphAccess({ invoke, grant: () => null })(SCOPE);
    await expect(graph.getLearningRules({})).rejects.toMatchObject({
      code: 'ENGINE_DATA_GRANT_MISSING',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rehydrates graph errors and denials with their name and code', async () => {
    const errors = [
      {
        name: 'EngineDataAccessDenied',
        code: 'scope_mismatch',
        message: 'denied',
        conflict: false,
      },
      {
        name: 'ResponseError',
        code: null,
        message: 'ConcurrentModificationException',
        conflict: false,
      },
    ];
    const graph = await createRemoteGraphAccess({
      invoke: async () => ({ error: errors.shift() }),
      grant: () => 'g',
    })(SCOPE);
    await expect(graph.getIntentGraph({})).rejects.toMatchObject({
      name: 'EngineDataAccessDenied',
      code: 'scope_mismatch',
    });
    await expect(graph.ingestCodeFiles({ files: [] })).rejects.toMatchObject({
      message: 'ConcurrentModificationException',
    });
  });

  it('sends only the fields each strict operation accepts', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: {} }));
    const graph = await createRemoteGraphAccess({ invoke, grant: () => 'g' })(SCOPE);
    await graph.recordPullRequest({
      repoId: 'r1',
      prUrl: 'https://x/pr/1',
      prNumber: 1,
      branch: 'b',
      baseBranch: 'main',
      provider: 'github',
      title: 'extra',
    });
    await graph.mirrorUnitDag({
      units: [
        { slug: 'auth', dependsOn: [], kind: 'service' },
        { name: 'billing', depends_on: ['auth'] },
      ],
      sourceArtifactId: 'dag-1',
    });
    await graph.ingestCodeFiles({
      repository: 'owner/repo',
      commitRef: 'abc',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      traceabilityStatus: 'valid',
      files: [{ filePath: 'src/a.ts', fileKind: 'implementation', evidenceIds: ['s1'], extra: 1 }],
    });
    expect(invoke.mock.calls.map(([event]) => event.args[1])).toEqual([
      { repoId: 'r1', prUrl: 'https://x/pr/1', prNumber: 1, branch: 'b', baseBranch: 'main' },
      {
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'billing', dependsOn: ['auth'] },
        ],
        sourceArtifactId: 'dag-1',
      },
      {
        repository: 'owner/repo',
        commitRef: 'abc',
        stageInstanceId: 'si-1',
        unitSlug: 'auth',
        files: [{ filePath: 'src/a.ts', fileKind: 'implementation', evidenceIds: ['s1'] }],
      },
    ]);
  });
});

describe('graphSelector', () => {
  it('names a lane only with its stage and drops empty ids', () => {
    expect(graphSelector({ projectId: 'p', intentId: 'i', executionId: null })).toEqual({
      projectId: 'p',
      intentId: 'i',
    });
    expect(graphSelector({ intentId: 'i', unitSlug: 'auth', sectionIndex: 1 })).toEqual({
      intentId: 'i',
    });
    expect(
      graphSelector({
        intentId: 'i',
        stageInstanceId: 'si',
        stageId: 'ignored',
        unitSlug: 'auth',
        sectionIndex: 0,
        systemWriter: true,
      }),
    ).toEqual({ intentId: 'i', stageInstanceId: 'si', unitSlug: 'auth', sectionIndex: 0 });
  });
});
