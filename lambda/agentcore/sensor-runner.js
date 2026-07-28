// Sensor runner — the deterministic verification axis, run AFTER an agent
// finishes a stage. The pure decision logic (result enum, severity gate, kind
// classifier, the in-process graph evaluators) lives in the shared
// `v2-sensor-contract.js`; this file is the thin I/O shell: graph reads, S3
// script fetch, child-process spawn, and the SensorRun verdict record.
//
// Two kinds, decided by `sensorKind` (see the contract for WHY the split is
// forced by our architecture):
//
//   - `graph`  — a methodology-document check. The artifact lives in Neptune,
//     so we read its `content` via the graph-writer and evaluate IN-PROCESS
//     (no spawn, no filesystem). `required-sections`, `upstream-coverage`.
//   - `script` — a source-code check. The code lives on the real git checkout
//     init-ws cloned into the workspace, so we glob the workspace for files
//     matching the sensor, materialize the sensor's `.ts` from S3, and spawn it
//     (one run per matching file). `linter`, `type-check`. Inert until a stage
//     actually writes code to the workspace; an empty match → INCONCLUSIVE.
//
// Severity governs the consequence: an `advisory` sensor NEVER holds a stage
// (it records a note + broadcasts); a `blocking` sensor that does not PASS marks
// the stage held. `run-stage` decides what to do with a held verdict.

import { spawn } from 'node:child_process';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  SENSOR_RESULT,
  sensorKind,
  severityGate,
  validateScriptSpec,
  resultFromExit,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  TOOL_UNAVAILABLE_EXIT,
  sensorVerdictMode,
  sensorScope,
  projectConfigFile,
} from '../shared/v2-sensor-contract.js';

// Convert a sensor `matches` glob (e.g. `**/*.{ts,tsx}`, `**/aidlc-docs/**`)
// into a RegExp. Supports the limited syntax the baseline sensors use: `**`,
// `*`, and a single `{a,b}` alternation. Server-controlled input (from the
// block), so we don't need to defend against pathological patterns.
const globToRegExp = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` matches zero or more path segments
      } else {
        re += '[^/]*';
      }
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
      } else {
        const alts = glob
          .slice(i + 1, close)
          .split(',')
          .map((a) => a.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = close;
      }
    } else if ('.+?^$()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
};

// Recursively list workspace files (relative paths), skipping VCS/dependency
// dirs that would never be a stage's code output. Best-effort: a missing dir
// yields []. Bounded by `cap` so a huge monorepo can't run the glob unbounded.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.aidlc',
  '.claude',
  '.kiro',
  '.kiro-data',
  '.opencode-data',
  'build',
  'dist',
  '.next',
  'coverage',
]);
const listFiles = async (root, { cap = 5000 } = {}) => {
  const out = [];
  const walk = async (dir, rel) => {
    if (out.length >= cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  await walk(root, '');
  return out;
};

// Narrow a globbed workspace file list to the files THIS stage actually changed.
//
// Why this exists: `listFiles` walks the whole checkout, so a stage that writes
// only methodology artifacts (which live in Neptune, not on disk) was still
// matching source files left behind by an EARLIER code stage — and then being
// judged on code it never touched. A design stage would spawn the type-checker
// once per pre-existing `.ts` file in the repo.
//
// `changed` comes from the git engine, already re-based onto the workspace root
// (see git-engine#toWorkspaceRelative). Contract:
//   null / not an array → UNKNOWN provenance; do not scope (check everything).
//                          Never silently skip checks when we can't tell.
//   []                   → the stage changed nothing on disk; nothing to check.
//
// Matching is EXACT. A suffix comparison would conflate identically-named files
// across repos in a multi-repo workspace — changing `src/index.ts` in repo A
// would also select repo B's untouched `src/index.ts` and grade the stage on it.
const scopeToChangedFiles = (files, changed) => {
  if (!Array.isArray(changed)) return files;
  if (changed.length === 0) return [];
  const exact = new Set(changed);
  return files.filter((f) => exact.has(f));
};

// Never rejects on a non-zero exit (a failing sensor is data, not an error).
// `spawnFn` injectable for tests.
// Resolve a file to its owning project root: the deepest directory at or above
// it containing the sensor's project config (e.g. `tsconfig.json`). Files with
// no such ancestor share the '' (workspace) root.
const projectRootOf = (file, projectRoots) => {
  let best = '';
  for (const root of projectRoots) {
    if (root === '') continue;
    if (file.startsWith(`${root}/`) && root.length > best.length) best = root;
  }
  return best;
};

// Widen a `project`-scoped sensor from the changed files to every matching file
// in each AFFECTED project.
//
// Required for CORRECTNESS, not efficiency. `tsc --project` compiles the whole
// project and attributes each diagnostic to the file containing it, so a changed
// provider that breaks an untouched consumer reports against the consumer —
// which is not in the changed set. Inspecting only changed files would return a
// false PASS. A change to the project CONFIG alone must widen too, since it can
// break compilation with no source file changing.
const expandToAffectedProjects = ({ globbed, changed, allFiles, configFile }) => {
  const rootOfConfig = (f) => (f === configFile ? '' : f.slice(0, -(configFile.length + 1)));
  const isConfig = (f) => f === configFile || f.endsWith(`/${configFile}`);
  const projectRoots = allFiles.filter(isConfig).map(rootOfConfig);
  const globbedSet = new Set(globbed);

  const affected = new Set();
  for (const c of changed) {
    if (isConfig(c)) affected.add(rootOfConfig(c));
    else if (globbedSet.has(c)) affected.add(projectRootOf(c, projectRoots));
  }
  if (affected.size === 0) return [];
  return globbed.filter((f) => affected.has(projectRootOf(f, projectRoots)));
};

const runChild = ({ file, args, timeoutMs, cwd, env, spawnFn = spawn }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawnFn(file, args, { cwd, env, shell: false });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

// Per-diagnostic stderr budget. Truncated from the TAIL: the interpreter's real
// error is the last thing written, not the banner.
const STDERR_BUDGET = 500;

// Total serialized budget for a SensorRun `detail`. DynamoDB's hard item ceiling
// is 400 KiB and the row carries more than just this field, so stay well under
// it: a wide glob can produce hundreds of file entries, and a `recordSensorRun`
// that exceeds the limit fails — losing the whole verdict, which is far worse
// than losing some diagnostics.
const DETAIL_BUDGET_BYTES = 120_000;

// Number of example files kept per deduped harness failure.
const SAMPLE_FILES = 5;

const tailDiagnostic = (stderr) => {
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (!text) return null;
  if (text.length <= STDERR_BUDGET) return text;
  return `…${text.slice(-STDERR_BUDGET)}`;
};

// Build the sensor-level `detail` from per-file results, bounded in size.
//
// A harness failure hits EVERY file identically (a missing tool, an unloadable
// tsconfig), so repeating the same exitCode+stderr hundreds of times is pure
// duplication AND the thing that can push the row past DynamoDB's item ceiling.
// Identical harness failures collapse into one `harnessFailures` entry carrying a
// count and a few sample files; genuine per-file findings are kept as-is.
//
// Whatever remains is trimmed to a total serialized budget, recording how many
// entries were dropped, so an oversized run degrades to fewer diagnostics rather
// than a silently failed write that loses the entire verdict.
const summarizeFileResults = (fileResults) => {
  const groups = new Map();
  const kept = [];
  for (const entry of fileResults) {
    const reason = entry.detail?.reason;
    // Harness failures are identical across files; genuine verdicts are not.
    if (reason === 'script-error' || reason === 'tool-unavailable') {
      const key = `${reason}|${entry.detail?.exitCode ?? ''}|${entry.detail?.stderr ?? ''}`;
      const g = groups.get(key) ?? {
        reason,
        result: entry.result,
        exitCode: entry.detail?.exitCode ?? null,
        stderr: entry.detail?.stderr ?? null,
        fileCount: 0,
        sampleFiles: [],
      };
      g.fileCount += 1;
      if (g.sampleFiles.length < SAMPLE_FILES) g.sampleFiles.push(entry.file);
      groups.set(key, g);
      continue;
    }
    kept.push({
      file: entry.file,
      result: entry.result,
      timedOut: entry.timedOut,
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }

  const detail = {};
  if (groups.size > 0) detail.harnessFailures = [...groups.values()];
  if (kept.length > 0) detail.files = kept;

  let dropped = 0;
  while (
    detail.files?.length &&
    Buffer.byteLength(JSON.stringify(detail), 'utf8') > DETAIL_BUDGET_BYTES
  ) {
    detail.files.pop();
    dropped += 1;
  }
  if (dropped > 0) {
    detail.filesOmitted = dropped;
    detail.omissionReason = 'detail size budget';
  }
  return detail;
};

// Read a sensor's stdout JSON `pass` field if present; falls back to the exit
// code. Upstream per-sensor scripts exit 0 and carry the verdict in stdout
// `{"pass": bool, ...}`, so the exit code alone under-reports a clean FAIL.
//
// `verdictMode` (see the contract) decides how a NON-ZERO exit with no stdout
// verdict is read. Under 'stdout-json' the script contract guarantees a verdict
// at exit 0, so a non-zero exit means the script itself failed — INCONCLUSIVE,
// because reporting it as FAIL makes a broken harness indistinguishable from real
// defects. Under 'exit-code' (the default for sensors that do not declare a
// mode, including custom scripts from the sensor editor) the classic convention
// is preserved: non-zero means FAIL.
//
// 127 is INCONCLUSIVE in BOTH modes: the upstream scripts reserve it for
// "underlying tool could not be resolved", which is never a code defect.
//
// `exitCode`/`stderr` are retained in the detail so the next occurrence is
// diagnosable from the persisted row alone.
const resultFromScript = ({ exitCode, stdout, stderr = '', verdictMode = 'exit-code' } = {}) => {
  if (exitCode === 0 && typeof stdout === 'string' && stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      if (typeof parsed?.pass === 'boolean') {
        return {
          result: parsed.pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL,
          detail: parsed,
        };
      }
    } catch {
      /* not JSON — fall through to exit-code mapping */
    }
  }

  const diagnostic = tailDiagnostic(stderr);
  const ranButUndecided = (reason) => ({
    result: SENSOR_RESULT.INCONCLUSIVE,
    detail: { reason, exitCode: exitCode ?? null, stderr: diagnostic },
  });

  if (exitCode === TOOL_UNAVAILABLE_EXIT) return ranButUndecided('tool-unavailable');

  const nonZero = exitCode !== 0 && exitCode !== 2 && exitCode !== null && exitCode !== undefined;
  if (nonZero && verdictMode === 'stdout-json') {
    // Exited non-zero without emitting a verdict: the script itself failed
    // (missing tsconfig, unreadable file, config-load error), not the code.
    return ranButUndecided('script-error');
  }

  return {
    result: resultFromExit(exitCode),
    detail: exitCode === 0 ? null : { exitCode: exitCode ?? null, stderr: diagnostic },
  };
};

// Create the sensor runner. `graph` is the graph-writer (for reading produced
// artifact content); `loadBlockScript` fetches a sensor's `.ts` from S3;
// `workspaceDir` is the session checkout root; `substitutions` is the
// SERVER-CONTROLLED template map (e.g. { HARNESS_DIR }).
export const createSensorRunner = ({
  graph,
  loadBlockScript,
  workspaceDir,
  substitutions = {},
  spawnFn = spawn,
  childEnv = process.env,
  // Workspace-relative paths this stage changed on disk, from the git engine.
  // null → unknown, fall back to inspecting the whole checkout.
  changedFiles = null,
} = {}) => {
  // Evaluate one `graph` sensor against the artifacts this stage produced. Each
  // produced artifact's content is read from Neptune and fed to the in-process
  // evaluator. The worst result across the produced artifacts wins (a single
  // FAIL fails the sensor). `consumes` is the upstream artifact-name list.
  const runGraphSensor = async ({ sensor, outputArtifacts = [], consumes = [] }) => {
    // graph-coverage is INTENT-WIDE (typed-item joins across all artifacts),
    // not per-produced-artifact like the content evaluators below.
    if (sensor.sensorId === 'graph-coverage') {
      if (typeof graph.getCoverage !== 'function') {
        return { result: SENSOR_RESULT.INCONCLUSIVE, detail: { reason: 'coverage unavailable' } };
      }
      const coverage = await graph.getCoverage().catch(() => null);
      if (!coverage) {
        return { result: SENSOR_RESULT.INCONCLUSIVE, detail: { reason: 'coverage read failed' } };
      }
      const evalled = evalGraphCoverage(coverage);
      return { result: evalled.result, detail: evalled.detail };
    }
    const produced = (outputArtifacts ?? [])
      .map((o) => ({ artifact: o?.artifact ?? o, optional: Boolean(o?.optional) }))
      .filter((o) => o.artifact);
    if (produced.length === 0) {
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        detail: { reason: 'stage produced no artifacts' },
      };
    }
    const details = [];
    let worst = SENSOR_RESULT.PASS;
    for (const { artifact: artifactType, optional } of produced) {
      // The agent ids artifacts however it likes; look them all up by type.
      const rows = await graph
        .lookupArtifacts({ artifactType, includeContent: true })
        .catch(() => []);
      if (!rows.length) {
        // An absent OPTIONAL artifact is by-design (the stage MAY write it) —
        // no finding, no verdict downgrade. Only required outputs count.
        if (optional) continue;
        details.push({ artifact: artifactType, reason: 'not found in graph' });
        if (worst === SENSOR_RESULT.PASS) worst = SENSOR_RESULT.INCONCLUSIVE;
        continue;
      }
      for (const row of rows) {
        const body = row?.content ?? '';
        const evalled =
          sensor.sensorId === 'upstream-coverage'
            ? evalUpstreamCoverage(body, consumes)
            : evalRequiredSections(body, artifactType, {
                // Strictness ladder: the sensor ROW (authored in the block
                // library) opts a workflow into failing on ABSENT structured
                // blocks. Default lenient — absence is an audit finding until
                // field-test compliance justifies flipping the switch.
                strictStructuredBlocks: Boolean(sensor.strictStructuredBlocks),
              });
        details.push({ artifact: artifactType, id: row.id ?? null, ...evalled.detail });
        if (evalled.result === SENSOR_RESULT.FAIL) worst = SENSOR_RESULT.FAIL;
      }
    }
    return { result: worst, detail: { artifacts: details } };
  };

  // Run one `script` sensor: glob the workspace for files the sensor matches,
  // materialize its script from S3, and spawn it once per matching file. No
  // match → INCONCLUSIVE (the stage produced no code this sensor inspects).
  const runScriptSensor = async ({ sensor, stageId }) => {
    const validation = validateScriptSpec(sensor);
    if (!validation.ok) {
      return { result: SENSOR_RESULT.BLOCKED, detail: { error: validation.error } };
    }
    const spec = validation.spec;

    if (!workspaceDir) {
      return { result: SENSOR_RESULT.INCONCLUSIVE, detail: { reason: 'no workspace' } };
    }
    const matcher = sensor.matches ? globToRegExp(sensor.matches) : null;
    const all = await listFiles(workspaceDir);
    const globbed = matcher ? all.filter((f) => matcher.test(f)) : all;
    if (globbed.length === 0) {
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        detail: { reason: 'no files match', matches: sensor.matches ?? null },
      };
    }
    // Narrow to this stage's own work. `file`-scoped sensors judge each file
    // independently, so the changed files are enough. `project`-scoped sensors
    // (tsc) must widen to every file in each affected project or they report
    // false PASSes — see expandToAffectedProjects.
    const scope = sensorScope(sensor);
    const matched =
      scope === 'project' && Array.isArray(changedFiles)
        ? expandToAffectedProjects({
            globbed,
            changed: changedFiles,
            allFiles: all,
            configFile: projectConfigFile(sensor),
          })
        : scopeToChangedFiles(globbed, changedFiles);
    if (matched.length === 0) {
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        detail: {
          reason: 'no changed files match',
          matches: sensor.matches ?? null,
          scope,
          globbed: globbed.length,
          changed: Array.isArray(changedFiles) ? changedFiles.length : null,
        },
      };
    }

    // Materialize the sensor's script into the runtime-private workspace dir so
    // the spawned interpreter can load it. The block carries the scriptRef.
    const script = await loadBlockScript(sensor).catch(() => '');
    if (!script) {
      return { result: SENSOR_RESULT.BLOCKED, detail: { error: 'sensor has no script' } };
    }
    const scriptDir = path.join(workspaceDir, '.aidlc', 'sensors');
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `${spec.sensorId ?? 'sensor'}.ts`);
    await writeFile(scriptPath, script, 'utf8');
    const { file, args } = buildScriptArgv(spec, { scriptPath, substitutions });

    // One run per matching file (the upstream scripts take a single --file-path).
    const verdictMode = sensorVerdictMode(sensor);
    const fileResults = [];
    let worst = SENSOR_RESULT.PASS;
    for (const rel of matched) {
      const run = await runChild({
        file,
        args: [...args, '--stage', stageId ?? '', '--file-path', rel],
        timeoutMs: spec.timeoutMs,
        cwd: workspaceDir,
        env: childEnv,
        spawnFn,
      });
      const { result, detail } = resultFromScript({ ...run, verdictMode });
      // exitCode/stderr live inside `detail`; summarizeFileResults dedupes
      // identical harness failures rather than repeating them per file.
      fileResults.push({ file: rel, result, timedOut: run.timedOut, detail });
      if (result === SENSOR_RESULT.FAIL) worst = SENSOR_RESULT.FAIL;
      else if (result === SENSOR_RESULT.BLOCKED && worst !== SENSOR_RESULT.FAIL)
        worst = SENSOR_RESULT.BLOCKED;
      else if (
        result === SENSOR_RESULT.INCONCLUSIVE &&
        worst !== SENSOR_RESULT.FAIL &&
        worst !== SENSOR_RESULT.BLOCKED
      )
        worst = SENSOR_RESULT.INCONCLUSIVE;
    }
    return { result: worst, detail: { scope, ...summarizeFileResults(fileResults) } };
  };

  // Run every sensor declared on a stage and return the verdicts. Each verdict:
  // { sensorId, kind, severity, result, held, detail }. Best-effort per sensor —
  // a thrown sensor becomes a BLOCKED verdict, never a stage crash.
  const runStageSensors = async ({
    sensors = [],
    outputArtifacts = [],
    inputArtifacts = [],
    stageId,
  }) => {
    // Upstream-coverage checks that the stage's output references each consumed
    // artifact — an `expectedAbsent` input (producer out of scope, absence by
    // design) can never be legitimately referenced, so threading it through
    // would manufacture a guaranteed false FAIL on every run in a lean scope.
    // Filter them out (our port of upstream PR #482's sensor filter).
    const consumes = (inputArtifacts ?? [])
      .filter((i) => !i?.expectedAbsent)
      .map((i) => i.artifact)
      .filter(Boolean);
    const verdicts = [];
    for (const sensor of sensors) {
      const kind = sensorKind(sensor);
      let outcome;
      try {
        outcome =
          kind === 'graph'
            ? await runGraphSensor({ sensor, outputArtifacts, consumes })
            : await runScriptSensor({ sensor, stageId });
      } catch (e) {
        outcome = { result: SENSOR_RESULT.BLOCKED, detail: { error: e.message } };
      }
      const { held } = severityGate(outcome.result, sensor.severity);
      verdicts.push({
        sensorId: sensor.sensorId,
        kind,
        severity: sensor.severity ?? 'advisory',
        result: outcome.result,
        held,
        detail: outcome.detail ?? null,
      });
    }
    return verdicts;
  };

  return { runStageSensors, runGraphSensor, runScriptSensor };
};

export const __test = {
  globToRegExp,
  listFiles,
  resultFromScript,
  tailDiagnostic,
  scopeToChangedFiles,
  expandToAffectedProjects,
  summarizeFileResults,
  projectRootOf,
};
