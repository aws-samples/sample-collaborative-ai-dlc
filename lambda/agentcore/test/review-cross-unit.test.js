import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createProcessBridge } from '../mcp/process-bridge.js';
import { registerTools, toolSchemas, buildToolHandlers } from '../mcp/server.js';
import { contextFromEnv } from '../mcp/startup-context.js';
import { buildMcpConfig } from '../stage-materializer.js';
import { dispatchPersona } from '../persona-dispatch.js';
import { __test as runStageInternals, reviewCrossUnitFindings } from '../commands/run-stage.js';

// REVIEW_CROSS_UNIT_FINDINGS=advisory: a unit lane's reviewer records findings
// owned by other units apart from the verdict, so a lane is not failed (or
// repaired) for work its own scope forbids it to do.

const reviewerStore = () => {
  const store = { sensorRuns: [], events: [] };
  store.recordSensorRun = async (row) => {
    const withId = { ...row, sensorRunId: `sr${store.sensorRuns.length + 1}` };
    store.sensorRuns.push(withId);
    return withId;
  };
  store.appendEvent = async (event) => {
    store.events.push(event);
    return { ...event, eventId: `e${store.events.length}` };
  };
  return store;
};

const SCOPE = {
  executionId: 'exec-1',
  intentId: 'intent-1',
  stageInstanceId: 'si-1',
  unitSlug: 'u3-web-shell',
  role: 'reviewer',
  reviewerAgent: 'aidlc-architecture-reviewer-agent',
};

const CROSS = '1. U2 must serve the shell build (owner: u2-platform-services).';

describe('reviewCrossUnitFindings', () => {
  it('is blocking unless set to advisory', () => {
    expect(reviewCrossUnitFindings({})).toBe('blocking');
    expect(reviewCrossUnitFindings({ REVIEW_CROSS_UNIT_FINDINGS: 'blocking' })).toBe('blocking');
    expect(reviewCrossUnitFindings({ REVIEW_CROSS_UNIT_FINDINGS: 'off' })).toBe('blocking');
    expect(reviewCrossUnitFindings({ REVIEW_CROSS_UNIT_FINDINGS: 'advisory' })).toBe('advisory');
  });
});

describe('submitReview — cross-unit findings', () => {
  it('records them apart from the verdict and shows them on the timeline', async () => {
    const store = reviewerStore();
    const sent = [];
    const bridge = createProcessBridge({
      store,
      scope: { ...SCOPE, crossUnitFindings: true },
      broadcast: async (p) => sent.push(p),
    });

    const res = await bridge.submitReview({
      verdict: 'READY',
      findings: '**Reviewer:** aidlc-architecture-reviewer-agent\nNo findings for this unit.',
      crossUnitFindings: CROSS,
      round: 1,
    });

    expect(res.verdict).toBe('READY');
    expect(store.sensorRuns[0]).toMatchObject({
      result: 'PASS',
      unitSlug: 'u3-web-shell',
      detail: {
        verdict: 'READY',
        findings: expect.not.stringContaining('owner: u2'),
        crossUnitFindings: CROSS,
      },
    });
    expect(store.events.map((e) => e.type)).toEqual(['v2.review.ready', 'v2.review.cross_unit']);
    expect(store.events[1]).toMatchObject({
      unitSlug: 'u3-web-shell',
      actor: 'aidlc-architecture-reviewer-agent',
      summary: expect.stringContaining('not counted towards READY'),
    });
    expect(store.events[1].summary).toContain(CROSS);
    expect(sent.map((p) => p.noteType)).toContain('v2.review.cross_unit');
  });

  it('records nothing extra when there are none', async () => {
    const store = reviewerStore();
    const bridge = createProcessBridge({
      store,
      scope: { ...SCOPE, crossUnitFindings: true },
      broadcast: async () => {},
    });
    await bridge.submitReview({
      verdict: 'NOT-READY',
      findings: 'own finding',
      crossUnitFindings: '  ',
    });
    expect(store.sensorRuns[0].detail.crossUnitFindings).toBeUndefined();
    expect(store.events.map((e) => e.type)).toEqual(['v2.review.not_ready']);
  });

  it('ignores them when the scope does not offer them', async () => {
    const store = reviewerStore();
    const bridge = createProcessBridge({ store, scope: SCOPE, broadcast: async () => {} });
    await bridge.submitReview({ verdict: 'READY', findings: 'ok', crossUnitFindings: CROSS });
    expect(store.sensorRuns[0].detail.crossUnitFindings).toBeUndefined();
    expect(store.events.map((e) => e.type)).toEqual(['v2.review.ready']);
  });

  it('reaches the bridge through the submit_review handler', async () => {
    const calls = [];
    const handlers = buildToolHandlers({
      graph: {},
      bridge: { submitReview: async (args) => (calls.push(args), { verdict: 'READY' }) },
    });
    await handlers.submit_review({ verdict: 'READY', crossUnitFindings: CROSS });
    await handlers.submit_review({ verdict: 'READY' });
    expect(calls.map((c) => c.crossUnitFindings)).toEqual([CROSS, '']);
  });
});

describe('submit_review tool surface', () => {
  it('offers crossUnitFindings only when asked', () => {
    const plain = toolSchemas(z).submit_review;
    const cross = toolSchemas(z, null, { crossUnitFindings: true }).submit_review;
    expect(Object.keys(plain.shape)).toEqual(['reviewer', 'verdict', 'findings', 'round']);
    expect(cross.shape.crossUnitFindings.safeParse('x').success).toBe(true);
    expect(cross.shape.crossUnitFindings.safeParse(undefined).success).toBe(true);
    expect(plain.description).not.toContain('crossUnitFindings');
    expect(cross.description).toContain('crossUnitFindings');
    expect(cross.description.startsWith(plain.description)).toBe(true);
  });

  it('registers it for a reviewer with the scope flag, never for an author', () => {
    const shapes = (role, crossUnitFindings) => {
      const seen = {};
      registerTools({
        server: { tool: (name, _d, shape) => (seen[name] = shape) },
        handlers: {},
        role,
        crossUnitFindings,
        z,
        env: { V2_MCP_TRACE: 'off' },
      });
      return seen;
    };
    expect(shapes('reviewer', true).submit_review.crossUnitFindings).toBeDefined();
    expect(shapes('reviewer', false).submit_review.crossUnitFindings).toBeUndefined();
    expect(shapes('author', true).submit_review).toBeUndefined();
  });
});

describe('trusted scope plumbing', () => {
  const base = { executionId: 'e', intentId: 'i', projectId: 'p', role: 'reviewer' };

  it('writes V2_REVIEW_CROSS_UNIT only for a reviewer scope that asks for it', () => {
    const env = (scope) => buildMcpConfig({ mcpEntry: 'x', scope }).mcpServers.aidlc.env;
    expect(env({ ...base, crossUnitFindings: true }).V2_REVIEW_CROSS_UNIT).toBe('1');
    expect(env(base).V2_REVIEW_CROSS_UNIT).toBeUndefined();
    expect(env({ ...base, role: 'author', crossUnitFindings: true }).V2_REVIEW_CROSS_UNIT).toBe(
      undefined,
    );
  });

  it('reads it back for a reviewer only', () => {
    const env = {
      V2_MCP_ROLE: 'reviewer',
      V2_EXECUTION_ID: 'e',
      V2_PROCESS_TABLE: 't',
      V2_INTENT_ID: 'i',
      V2_PROJECT_ID: 'p',
      V2_STAGE_ID: 's',
      V2_STAGE_INSTANCE_ID: 'si',
    };
    expect(contextFromEnv({ ...env, V2_REVIEW_CROSS_UNIT: '1' }).scope.crossUnitFindings).toBe(
      true,
    );
    expect(contextFromEnv(env).scope.crossUnitFindings).toBe(false);
    expect(
      contextFromEnv({ ...env, V2_MCP_ROLE: 'author', V2_REVIEW_CROSS_UNIT: '1' }).scope
        .crossUnitFindings,
    ).toBe(false);
  });

  it('carries it from the persona scope to a reviewer session only', async () => {
    const scopeFor = async (role, crossUnitFindings) => {
      let captured;
      await dispatchPersona({
        role,
        personaScope: { agentRef: 'a', crossUnitFindings },
        persona: 'p',
        knowledge: '',
        brief: 'b',
        cli: 'claude',
        cliModels: {},
        env: { BEDROCK_MODEL: 'm' },
        workspaceDir: '/ws',
        mcpEntry: 'x',
        spawnFn: () => ({
          on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
          stdin: { end() {} },
        }),
        materializeMcpConfig: async ({ scope }) => ((captured = scope), '/ws/.aidlc/mcp.json'),
        executionId: 'e',
        projectId: 'p',
        intentId: 'i',
        stageInstanceId: 'si',
        unitSlug: 'u3',
        ids: () => 'sess',
      });
      return captured;
    };
    expect((await scopeFor('reviewer', true)).crossUnitFindings).toBe(true);
    expect((await scopeFor('reviewer', false)).crossUnitFindings).toBeUndefined();
    expect((await scopeFor('support', true)).crossUnitFindings).toBeUndefined();
  });
});

describe('reviewer brief', () => {
  const { buildReviewerPrompt } = runStageInternals;
  const args = {
    stage: {
      stageId: 'code-generation',
      phase: 'construction',
      inputArtifacts: [{ artifact: 'unit-of-work' }],
      outputArtifacts: [{ artifact: 'code-summary' }],
    },
    reviewerAgent: 'aidlc-architecture-reviewer-agent',
    reviewerPersona: 'persona',
    knowledge: '',
    round: 1,
  };
  const unit = { slug: 'u3-web-shell', kind: 'service', dependsOn: ['u2-platform-services'] };

  it('tells a lane reviewer to keep other units out of the verdict', () => {
    const prompt = buildReviewerPrompt({ ...args, unit, crossUnitFindings: true });
    expect(prompt).toContain('## Findings for other units');
    expect(prompt).toContain('may change only the unit **u3-web-shell**');
    expect(prompt).toContain('(u2-platform-services)');
    expect(prompt).toContain('`crossUnitFindings`');
    expect(prompt).toContain('When every finding is for another');
  });

  it('is unchanged when off or outside a lane', () => {
    const off = buildReviewerPrompt({ ...args, unit });
    expect(off).not.toContain('## Findings for other units');
    expect(off).toBe(buildReviewerPrompt({ ...args, unit, crossUnitFindings: false }));
    expect(buildReviewerPrompt({ ...args, crossUnitFindings: true })).toBe(
      buildReviewerPrompt(args),
    );
  });
});
