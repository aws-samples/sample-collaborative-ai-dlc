import { describe, it, expect } from 'vitest';
import { buildIntentAudit } from '../audit.js';

describe('buildIntentAudit', () => {
  it('aggregates reads, metrics, sensor findings, and advisories', () => {
    const audit = buildIntentAudit({
      records: {
        stages: [{}, {}],
        events: [{}],
        humanTasks: [{}],
        graphReads: [
          { tool: 'get_artifact', bytes: 200_000, resultCount: 1 },
          { tool: 'get_items', bytes: 80_000, resultCount: 10 },
          { tool: 'get_artifact', bytes: 10_000, resultCount: 1 },
        ],
        metrics: [
          { metrics: { tokensInput: 100, contextWindowPct: 40 } },
          { metrics: { tokensInput: 50 } },
        ],
        sensorRuns: [
          { sensorId: 'required-sections', result: 'FAIL', severity: 'advisory', held: false },
        ],
      },
    });
    expect(audit.summary).toMatchObject({
      stageCount: 2,
      graphReadCalls: 3,
      graphReadBytes: 290_000,
      sensorFindings: 1,
    });
    expect(audit.graphReads.byTool[0]).toMatchObject({ tool: 'get_artifact', bytes: 210_000 });
    expect(audit.metrics.find((m) => m.key === 'tokensInput')).toMatchObject({
      samples: 2,
      total: 150,
    });
    expect(audit.advisories.map((a) => a.kind)).toEqual(['context-heavy', 'sensor-finding']);
  });

  it('splits enrichment spend from stage spend and measures compact-read adoption', () => {
    const audit = buildIntentAudit({
      records: {
        meta: { deriveEnrichment: 'llm' },
        graphReads: [
          // Full-document read.
          { tool: 'get_artifact', bytes: 100_000, resultCount: 1, args: { mode: 'full' } },
          // Compact reads: summary-mode get_artifact + targeted tools.
          { tool: 'get_artifact', bytes: 2_000, resultCount: 1, args: { mode: 'summary' } },
          { tool: 'get_section', bytes: 3_000, resultCount: 1, args: {} },
          { tool: 'get_items', bytes: 5_000, resultCount: 12, args: {} },
        ],
        metrics: [
          // Stage-agent spend (no marker).
          { metrics: { tokensInput: 1000, tokensOutput: 500 } },
          // Enrichment spend (marker key stamped by derive-artifacts).
          { metrics: { tokensInput: 50, tokensOutput: 10, enrichmentCalls: 1 } },
          { metrics: { credits: 0.12, enrichmentCalls: 1 } },
        ],
      },
    });
    expect(audit.enrichment).toMatchObject({
      mode: 'llm',
      calls: 2,
      tokensInput: 50,
      tokensOutput: 10,
      credits: 0.12,
    });
    expect(audit.enrichment.reads).toMatchObject({
      compactCalls: 3,
      compactBytes: 10_000,
      fullCalls: 1,
      fullBytes: 100_000,
      compactShare: 0.09,
    });
    // Enrichment ran AND the compact projection was consumed — no unused flag.
    expect(audit.advisories.map((a) => a.kind)).not.toContain('enrichment-unused');
  });

  it('defaults to mode off with a null share when there are no reads', () => {
    const audit = buildIntentAudit({ records: {} });
    expect(audit.enrichment).toMatchObject({ mode: 'off', calls: 0 });
    expect(audit.enrichment.reads.compactShare).toBeNull();
  });

  it('flags enrichment spend that no compact read ever consumed', () => {
    const audit = buildIntentAudit({
      records: {
        meta: { deriveEnrichment: 'llm' },
        graphReads: [{ tool: 'get_artifact', bytes: 50_000, args: { mode: 'full' } }],
        metrics: [{ metrics: { tokensInput: 40, enrichmentCalls: 1 } }],
      },
    });
    expect(audit.advisories.map((a) => a.kind)).toContain('enrichment-unused');
  });

  it('reports derivation health and structure-contract compliance', () => {
    const audit = buildIntentAudit({
      records: {
        events: [
          { type: 'v2.derive.completed' },
          { type: 'v2.derive.completed' },
          { type: 'v2.derive.partial' },
          { type: 'v2.derive.failed' },
          { type: 'v2.derive.enrichment_skipped' },
          { type: 'v2.stage.started' },
        ],
        sensorRuns: [
          {
            sensorId: 'required-sections',
            result: 'PASS',
            detail: {
              artifacts: [
                { artifact: 'stories', structured_block: 'present', structured_items: 3 },
                { artifact: 'personas', structured_block: 'absent', structured_items: 0 },
              ],
            },
          },
          {
            sensorId: 'required-sections',
            result: 'FAIL',
            detail: { artifacts: [{ artifact: 'decisions', structured_block: 'malformed' }] },
          },
          // Non-structured sensor entries are ignored by the compliance rollup.
          {
            sensorId: 'upstream-coverage',
            result: 'PASS',
            detail: { artifacts: [{ artifact: 'x' }] },
          },
        ],
      },
    });
    expect(audit.derivation).toMatchObject({
      runs: 3,
      failures: 1,
      partial: 1,
      enrichmentSkips: 1,
      structuredBlocks: { checked: 3, present: 1, absent: 1, malformed: 1, complianceRate: 0.33 },
    });
    const kinds = audit.advisories.map((a) => a.kind);
    expect(kinds).toContain('structured-block-missing');
    expect(kinds).toContain('derivation-failed');
    expect(audit.advisories.find((a) => a.kind === 'structured-block-missing').summary).toContain(
      'personas',
    );
  });

  it('rolls reads and token spend up per unit lane', () => {
    const audit = buildIntentAudit({
      records: {
        graphReads: [
          { tool: 'get_items', bytes: 1000, unitSlug: 'auth' },
          { tool: 'get_section', bytes: 500, unitSlug: 'auth' },
          { tool: 'get_items', bytes: 200, unitSlug: 'billing' },
          { tool: 'get_intent_graph', bytes: 300 }, // intent-level: not in the lane split
        ],
        metrics: [
          { metrics: { tokensInput: 100, tokensOutput: 10 }, unitSlug: 'auth' },
          { metrics: { tokensInput: 50 } },
        ],
      },
    });
    expect(audit.units).toEqual([
      { unitSlug: 'auth', readCalls: 2, readBytes: 1500, tokensInput: 100, tokensOutput: 10 },
      { unitSlug: 'billing', readCalls: 1, readBytes: 200, tokensInput: 0, tokensOutput: 0 },
    ]);
  });

  it('counts get_coverage as a compact read', () => {
    const audit = buildIntentAudit({
      records: { graphReads: [{ tool: 'get_coverage', bytes: 900 }] },
    });
    expect(audit.enrichment.reads.compactCalls).toBe(1);
  });

  it('rolls up the write-side prompt-context ledger', () => {
    const audit = buildIntentAudit({
      records: {
        metrics: [
          { metrics: { promptBytes: 30_000, compiledContextBytes: 5_000 } },
          { metrics: { promptBytes: 10_000, compiledContextBytes: 1_000 } },
          { metrics: { tokensInput: 100 } }, // not a prompt sample
        ],
      },
    });
    expect(audit.promptContext).toEqual({
      samples: 2,
      promptBytes: 40_000,
      compiledContextBytes: 6_000,
      avgPromptBytes: 20_000,
    });
    // No samples → null average, zero totals.
    expect(buildIntentAudit({ records: {} }).promptContext).toEqual({
      samples: 0,
      promptBytes: 0,
      compiledContextBytes: 0,
      avgPromptBytes: null,
    });
  });
});
