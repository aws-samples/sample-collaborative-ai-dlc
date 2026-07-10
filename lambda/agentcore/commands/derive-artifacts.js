// derive-artifacts — rebuild the fine-grained graph projection from canonical
// v2 Artifact markdown. The document remains source-of-truth; this command only
// mirrors deterministic sections, typed items, and citation edges for efficient
// agent reads.
//
// When the Admin enrichment toggle (payload `enrichment: 'llm'`) is on, each
// changed artifact additionally gets ONE bounded one-shot summary call through
// the already-configured agent CLI (same selection as stage runs). Enrichment
// writes PROPS ONLY (gist/claims metadata) and is strictly fail-open: any
// enrichment failure is recorded and skipped, deterministic derivation and the
// stage flow are never blocked by it.

import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';
import { runOneShotPrompt, extractJsonObject } from '../cli/one-shot.js';
import { machineCliModels } from '../model-resolver.js';
import { extractArtifactStructure } from '../../shared/artifact-extractors.js';

const artifactTs = (r) => String(r.updated_at ?? r.created_at ?? '');
export const currentArtifacts = (rows = []) =>
  rows
    .filter((r) => !r.superseded_at)
    .toSorted(
      (a, b) =>
        artifactTs(a).localeCompare(artifactTs(b)) || String(a.id).localeCompare(String(b.id)),
    );

// Enrichment mode arrives IN THE PAYLOAD (snapshotted onto the execution META
// row at intent create from the Admin SSM setting and forwarded by the
// orchestrator) — not from container env, so an Admin toggle flip needs no
// redeploy. Strict allowlist; anything unknown degrades to 'off'.
export const deriveEnrichmentMode = (value) =>
  String(value ?? 'off').toLowerCase() === 'llm' ? 'llm' : 'off';

// Bound the artifact body handed to the summary call — enrichment is a cheap
// orientation aid, not a full-document analysis. 16 KB covers the vast
// majority of stage artifacts whole; longer ones are summarized from the head.
const ENRICHMENT_CONTENT_LIMIT = 16000;

// Wall-clock budget for ALL enrichment calls in one derive run. Enrichment is
// an optional garnish: when the budget is spent, remaining artifacts skip with
// `budget_exhausted` and are picked up by the next derive/backfill (the
// source-hash check makes that free for unchanged ones). Protects the stage
// flow and the 30s backfill route from a pathological CLI.
const ENRICHMENT_BUDGET_MS = 300_000;

export const buildEnrichmentPrompt = ({ artifactType, title, content }) => {
  const body = String(content ?? '').slice(0, ENRICHMENT_CONTENT_LIMIT);
  return [
    'You summarize a software-delivery artifact for a knowledge graph. Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"gist": "<one sentence, max 40 words>", "claims": ["<key fact or decision>", "..."]}',
    'Rules: 3 to 5 claims, each a single self-contained sentence. No markdown, no code fences.',
    '',
    `Artifact type: ${artifactType}`,
    `Title: ${title || '(untitled)'}`,
    '--- ARTIFACT CONTENT ---',
    body,
    '--- END ---',
  ].join('\n');
};

// Enrich one artifact via the one-shot CLI. Returns { enriched, metrics } or
// { skipped, sample? } — never throws (fail-open contract).
const enrichArtifact = async ({ artifact, extraction, graph, oneShot, cliArgs }) => {
  // Unchanged content keeps its existing summary — no repeat spend.
  if (
    artifact.enrichment_source_hash &&
    artifact.enrichment_source_hash === extraction.contentHash
  ) {
    return { skipped: 'unchanged' };
  }
  const prompt = buildEnrichmentPrompt({
    artifactType: artifact.artifact_type,
    title: artifact.title,
    content: artifact.content,
  });
  const out = await oneShot({ prompt, ...cliArgs });
  if (!out.ok) return { skipped: out.reason ?? 'cli_failed', sample: out.sample ?? null };
  const parsed = extractJsonObject(out.text);
  const gist = typeof parsed?.gist === 'string' ? parsed.gist.trim() : '';
  if (!gist) return { skipped: 'unparseable_answer', sample: String(out.text ?? '').slice(0, 300) };
  const claims = Array.isArray(parsed.claims) ? parsed.claims.map(String).slice(0, 5) : [];
  await graph.applyArtifactEnrichment({
    artifactId: artifact.id,
    gist,
    claims,
    model: out.model,
    sourceHash: extraction.contentHash,
  });
  return { enriched: true, metrics: out.metrics, model: out.model };
};

export const deriveArtifacts = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    stageInstanceId = null,
    artifactTypes = null,
    enrichment: requestedEnrichment = 'off',
    requestedCli = null,
    cliModels = null,
    tierModels = null,
    // Lane attribution: set on unit-lane dispatches so enrichment metrics and
    // derive events land on the lane in the audit, matching stage metrics.
    unitSlug = null,
  } = payload ?? {};
  const {
    openGraph,
    store,
    broadcast = async () => {},
    clock,
    createWriter = createGraphWriter,
    availableClis = [],
    oneShot = runOneShotPrompt,
    env = process.env,
  } = deps;
  if (!intentId || !executionId) return { ok: false, reason: 'missing_identity' };

  const publish = (p) => broadcast({ executionId, intentId, projectId, ...p }).catch(() => {});
  const event = (type, summary) =>
    store
      ?.appendEvent?.({ executionId, type, stageInstanceId, actor: 'agentcore', summary })
      .catch(() => {});

  let g;
  try {
    g = await openGraph();
    const graph = createWriter({
      g,
      scope: { projectId, intentId, executionId, stageInstanceId },
      ...(clock ? { clock } : {}),
    });

    const rows = await graph.getIntentGraph({ includeContent: true, includeSuperseded: true });
    const all = currentArtifacts(rows);
    // Orphan sweep (rewind hygiene): a re-run that minted a NEW artifact id
    // leaves the OLD (superseded) artifact's sections/items current forever —
    // no mirror pass ever reconciles them. Sweep them here, before deriving,
    // so reads stay clean. Best-effort: a sweep failure must not block the
    // deterministic projection.
    const supersededArtifactIds = rows.filter((r) => r.superseded_at).map((r) => r.id);
    let swept = 0;
    if (supersededArtifactIds.length && graph.supersedeDerivationsForArtifacts) {
      try {
        const sweep = await graph.supersedeDerivationsForArtifacts({
          artifactIds: supersededArtifactIds,
        });
        swept = sweep.superseded ?? 0;
      } catch {
        /* sweep is hygiene, never a blocker */
      }
    }
    const typeFilter = artifactTypes ? new Set(artifactTypes) : null;
    const targets = all.filter((a) => {
      if (typeFilter && !typeFilter.has(a.artifact_type)) return false;
      if (stageInstanceId && a.created_by_stage_instance_id !== stageInstanceId) return false;
      return true;
    });

    const artifacts = [];
    let sections = 0;
    let items = 0;
    let citations = 0;
    let superseded = 0;
    const enrichment = deriveEnrichmentMode(requestedEnrichment);
    const errors = [];
    let enriched = 0;
    const enrichmentSkips = [];
    // Machine one-shot: flat selection backfilled by the fallback row (no
    // persona → no tier; the quorum row is for conversational surfaces).
    const cliArgs = {
      requestedCli,
      cliModels: machineCliModels({ cliModels, tierModels }),
      availableClis,
      env,
    };
    const enrichmentDeadline = Date.now() + ENRICHMENT_BUDGET_MS;
    for (const artifact of targets) {
      const extraction = extractArtifactStructure({
        artifactType: artifact.artifact_type,
        artifactId: artifact.id,
        content: artifact.content ?? '',
      });
      if (extraction.error) {
        errors.push({ artifactId: artifact.id, error: extraction.error });
        continue;
      }
      const mirrored = await graph.mirrorArtifactDerivations({ artifact, extraction });
      artifacts.push(mirrored.artifactId);
      sections += mirrored.sections;
      items += mirrored.items;
      citations += mirrored.citations;
      superseded += mirrored.superseded;

      if (enrichment !== 'llm') continue;
      if (Date.now() >= enrichmentDeadline) {
        enrichmentSkips.push({ artifactId: artifact.id, reason: 'budget_exhausted' });
        continue;
      }
      try {
        const result = await enrichArtifact({ artifact, extraction, graph, oneShot, cliArgs });
        if (result.enriched) {
          enriched += 1;
          if (result.metrics) {
            // Standard spend keys (tokensInput/tokensOutput/credits) so the
            // read-time pricer costs the sample like any other; the extra
            // `enrichmentCalls` key lets the audit view split enrichment
            // spend from stage-agent spend.
            await store
              ?.recordMetric?.({
                executionId,
                stageInstanceId,
                unitSlug,
                metrics: { ...result.metrics, enrichmentCalls: 1 },
                resolvedModel: result.model ?? null,
              })
              .catch(() => {});
          }
        } else if (result.skipped && result.skipped !== 'unchanged') {
          enrichmentSkips.push({
            artifactId: artifact.id,
            reason: result.skipped,
            ...(result.sample ? { sample: result.sample } : {}),
          });
        }
      } catch (e) {
        enrichmentSkips.push({ artifactId: artifact.id, reason: e.message });
      }
    }

    // Item↔item traceability sweep (Story COVERS Requirement, unit wiring, …)
    // — intent-wide and idempotent, so it runs once per derive, after all
    // mirrors. Best-effort: edge materialization is a projection of props that
    // remain readable either way (getCoverage joins them in memory).
    let itemEdges = 0;
    if (graph.resolveDerivedItemEdges) {
      try {
        itemEdges = (await graph.resolveDerivedItemEdges()).edges ?? 0;
      } catch {
        /* traceability edges are a projection, never a blocker */
      }
    }

    if (enrichmentSkips.length) {
      await event(
        'v2.derive.enrichment_skipped',
        `Enrichment skipped for ${enrichmentSkips.length} artifact(s): ${enrichmentSkips
          .map((s) => `${s.artifactId} (${s.reason}${s.sample ? `; sample: ${s.sample}` : ''})`)
          .join(', ')}`,
      );
    }

    const summary = `Derived graph projection: ${artifacts.length} artifact(s), ${sections} section(s), ${items} item(s), ${itemEdges} item edge(s), ${citations} citation set(s)${
      enrichment === 'llm' ? `, ${enriched} enriched` : ''
    }`;
    await event(errors.length ? 'v2.derive.partial' : 'v2.derive.completed', summary);
    await publish({
      action: 'agent.derived',
      artifactCount: artifacts.length,
      sectionCount: sections,
      itemCount: items,
    });

    return {
      ok: true,
      artifacts,
      sections,
      items,
      itemEdges,
      citations,
      superseded,
      swept,
      enrichment,
      enriched,
      errors,
    };
  } catch (e) {
    await event('v2.derive.failed', e.message);
    return { ok: false, reason: 'derive_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
  }
};
