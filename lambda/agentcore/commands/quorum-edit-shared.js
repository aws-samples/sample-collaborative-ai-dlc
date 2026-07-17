// Shared helpers for the Quorum-edit container commands
// (quorum-edit-plan-start / quorum-edit-apply-start). Pure where possible so
// the plan sanitization, fence stripping and the rewrite structure guard are
// unit-testable without a CLI or a graph.

import { flattenVertexMap } from '../../shared/graph-rows.js';
import { extractArtifactStructure } from '../../shared/artifact-extractors.js';
import { renderStructureContract } from '../../shared/artifact-structure-contract.js';

// Bounded content windows: Quorum edits are coordinated document rewrites,
// not whole-corpus analysis. A document beyond the rewrite limit is refused
// for automated rewriting (the human edits it directly instead) — silently
// truncating a rewrite would DESTROY the tail of the document.
export const PLAN_CONTEXT_DOC_LIMIT = 6 * 1024; // per downstream doc in the plan prompt
export const PLAN_TARGET_DOC_LIMIT = 24 * 1024; // target doc in the plan prompt
export const REWRITE_DOC_LIMIT = 48 * 1024; // max size of a doc we rewrite whole

export const bounded = (text, limit) => String(text ?? '').slice(0, limit);

// A model asked for "the complete updated markdown document" often wraps the
// answer in a code fence anyway. Unwrap ONLY when the entire answer is one
// fenced block — inner fences are document content.
export const stripMarkdownFence = (text = '') => {
  const body = String(text ?? '').trim();
  const match = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/.exec(body);
  return match ? match[1] : body;
};

// ── Rewrite structure guard ──────────────────────────────────────────────────
// Field incident (2026-07-09): one-shot rewrites silently DROPPED the fenced
// YAML structured blocks (`requirements:`, `stories:`, …) that
// extractArtifactStructure machine-parses into typed graph items. The
// post-apply derive then honestly reconciled to the new content — superseding
// EVERY previously derived item ("we lost all derived artifacts"). A rewrite
// is a consistency edit, never a structural demolition — so any rewrite that
// loses the structured block, empties it, breaks its parse, or flattens all
// section headings is REFUSED (the caller retries with a corrective reminder,
// then gives up and leaves the artifact stale instead of writing damage).
export const checkRewriteStructure = ({ artifactType, artifactId, before, after }) => {
  const prev = extractArtifactStructure({ artifactType, artifactId, content: before });
  const next = extractArtifactStructure({ artifactType, artifactId, content: after });
  const problems = [];
  if (prev.structuredPresent && !next.structuredPresent) {
    problems.push(
      `the machine-parsed fenced YAML block (top-level \`${prev.structuredKey}:\`) was dropped`,
    );
  }
  if (next.structuredPresent && next.error) {
    problems.push(`the \`${next.structuredKey}:\` block no longer parses: ${next.error}`);
  }
  if (
    prev.structuredPresent &&
    next.structuredPresent &&
    prev.items.length > 0 &&
    next.items.length === 0
  ) {
    problems.push(`the \`${prev.structuredKey}:\` block lost all of its entries`);
  }
  if (prev.sections.length >= 2 && next.sections.length === 0) {
    problems.push('every section heading was removed');
  }
  return {
    ok: problems.length === 0,
    problems,
    beforeItems: prev.items.length,
    afterItems: next.items.length,
  };
};

// Prompt rules that keep a rewrite structure-safe. Generic fence preservation
// for every document, plus the SAME machine-readable structure contract the
// stage prompts inject for types with a registered extraction spec — so what
// a rewrite is told to preserve and what the parser reads cannot drift.
export const structurePreservationRules = (artifactType) => {
  const lines = [
    'STRUCTURE PRESERVATION (mandatory):',
    '- Keep every fenced code block (``` … ```) from the original document. Fenced YAML blocks are machine-parsed into the business graph — deleting one destroys derived data.',
    '- If the change affects entries inside a fenced YAML block, edit/add entries while keeping the block, its top-level key, and its field shape intact. Keep existing ids stable.',
    '- Keep the markdown section headings; restructure only where the change requires it.',
  ];
  const contract = renderStructureContract(String(artifactType ?? ''));
  if (contract) {
    lines.push(
      '',
      'This document type carries a machine-parsed structured block. Its contract:',
      contract,
    );
  }
  return lines.join('\n');
};

// Normalize Quorum's raw plan answer against the ACTUAL downstream closure:
// fabricated ids are dropped, duplicates collapse, unknown actions degrade to
// verify-unaffected, and closure artifacts the model skipped are appended as
// explicitly-unassessed verify items — the human sees the WHOLE closure,
// never a subset the model happened to mention. Enforcement by construction:
// only items produced here can ever be approved/applied.
export const sanitizePlan = ({ parsed, downstream = [] }) => {
  const byId = new Map(downstream.map((d) => [d.id, d]));
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    const id = typeof raw?.artifactId === 'string' ? raw.artifactId : null;
    if (!id || !byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    const d = byId.get(id);
    items.push({
      artifactId: id,
      title: d.title ?? null,
      artifactType: d.artifactType ?? null,
      depth: d.depth ?? 1,
      action: raw.action === 'update' ? 'update' : 'verify-unaffected',
      rationale: bounded(raw.rationale, 600),
      proposedChange: bounded(raw.proposedChange, 1200),
    });
  }
  for (const d of downstream) {
    if (seen.has(d.id)) continue;
    items.push({
      artifactId: d.id,
      title: d.title ?? null,
      artifactType: d.artifactType ?? null,
      depth: d.depth ?? 1,
      action: 'verify-unaffected',
      rationale: 'Not explicitly assessed by Quorum — review before approving.',
      proposedChange: '',
      unassessed: true,
    });
  }
  return { summary: bounded(parsed?.summary, 1000), items };
};

// One artifact (full row incl. content), intent-scoped. Returns null when
// absent or superseded — an edit against a rewound-away artifact is a bug.
export const fetchArtifactForEdit = async (g, intentId, artifactId) => {
  const res = await g
    .V()
    .has('Artifact', 'id', artifactId)
    .has('intent_id', intentId)
    .valueMap(true)
    .next();
  if (res.done || !res.value) return null;
  const row = flattenVertexMap(res.value);
  if (row.superseded_at) return null;
  return row;
};

// Progress emitter: persisted OUTPUT# chunk (restore-on-reload, keyed under
// the qedit pane) + live `agent.output` broadcast — the exact contract the
// AgentStreamPanel/IntentContext panes already speak. Best-effort.
export const makeProgressEmitter = ({
  store,
  broadcast,
  executionId,
  intentId,
  projectId,
  editId,
}) => {
  const paneKey = `qedit-${editId}`;
  return async (text) => {
    const content = `${text}\n`;
    let seq;
    try {
      const row = await store?.appendOutput?.({
        executionId,
        stageInstanceId: paneKey,
        kind: 'text',
        content,
      });
      seq = row?.seq;
    } catch {
      /* durable copy is best-effort */
    }
    try {
      await broadcast?.({
        action: 'agent.output',
        executionId,
        intentId,
        projectId,
        stageInstanceId: paneKey,
        ...(seq != null ? { seq } : {}),
        kind: 'text',
        content,
      });
    } catch {
      /* live copy is best-effort */
    }
  };
};

export default {
  PLAN_CONTEXT_DOC_LIMIT,
  PLAN_TARGET_DOC_LIMIT,
  REWRITE_DOC_LIMIT,
  bounded,
  stripMarkdownFence,
  checkRewriteStructure,
  structurePreservationRules,
  sanitizePlan,
  fetchArtifactForEdit,
  makeProgressEmitter,
};
