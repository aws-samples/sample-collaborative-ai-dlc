'use strict';

// V2 deterministic sensor contract — PURE + shared (no I/O, no AWS, no spawn).
//
// A sensor is one of a stage's three verification axes (the others are the
// LLM-judged reviewer and the human gate). It runs AFTER the agent finishes a
// stage and reports a verdict the runtime turns into a continue / hold decision
// per the sensor's `severity`.
//
// Two execution KINDS, decided by what the sensor inspects — and that split is
// forced by our architecture, not a preference:
//
//   - `graph`  — the sensor inspects a METHODOLOGY artifact, which in this
//     runtime lives in Neptune (`artifact.content`), NOT on a filesystem. The
//     upstream `.ts` reads it via `readFileSync(--output-path)`; we reimplement
//     the SAME check in-process over the graph content. The seeded script stays
//     as provenance. `required-sections`, `upstream-coverage`.
//   - `script` — the sensor inspects SOURCE CODE, which DOES exist on disk: the
//     real git checkout init-ws cloned into the workspace. Here the upstream
//     `.ts` is self-contained and shells out to `bunx eslint`/`tsc`; we
//     materialize it from S3 and spawn it against the workspace. `linter`,
//     `type-check`.
//
// This module owns: the result enum, the severity gate, the kind classifier,
// and the two in-process evaluators (the `graph` checks, ported faithfully from
// the upstream scripts). The runner (agentcore/sensor-runner.js) owns the I/O:
// graph reads, S3 script fetch, child-process spawn, DynamoDB record writes.

// ── Result enum ──
// PASS         — the check ran and the artifact is good.
// FAIL         — the check ran and found a real problem.
// INCONCLUSIVE — the check ran but couldn't decide (e.g. tool unavailable, no
//                matching files), OR is not applicable in this model.
// BLOCKED      — the check could not run at all (validation/spawn/timeout error).
const SENSOR_RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
  BLOCKED: 'BLOCKED',
});
const SENSOR_RESULTS = Object.freeze(Object.values(SENSOR_RESULT));

// Runtime allowlist for the `script` kind — DELIBERATELY narrow. The baseline
// code sensors ship `runtime: 'bun'`; `sh`/`node` are allowed for shell-form or
// node deterministic checks. An unknown runtime is rejected (BLOCKED) so a
// malicious or misconfigured block can't smuggle an interpreter into the image.
const ALLOWED_SCRIPT_RUNTIMES = Object.freeze(['bun', 'node', 'sh']);

// Hard ceiling on a sensor timeout (seconds). Baseline sensors are 5–60s; this
// bounds a misconfigured block so it can't hang the container indefinitely.
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 30;

// The two sensors we evaluate in-process over graph content, by id. Everything
// else is treated as a `script` sensor (materialize + spawn). Keyed on the
// stable sensor id the seed assigns (basename minus `aidlc-` prefix).
const GRAPH_SENSORS = Object.freeze(['required-sections', 'upstream-coverage']);

// Classify a resolved sensor into its execution kind. A sensor whose id is one
// of the graph evaluators runs in-process; otherwise it is a script sensor that
// inspects the workspace filesystem. `runtime: 'graph'` (set by a future block)
// also forces the in-process path.
const sensorKind = (sensor) => {
  if (!sensor) return 'script';
  if (sensor.runtime === 'graph') return 'graph';
  return GRAPH_SENSORS.includes(sensor.sensorId ?? sensor.id) ? 'graph' : 'script';
};

// Does a result + severity let the stage continue? Only a `blocking` sensor that
// did not PASS holds the stage. An `advisory` sensor NEVER holds (it records a
// note and the stage continues). BLOCKED/INCONCLUSIVE are non-PASS but only bite
// when the sensor is blocking — an advisory tool-unavailable must not wedge a run.
const severityGate = (result, severity) => {
  const passed = result === SENSOR_RESULT.PASS;
  if (severity === 'blocking') return { continues: passed, held: !passed };
  return { continues: true, held: false };
};

// Validate + normalize a script-sensor's run spec, or return an error. Mirrors
// the old v2-script-contract: `command` is SERVER-CONTROLLED (from the block),
// never agent input. The returned spec is the ONLY thing the runner executes.
const validateScriptSpec = (sensor) => {
  if (!sensor || typeof sensor !== 'object') return { ok: false, error: 'sensor is required' };
  const runtime = sensor.runtime;
  if (!ALLOWED_SCRIPT_RUNTIMES.includes(runtime)) {
    return {
      ok: false,
      error: `unsupported runtime "${runtime}"; allowed: ${ALLOWED_SCRIPT_RUNTIMES.join(', ')}`,
    };
  }
  if (typeof sensor.command !== 'string' || sensor.command.trim() === '') {
    return { ok: false, error: 'sensor command is required' };
  }
  const seconds = Number(sensor.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, error: 'sensor timeout must be a positive number of seconds' };
  }
  return {
    ok: true,
    spec: {
      sensorId: sensor.sensorId ?? sensor.id ?? null,
      runtime,
      command: sensor.command,
      timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000,
    },
  };
};

// Map a script's exit code to a result. Convention (matches upstream per-sensor
// scripts): 0 → PASS/FAIL is decided by the script's stdout JSON `pass` field;
// the runner reads that. When stdout JSON is unavailable we fall back to the
// exit code alone: 0 PASS, 2 INCONCLUSIVE, null BLOCKED, else FAIL.
const resultFromExit = (exitCode) => {
  if (exitCode === 0) return SENSOR_RESULT.PASS;
  if (exitCode === 2) return SENSOR_RESULT.INCONCLUSIVE;
  if (exitCode === null || exitCode === undefined) return SENSOR_RESULT.BLOCKED;
  return SENSOR_RESULT.FAIL;
};

// Build argv for a script sensor from its server-controlled command, applying
// server-side template substitutions (e.g. {{HARNESS_DIR}}). The per-file flags
// (`--stage`, `--file-path`) are appended by the runner. Never concatenates
// untrusted input. For `sh` we run `sh -c <command>`; for bun/node we drop the
// command's own `<runtime> <script.ts>` tokens in favour of the materialized
// scriptPath the runner resolved from S3.
const buildScriptArgv = (spec, { scriptPath, substitutions = {} } = {}) => {
  let command = spec.command;
  for (const [token, value] of Object.entries(substitutions)) {
    command = command.split(`{{${token}}}`).join(value);
  }
  if (spec.runtime === 'sh') return { file: 'sh', args: ['-c', command] };
  // bun / node: run the materialized script the runner fetched from S3 (the
  // command's own path is `<runtime-managed>/tools/...` and not on disk here).
  return { file: spec.runtime, args: [scriptPath] };
};

// ─── In-process evaluator: required-sections ───
// Ported from core/tools/aidlc-sensor-required-sections.ts. Counts DISTINCT
// `## ` (exactly two hashes + space) headings; passes at ≥2. The unit-of-work
// dependency artifact additionally requires a valid acyclic `units:` DAG block.
// `body` is the artifact content (from Neptune); `name` is the artifact type /
// filename used to gate the DAG extension.
const evalRequiredSections = (body = '', name = '') => {
  const seen = new Set();
  const headings = [];
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('## ')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    headings.push(line);
  }
  const h2Count = headings.length;
  let pass = h2Count >= 2;
  let findingsCount = Math.max(0, 2 - h2Count);
  const detail = { h2_count: h2Count, headings };

  // The machine-readable DAG check fires for the unit-of-work-dependency
  // artifact only — a malformed/cyclic block fails loud here, at the gate.
  if (name === 'unit-of-work-dependency' || name === 'unit-of-work-dependency.md') {
    const parsed = parseBoltDag(String(body));
    detail.edge_block = parsed.ok ? 'ok' : parsed.reason;
    if (!parsed.ok) {
      pass = false;
      findingsCount += 1;
      detail.edge_detail = parsed.detail ?? null;
    }
  }

  detail.findings_count = findingsCount;
  return { pass, result: pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL, detail };
};

// ─── In-process evaluator: upstream-coverage ───
// Ported from core/tools/aidlc-sensor-upstream-coverage.ts. Each consumed
// upstream artifact slug must appear in the output prose, either literally
// (word-boundary) or as a `[[wikilink]]`. `consumes` is the list of upstream
// artifact names the stage declares.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const evalUpstreamCoverage = (body = '', consumes = []) => {
  const slugs = (consumes ?? [])
    .map((c) => (typeof c === 'string' ? c : c?.artifact))
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
  if (slugs.length === 0) {
    return {
      pass: true,
      result: SENSOR_RESULT.PASS,
      detail: { consumes: [], unreferenced: [], reason: 'no upstream', findings_count: 0 },
    };
  }
  const text = String(body);
  const unreferenced = [];
  for (const slug of slugs) {
    const esc = escapeRegex(slug);
    const pattern = new RegExp(`\\b${esc}\\b|\\[\\[${esc}\\]\\]`, 'i');
    if (!pattern.test(text)) unreferenced.push(slug);
  }
  const pass = unreferenced.length === 0;
  return {
    pass,
    result: pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL,
    detail: { consumes: slugs, unreferenced, findings_count: unreferenced.length },
  };
};

// ─── parseBoltDag — faithful JS port of the upstream lib ───
// Extracts the fenced ```yaml units: block, parses the edges, and topo-sorts
// into batches. Returns { ok, reason?, detail?, units?, batches? } where reason
// is 'absent' | 'malformed' | 'cyclic'.
const unquoteScalar = (s) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

const parseInlineDepsList = (raw) => {
  const t = raw.trim();
  if (t === '' || t === '[]') return [];
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner
    .split(',')
    .map((s) => unquoteScalar(s))
    .filter((s) => s.length > 0);
};

const extractYamlUnitsBlock = (body) => {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      const inner = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) break;
        inner.push(lines[j]);
      }
      const block = inner.join('\n');
      if (/^\s*units\s*:/m.test(block)) return block;
      i = j;
    }
  }
  return null;
};

const parseUnitsBlock = (block) => {
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*units\s*:/.test(lines[i])) {
      const after = lines[i].replace(/^\s*units\s*:/, '').trim();
      if (after !== '') throw new Error('units: must be a block list, not an inline value');
      break;
    }
  }
  if (i >= lines.length) throw new Error('missing units: key');
  i++;

  const edges = [];
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const nameMatch = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) edges.push(current);
      current = { name: unquoteScalar(nameMatch[1]), depends_on: [] };
      continue;
    }
    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error('depends_on: before any - name: entry');
      current.depends_on = parseInlineDepsList(depMatch[1]);
      continue;
    }
    const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch && current) {
      current.depends_on.push(unquoteScalar(itemMatch[1]));
      continue;
    }
    throw new Error(`unrecognised line in units block: ${line.trim()}`);
  }
  if (current) edges.push(current);
  for (const e of edges) {
    if (!e.name.trim()) throw new Error('unit with empty name');
  }
  return edges;
};

const computeBatches = (edges) => {
  const deps = new Map();
  for (const e of edges) deps.set(e.name, e.depends_on);
  const remaining = new Set(edges.map((e) => e.name));
  const batches = [];
  while (remaining.size > 0) {
    const level = [];
    for (const name of remaining) {
      if (deps.get(name).every((dep) => !remaining.has(dep))) level.push(name);
    }
    if (level.length === 0) return null; // cycle
    level.sort();
    for (const name of level) remaining.delete(name);
    batches.push(level);
  }
  return batches;
};

const parseBoltDag = (body) => {
  const block = extractYamlUnitsBlock(body);
  if (block === null) return { ok: false, reason: 'absent', detail: 'no fenced yaml units: block' };

  let edges;
  try {
    edges = parseUnitsBlock(block);
  } catch (e) {
    return { ok: false, reason: 'malformed', detail: e.message };
  }
  if (edges.length === 0) return { ok: false, reason: 'malformed', detail: 'no entries' };

  const names = new Set();
  for (const u of edges) {
    if (names.has(u.name))
      return { ok: false, reason: 'malformed', detail: `duplicate: ${u.name}` };
    names.add(u.name);
  }
  for (const u of edges) {
    for (const dep of u.depends_on) {
      if (dep === u.name)
        return { ok: false, reason: 'malformed', detail: `${u.name} depends on itself` };
      if (!names.has(dep))
        return { ok: false, reason: 'malformed', detail: `${u.name} → unknown ${dep}` };
    }
  }
  const batches = computeBatches(edges);
  if (batches === null) return { ok: false, reason: 'cyclic', detail: 'dependency cycle detected' };
  return { ok: true, units: edges, batches };
};

module.exports = {
  SENSOR_RESULT,
  SENSOR_RESULTS,
  ALLOWED_SCRIPT_RUNTIMES,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  GRAPH_SENSORS,
  sensorKind,
  severityGate,
  validateScriptSpec,
  resultFromExit,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  parseBoltDag,
};
