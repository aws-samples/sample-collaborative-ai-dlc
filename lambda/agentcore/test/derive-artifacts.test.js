import { describe, it, expect, vi } from 'vitest';
import {
  deriveArtifacts,
  currentArtifacts,
  deriveEnrichmentMode,
  buildEnrichmentPrompt,
} from '../commands/derive-artifacts.js';

const artifact = (overrides = {}) => ({
  id: 'stories-art',
  artifact_type: 'stories',
  created_by_stage_instance_id: 'si-1',
  created_at: '2026-01-01T00:00:00.000Z',
  content: ['## Stories', '', '```yaml', 'stories:', '  - id: s1', '    title: S1', '```'].join(
    '\n',
  ),
  ...overrides,
});

// Head lookups answered from the same rows the fake writer lists.
const withHeads = (writer) =>
  Object.assign(writer, {
    getCurrentHeads: async ({ id }) =>
      currentArtifacts(await writer.getIntentGraph({})).filter((a) => a.id === id),
  });

describe('currentArtifacts', () => {
  it('filters superseded artifacts and returns a stable order', () => {
    expect(
      currentArtifacts([
        artifact({ id: 'b', created_at: '2' }),
        artifact({ id: 'x', superseded_at: 'now' }),
        artifact({ id: 'a', created_at: '1', created_by_stage_instance_id: 'si-2' }),
      ]).map((a) => a.id),
    ).toEqual(['a', 'b']);
  });

  it('selects only the newest legacy row for one logical artifact', () => {
    expect(
      currentArtifacts([
        artifact({ id: 'old', created_at: '1' }),
        artifact({ id: 'new', created_at: '2' }),
      ]).map((a) => a.id),
    ).toEqual(['new']);
  });
});

describe('deriveArtifacts', () => {
  it('extracts and mirrors only current stage artifacts', async () => {
    const writer = {
      getIntentGraph: vi.fn(async () => [
        artifact(),
        artifact({ id: 'other', created_by_stage_instance_id: 'si-2' }),
      ]),
      mirrorArtifactDerivations: vi.fn(async ({ artifact: sourceArtifact, extraction }) => ({
        artifactId: sourceArtifact.id,
        sections: extraction.sections.length,
        items: extraction.items.length,
        citations: extraction.citations.length,
        superseded: 0,
      })),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const broadcast = vi.fn(async () => {});
    const out = await deriveArtifacts(
      { projectId: 'p', intentId: 'i', executionId: 'e', stageInstanceId: 'si-1' },
      { openGraph: async () => ({}), createWriter: () => withHeads(writer), store, broadcast },
    );
    expect(out).toMatchObject({
      ok: true,
      artifacts: ['stories-art'],
      sections: 1,
      items: 1,
      enrichment: 'off',
    });
    // The listing carries no bodies; each target's body is read on its own.
    expect(writer.getIntentGraph.mock.calls[0][0]).toEqual({ includeSuperseded: true });
    expect(writer.mirrorArtifactDerivations).toHaveBeenCalledTimes(1);
    expect(store.appendEvent.mock.calls[0][0].type).toBe('v2.derive.completed');
    expect(broadcast.mock.calls[0][0]).toMatchObject({ action: 'agent.derived', sectionCount: 1 });
  });

  it('also derives artifacts this stage changed, whatever their type or creator', async () => {
    const decisions = artifact({
      id: 'decision-log',
      artifact_type: 'decisions',
      created_by_stage_instance_id: 'si-earlier',
      updated_by_stage_instance_id: 'si-1',
      content: [
        '## Decisions',
        '',
        '```yaml',
        'decisions:',
        '  - id: dec-session-tokens',
        '    title: Use short-lived session tokens',
        '    status: proposed',
        '```',
      ].join('\n'),
    });
    const writer = {
      getIntentGraph: vi.fn(async () => [
        artifact(),
        artifact({ id: 'reqs-art', artifact_type: 'requirements' }),
        artifact({ id: 'other-stage', created_by_stage_instance_id: 'si-2' }),
        artifact({
          id: 'earlier-stories',
          created_by_stage_instance_id: 'si-earlier',
          updated_by_stage_instance_id: 'si-1',
        }),
        artifact({
          id: 'untouched-log',
          artifact_type: 'decisions',
          created_by_stage_instance_id: 'si-other',
          updated_by_stage_instance_id: 'si-2',
        }),
        decisions,
      ]),
      mirrorArtifactDerivations: vi.fn(async ({ artifact: a, extraction }) => ({
        artifactId: a.id,
        sections: extraction.sections.length,
        items: extraction.items.length,
        citations: 0,
        superseded: 0,
      })),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const out = await deriveArtifacts(
      {
        projectId: 'p',
        intentId: 'i',
        executionId: 'e',
        stageInstanceId: 'si-1',
        artifactTypes: ['stories'],
      },
      {
        openGraph: async () => ({}),
        createWriter: () => withHeads(writer),
        store,
        broadcast: async () => {},
      },
    );
    expect(out.ok).toBe(true);
    // This stage's own stories, plus what it changed of earlier stages' work.
    // Not its undeclared requirements, and nothing other stages created or
    // last changed.
    expect([...out.artifacts].toSorted()).toEqual([
      'decision-log',
      'earlier-stories',
      'stories-art',
    ]);
    const log = writer.mirrorArtifactDerivations.mock.calls.find(
      ([call]) => call.artifact.id === 'decision-log',
    );
    expect(log[0].extraction.items).toEqual([
      expect.objectContaining({ slug: 'dec-session-tokens', label: 'Decision' }),
    ]);
  });

  it('returns missing identity without opening the graph', async () => {
    const openGraph = vi.fn();
    await expect(deriveArtifacts({}, { openGraph })).resolves.toEqual({
      ok: false,
      reason: 'missing_identity',
    });
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('runs the item↔item edge sweep ONCE after all mirrors and reports the count', async () => {
    const writer = {
      getIntentGraph: vi.fn(async () => [
        artifact(),
        artifact({ id: 'reqs-art', artifact_type: 'requirements' }),
      ]),
      mirrorArtifactDerivations: vi.fn(async ({ artifact: a }) => ({
        artifactId: a.id,
        sections: 1,
        items: 1,
        citations: 0,
        superseded: 0,
      })),
      resolveDerivedItemEdges: vi.fn(async () => ({ edges: 4 })),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const out = await deriveArtifacts(
      { projectId: 'p', intentId: 'i', executionId: 'e' },
      {
        openGraph: async () => ({}),
        createWriter: () => withHeads(writer),
        store,
        broadcast: async () => {},
      },
    );
    expect(out).toMatchObject({ ok: true, itemEdges: 4 });
    // Intent-wide sweep: once per derive run, not per artifact.
    expect(writer.resolveDerivedItemEdges).toHaveBeenCalledTimes(1);
    const completed = store.appendEvent.mock.calls.find((c) => c[0].type === 'v2.derive.completed');
    expect(completed[0].summary).toContain('4 item edge(s)');
  });

  it('edge sweep is fail-open — a sweep failure never fails the derive', async () => {
    const writer = {
      getIntentGraph: vi.fn(async () => [artifact()]),
      mirrorArtifactDerivations: vi.fn(async ({ artifact: a }) => ({
        artifactId: a.id,
        sections: 1,
        items: 1,
        citations: 0,
        superseded: 0,
      })),
      resolveDerivedItemEdges: vi.fn(async () => {
        throw new Error('neptune hiccup');
      }),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const out = await deriveArtifacts(
      { projectId: 'p', intentId: 'i', executionId: 'e' },
      {
        openGraph: async () => ({}),
        createWriter: () => withHeads(writer),
        store,
        broadcast: async () => {},
      },
    );
    expect(out).toMatchObject({ ok: true, itemEdges: 0 });
    expect(
      store.appendEvent.mock.calls.find((c) => c[0].type === 'v2.derive.completed'),
    ).toBeTruthy();
  });
});

describe('deriveEnrichmentMode', () => {
  it('normalizes the payload toggle safely', () => {
    expect(deriveEnrichmentMode('llm')).toBe('llm');
    expect(deriveEnrichmentMode('LLM')).toBe('llm');
    expect(deriveEnrichmentMode('bogus')).toBe('off');
    expect(deriveEnrichmentMode(undefined)).toBe('off');
    expect(deriveEnrichmentMode(null)).toBe('off');
  });
});

describe('buildEnrichmentPrompt', () => {
  it('bounds the content and demands strict JSON', () => {
    const prompt = buildEnrichmentPrompt({
      artifactType: 'stories',
      title: 'T',
      content: 'x'.repeat(50000),
    });
    expect(prompt).toContain('"gist"');
    expect(prompt).toContain('Artifact type: stories');
    expect(prompt.length).toBeLessThan(20000);
  });
});

describe('deriveArtifacts — llm enrichment (fail-open)', () => {
  const makeWriter = () => ({
    getIntentGraph: vi.fn(async () => [artifact()]),
    mirrorArtifactDerivations: vi.fn(async ({ artifact: a, extraction }) => ({
      artifactId: a.id,
      sections: extraction.sections.length,
      items: extraction.items.length,
      citations: extraction.citations.length,
      superseded: 0,
    })),
    applyArtifactEnrichment: vi.fn(async () => ({ enriched: true })),
  });
  const makeStore = () => ({
    appendEvent: vi.fn(async () => {}),
    recordMetric: vi.fn(async () => ({ metricId: 'm1' })),
  });
  const basePayload = {
    projectId: 'p',
    intentId: 'i',
    executionId: 'e',
    stageInstanceId: 'si-1',
    enrichment: 'llm',
    requestedCli: 'claude',
    cliModels: { claude: 'us.anthropic.claude-haiku-4-5' },
  };

  it('enriches changed artifacts, writes props, and records a spend metric', async () => {
    const writer = makeWriter();
    const store = makeStore();
    const oneShot = vi.fn(async () => ({
      ok: true,
      text: '{"gist":"Stories for auth","claims":["c1","c2","c3"]}',
      cli: 'claude',
      model: 'us.anthropic.claude-haiku-4-5',
      metrics: { tokensInput: 50, tokensOutput: 10 },
    }));
    const out = await deriveArtifacts(basePayload, {
      openGraph: async () => ({}),
      createWriter: () => withHeads(writer),
      store,
      oneShot,
      availableClis: ['claude'],
    });
    expect(out).toMatchObject({ ok: true, enrichment: 'llm', enriched: 1 });
    // The one-shot got the artifact body and the CLI selection from the payload.
    expect(oneShot.mock.calls[0][0]).toMatchObject({
      requestedCli: 'claude',
      cliModels: { claude: 'us.anthropic.claude-haiku-4-5' },
      availableClis: ['claude'],
    });
    expect(oneShot.mock.calls[0][0].prompt).toContain('## Stories');
    expect(writer.applyArtifactEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: 'stories-art',
        gist: 'Stories for auth',
        claims: ['c1', 'c2', 'c3'],
        model: 'us.anthropic.claude-haiku-4-5',
      }),
    );
    // Standard spend keys + the enrichmentCalls marker for the audit split.
    expect(store.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: { tokensInput: 50, tokensOutput: 10, enrichmentCalls: 1 },
        resolvedModel: 'us.anthropic.claude-haiku-4-5',
      }),
    );
  });

  it('skips unchanged artifacts (same enrichment_source_hash) without spend', async () => {
    const writer = makeWriter();
    // Compute the real hash the extractor will produce for this content.
    const { extractArtifactStructure } = await import('../../shared/artifact-extractors.js');
    const hash = extractArtifactStructure({
      artifactType: 'stories',
      artifactId: 'stories-art',
      content: artifact().content,
    }).contentHash;
    writer.getIntentGraph = vi.fn(async () => [artifact({ enrichment_source_hash: hash })]);
    const oneShot = vi.fn();
    const out = await deriveArtifacts(basePayload, {
      openGraph: async () => ({}),
      createWriter: () => withHeads(writer),
      store: makeStore(),
      oneShot,
      availableClis: ['claude'],
    });
    expect(out).toMatchObject({ ok: true, enriched: 0 });
    expect(oneShot).not.toHaveBeenCalled();
    expect(writer.applyArtifactEnrichment).not.toHaveBeenCalled();
  });

  it('is fail-open: a failing one-shot never fails derivation, and is logged', async () => {
    const writer = makeWriter();
    const store = makeStore();
    const oneShot = vi.fn(async () => ({ ok: false, reason: 'no_cli', text: '', metrics: null }));
    const out = await deriveArtifacts(basePayload, {
      openGraph: async () => ({}),
      createWriter: () => withHeads(writer),
      store,
      oneShot,
      availableClis: [],
    });
    expect(out).toMatchObject({ ok: true, enriched: 0, artifacts: ['stories-art'] });
    const eventTypes = store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain('v2.derive.enrichment_skipped');
    expect(eventTypes).toContain('v2.derive.completed');
  });

  it('skips an unparseable answer without writing props', async () => {
    const writer = makeWriter();
    const oneShot = vi.fn(async () => ({ ok: true, text: 'sorry, no json', metrics: null }));
    const out = await deriveArtifacts(basePayload, {
      openGraph: async () => ({}),
      createWriter: () => withHeads(writer),
      store: makeStore(),
      oneShot,
      availableClis: ['claude'],
    });
    expect(out).toMatchObject({ ok: true, enriched: 0 });
    expect(writer.applyArtifactEnrichment).not.toHaveBeenCalled();
  });

  it('never calls the one-shot when the mode is off', async () => {
    const writer = makeWriter();
    const oneShot = vi.fn();
    const out = await deriveArtifacts(
      { ...basePayload, enrichment: 'off' },
      {
        openGraph: async () => ({}),
        createWriter: () => withHeads(writer),
        store: makeStore(),
        oneShot,
      },
    );
    expect(out).toMatchObject({ ok: true, enrichment: 'off' });
    expect(oneShot).not.toHaveBeenCalled();
  });
});
