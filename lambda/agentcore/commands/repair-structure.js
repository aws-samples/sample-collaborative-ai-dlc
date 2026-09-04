// repair-structure — regenerate LOST machine-parsed structured blocks.
//
// Remediation command for the 2026-07-09 incident: quorum-edit rewrites
// dropped the fenced YAML blocks (`requirements:`, `stories:`, …) from
// artifact markdown, and the follow-up derive honestly superseded every
// previously derived typed item. The prose survived — only the machine block
// was lost — so the block is recoverable: one bounded one-shot call per
// damaged artifact re-derives the block FROM the document's own prose, the
// result is validated through the SAME extractor the derive uses, appended to
// the document, and the projection is re-derived.
//
// Deterministic discipline:
//   - only artifacts whose type has a registered extraction spec AND whose
//     current content yields no items are candidates (intact docs are never
//     touched);
//   - a candidate block is written ONLY when the extractor parses it into at
//     least one item against the real content — an unparseable answer is a
//     reported skip, never a write;
//   - synchronous command (ops path, like the derive backfill): invoke via
//     the runtime with { command: "repair-structure", projectId, intentId,
//     executionId, artifactTypes?, requestedCli?, cliModels? }.

import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';
import { runOneShotPrompt } from '../cli/one-shot.js';
import { REGISTRY, extractArtifactStructure } from '../../shared/artifact-extractors.js';
import { renderStructureContract } from '../../shared/artifact-structure-contract.js';
import { currentArtifacts } from './derive-artifacts.js';

const REPAIR_ONE_SHOT_TIMEOUT_MS = 300_000;
// The whole document rides the prompt — same ceiling as the quorum rewrites.
const REPAIR_DOC_LIMIT = 48 * 1024;

export const buildRepairPrompt = ({ artifact, contract }) =>
  [
    'You are reconstructing the machine-parsed structured data block of a project document.',
    'The document below LOST its fenced YAML block. Read the document and produce that block again, capturing every item the prose defines.',
    'Respond with ONLY one fenced YAML code block (```yaml … ```) — no commentary, no other text.',
    'Keep ids stable and kebab-case; derive them from the item titles/headings in the document.',
    '',
    contract,
    '',
    `--- DOCUMENT: "${artifact.title || artifact.id}" (${artifact.artifact_type}) ---`,
    String(artifact.content ?? '').slice(0, REPAIR_DOC_LIMIT),
    '--- END DOCUMENT ---',
  ].join('\n');

// Pull the fenced YAML block out of the model answer. Tolerates prose around
// it; returns the full fenced block (markers included) or null.
export const extractFencedYamlBlock = (text = '') => {
  const m = /```ya?ml\s*\n[\s\S]*?\n```/i.exec(String(text ?? ''));
  return m ? m[0] : null;
};

export const repairStructure = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    artifactTypes = null,
    enrichment = 'off',
    requestedCli = null,
    cliModels = null,
  } = payload ?? {};
  const {
    openGraph,
    store,
    broadcast = async () => {},
    availableClis = [],
    oneShot = runOneShotPrompt,
    deriveArtifacts = null,
    createWriter = createGraphWriter,
    env = process.env,
  } = deps;
  if (!intentId || !executionId) return { ok: false, reason: 'missing_identity' };

  const event = (type, summary) =>
    store?.appendEvent?.({ executionId, type, actor: 'agentcore', summary }).catch(() => {});

  let g;
  try {
    g = await openGraph();
    const graph = createWriter({ g, scope: { projectId, intentId, executionId } });
    const rows = currentArtifacts(
      await graph.getIntentGraph({ includeContent: true, includeSuperseded: true }),
    );
    const typeFilter = artifactTypes ? new Set(artifactTypes) : null;

    const repaired = [];
    const intact = [];
    const failures = [];
    const cliArgs = { requestedCli, cliModels, availableClis, env };

    for (const artifact of rows) {
      const type = artifact.artifact_type;
      if (!REGISTRY[type]) continue; // no structured contract for this type
      if (typeFilter && !typeFilter.has(type)) continue;
      const extraction = extractArtifactStructure({
        artifactType: type,
        artifactId: artifact.id,
        content: artifact.content ?? '',
      });
      if (extraction.structuredPresent && extraction.items.length > 0 && !extraction.error) {
        intact.push(artifact.id);
        continue;
      }
      const contract = renderStructureContract(type);
      if (!contract) {
        intact.push(artifact.id);
        continue;
      }

      const out = await oneShot({
        prompt: buildRepairPrompt({ artifact, contract }),
        timeoutMs: REPAIR_ONE_SHOT_TIMEOUT_MS,
        ...cliArgs,
      });
      if (out.metrics) {
        await store
          ?.recordMetric?.({
            executionId,
            stageInstanceId: `repair-${intentId}`,
            metrics: { ...out.metrics, structureRepairCalls: 1 },
            resolvedModel: out.model ?? null,
          })
          .catch(() => {});
      }
      if (!out.ok) {
        failures.push({ artifactId: artifact.id, reason: out.reason ?? 'cli_failed' });
        continue;
      }
      const block = extractFencedYamlBlock(out.text);
      if (!block) {
        failures.push({ artifactId: artifact.id, reason: 'no_yaml_block_in_answer' });
        continue;
      }
      // Validate the candidate against the REAL extractor before any write.
      const candidateContent = `${String(artifact.content ?? '').trimEnd()}\n\n${block}\n`;
      const check = extractArtifactStructure({
        artifactType: type,
        artifactId: artifact.id,
        content: candidateContent,
      });
      if (!check.structuredPresent || check.error || check.items.length === 0) {
        failures.push({
          artifactId: artifact.id,
          reason: check.error ? `block_unparseable: ${check.error}` : 'block_yields_no_items',
        });
        continue;
      }
      await graph.updateArtifact({ id: artifact.id, props: { content: candidateContent } });
      repaired.push({ artifactId: artifact.id, artifactType: type, items: check.items.length });
      await event(
        'v2.artifact.repaired',
        `Structured block reconstructed for "${artifact.title || artifact.id}" (${check.items.length} item(s))`,
      );
    }

    // Re-derive the projection for the repaired types so the typed items come
    // back. Best-effort: the canonical content is already fixed.
    if (deriveArtifacts && repaired.length) {
      try {
        await deriveArtifacts({
          projectId,
          intentId,
          executionId,
          artifactTypes: [...new Set(repaired.map((r) => r.artifactType))],
          enrichment,
          requestedCli,
          cliModels,
        });
      } catch (e) {
        failures.push({ artifactId: '(derive)', reason: e.message });
      }
    }

    const summary = `Structure repair: ${repaired.length} artifact(s) reconstructed, ${intact.length} intact, ${failures.length} failure(s)`;
    await event('v2.repair.completed', summary);
    await broadcast({
      action: 'agent.note',
      executionId,
      intentId,
      projectId,
      noteType: 'v2.artifact.repaired',
      summary,
    }).catch(() => {});
    return { ok: true, repaired, intact, failures };
  } catch (e) {
    await event('v2.repair.failed', e.message);
    return { ok: false, reason: 'repair_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
  }
};
