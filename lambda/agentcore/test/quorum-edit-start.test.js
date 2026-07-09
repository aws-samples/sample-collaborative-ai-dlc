import { describe, it, expect, vi } from 'vitest';
import { sanitizePlan, stripMarkdownFence, bounded } from '../commands/quorum-edit-shared.js';
import { createQuorumEditPlanStart } from '../commands/quorum-edit-plan-start.js';
import { createQuorumEditApplyStart } from '../commands/quorum-edit-apply-start.js';
import { sanitizeProps } from '../mcp/graph-writer.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('sanitizePlan', () => {
  const downstream = [
    { id: 'a2', title: 'Trends', artifactType: 'market-trends', depth: 1 },
    { id: 'a3', title: 'Build vs buy', artifactType: 'build-vs-buy', depth: 2 },
  ];

  it('keeps only REAL closure members, dedupes, and coerces unknown actions', () => {
    const plan = sanitizePlan({
      parsed: {
        summary: 's',
        items: [
          { artifactId: 'a2', action: 'update', rationale: 'r', proposedChange: 'p' },
          { artifactId: 'a2', action: 'update' }, // duplicate → dropped
          { artifactId: 'fabricated', action: 'update' }, // not in closure → dropped
          { artifactId: 'a3', action: 'delete-everything' }, // unknown → verify
        ],
      },
      downstream,
    });
    expect(plan.items.map((i) => [i.artifactId, i.action])).toEqual([
      ['a2', 'update'],
      ['a3', 'verify-unaffected'],
    ]);
  });

  it('appends closure members the model skipped as explicitly-unassessed verify items', () => {
    const plan = sanitizePlan({
      parsed: { summary: 's', items: [{ artifactId: 'a2', action: 'update' }] },
      downstream,
    });
    const a3 = plan.items.find((i) => i.artifactId === 'a3');
    expect(a3).toMatchObject({ action: 'verify-unaffected', unassessed: true });
  });

  it('tolerates a garbage answer (no items) — the whole closure becomes unassessed', () => {
    const plan = sanitizePlan({ parsed: { summary: 42 }, downstream });
    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((i) => i.unassessed)).toBe(true);
  });
});

describe('stripMarkdownFence', () => {
  it('unwraps a fully fenced answer but leaves inner fences alone', () => {
    expect(stripMarkdownFence('```markdown\n# Doc\n\n```js\ncode\n```\n```')).toBe(
      '# Doc\n\n```js\ncode\n```',
    );
    expect(stripMarkdownFence('# Doc\n\n```js\ncode\n```')).toBe('# Doc\n\n```js\ncode\n```');
    expect(bounded('abcdef', 3)).toBe('abc');
  });
});

describe('graph-writer reserved props', () => {
  it('drops the drift/edit/verify trust anchors from agent tool args', () => {
    const clean = sanitizeProps({
      status: 'draft',
      stale_since: 'T',
      stale_reason: 'spoof',
      edited_by: 'agent',
      edited_by_name: 'x',
      edited_at: 'T',
      edit_origin: 'human',
      edit_ref: 'x',
      verified_by: 'agent',
      verified_by_name: 'x',
      verified_at: 'T',
      verify_note: 'x',
    });
    expect(clean).toEqual({ status: 'draft' });
  });
});

// ── Commands (accept contract + background job with injected collaborators) ──

const basePlanPayload = {
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'i1',
  editId: 'qe-1',
  artifactId: 'a1',
  changeDescription: 'Target the EU market',
  callbackId: 'cb-plan',
};

const TARGET = {
  id: 'a1',
  title: 'Market research',
  artifact_type: 'market-research',
  content: '# Market research\nUS focus.',
};

const makeStore = () => ({
  appendOutput: vi.fn(async () => ({ seq: 1 })),
  appendEvent: vi.fn(async () => ({})),
  recordMetric: vi.fn(async () => ({})),
  updateQuorumEdit: vi.fn(async () => ({})),
  getQuorumEdit: vi.fn(async () => null),
});

describe('quorum-edit-plan-start', () => {
  it('validates identity + callback id', async () => {
    const start = createQuorumEditPlanStart({ openGraph: vi.fn(), sendCallbackSuccess: vi.fn() });
    expect(await start({ ...basePlanPayload, callbackId: '' })).toMatchObject({
      ok: false,
      reason: 'missing_callback_id',
    });
    expect(await start({ ...basePlanPayload, artifactId: '' })).toMatchObject({
      ok: false,
      reason: 'missing_quorum_edit_identity',
    });
  });

  it('accepts fast, is idempotent for the same callback, refuses a conflicting attempt', async () => {
    const start = createQuorumEditPlanStart({
      openGraph: () => new Promise(() => {}), // job never progresses
      sendCallbackSuccess: vi.fn(),
    });
    expect(await start(basePlanPayload)).toMatchObject({ ok: true, accepted: true });
    expect(await start(basePlanPayload)).toMatchObject({ ok: true, alreadyRunning: true });
    expect(await start({ ...basePlanPayload, callbackId: 'cb-other' })).toMatchObject({
      ok: false,
      reason: 'job_already_running',
    });
  });

  it('runs the job: closure → one-shot → sanitized plan → row patch → callback', async () => {
    const store = makeStore();
    const sendCallbackSuccess = vi.fn(async () => ({ delivered: true }));
    const rows = {
      a1: TARGET,
      a2: { id: 'a2', title: 'Trends', artifact_type: 'market-trends', content: 'trend doc' },
    };
    const start = createQuorumEditPlanStart({
      openGraph: vi.fn(async () => ({})),
      store,
      sendCallbackSuccess,
      fetchArtifact: vi.fn(async (_g, _i, id) => rows[id] ?? null),
      fetchClosure: vi.fn(async () => [
        { id: 'a2', title: 'Trends', artifactType: 'market-trends', depth: 1, via: ['CONSUMES'] },
      ]),
      oneShot: vi.fn(async ({ prompt }) => {
        // The prompt carries the change + the downstream inventory.
        expect(prompt).toContain('Target the EU market');
        expect(prompt).toContain('artifactId: a2');
        return {
          ok: true,
          text: JSON.stringify({
            summary: 'Trends drift.',
            items: [
              { artifactId: 'a2', action: 'update', rationale: 'r', proposedChange: 'p' },
              { artifactId: 'nope', action: 'update' },
            ],
          }),
          metrics: { tokensInput: 10, tokensOutput: 5 },
          model: 'm1',
        };
      }),
    });
    const accepted = await start(basePlanPayload);
    expect(accepted).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => {
      expect(sendCallbackSuccess).toHaveBeenCalled();
    });
    const [cbId, result] = sendCallbackSuccess.mock.calls[0];
    expect(cbId).toBe('cb-plan');
    expect(result.ok).toBe(true);
    expect(result.plan.items).toEqual([
      expect.objectContaining({ artifactId: 'a2', action: 'update' }),
    ]);
    // Plan persisted on the row (fields-only patch) + spend recorded.
    expect(store.updateQuorumEdit).toHaveBeenCalledWith(
      expect.objectContaining({ editId: 'qe-1', fields: { plan: result.plan } }),
    );
    expect(store.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: expect.objectContaining({ quorumEditCalls: 1 }) }),
    );
  });

  it('an unparseable answer completes the callback with ok:false (never deadlocks)', async () => {
    const sendCallbackSuccess = vi.fn(async () => ({ delivered: true }));
    const start = createQuorumEditPlanStart({
      openGraph: vi.fn(async () => ({})),
      store: makeStore(),
      sendCallbackSuccess,
      fetchArtifact: vi.fn(async () => TARGET),
      fetchClosure: vi.fn(async () => []),
      oneShot: vi.fn(async () => ({ ok: true, text: 'no json here', metrics: null })),
    });
    await start(basePlanPayload);
    await vi.waitFor(() => {
      expect(sendCallbackSuccess).toHaveBeenCalled();
    });
    expect(sendCallbackSuccess.mock.calls[0][1]).toMatchObject({
      ok: false,
      reason: 'plan_unparseable',
    });
  });

  it('a crashed job still completes the callback', async () => {
    const sendCallbackSuccess = vi.fn(async () => ({ delivered: true }));
    const start = createQuorumEditPlanStart({
      openGraph: vi.fn(async () => {
        throw new Error('neptune down');
      }),
      store: makeStore(),
      sendCallbackSuccess,
    });
    await start(basePlanPayload);
    await vi.waitFor(() => {
      expect(sendCallbackSuccess).toHaveBeenCalled();
    });
    expect(sendCallbackSuccess.mock.calls[0][1]).toMatchObject({
      ok: false,
      reason: 'plan_job_crashed',
    });
  });
});

describe('quorum-edit-apply-start', () => {
  const PLAN = {
    summary: 's',
    items: [
      {
        artifactId: 'a2',
        title: 'Trends',
        artifactType: 'market-trends',
        action: 'update',
        rationale: 'r',
        proposedChange: 'p',
      },
      {
        artifactId: 'a3',
        title: 'Build vs buy',
        artifactType: 'build-vs-buy',
        action: 'verify-unaffected',
        rationale: 'still valid',
        proposedChange: '',
      },
      {
        artifactId: 'a4',
        title: 'Questions',
        artifactType: 'market-research-questions',
        action: 'update',
        rationale: 'excluded by the human',
        proposedChange: '',
      },
    ],
  };
  const ROWS = {
    a1: TARGET,
    a2: { id: 'a2', title: 'Trends', artifact_type: 'market-trends', content: 'trend doc' },
    a3: { id: 'a3', title: 'Build vs buy', artifact_type: 'build-vs-buy', content: 'bvb doc' },
    a4: { id: 'a4', title: 'Questions', artifact_type: 'mrq', content: 'q doc' },
  };
  const applyPayload = {
    projectId: 'p1',
    intentId: 'i1',
    executionId: 'i1',
    editId: 'qe-1',
    artifactId: 'a1',
    changeDescription: 'Target the EU market',
    approvedArtifactIds: ['a2', 'a3'], // a4 excluded → stays stale
    enrichment: 'off',
    callbackId: 'cb-apply',
  };

  const makeApply = (over = {}) => {
    const store = { ...makeStore(), getQuorumEdit: vi.fn(async () => ({ plan: PLAN })) };
    const collab = {
      openGraph: vi.fn(async () => ({})),
      store,
      sendCallbackSuccess: vi.fn(async () => ({ delivered: true })),
      fetchArtifact: vi.fn(async (_g, _i, id) => ROWS[id] ?? null),
      fetchClosure: vi.fn(async () => [
        { id: 'a2', depth: 1 },
        { id: 'a3', depth: 1 },
        { id: 'a4', depth: 2 },
      ]),
      applyEdit: vi.fn(async ({ artifactId }) => ({ artifactId, editedAt: 'T' })),
      verify: vi.fn(async ({ artifactId }) => ({ artifactId, verifiedAt: 'T' })),
      markStale: vi.fn(async ({ artifactIds }) => artifactIds),
      deriveArtifacts: vi.fn(async () => ({ ok: true })),
      oneShot: vi.fn(async () => ({ ok: true, text: 'updated doc', metrics: null })),
      ...over,
    };
    return { start: createQuorumEditApplyStart(collab), collab, store };
  };

  it('rewrites the target + approved updates, verifies, marks stale, derives, completes', async () => {
    const { start, collab, store } = makeApply();
    expect(await start(applyPayload)).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => {
      expect(collab.sendCallbackSuccess).toHaveBeenCalled();
    });
    const [, result] = collab.sendCallbackSuccess.mock.calls[0];
    expect(result).toMatchObject({
      ok: true,
      updatedArtifactIds: ['a2'],
      verifiedArtifactIds: ['a3'],
      failedArtifactIds: [],
    });
    // Target + the ONE approved update were written with quorum provenance.
    expect(collab.applyEdit.mock.calls.map(([a]) => a.artifactId)).toEqual(['a1', 'a2']);
    expect(collab.applyEdit.mock.calls[0][0]).toMatchObject({
      origin: 'quorum',
      editRef: 'qedit:qe-1',
    });
    // The WHOLE closure was marked stale before rehabilitation (a4 stays).
    expect(collab.markStale.mock.calls[0][0].artifactIds).toEqual(['a2', 'a3', 'a4']);
    // Verify-unaffected carried Quorum's rationale as the note.
    expect(collab.verify.mock.calls[0][0]).toMatchObject({
      artifactId: 'a3',
      note: 'still valid',
    });
    // The projection re-derived for the rewritten types only.
    expect(collab.deriveArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ artifactTypes: ['market-research', 'market-trends'] }),
    );
    // The excluded a4 was never rewritten or verified.
    expect(collab.applyEdit.mock.calls.some(([a]) => a.artifactId === 'a4')).toBe(false);
    expect(store.appendEvent).toHaveBeenCalled();
  });

  it('a failed downstream rewrite leaves the artifact stale and reports it', async () => {
    const { start, collab } = makeApply({
      oneShot: vi
        .fn()
        // target rewrite ok, downstream rewrite fails
        .mockResolvedValueOnce({ ok: true, text: 'updated target', metrics: null })
        .mockResolvedValueOnce({ ok: false, reason: 'timeout', metrics: null }),
    });
    await start(applyPayload);
    await vi.waitFor(() => {
      expect(collab.sendCallbackSuccess).toHaveBeenCalled();
    });
    const [, result] = collab.sendCallbackSuccess.mock.calls[0];
    expect(result).toMatchObject({
      ok: true,
      updatedArtifactIds: [],
      verifiedArtifactIds: ['a3'],
      failedArtifactIds: ['a2'],
    });
    // a2 was NOT rehabilitated (only the target was written).
    expect(collab.applyEdit.mock.calls.map(([a]) => a.artifactId)).toEqual(['a1']);
  });

  it('a failed target rewrite fails the whole apply without touching downstream', async () => {
    const { start, collab } = makeApply({
      oneShot: vi.fn(async () => ({ ok: false, reason: 'cli_failed', metrics: null })),
    });
    await start(applyPayload);
    await vi.waitFor(() => {
      expect(collab.sendCallbackSuccess).toHaveBeenCalled();
    });
    expect(collab.sendCallbackSuccess.mock.calls[0][1]).toMatchObject({
      ok: false,
      reason: 'cli_failed',
    });
    expect(collab.applyEdit).not.toHaveBeenCalled();
    expect(collab.markStale).not.toHaveBeenCalled();
  });
});
