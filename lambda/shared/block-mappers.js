'use strict';

// Maps the fetched aidlc-workflows `core/**` files into the block + workflow
// shapes the seed job writes. This is the data seam that REPLACES the old
// hand-transcribed tables: every structured field is derived from the real
// repo file (frontmatter where the file has it, repo path where it does not),
// and every block carries its markdown body verbatim.
//
// Block files split into two shapes:
//   - frontmatter-bearing: stages, agents, scopes, sensors, skills — fields come
//     from the YAML header, prose from the body.
//   - frontmatter-less: rules, knowledge, templates — the whole file is the
//     body; the structured fields are derived from the repo path.
//
// The `aidlc-v2` default workflow (phases + placements + rule refs) is derived
// from the parsed stages and rules, exactly as the methodology composes them.

const { parseFrontmatter } = require('./frontmatter.js');

const titleCase = (slug) =>
  String(slug)
    .split(/[-/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

// Path prefixes inside the repo's core/ dir.
const STAGES_DIR = 'core/aidlc-common/stages/';
const AGENTS_DIR = 'core/agents/';
const SCOPES_DIR = 'core/scopes/';
const SENSORS_DIR = 'core/sensors/';
const RULES_DIR = 'core/rules/';
const KNOWLEDGE_DIR = 'core/knowledge/';
const SKILLS_DIR = 'core/skills/';
const TEMPLATES_DIR = 'core/templates/';

const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
const stripMd = (name) => name.replace(/\.md$/, '');

// ─── Stages ───
// Frontmatter mirrors V2 1:1; the body is the stage instructions. `consumes`
// maps conditional_on → conditionalOn so the compiler reads one shape.
const mapStage = (fm, body) => ({
  type: 'STAGE',
  id: fm.slug,
  name: titleCase(fm.slug),
  body,
  phase: fm.phase,
  condition: fm.condition ?? '',
  leadAgent: fm.lead_agent ?? null,
  supportAgents: fm.support_agents ?? [],
  mode: fm.mode ?? 'inline',
  execution: fm.execution,
  forEach: fm.for_each ?? null,
  produces: fm.produces ?? [],
  consumes: (fm.consumes ?? []).map((c) => {
    const edge = { artifact: c.artifact, required: Boolean(c.required) };
    if (c.conditional_on) edge.conditionalOn = c.conditional_on;
    return edge;
  }),
  requires: fm.requires_stage ?? [],
  blocksOn: fm.blocks_on ?? [],
  inputs: fm.inputs ?? '',
  outputs: fm.outputs ?? '',
  sensors: fm.sensors ?? [],
  reviewer: fm.reviewer ?? null,
  reviewerMaxIterations: fm.reviewer != null ? (fm.reviewer_max_iterations ?? null) : null,
  // V2 gates every non-initialization stage on human approval.
  humanValidation: fm.phase === 'initialization' ? 'none' : 'required',
});

// ─── Agents ───
const mapAgent = (fm, body, id) => ({
  type: 'AGENT',
  id: fm.name ?? id,
  name: fm.display_name ?? titleCase(fm.name ?? id),
  displayName: fm.display_name ?? titleCase(fm.name ?? id),
  description: fm.description ?? '',
  modelOverride: fm.modelOverride ?? null,
  disallowedTools: fm.disallowedTools ?? null,
  examples: fm.examples ?? [],
  ...(fm.tools ? { tools: fm.tools } : {}),
  body,
});

// ─── Scopes ───
const mapScope = (fm, body, id) => {
  const depth = fm.depth;
  return {
    type: 'SCOPE',
    id: fm.name ?? id,
    name: titleCase(fm.name ?? id),
    depth,
    // V2 defaults testStrategy to depth when the scope declares no override.
    testStrategy: fm.testStrategy ?? depth,
    keywords: fm.keywords ?? [],
    description: fm.description ?? '',
    body,
  };
};

// ─── Sensors ───
// Deterministic checks. The script the `command` runs is attached separately
// (scriptRef) by the seed; here we keep the manifest fields + the manifest body.
const mapSensor = (fm, body, id) => ({
  type: 'SENSOR',
  id: fm.id ?? id,
  name: titleCase(fm.id ?? id),
  description: fm.description ?? '',
  mode: fm.kind ?? 'deterministic',
  severity: fm.default_severity ?? 'advisory',
  command: fm.command ?? '',
  runtime: 'bun',
  category: fm.category ?? null,
  matches: fm.matches ?? null,
  timeoutSeconds: fm.timeout_seconds ?? null,
  ...(fm.input_schema ? { inputSchema: fm.input_schema } : {}),
  ...(fm.output_schema ? { outputSchema: fm.output_schema } : {}),
  body,
});

// ─── Rules ───
// Rule files carry NO frontmatter — layer/phase derive from the filename.
//   aidlc-org / aidlc-team / aidlc-project → universal layers
//   aidlc-phase-<phase>                    → phase layer bound to <phase>
const mapRule = (body, id) => {
  const base = stripMd(id).replace(/^aidlc-/, '');
  const phaseMatch = base.match(/^phase-(.+)$/);
  const layer = phaseMatch ? 'phase' : base; // org | team | project | phase
  const phase = phaseMatch ? phaseMatch[1] : null;
  return {
    type: 'RULE',
    id: stripMd(id),
    name: titleCase(base),
    layer,
    phase,
    // V2 rule files ship no pairing; the relation is seeded null for forks.
    pairing: null,
    description: `${titleCase(base)} rules.`,
    body,
  };
};

// ─── Knowledge ───
// Knowledge files carry no frontmatter; agentRef + doc derive from the path
// `core/knowledge/<agentRef>/<doc>.md`. `aidlc-shared` is the cross-cutting
// corpus. The id namespaces the doc under its agent.
const mapKnowledge = (body, agentDir, doc) => ({
  type: 'KNOWLEDGE',
  id: agentDir === 'aidlc-shared' ? `shared-${doc}` : `${agentDir.replace(/^aidlc-/, '')}-${doc}`,
  name: titleCase(doc),
  tier: 'methodology',
  agentRef: agentDir === 'aidlc-shared' ? 'shared' : agentDir,
  description: `Methodology knowledge: ${titleCase(doc)} (${agentDir}).`,
  body,
});

// ─── Skills ───
// User-invocable runner packs (SKILL.md). Frontmatter carries the harness
// invocation contract; the body is the skill instructions.
const mapSkill = (fm, body, id) => ({
  type: 'SKILL',
  id: fm.name ?? id,
  name: titleCase((fm.name ?? id).replace(/^aidlc-/, '')),
  description: typeof fm.description === 'string' ? fm.description.trim() : '',
  argumentHint: fm['argument-hint'] ?? '',
  userInvocable: fm['user-invocable'] ?? false,
  classification: fm.classification ?? null,
  body,
});

// ─── Templates ───
const mapTemplate = (fm, body, id) => ({
  type: 'TEMPLATE',
  id: stripMd(id),
  name: titleCase(stripMd(id)),
  description: typeof fm.description === 'string' ? fm.description.trim() : '',
  body,
});

// ─── Artifacts ───
// Derived from the stages so the vocabulary can never drift from the graph:
// one ARTIFACT per distinct produced name, flagged terminal when consumed by
// no stage.
const buildArtifacts = (stages) => {
  const consumed = new Set();
  const producedBy = new Map();
  for (const s of stages) {
    for (const c of s.consumes) consumed.add(c.artifact);
    for (const artifact of s.produces) {
      if (!producedBy.has(artifact)) producedBy.set(artifact, []);
      producedBy.get(artifact).push(s.id);
    }
  }
  return [...producedBy.keys()].toSorted().map((artifact) => ({
    type: 'ARTIFACT',
    id: artifact,
    name: titleCase(artifact),
    producedBy: producedBy.get(artifact),
    terminal: !consumed.has(artifact),
  }));
};

// ─── Default workflow ───
const PHASE_ORDER = ['initialization', 'ideation', 'inception', 'construction', 'operation'];
const phasePath = (phase) => String(PHASE_ORDER.indexOf(phase) + 1).padStart(2, '0');

const buildDefaultWorkflow = (stages, rules) => {
  // Stages in a stable order: by phase order, then by id, so placements are
  // deterministic regardless of file iteration order.
  const ordered = stages.toSorted((a, b) => {
    const pa = PHASE_ORDER.indexOf(a.phase);
    const pb = PHASE_ORDER.indexOf(b.phase);
    return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
  });
  const phases = PHASE_ORDER.map((phase) => ({
    phaseId: phase,
    name: titleCase(phase),
    kind: 'phase',
    path: phasePath(phase),
  }));
  const placements = ordered.map((s, i) => ({
    stageId: s.id,
    phasePath: phasePath(s.phase),
    order: i,
    scopeMembership: Object.fromEntries((s.scopes ?? []).map((scope) => [scope, 'EXECUTE'])),
  }));
  const ruleRefs = rules.map((r) => ({ layer: r.layer, ruleId: r.id }));
  // The workflow's available scope vocabulary is the union of every scope named
  // in a placement's membership. The `compiled` view derives its scopeGrid from
  // these SCOPEREF rows, so without them the scope picker is empty.
  const scopeRefs = [...new Set(placements.flatMap((p) => Object.keys(p.scopeMembership)))]
    .toSorted()
    .map((scopeId) => ({ scopeId }));
  return {
    id: 'aidlc-v2',
    name: 'AI-DLC v2 (default)',
    objective: 'The default AI-DLC v2 flow — the full 32-stage methodology to fork and tailor.',
    defaultScope: 'feature',
    phases,
    placements,
    ruleRefs,
    scopeRefs,
  };
};

// Files under core/ that are pure runtime machinery (engine code + lifecycle
// hooks + protocols/conductor) — NOT editable blocks. They are seeded to the
// internal runtime snapshot so execution can inject them, never to the library.
// Everything else under core/ is either a block (handled above) or scaffold.
// `core/tools/data/` is scaffold data (empty .gitkeep artefact dirs), not engine
// code, so it is excluded.
const isRuntimeFile = (path) =>
  (path.startsWith('core/tools/') && !path.startsWith('core/tools/data/')) ||
  path.startsWith('core/hooks/') ||
  path.startsWith('core/aidlc-common/protocols/') ||
  path === 'core/aidlc-common/conductor.md';

// The sensor-script file a sensor's `command` runs, by convention
// core/tools/aidlc-sensor-<id>.ts. Returns the repo path or null.
const sensorScriptPath = (sensorId) => `core/tools/aidlc-sensor-${sensorId}.ts`;

// Builds every block + the default workflow from the fetched core/ files. The
// `scopes` field is kept on the intermediate stage objects only long enough to
// build the workflow placements; it is stripped from the persisted STAGE block
// (V2's scope membership lives on the workflow placement, not the stage).
const buildFromFiles = (files) => {
  const stagesWithScopes = [];
  const blocks = [];

  for (const [path, content] of files) {
    if (path.startsWith(STAGES_DIR) && path.endsWith('.md')) {
      const { data, body } = parseFrontmatter(content);
      const stage = mapStage(data, body);
      stagesWithScopes.push({ ...stage, scopes: data.scopes ?? [] });
      blocks.push(stage);
    } else if (path.startsWith(AGENTS_DIR) && path.endsWith('.md')) {
      const { data, body } = parseFrontmatter(content);
      blocks.push(mapAgent(data, body, stripMd(basename(path))));
    } else if (path.startsWith(SCOPES_DIR) && path.endsWith('.md')) {
      const { data, body } = parseFrontmatter(content);
      blocks.push(mapScope(data, body, stripMd(basename(path)).replace(/^aidlc-/, '')));
    } else if (path.startsWith(SENSORS_DIR) && path.endsWith('.md')) {
      const { data, body } = parseFrontmatter(content);
      blocks.push(mapSensor(data, body, stripMd(basename(path)).replace(/^aidlc-/, '')));
    } else if (path.startsWith(RULES_DIR) && path.endsWith('.md')) {
      blocks.push(mapRule(content, basename(path)));
    } else if (path.startsWith(KNOWLEDGE_DIR) && path.endsWith('.md')) {
      const rel = path.slice(KNOWLEDGE_DIR.length); // <agentDir>/<doc>.md
      const [agentDir, file] = rel.split('/');
      if (agentDir && file) blocks.push(mapKnowledge(content, agentDir, stripMd(file)));
    } else if (path.startsWith(SKILLS_DIR) && path.endsWith('/SKILL.md')) {
      const { data, body } = parseFrontmatter(content);
      const skillDir = path.slice(SKILLS_DIR.length).split('/')[0];
      blocks.push(mapSkill(data, body, skillDir));
    } else if (path.startsWith(TEMPLATES_DIR) && path.endsWith('.md')) {
      const { data, body } = parseFrontmatter(content);
      blocks.push(mapTemplate(data, body, basename(path)));
    }
  }

  // Strip the transient `scopes` field from persisted stages.
  const stages = stagesWithScopes.map(({ scopes: _scopes, ...stage }) => stage);
  const rules = blocks.filter((b) => b.type === 'RULE');
  const artifacts = buildArtifacts(stages);

  const allBlocks = [...blocks, ...artifacts];
  const workflow = buildDefaultWorkflow(stagesWithScopes, rules);

  // Sensor scripts: pair each SENSOR with its core/tools/aidlc-sensor-<id>.ts.
  const sensorScripts = new Map();
  for (const b of blocks) {
    if (b.type !== 'SENSOR') continue;
    const scriptPath = sensorScriptPath(b.id);
    if (files.has(scriptPath)) {
      sensorScripts.set(b.id, { path: scriptPath, content: files.get(scriptPath) });
    }
  }

  // Internal runtime files: everything classed as machinery.
  const runtimeFiles = new Map();
  for (const [path, content] of files) {
    if (isRuntimeFile(path)) runtimeFiles.set(path, content);
  }

  return { blocks: allBlocks, workflow, sensorScripts, runtimeFiles };
};

module.exports = {
  buildFromFiles,
  buildArtifacts,
  buildDefaultWorkflow,
  isRuntimeFile,
  sensorScriptPath,
  titleCase,
  PHASE_ORDER,
  // exported for unit tests
  mapStage,
  mapAgent,
  mapScope,
  mapSensor,
  mapRule,
  mapKnowledge,
  mapSkill,
  mapTemplate,
};
