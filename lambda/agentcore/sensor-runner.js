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
} from '../shared/v2-sensor-contract.js';

// `fire_on` (upstream ≥2.7.0) declares WHEN a sensor fires:
//   `write` — when a matching file is written, and
//   `gate`  — once per matching EXISTING deliverable as the stage opens its gate.
// Collaborative has no per-write hook (the CLI owns the edit loop), so `write`
// stays approximated post-agent: it narrows the candidate set to the files this
// stage attempt actually changed. `gate` IS reproduced, but only because the
// caller runs it in its own pass AFTER the reviewer loop resolves — see
// `runStageSensors({ planes })`. A sensor without `fire_on` keeps today's
// behavior exactly, and `planes: null` keeps today's single-pass behavior.
const FIRE_ON_WRITE = 'write';
const FIRE_ON_GATE = 'gate';

// Which pass a sensor belongs to. Everything that does not ask for the gate
// plane runs on the write plane, which is where an unauthored `fire_on` has
// always run.
const planeOf = (sensor) => (sensor?.fireOn === FIRE_ON_GATE ? FIRE_ON_GATE : FIRE_ON_WRITE);

// A sensor is on the gate plane when it asked to be AND the caller is running
// that pass. `plane: null` is the legacy single-pass call, where a `gate` sensor
// still recorded the not-applicable verdict — so the shortcut stays reachable.
const gatePlane = (sensor, plane) =>
  sensor?.fireOn === FIRE_ON_GATE && (plane == null || plane === FIRE_ON_GATE);

// `not-applicable` is reported as INCONCLUSIVE with an explicit `notApplicable`
// detail flag rather than a new result enum: SensorRun rows, the severity gate,
// and the UI all key off the existing four-value vocabulary, and widening it
// here would change how every historical verdict is read.
const notApplicable = (reason, extra = {}) => ({
  result: SENSOR_RESULT.INCONCLUSIVE,
  detail: { notApplicable: true, reason, ...extra },
});

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

// Spawn a child and collect stdout/stderr + exit, enforcing a hard timeout.
// Never rejects on a non-zero exit (a failing sensor is data, not an error).
// `spawnFn` injectable for tests.
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

// Read a sensor's stdout JSON `pass` field if present; falls back to the exit
// code. Upstream per-sensor scripts exit 0 and carry the verdict in stdout
// `{"pass": bool, ...}`, so the exit code alone under-reports a clean FAIL.
const resultFromScript = ({ exitCode, stdout }) => {
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
  return { result: resultFromExit(exitCode), detail: null };
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
} = {}) => {
  // Evaluate one `graph` sensor against the artifacts this stage produced. Each
  // produced artifact's content is read from Neptune and fed to the in-process
  // evaluator. The worst result across the produced artifacts wins (a single
  // FAIL fails the sensor). `consumes` is the upstream artifact-name list.
  const runGraphSensor = async ({ sensor, outputArtifacts = [], consumes = [], plane = null }) => {
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
    let deliverables = 0;
    for (const { artifact: artifactType, optional } of produced) {
      // The agent ids artifacts however it likes; look them all up by type.
      const rows = await graph
        .lookupArtifacts({ artifactType, includeContent: true })
        .catch(() => []);
      if (!rows.length) {
        // An absent OPTIONAL artifact is by-design (the stage MAY write it) —
        // no finding, no verdict downgrade. Only required outputs count.
        if (optional) continue;
        // A MISSING REQUIRED deliverable is a finding, not a not-applicable: it
        // is recorded in `details` and therefore suppresses the gate-plane
        // not-applicable shortcut below (which only fires when the sensor found
        // nothing to say at all).
        details.push({ artifact: artifactType, reason: 'not found in graph' });
        if (worst === SENSOR_RESULT.PASS) worst = SENSOR_RESULT.INCONCLUSIVE;
        continue;
      }
      deliverables += rows.length;
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
    if (gatePlane(sensor, plane) && deliverables === 0 && details.length === 0) {
      return notApplicable('no matching deliverable at the gate', { fireOn: FIRE_ON_GATE });
    }
    return { result: worst, detail: { artifacts: details } };
  };

  // Run one `script` sensor: glob the workspace for files the sensor matches,
  // materialize its script from S3, and spawn it once per matching file. No
  // match → INCONCLUSIVE (the stage produced no code this sensor inspects).
  // With `fire_on: write` the candidate set narrows to `changedFiles` (this
  // attempt's git diff); when that list is unavailable the sweep falls back to
  // the whole workspace, which is the documented approximation. The GATE plane
  // never narrows: its whole purpose is the final bytes of every deliverable,
  // not the delta one attempt happened to touch.
  const runScriptSensor = async ({ sensor, stageId, changedFiles = null, plane = null }) => {
    const validation = validateScriptSpec(sensor);
    if (!validation.ok) {
      return { result: SENSOR_RESULT.BLOCKED, detail: { error: validation.error } };
    }
    const spec = validation.spec;

    if (!workspaceDir) {
      return { result: SENSOR_RESULT.INCONCLUSIVE, detail: { reason: 'no workspace' } };
    }
    const matcher = sensor.matches ? globToRegExp(sensor.matches) : null;
    const onGatePlane = gatePlane(sensor, plane);
    const writePlane =
      !onGatePlane && sensor.fireOn === FIRE_ON_WRITE && Array.isArray(changedFiles);
    const all = writePlane ? changedFiles : await listFiles(workspaceDir);
    const matched = matcher ? all.filter((f) => matcher.test(f)) : all;
    if (matched.length === 0) {
      if (onGatePlane) {
        return notApplicable('no matching deliverable at the gate', {
          fireOn: FIRE_ON_GATE,
          matches: sensor.matches ?? null,
        });
      }
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        detail: {
          reason: 'no files match',
          matches: sensor.matches ?? null,
          ...(writePlane ? { fireOn: FIRE_ON_WRITE, changedFiles: changedFiles.length } : {}),
        },
      };
    }

    // Materialize the sensor's script into the runtime-private workspace dir so
    // the spawned interpreter can load it. The block carries the scriptRef.
    // A release-mode integrity failure surfaces as BLOCKED with the reason
    // attached rather than a bare "no script": the verdict must not read as if
    // the sensor simply had nothing to run.
    let script = '';
    let scriptError = null;
    try {
      script = await loadBlockScript(sensor);
    } catch (error) {
      scriptError = error;
    }
    if (!script) {
      return {
        result: SENSOR_RESULT.BLOCKED,
        detail: scriptError
          ? {
              error: scriptError?.message ?? String(scriptError),
              ...(scriptError?.name ? { name: scriptError.name } : {}),
              ...(scriptError?.code ? { code: scriptError.code } : {}),
              ...(scriptError?.details ? { details: scriptError.details } : {}),
            }
          : { error: 'sensor has no script' },
      };
    }
    const scriptDir = path.join(workspaceDir, '.aidlc', 'sensors');
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `${spec.sensorId ?? 'sensor'}.ts`);
    await writeFile(scriptPath, script, 'utf8');
    const { file, args } = buildScriptArgv(spec, { scriptPath, substitutions });

    // One run per matching file (the upstream scripts take a single --file-path).
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
      const { result, detail } = resultFromScript(run);
      fileResults.push({ file: rel, result, timedOut: run.timedOut, detail });
      if (result === SENSOR_RESULT.FAIL) worst = SENSOR_RESULT.FAIL;
      else if (result === SENSOR_RESULT.BLOCKED && worst !== SENSOR_RESULT.FAIL)
        worst = SENSOR_RESULT.BLOCKED;
    }
    return { result: worst, detail: { files: fileResults } };
  };

  // Run every sensor declared on a stage and return the verdicts. Each verdict:
  // { sensorId, kind, severity, result, held, detail, plane }. Best-effort per
  // sensor — a thrown sensor becomes a BLOCKED verdict, never a stage crash.
  //
  // `planes` selects which pass this call runs. `null` (the default) is the
  // legacy single pass over every sensor and is what an unpinned / 2.3.3 run
  // still does, byte for byte. A plane-aware caller runs `['write']` post-agent
  // and `['gate']` after the reviewer loop resolves, so a gate verdict is taken
  // on the bytes the human will actually approve.
  const runStageSensors = async ({
    sensors = [],
    outputArtifacts = [],
    inputArtifacts = [],
    stageId,
    changedFiles = null,
    planes = null,
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
    const selected = Array.isArray(planes)
      ? sensors.filter((sensor) => planes.includes(planeOf(sensor)))
      : sensors;
    const verdicts = [];
    for (const sensor of selected) {
      const kind = sensorKind(sensor);
      const plane = Array.isArray(planes) ? planeOf(sensor) : null;
      let outcome;
      try {
        outcome =
          kind === 'graph'
            ? await runGraphSensor({ sensor, outputArtifacts, consumes, plane })
            : await runScriptSensor({ sensor, stageId, changedFiles, plane });
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
        // Only a plane-aware call states the plane, so a legacy verdict object
        // stays exactly the shape every historical consumer reads.
        ...(plane ? { plane } : {}),
      });
    }
    return verdicts;
  };

  return { runStageSensors, runGraphSensor, runScriptSensor };
};

export const __test = { globToRegExp, listFiles, resultFromScript, notApplicable };
