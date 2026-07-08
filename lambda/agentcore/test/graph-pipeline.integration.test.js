// End-to-end pipeline test for the granular graph (docs/v2-graph-context.md):
// a simulated agent follows the PROMPT-INJECTED structure contract verbatim,
// records the artifact via the writer, the derive command projects it, and
// every downstream consumer — drill-down reads, coverage, the graph-coverage
// sensor, the context compiler, and the audit — sees consistent typed data.
// Runs against a REAL gremlin server (same harness as graph-writer.test.js);
// only DDB/broadcast are spies. This is the regression net for the whole
// authoring → derivation → consumption → measurement chain.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createGraphWriter } from '../mcp/graph-writer.js';
import { deriveArtifacts } from '../commands/derive-artifacts.js';
import { compileContextPack } from '../context-compiler.js';
import { createSensorRunner } from '../sensor-runner.js';
import { buildStagePrompt } from '../stage-materializer.js';
import { buildIntentAudit } from '../../intents/audit.js';

const PARTITION = 'agentcore-graph-pipeline';
const SCOPE = {
  projectId: 'proj-e2e',
  intentId: 'intent-e2e',
  executionId: 'exec-e2e',
  stageInstanceId: 'si-stories',
};

let conn;
let g;
let writer;

beforeAll(async () => {
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
  await g
    .addV('Intent')
    .property('id', SCOPE.intentId)
    .property('project_id', SCOPE.projectId)
    .next();
  let t = 0;
  writer = createGraphWriter({
    g,
    scope: SCOPE,
    clock: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
  });
});

// Extract the fenced example block a structure contract renders for `key` —
// the simulated agent writes EXACTLY what the prompt showed it.
const exampleBlockFromPrompt = (prompt, key) => {
  const blocks = [...prompt.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.startsWith(`${key}:`));
  expect(block, `prompt carries no ${key}: example`).toBeTruthy();
  return block;
};

describe('granular graph — full pipeline', () => {
  it('prompt contract → artifact → derive → reads/coverage/sensor/compiler/audit', async () => {
    // ── 1. The stage prompt injects the structure contracts ──
    const requirementsPrompt = buildStagePrompt({
      stage: { stageId: 's-req', outputArtifacts: [{ artifact: 'requirements' }] },
      stageBody: 'x',
    });
    const storiesPrompt = buildStagePrompt({
      stage: { stageId: 's-stories', outputArtifacts: [{ artifact: 'stories' }] },
      stageBody: 'x',
    });

    // ── 2. A compliant agent authors artifacts following the contracts ──
    // (the requirements example from the prompt, verbatim; stories crafted to
    // cover one requirement and leave the example's must-have uncovered).
    await writer.createArtifact({
      artifactType: 'requirements',
      id: 'req-art',
      title: 'Requirements',
      content: [
        '## Overview',
        'What the system must do.',
        '## Requirements',
        '```yaml',
        exampleBlockFromPrompt(requirementsPrompt, 'requirements'),
        '```',
      ].join('\n'),
    });
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'stories-art',
      title: 'Stories',
      content: [
        '## Stories',
        'Derived from [[requirements]].',
        '## Traceability',
        'Each story cites its requirement.',
        '```yaml',
        'stories:',
        '  - id: story-user-login',
        '    title: User logs in with email',
        '    priority: must-have',
        '    covers: [req-user-login]',
        '```',
      ].join('\n'),
    });
    expect(storiesPrompt).toContain('## Structure contract — stories');

    // ── 3. Derive: projection + enrichment (stubbed one-shot CLI) ──
    const store = {
      appendEvent: vi.fn(async () => {}),
      recordMetric: vi.fn(async () => ({ metricId: 'm1' })),
    };
    const oneShot = vi.fn(async ({ prompt }) => {
      // Type-specific answers, like a real model would give.
      const isStories = /Artifact type: stories/.test(prompt);
      return {
        ok: true,
        text: isStories
          ? '{"gist":"Login stories covering the auth requirements.","claims":["Login is must-have"]}'
          : '{"gist":"Authentication requirements for the system.","claims":["Login required"]}',
        cli: 'claude',
        model: 'us.anthropic.claude-haiku-4-5',
        metrics: { tokensInput: 40, tokensOutput: 8 },
      };
    });
    const out = await deriveArtifacts(
      {
        projectId: SCOPE.projectId,
        intentId: SCOPE.intentId,
        executionId: SCOPE.executionId,
        enrichment: 'llm',
        requestedCli: 'claude',
      },
      {
        openGraph: async () => g,
        createWriter: ({ g: gg, scope }) => createGraphWriter({ g: gg, scope }),
        store,
        oneShot,
        availableClis: ['claude'],
      },
    );
    expect(out).toMatchObject({ ok: true, enrichment: 'llm', enriched: 2 });
    expect(out.artifacts.toSorted()).toEqual(['req-art', 'stories-art']);
    expect(out.items).toBeGreaterThanOrEqual(2);

    // ── 4. Drill-down reads serve the typed projection ──
    const toc = await writer.getArtifactToc({ id: 'stories-art' });
    expect(toc.map((s) => s.slug)).toEqual(['stories', 'traceability']);
    const stories = await writer.getItems({ itemType: 'Story' });
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ slug: 'story-user-login', priority: 'must-have' });
    // Citation edge from the [[requirements]] reference.
    const cites = await g
      .V()
      .has('Artifact', 'id', 'stories-art')
      .out('CITES')
      .values('id')
      .toList();
    expect(cites).toEqual(['req-art']);
    // Enrichment gist rides compact reads and the search corpus.
    const compact = await writer.lookupArtifacts({ artifactType: 'stories' });
    expect(compact[0].summary_gist).toContain('Login stories');
    expect((await writer.searchGraph({ query: 'covering the auth' })).map((a) => a.id)).toEqual([
      'stories-art',
    ]);

    // ── 5. Coverage + the graph-coverage sensor agree ──
    const coverage = await writer.getCoverage();
    expect(coverage.counts).toMatchObject({ requirements: 1, stories: 1 });
    expect(coverage.uncoveredMustHave).toEqual([]); // the story covers req-user-login
    // …and the derive sweep persisted the same join as a COVERS edge — the
    // topology the UI graph and the unit pack traverse.
    expect(out.itemEdges).toBeGreaterThanOrEqual(1);
    const covered = await g
      .V()
      .has('Story', 'id', `story:${SCOPE.intentId}:story-user-login`)
      .out('COVERS')
      .values('slug')
      .toList();
    expect(covered).toEqual(['req-user-login']);
    const runner = createSensorRunner({
      graph: writer,
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        { sensorId: 'required-sections', severity: 'blocking' },
        { sensorId: 'graph-coverage', severity: 'advisory' },
      ],
      outputArtifacts: [{ artifact: 'stories' }],
      inputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's-stories',
    });
    const byId = Object.fromEntries(verdicts.map((v) => [v.sensorId, v]));
    expect(byId['required-sections']).toMatchObject({ result: 'PASS', held: false });
    expect(byId['required-sections'].detail.artifacts[0].structured_block).toBe('present');
    expect(byId['graph-coverage'].result).toBe('PASS');

    // ── 6. The context compiler serves the projection to the NEXT stage ──
    const pack = await compileContextPack({
      graph: writer,
      stage: { inputArtifacts: [{ artifact: 'stories' }] },
    });
    expect(pack.markdown).toContain('gist: Login stories covering the auth requirements.');
    expect(pack.markdown).toContain('Story story-user-login');
    // The derived-item index carries the traceability suffix.
    expect(pack.markdown).toContain('→ covers: req-user-login');
    expect(pack.markdown).toContain('### Sections — stories (stories-art)');

    // ── 7. The audit measures the whole mechanism ──
    const audit = buildIntentAudit({
      records: {
        meta: { deriveEnrichment: 'llm' },
        events: store.appendEvent.mock.calls.map((c) => c[0]),
        metrics: store.recordMetric.mock.calls.map((c) => c[0]),
        graphReads: [
          { tool: 'get_items', bytes: 900, resultCount: 1, args: {} },
          { tool: 'get_artifact', bytes: 4_000, resultCount: 1, args: { mode: 'full' } },
        ],
        sensorRuns: verdicts.map((v) => ({
          sensorId: v.sensorId,
          result: v.result,
          detail: v.detail,
        })),
      },
    });
    expect(audit.derivation).toMatchObject({ runs: 1, failures: 0 });
    expect(audit.derivation.structuredBlocks).toMatchObject({ present: 1, complianceRate: 1 });
    expect(audit.enrichment).toMatchObject({ mode: 'llm', calls: 2, tokensInput: 80 });
    expect(audit.enrichment.reads.compactShare).toBeCloseTo(0.18, 2);
    expect(audit.advisories.map((a) => a.kind)).not.toContain('enrichment-unused');
  });

  it('non-compliant artifact (no structured block) degrades visibly, never silently', async () => {
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'prose-art',
      title: 'Prose only',
      content: '## Stories\nJust prose.\n## Notes\nNo block.',
    });
    const out = await deriveArtifacts(
      { projectId: SCOPE.projectId, intentId: SCOPE.intentId, executionId: SCOPE.executionId },
      {
        openGraph: async () => g,
        createWriter: ({ g: gg, scope }) => createGraphWriter({ g: gg, scope }),
        store: { appendEvent: vi.fn(async () => {}) },
      },
    );
    // Sections derive fine; no typed items.
    expect(out).toMatchObject({ ok: true, sections: 2, items: 0 });
    expect(await writer.getItems({ itemType: 'Story' })).toEqual([]);
    // The sensor reports the absence (finding, non-blocking by default)…
    const runner = createSensorRunner({
      graph: writer,
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const [verdict] = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'stories' }],
      stageId: 's',
    });
    expect(verdict.result).toBe('PASS');
    expect(verdict.detail.artifacts[0].structured_block).toBe('absent');
    // …and the audit turns it into the compliance advisory.
    const audit = buildIntentAudit({
      records: {
        sensorRuns: [
          { sensorId: 'required-sections', result: verdict.result, detail: verdict.detail },
        ],
      },
    });
    expect(audit.derivation.structuredBlocks).toMatchObject({ absent: 1, complianceRate: 0 });
    expect(audit.advisories.map((a) => a.kind)).toContain('structured-block-missing');
  });
});
