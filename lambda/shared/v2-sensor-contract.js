import { REGISTRY, extractArtifactStructure } from './artifact-extractors.js';
import { UNIT_KINDS } from './blocks.js';

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

// Applicability is independent of a sensor's execution result. A sensor can be
// definitively irrelevant to a known change set, or its relevance can be
// unknown because changed-file provenance could not be collected. Only the
// former may bypass a blocking severity gate.
const SENSOR_APPLICABILITY = Object.freeze({
  APPLICABLE: 'APPLICABLE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN',
});

// Runtime allowlist for the `script` kind — DELIBERATELY narrow. The baseline
// code sensors ship `runtime: 'bun'`; `sh`/`node` are allowed for shell-form or
// node deterministic checks. An unknown runtime is rejected (BLOCKED) so a
// malicious or misconfigured block can't smuggle an interpreter into the image.
const ALLOWED_SCRIPT_RUNTIMES = Object.freeze(['bun', 'node', 'sh']);

// Hard ceiling on a sensor timeout (seconds). Baseline sensors are 5–60s; this
// bounds a misconfigured block so it can't hang the container indefinitely.
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 30;

// Which flag carries the path a script sensor analyses. A sensor's `input_schema`
// IS its declared invocation contract, so the flag is read from the contract the
// block authored and never from the sensor's id: a fork can ship a document
// sensor under any name. A block that authors no schema keeps the default, which
// is what every pre-2.8.2 catalog gets.
const FILE_PATH_FLAG = '--file-path';
const OUTPUT_PATH_FLAG = '--output-path';

// Mirrors upstream `sensorTakesFilePath` (core/tools/aidlc-sensor.ts): a declared
// contract decides, and only a contract that names `file_path` takes a file path.
const sensorPathFlag = (inputSchema) => {
  if (!inputSchema || typeof inputSchema !== 'object') return FILE_PATH_FLAG;
  if (Object.keys(inputSchema).length === 0) return FILE_PATH_FLAG;
  return Object.hasOwn(inputSchema, 'file_path') ? FILE_PATH_FLAG : OUTPUT_PATH_FLAG;
};

// The two sensors we evaluate in-process over graph content, by id. Everything
// else is treated as a `script` sensor (materialize + spawn). Keyed on the
// stable sensor id the seed assigns (basename minus `aidlc-` prefix).
const GRAPH_SENSORS = Object.freeze(['required-sections', 'upstream-coverage', 'graph-coverage']);

// A record sensor whose candidate set reaches the knowledge base also covers run
// records, and that widening is the authored change upstream shipped the
// timestamp exemption with, in the same sensor file. Reading the authored glob
// of the RECORD sensors keeps the switch version-agnostic — it never reads a
// version string — and keeps it out of reach of an unrelated sensor's glob. A
// catalog whose record sensors claim no such coverage keeps the heading floor,
// which is every release that shipped before the exemption.
const RUN_RECORD_COVERAGE_MARKER = 'codekb';
const recordSensorsCoverRunRecords = (sensorsById = {}) =>
  GRAPH_SENSORS.some((sensorId) =>
    String(sensorsById?.[sensorId]?.matches ?? '').includes(RUN_RECORD_COVERAGE_MARKER),
  );

// A catalog that routes a sensor through its OWN engine sensor dispatcher
// (`{{INVOKE}} engine sensor-<id>`) authors that dispatcher's documented
// exit-code contract for the per-sensor script behind it: exit 0 carries the
// verdict in the stdout JSON, exit 127 is the script reporting that the tool it
// wraps — or that tool's configuration — could not be used, and any other
// non-zero exit is a script error that produced no verdict at all. We spawn
// that script directly, so we stand in for the dispatcher and owe the same
// reading of its exits. A catalog that authors a DIRECT script invocation
// (`bun {{HARNESS_DIR}}/tools/aidlc-sensor-<id>.ts`) declares no dispatcher and
// no reclassification, so its scripts keep the bare exit-code mapping below —
// which is every catalog that shipped before the dispatcher route. Reading the
// authored command keeps the switch version-agnostic: it never reads a version
// string, exactly like the path flag read off `input_schema`.
const DISPATCHER_SENSOR_COMMAND_RE = /\{\{INVOKE\}\}\s+engine\s+sensor-/;
const sensorDeclaresDispatcherExitCodes = (sensor) =>
  DISPATCHER_SENSOR_COMMAND_RE.test(String(sensor?.command ?? ''));

// The exit code a per-sensor script uses to report that its tool or that tool's
// configuration is unavailable. The dispatcher answers it with a PASS carrying a
// tool-unavailable note, so an environment without the tool does not read as a
// finding — the check simply did not run.
const SCRIPT_EXIT_TOOL_UNAVAILABLE = 127;

// How much of a failing script's stderr is kept on the record: enough to name
// the breakage, bounded so a script that writes a stack trace per file cannot
// grow the sensor row without limit.
const STDERR_EXCERPT_LIMIT = 400;

// How many DISTINCT reasons the sensor-level summary names before it counts the
// rest. One sweep can span repositories whose tooling fails differently.
const MAX_SUMMARIZED_REASONS = 3;

const stderrExcerpt = (stderr) => {
  const text = String(stderr ?? '').trim();
  if (text.length <= STDERR_EXCERPT_LIMIT) return text;
  return `${text.slice(0, STDERR_EXCERPT_LIMIT)}…`;
};

// The first line a per-sensor script writes to stderr before exiting is its own
// marker (`eslint-unavailable`, `no-eslint-config`, `tsc-unavailable`, …), and
// it is the ONLY place the missing tool or configuration is named — the
// dispatcher's own note is the bare string `tool-unavailable`. Reading the
// marker keeps the reason specific without the runtime knowing any sensor's
// tool, and an unrecognised marker is still quoted rather than dropped.
const firstStderrLine = (stderr) =>
  String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';

const MISSING_CONFIG_MARKER_RE = /^no-([\w.-]+)-config$/;
const UNAVAILABLE_TOOL_MARKER_RE = /^([\w.-]+)-unavailable$/;

const toolUnavailableReason = (stderr) => {
  const marker = firstStderrLine(stderr);
  const missingConfig = MISSING_CONFIG_MARKER_RE.exec(marker);
  if (missingConfig) {
    return `no ${missingConfig[1]} configuration was found, so the check did not run`;
  }
  const unavailableTool = UNAVAILABLE_TOOL_MARKER_RE.exec(marker);
  if (unavailableTool) {
    return `${unavailableTool[1]} is not available here, so the check did not run`;
  }
  return marker
    ? `the sensor reported its tool unavailable ("${marker}"), so the check did not run`
    : 'the sensor reported its tool unavailable, so the check did not run';
};

// Map ONE non-zero child exit to a verdict under the authored contract. Exit 0
// is not routed here — the script printed a verdict and that verdict decides —
// and neither is a timeout or a spawn failure, which produce no exit code.
//
// Only the tool-unavailable exit changes a verdict, because only that exit was
// being read as a finding when the script was reporting it had not run. Every
// other non-zero exit keeps the verdict the bare mapping already gave it and
// gains only the detail that was missing: the exit code and a bounded stderr
// excerpt. So a script error stays the FAIL it was, and the one exit the bare
// mapping already calls inconclusive stays inconclusive.
const resultFromDispatcherExit = ({ exitCode, stderr } = {}) => {
  if (exitCode === SCRIPT_EXIT_TOOL_UNAVAILABLE) {
    return {
      result: SENSOR_RESULT.PASS,
      detail: { toolUnavailable: true, exitCode, reason: toolUnavailableReason(stderr) },
    };
  }
  const excerpt = stderrExcerpt(stderr);
  return {
    result: resultFromExit(exitCode),
    detail: {
      scriptError: true,
      exitCode,
      reason: `the sensor script exited ${exitCode} without a verdict`,
      ...(excerpt ? { stderr: excerpt } : {}),
    },
  };
};

// The gate finding and the activity note read the SENSOR-level `detail.reason`,
// not the per-file rows, so a sweep that only reached tool-unavailable passes —
// or script errors that produced no verdict — has to say so there as well. That
// is the path a human sees; without it the verdict carries no reason at all.
const dispatcherExitReason = (fileResults = [], total = 0) => {
  const reasons = [];
  let affected = 0;
  for (const row of fileResults) {
    const detail = row?.detail;
    if (!detail?.reason) continue;
    if (detail.toolUnavailable !== true && detail.scriptError !== true) continue;
    affected += 1;
    if (!reasons.includes(detail.reason)) reasons.push(detail.reason);
  }
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, MAX_SUMMARIZED_REASONS);
  const rest = reasons.length - shown.length;
  return `${affected} of ${total} files: ${shown.join('; ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
};

// The run-record naming convention: `<artifact>-timestamp[.md]`.
const TIMESTAMP_MARKER_RE = /-timestamp(?:\.md)?$/;

// Classify a resolved sensor into its execution kind. A sensor whose id is one
// of the graph evaluators runs in-process; otherwise it is a script sensor that
// inspects the workspace filesystem. `runtime: 'graph'` (set by a future block)
// also forces the in-process path.
const sensorKind = (sensor) => {
  if (!sensor) return 'script';
  if (sensor.runtime === 'graph') return 'graph';
  return GRAPH_SENSORS.includes(sensor.sensorId ?? sensor.id) ? 'graph' : 'script';
};

// Does a result + severity let the stage continue? A definitively irrelevant
// sensor never holds a stage. Unknown applicability is deliberately NOT treated
// as a skip: a blocking sensor still requires PASS after the runner widens its
// selection to the full checkout. Advisory sensors never hold.
const severityGate = (result, severity, applicability = SENSOR_APPLICABILITY.APPLICABLE) => {
  if (applicability === SENSOR_APPLICABILITY.NOT_APPLICABLE) {
    return { continues: true, held: false };
  }
  const passed = result === SENSOR_RESULT.PASS;
  if (severity === 'blocking') return { continues: passed, held: !passed };
  return { continues: true, held: false };
};

// The same code under the name the provenance work introduced.
const TOOL_UNAVAILABLE_EXIT = SCRIPT_EXIT_TOOL_UNAVAILABLE;
const SENSOR_VERDICT_MODES = Object.freeze(['stdout-json', 'exit-code']);
const STDOUT_JSON_SENSORS = Object.freeze(['linter', 'type-check']);
const SENSOR_SCOPES = Object.freeze(['file', 'project']);
const PROJECT_SCOPED_SENSORS = Object.freeze(['type-check']);
const DEFAULT_PROJECT_CONFIG = 'tsconfig.json';

const defaultVerdictMode = (sensor) =>
  STDOUT_JSON_SENSORS.includes(sensor?.sensorId ?? sensor?.id) ? 'stdout-json' : 'exit-code';
const defaultScope = (sensor) =>
  PROJECT_SCOPED_SENSORS.includes(sensor?.sensorId ?? sensor?.id) ? 'project' : 'file';

// A project config is interpreted relative to each detected project root. Keep
// the accepted representation canonical and platform-independent so joining it
// to a project root can never select an absolute path or escape that root.
const validateProjectConfig = (value) => {
  const invalid = (message) => ({ ok: false, error: message, value: DEFAULT_PROJECT_CONFIG });
  if (value == null) return { ok: true, value: DEFAULT_PROJECT_CONFIG };
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('projectConfig must be a non-empty relative path');
  }
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return invalid('projectConfig must be a normalized safe relative path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid('projectConfig must be a normalized safe relative path');
  }
  return { ok: true, value };
};

// Validate the fields shared by plan construction and runtime execution. The
// returned fields are always safe defaults or validated declarations, even when
// errors are present, so invalid authored values are never copied into a plan.
const validateSensorContractFields = (sensor = {}) => {
  sensor = sensor && typeof sensor === 'object' ? sensor : {};
  const errors = [];
  let verdictMode = defaultVerdictMode(sensor);
  if (sensor.verdictMode != null) {
    if (SENSOR_VERDICT_MODES.includes(sensor.verdictMode)) verdictMode = sensor.verdictMode;
    else {
      errors.push({
        field: 'verdictMode',
        code: 'sensor_invalid_verdict_mode',
        message: `unsupported verdictMode "${sensor.verdictMode}"; allowed: ${SENSOR_VERDICT_MODES.join(', ')}`,
      });
    }
  }

  let scope = defaultScope(sensor);
  if (sensor.scope != null) {
    if (SENSOR_SCOPES.includes(sensor.scope)) scope = sensor.scope;
    else {
      errors.push({
        field: 'scope',
        code: 'sensor_invalid_scope',
        message: `unsupported scope "${sensor.scope}"; allowed: ${SENSOR_SCOPES.join(', ')}`,
      });
    }
  }

  const projectConfig = validateProjectConfig(sensor.projectConfig);
  if (!projectConfig.ok) {
    errors.push({
      field: 'projectConfig',
      code: 'sensor_invalid_project_config',
      message: projectConfig.error,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    fields: { verdictMode, scope, projectConfig: projectConfig.value },
  };
};

const sensorVerdictMode = (sensor) => validateSensorContractFields(sensor).fields.verdictMode;
const sensorScope = (sensor) => validateSensorContractFields(sensor).fields.scope;
const projectConfigFile = (sensor) => validateSensorContractFields(sensor).fields.projectConfig;

// The bound that governs ONE child launch, and which of the three set it.
//
// `remainingStageMs` is what is left of the stage's wall-clock budget. Three
// states, deliberately distinguished:
//   - not a finite number — no deadline is available (an unpinned run, or a
//     caller that reads no deadline): the authored budget stands;
//   - greater than zero — the budget may narrow the authored one;
//   - zero or less — the budget is EXHAUSTED. That is NOT "unavailable": the
//     stage is already past its deadline, so nothing further may be launched.
// The caller re-reads the remaining budget before each launch, because a sensor
// matching several files must not hand every one of them the allowance the
// first one found.
const scriptTimeoutBound = (authoredSeconds, remainingStageMs = null) => {
  const base =
    authoredSeconds > MAX_TIMEOUT_SECONDS
      ? { timeoutMs: MAX_TIMEOUT_SECONDS * 1000, boundedBy: 'ceiling' }
      : { timeoutMs: authoredSeconds * 1000, boundedBy: 'authored' };
  if (!Number.isFinite(remainingStageMs)) return { ...base, exhausted: false };
  if (remainingStageMs <= 0) return { timeoutMs: 0, boundedBy: 'stage-deadline', exhausted: true };
  if (remainingStageMs < base.timeoutMs) {
    return { timeoutMs: remainingStageMs, boundedBy: 'stage-deadline', exhausted: false };
  }
  return { ...base, exhausted: false };
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
  const contract = validateSensorContractFields(sensor);
  if (!contract.ok) return { ok: false, error: contract.errors[0].message };

  // The authored budget, clamped by the ceiling. The stage deadline is applied
  // per child launch by the runner, not here: a spec is validated once but a
  // sensor can launch a child per matching file, minutes apart.
  const bound = scriptTimeoutBound(seconds);
  return {
    ok: true,
    spec: {
      sensorId: sensor.sensorId ?? sensor.id ?? null,
      runtime,
      command: sensor.command,
      pathFlag: sensor.pathFlag ?? sensorPathFlag(sensor.inputSchema),
      timeoutSeconds: seconds,
      // `scriptTimeoutBound` already applies the MAX_TIMEOUT_SECONDS ceiling
      // that main clamped inline here.
      timeoutMs: bound.timeoutMs,
      boundedBy: bound.boundedBy,
      ...contract.fields,
    },
  };
};

// Map a script's exit code to a result. Convention (matches upstream per-sensor
// scripts): 0 → PASS/FAIL is decided by the script's stdout JSON `pass` field;
// the runner reads that. When stdout JSON is unavailable we fall back to the
// exit code alone: 0 PASS, 2 INCONCLUSIVE, null BLOCKED, else FAIL.
const resultFromExit = (exitCode) => {
  if (exitCode === 0) return SENSOR_RESULT.PASS;
  if (exitCode === 2 || exitCode === TOOL_UNAVAILABLE_EXIT) return SENSOR_RESULT.INCONCLUSIVE;
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
//
// Structured-block strictness ladder (registered types): a MALFORMED fenced
// block always fails (broken YAML would silently drop typed items); an ABSENT
// block is reported (`structured_block: 'absent'`) but only fails when
// `options.strictStructuredBlocks` is set — the prompt-injected structure
// contracts are new, so absence stays an advisory finding until field-test
// compliance data justifies flipping the switch (a sensor-row/config change,
// not code).
const evalRequiredSections = (body = '', name = '', options = {}) => {
  const strictStructuredBlocks = Boolean(options.strictStructuredBlocks);
  // A `<artifact>-timestamp` marker is a run record, not a document: the
  // methodology specifies a single `Discovered: ...` line, so the heading floor
  // reported two findings on every to-spec file. A `*-questions` marker keeps
  // the floor, because each question is its own `##` section.
  const timestampMarker =
    Boolean(options.recordTimestampExempt) && TIMESTAMP_MARKER_RE.test(String(name));
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
  let pass = timestampMarker || h2Count >= 2;
  let findingsCount = timestampMarker ? 0 : Math.max(0, 2 - h2Count);
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

  const artifactType = String(name).replace(/\.md$/, '');
  if (REGISTRY[artifactType]) {
    const extracted = extractArtifactStructure({ artifactType, content: body });
    detail.structured_key = extracted.structuredKey;
    detail.structured_block = extracted.error
      ? 'malformed'
      : extracted.structuredPresent
        ? 'present'
        : 'absent';
    detail.structured_items = extracted.items.length;
    if (extracted.error) {
      pass = false;
      findingsCount += 1;
      detail.structured_detail = extracted.error;
    } else if (!extracted.structuredPresent) {
      // Absent: a finding either way (audit surfaces it); blocking only in
      // strict mode.
      findingsCount += 1;
      if (strictStructuredBlocks) pass = false;
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

// ─── In-process evaluator: graph-coverage ───
// Pure verdict over a getCoverage() report (the typed-item joins the graph
// writer computes): the topology-integrity gate for the derived graph.
//   INCONCLUSIVE — no typed items derived yet (early stages; nothing to judge).
//   FAIL — a must-have requirement no story covers, a reference to a
//          nonexistent slug, a component dependency cycle, or (once a story
//          map exists) stories mapped to no unit.
//   PASS — everything wired. Non-must-have uncovered requirements are
//          reported in detail but never fail (could/should-haves may be
//          deliberately deferred).
const evalGraphCoverage = (coverage = {}) => {
  const counts = coverage.counts ?? {};
  const totalItems =
    (counts.requirements ?? 0) +
    (counts.stories ?? 0) +
    (counts.mappings ?? 0) +
    (counts.components ?? 0);
  if (totalItems === 0) {
    return {
      pass: true,
      result: SENSOR_RESULT.INCONCLUSIVE,
      detail: { reason: 'no typed items derived yet', findings_count: 0 },
    };
  }
  const uncoveredMustHave = coverage.uncoveredMustHave ?? [];
  const unknownReferences = coverage.unknownReferences ?? [];
  const componentCycles = coverage.componentCycles ?? [];
  // Unmapped stories only count once a story map exists — before that stage,
  // every story is trivially unmapped.
  const unmappedStories = (counts.mappings ?? 0) > 0 ? (coverage.unmappedStories ?? []) : [];
  const findings =
    uncoveredMustHave.length +
    unknownReferences.length +
    componentCycles.length +
    unmappedStories.length;
  const pass = findings === 0;
  return {
    pass,
    result: pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL,
    detail: {
      counts,
      uncovered_must_have: uncoveredMustHave.map((r) => r.slug),
      uncovered_requirements: (coverage.uncoveredRequirements ?? []).map((r) => r.slug),
      unmapped_stories: unmappedStories.map((s) => s.slug),
      unknown_references: unknownReferences,
      component_cycles: componentCycles,
      findings_count: findings,
    },
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
      current = { name: unquoteScalar(nameMatch[1]), depends_on: [], kind: null };
      continue;
    }
    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error('depends_on: before any - name: entry');
      current.depends_on = parseInlineDepsList(depMatch[1]);
      continue;
    }
    // Optional per-unit kind (V2 ≥2.2.18): drives produces_kinds pruning.
    // Parsed here, validated (against UNIT_KINDS) in parseBoltDag so an
    // invalid value is a loud malformed-DAG error, never a silent full-matrix.
    const kindMatch = line.match(/^\s*kind\s*:\s*(.+?)\s*$/);
    if (kindMatch) {
      if (!current) throw new Error('kind: before any - name: entry');
      current.kind = unquoteScalar(kindMatch[1]);
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
    // A declared kind must be a known unit kind; an unknown value would make
    // produces_kinds pruning silently treat the unit as full-matrix.
    if (u.kind != null && !UNIT_KINDS.includes(u.kind)) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `${u.name} has unknown kind "${u.kind}" (allowed: ${UNIT_KINDS.join(', ')})`,
      };
    }
  }
  const batches = computeBatches(edges);
  if (batches === null) return { ok: false, reason: 'cyclic', detail: 'dependency cycle detected' };
  return { ok: true, units: edges, batches };
};

export {
  SENSOR_RESULT,
  SENSOR_RESULTS,
  SENSOR_APPLICABILITY,
  ALLOWED_SCRIPT_RUNTIMES,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  TOOL_UNAVAILABLE_EXIT,
  SENSOR_VERDICT_MODES,
  SENSOR_SCOPES,
  validateSensorContractFields,
  sensorVerdictMode,
  sensorScope,
  projectConfigFile,
  GRAPH_SENSORS,
  FILE_PATH_FLAG,
  OUTPUT_PATH_FLAG,
  recordSensorsCoverRunRecords,
  sensorDeclaresDispatcherExitCodes,
  SCRIPT_EXIT_TOOL_UNAVAILABLE,
  sensorKind,
  sensorPathFlag,
  scriptTimeoutBound,
  severityGate,
  validateScriptSpec,
  resultFromExit,
  resultFromDispatcherExit,
  dispatcherExitReason,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  parseBoltDag,
};
export default {
  SENSOR_RESULT,
  SENSOR_RESULTS,
  SENSOR_APPLICABILITY,
  ALLOWED_SCRIPT_RUNTIMES,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  TOOL_UNAVAILABLE_EXIT,
  SENSOR_VERDICT_MODES,
  SENSOR_SCOPES,
  validateSensorContractFields,
  sensorVerdictMode,
  sensorScope,
  projectConfigFile,
  GRAPH_SENSORS,
  FILE_PATH_FLAG,
  OUTPUT_PATH_FLAG,
  recordSensorsCoverRunRecords,
  sensorDeclaresDispatcherExitCodes,
  SCRIPT_EXIT_TOOL_UNAVAILABLE,
  sensorKind,
  sensorPathFlag,
  scriptTimeoutBound,
  severityGate,
  validateScriptSpec,
  resultFromExit,
  resultFromDispatcherExit,
  dispatcherExitReason,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  parseBoltDag,
};
