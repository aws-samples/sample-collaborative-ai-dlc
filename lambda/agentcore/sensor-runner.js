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
// Severity governs the consequence for a verdict the sensor actually produced:
// an `advisory` sensor NEVER holds a stage (it records a note + broadcasts); a
// `blocking` sensor that does not PASS marks the stage held. A release integrity
// or dependency failure holds either severity, because the pinned check could
// not be executed at all. `run-stage` decides what to do with a held verdict.

import { spawn } from 'node:child_process';
import {
  sensitiveEnvironmentValues,
  redactCredentialText,
  redactDiagnostic,
} from '../shared/safe-event-logger.js';
import { Logger } from '@aws-lambda-powertools/logger';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  SENSOR_RESULT,
  SENSOR_APPLICABILITY,
  sensorKind,
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
  TOOL_UNAVAILABLE_EXIT,
} from '../shared/v2-sensor-contract.js';
import {
  knownChangedFileProvenance,
  normalizeChangedFileProvenance,
  unknownChangedFileProvenance,
} from '../shared/changed-file-provenance.js';

// The capability-registry handler ids (aidlc-capabilities.js RUNTIME_HANDLERS)
// this module implements. Checked against the registry by a test, so a
// capability cannot be declared handled without the code that handles it.
export const IMPLEMENTED_RUNTIME_HANDLERS = Object.freeze([
  'sensor.plane.gate@v1',
  'sensor.plane.write@v1',
]);

const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'sensor-runner' } });

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
  applicability: SENSOR_APPLICABILITY.NOT_APPLICABLE,
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
// dirs that would never be a stage's code output. Completeness is part of the
// result: a read failure or cap hit means absence cannot prove inapplicability.
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
const MAX_ENUMERATION_FAILURES = 20;

const listFiles = async (root, { cap = 5000, readdirFn = readdir } = {}) => {
  const limit = Number.isSafeInteger(cap) && cap >= 0 ? cap : 5000;
  const files = [];
  const failures = [];
  let failuresOmitted = 0;
  let truncated = false;

  const walk = async (dir, rel) => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdirFn(dir, { withFileTypes: true });
    } catch (error) {
      if (failures.length < MAX_ENUMERATION_FAILURES) {
        failures.push({
          directory: rel || '.',
          code: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
        });
      } else {
        failuresOmitted += 1;
      }
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(childRel);
      }
    }
  };

  await walk(root, '');
  const complete = !truncated && failures.length === 0;
  return {
    files,
    complete,
    scanned: files.length,
    cap: limit,
    ...(truncated ? { reason: 'file_limit_exceeded' } : {}),
    ...(!truncated && failures.length > 0 ? { reason: 'directory_read_failed' } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    ...(failuresOmitted > 0 ? { failuresOmitted } : {}),
  };
};

const summarizeEnumeration = ({
  complete,
  scanned,
  cap,
  reason = null,
  failures = [],
  failuresOmitted = 0,
}) => ({
  complete,
  scanned,
  cap,
  ...(reason ? { reason } : {}),
  ...(failures.length > 0 ? { failures } : {}),
  ...(failuresOmitted > 0 ? { failuresOmitted } : {}),
});

// Narrow a globbed workspace file list to the paths attributed to this stage.
// Matching is exact: suffix matching would conflate identically named files in
// different repositories of a multi-repository workspace. Unknown provenance
// deliberately widens to every match.
const scopeToChangedFiles = (files, provenance) => {
  const normalized = normalizeChangedFileProvenance(provenance);
  if (normalized.state === 'unknown') return files;
  if (normalized.files.length === 0) return [];
  const exact = new Set(normalized.files);
  return files.filter((file) => exact.has(file));
};

const projectRootOf = (file, projectRoots) => {
  let best = '';
  for (const root of projectRoots) {
    if (root && file.startsWith(`${root}/`) && root.length > best.length) best = root;
  }
  return best;
};

// Project-scoped analyzers compile an entire project and may report a diagnostic
// against an untouched consumer. Widen changed-file provenance to every matched
// file in each affected project so those diagnostics cannot become false PASSes.
const expandToAffectedProjects = ({ globbed, changed, allFiles, configFile }) => {
  const rootOfConfig = (file) =>
    file === configFile ? '' : file.slice(0, -(configFile.length + 1));
  const isConfig = (file) => file === configFile || file.endsWith(`/${configFile}`);
  const projectRoots = allFiles.filter(isConfig).map(rootOfConfig);
  const allRoots = new Set(projectRoots);
  const globbedSet = new Set(globbed);
  const affected = new Set();

  for (const file of changed) {
    if (isConfig(file)) {
      const root = rootOfConfig(file);
      allRoots.add(root);
      affected.add(root);
    } else if (globbedSet.has(file)) {
      affected.add(projectRootOf(file, [...allRoots]));
    } else {
      // Deleted paths are absent from the workspace walk but still affect the
      // deepest surviving project root that owned them.
      affected.add(projectRootOf(file, [...allRoots]));
    }
  }

  if (affected.size === 0) return [];
  const roots = [...allRoots];
  return globbed.filter((file) => affected.has(projectRootOf(file, roots)));
};

// Select runnable files and preserve whether that selection was proven or had
// to be widened. Unknown provenance scans every glob match and stays UNKNOWN so
// a blocking harness failure cannot be mistaken for an irrelevant check. Only
// a known provenance set with no relevant files is NOT_APPLICABLE.
const selectSensorFiles = ({ globbed, provenance, scope, allFiles, configFile, enumeration }) => {
  const normalized = normalizeChangedFileProvenance(provenance);
  if (!enumeration?.complete) {
    return {
      applicability: SENSOR_APPLICABILITY.UNKNOWN,
      files: [...globbed],
      provenance: normalized,
      selectionComplete: false,
    };
  }
  if (normalized.state === 'unknown') {
    return {
      applicability: SENSOR_APPLICABILITY.UNKNOWN,
      files: [...globbed],
      provenance: normalized,
      selectionComplete: true,
    };
  }

  const files =
    scope === 'project'
      ? expandToAffectedProjects({
          globbed,
          changed: normalized.files,
          allFiles,
          configFile,
        })
      : scopeToChangedFiles(globbed, normalized);
  return {
    applicability:
      files.length > 0 ? SENSOR_APPLICABILITY.APPLICABLE : SENSOR_APPLICABILITY.NOT_APPLICABLE,
    files,
    provenance: normalized,
    selectionComplete: true,
  };
};

// Sensor scripts need only executable discovery, a writable package-manager home/temp
// location, and locale/timezone settings. Build a new object instead of forwarding
// the AgentCore environment: repository credentials, AWS credentials, provider
// tokens, MCP secrets, proxy credentials, and unrelated CLI state must never reach
// deterministic sensor children.
const SENSOR_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
]);

const sensorChildEnv = (source = {}) => {
  const env = {};
  for (const name of SENSOR_ENV_ALLOWLIST) {
    if (typeof source?.[name] === 'string') env[name] = source[name];
  }
  return env;
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
    const child = spawnFn(file, args, { cwd, env: sensorChildEnv(env), shell: false });

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

const STDERR_BUDGET = 500;
const DETAIL_BUDGET_BYTES = 120_000;
const SAMPLE_FILES = 5;
const tailDiagnostic = (stderr, sensitiveValues = []) => {
  const text =
    typeof stderr === 'string' ? redactCredentialText(stderr, sensitiveValues).trim() : '';
  if (!text) return null;
  if (text.length <= STDERR_BUDGET) return text;
  return `…${text.slice(-STDERR_BUDGET)}`;
};

const OMISSION_REASON = 'detail size budget';
const jsonByteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const JSON_KEY_BYTES = Object.freeze({
  harnessFailures: jsonByteLength('harnessFailures'),
  files: jsonByteLength('files'),
  filesOmitted: jsonByteLength('filesOmitted'),
  omissionReason: jsonByteLength('omissionReason'),
});
const OMISSION_REASON_BYTES = jsonByteLength(OMISSION_REASON);
const jsonArrayByteLength = (count, contentBytes) => 2 + contentBytes + Math.max(0, count - 1);

// Calculate the exact encoded size without repeatedly serializing the growing
// detail object. Each candidate is serialized once; all subsequent accounting
// is constant time, so high-cardinality sensor output remains linear.
const summarizedDetailByteLength = ({
  harnessFailureCount,
  harnessFailureBytes,
  fileCount,
  fileBytes,
  filesOmitted,
}) => {
  let bytes = 2; // opening and closing object braces
  let propertyCount = 0;
  const addProperty = (key, valueBytes) => {
    if (propertyCount > 0) bytes += 1; // comma between object properties
    bytes += JSON_KEY_BYTES[key] + 1 + valueBytes; // key, colon, value
    propertyCount += 1;
  };

  if (harnessFailureCount > 0) {
    addProperty('harnessFailures', jsonArrayByteLength(harnessFailureCount, harnessFailureBytes));
  }
  if (fileCount > 0) addProperty('files', jsonArrayByteLength(fileCount, fileBytes));
  if (filesOmitted > 0) {
    addProperty('filesOmitted', String(filesOmitted).length);
    addProperty('omissionReason', OMISSION_REASON_BYTES);
  }
  return bytes;
};

// Collapse repeated harness failures and keep the persisted SensorRun detail
// below the DynamoDB item ceiling. Grouping consumes only the redacted detail:
// different secret values in otherwise-identical failures collapse together,
// and no raw credential can be retained in a key or copied into persistence.
// Candidates retain first-seen order. The byte-accounting pass includes an
// entry only when the complete final shape (including omission metadata) fits.
const summarizeFileResults = (fileResults, sensitiveValues = []) => {
  const groups = new Map();
  const files = [];
  for (const entry of fileResults) {
    const safeDetail = redactDiagnostic(entry.detail, sensitiveValues);
    const reason = safeDetail?.reason;
    if (reason === 'script-error' || reason === 'tool-unavailable') {
      const key = `${reason}|${safeDetail?.exitCode ?? ''}|${safeDetail?.stderr ?? ''}`;
      const group = groups.get(key) ?? {
        reason,
        result: entry.result,
        exitCode: safeDetail?.exitCode ?? null,
        stderr: safeDetail?.stderr ?? null,
        fileCount: 0,
        sampleFiles: [],
      };
      group.fileCount += 1;
      if (group.sampleFiles.length < SAMPLE_FILES) group.sampleFiles.push(entry.file);
      groups.set(key, group);
    } else {
      files.push({
        file: entry.file,
        result: entry.result,
        timedOut: entry.timedOut,
        ...(safeDetail ? { detail: safeDetail } : {}),
      });
    }
  }

  const harnessFailures = [...groups.values()];
  const totalRepresentedFiles =
    files.length + harnessFailures.reduce((total, group) => total + group.fileCount, 0);
  const includedHarnessFailures = [];
  const includedFiles = [];
  const size = {
    harnessFailureCount: 0,
    harnessFailureBytes: 0,
    fileCount: 0,
    fileBytes: 0,
  };
  let representedFiles = 0;

  const includeWhenBounded = (entry, representedCount, kind) => {
    const entryBytes = jsonByteLength(entry);
    const harnessFailure = kind === 'harnessFailure';
    const projected = {
      harnessFailureCount: size.harnessFailureCount + (harnessFailure ? 1 : 0),
      harnessFailureBytes: size.harnessFailureBytes + (harnessFailure ? entryBytes : 0),
      fileCount: size.fileCount + (harnessFailure ? 0 : 1),
      fileBytes: size.fileBytes + (harnessFailure ? 0 : entryBytes),
      filesOmitted: totalRepresentedFiles - representedFiles - representedCount,
    };
    if (summarizedDetailByteLength(projected) > DETAIL_BUDGET_BYTES) return;

    Object.assign(size, projected);
    representedFiles += representedCount;
    if (harnessFailure) includedHarnessFailures.push(entry);
    else includedFiles.push(entry);
  };

  for (const group of harnessFailures) {
    includeWhenBounded(group, group.fileCount, 'harnessFailure');
  }
  for (const file of files) includeWhenBounded(file, 1, 'file');

  const detail = {};
  if (includedHarnessFailures.length > 0) detail.harnessFailures = includedHarnessFailures;
  if (includedFiles.length > 0) detail.files = includedFiles;
  const filesOmitted = totalRepresentedFiles - representedFiles;
  if (filesOmitted > 0) {
    detail.filesOmitted = filesOmitted;
    detail.omissionReason = OMISSION_REASON;
  }
  return detail;
};

// Read the declared verdict protocol. Upstream stdout-json sensors use non-zero
// exits for harness failures, while custom exit-code sensors retain the classic
// non-zero-is-FAIL convention. A stdout-json sensor may report PASS or FAIL only
// by emitting exactly one JSON value with a boolean `pass` field on exit zero.
//
// `dispatcherExitCodes` is the contract the pinned catalog authored (see
// `sensorDeclaresDispatcherExitCodes`). When a catalog declares it, the
// documented non-zero exits are read by that contract instead of the default
// mapping below: 127 is the script reporting that its tool or that tool's
// config could not be used, which its own dispatcher answers with a pass rather
// than a finding, and any other non-zero exit keeps its verdict but now carries
// the exit code and a stderr excerpt naming the breakage.
const resultFromScript = ({
  exitCode,
  stdout,
  stderr = '',
  verdictMode = 'exit-code',
  sensitiveValues = [],
  dispatcherExitCodes = false,
} = {}) => {
  const stdoutText = typeof stdout === 'string' ? stdout.trim() : '';
  const diagnostic = tailDiagnostic(stderr, sensitiveValues);
  const inconclusive = (reason, extra = {}) => ({
    result: SENSOR_RESULT.INCONCLUSIVE,
    detail: redactDiagnostic(
      {
        reason,
        exitCode: exitCode ?? null,
        stderr: diagnostic,
        ...extra,
      },
      sensitiveValues,
    ),
  });

  if (exitCode === 0 && verdictMode === 'stdout-json') {
    if (!stdoutText) return inconclusive('missing-verdict', { stdout: null });

    let parsed;
    try {
      // Parse the complete trimmed stream, not only its final line. This rejects
      // leading/trailing log output and multiple values instead of silently
      // accepting a valid-looking fragment as the sensor verdict.
      parsed = JSON.parse(stdoutText);
    } catch {
      return inconclusive('invalid-verdict', {
        stdout: tailDiagnostic(stdoutText, sensitiveValues),
      });
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return inconclusive('invalid-verdict', {
        stdout: tailDiagnostic(stdoutText, sensitiveValues),
      });
    }
    if (typeof parsed.pass !== 'boolean') {
      return inconclusive('invalid-verdict', {
        stdout: tailDiagnostic(stdoutText, sensitiveValues),
      });
    }
    return {
      result: parsed.pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL,
      detail: redactDiagnostic(parsed, sensitiveValues),
    };
  }

  // Preserve the existing optional JSON verdict behavior for exit-code sensors.
  // Their declared protocol still permits exit-code fallback when output is
  // absent or malformed.
  if (exitCode === 0 && stdoutText) {
    try {
      const parsed = JSON.parse(stdoutText.split(/\r?\n/).at(-1));
      if (typeof parsed?.pass === 'boolean') {
        return {
          result: parsed.pass ? SENSOR_RESULT.PASS : SENSOR_RESULT.FAIL,
          detail: redactDiagnostic(parsed, sensitiveValues),
        };
      }
    } catch {
      /* exit-code sensors fall through to their declared exit-code mapping */
    }
  }

  // A catalog that authored the dispatcher's exit-code contract reads its own
  // documented exits. That is strictly narrower than the default mapping that
  // follows, so a catalog which declares nothing is unaffected.
  if (dispatcherExitCodes && Number.isInteger(exitCode) && exitCode !== 0) {
    const dispatched = resultFromDispatcherExit({ exitCode, stderr });
    return {
      result: dispatched.result,
      detail: redactDiagnostic(dispatched.detail, sensitiveValues),
    };
  }

  if (exitCode === TOOL_UNAVAILABLE_EXIT) return inconclusive('tool-unavailable');
  const nonZero = exitCode !== 0 && exitCode !== 2 && exitCode != null;
  if (nonZero && verdictMode === 'stdout-json') return inconclusive('script-error');

  return {
    result: resultFromExit(exitCode),
    detail:
      exitCode === 0
        ? null
        : redactDiagnostic({ exitCode: exitCode ?? null, stderr: diagnostic }, sensitiveValues),
  };
};

const STAGE_BUDGET_EXHAUSTED = 'the stage budget was exhausted before this file was examined';

// A pinned sensor whose script could not be verified or read has not produced a
// verdict at all, so its severity does not apply — the check is missing, which is
// the drift the release pin exists to prevent. run-stage applies the same test to
// the persona and knowledge bodies its ensemble sessions read.
//
// `runtime_file_missing` is listed explicitly because it does not carry the
// `release_` prefix: the resolver raises it when a release manifest lists an
// object that is absent from storage. An incompletely published closure is a
// release integrity failure exactly like a digest mismatch, so it must hold the
// stage rather than degrade to a best-effort advisory note.
export const isReleaseDependencyError = (error) =>
  ['ReleaseResolverError', 'AidlcReleaseError'].includes(error?.name) &&
  (String(error.code ?? '').startsWith('release_') ||
    ['runtime_file_missing', 'unpinned_user_block', 'user_block_missing'].includes(error.code));

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
  changedFileProvenance = null,
  fileListOptions = {},
  // Milliseconds left of the stage's wall-clock budget, read per child. The
  // stage deadline — not the contract's ceiling — is what keeps a long sensor
  // from outliving the container. Absent (unpinned, a policy-free release, or a
  // caller with no deadline) leaves the authored budget alone.
  remainingStageMs = null,
  // Resolves the sibling modules a pinned sensor script imports, so the spawned
  // interpreter can load them. Absent in legacy mode, where a sensor script is
  // one self-contained object.
  loadScriptClosure = null,
} = {}) => {
  const sensitiveValues = sensitiveEnvironmentValues(childEnv);
  const readRemainingStageMs = () =>
    typeof remainingStageMs === 'function' ? remainingStageMs() : remainingStageMs;
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
                recordTimestampExempt: Boolean(sensor.recordTimestampExempt),
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
      return {
        result: SENSOR_RESULT.BLOCKED,
        applicability: SENSOR_APPLICABILITY.UNKNOWN,
        detail: { error: validation.error },
      };
    }
    const spec = validation.spec;

    if (!workspaceDir) {
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        applicability: SENSOR_APPLICABILITY.UNKNOWN,
        detail: { reason: 'no workspace' },
      };
    }
    const matcher = sensor.matches ? globToRegExp(sensor.matches) : null;
    const enumeration = await listFiles(workspaceDir, fileListOptions);
    const all = enumeration.files;
    const globbed = matcher ? all.filter((file) => matcher.test(file)) : all;
    const onGatePlane = gatePlane(sensor, plane);
    // Explicit provenance is authoritative, including an unknown reason. Keep
    // the older changedFiles argument for direct write-plane callers only.
    const provenance = normalizeChangedFileProvenance(
      changedFileProvenance ??
        (sensor.fireOn === FIRE_ON_WRITE && Array.isArray(changedFiles)
          ? knownChangedFileProvenance(changedFiles)
          : unknownChangedFileProvenance('not_provided')),
    );
    const scope = spec.scope;
    const selection = selectSensorFiles({
      globbed,
      // Gate sensors inspect every existing deliverable after repair, even
      // when this attempt has a known empty delta.
      provenance: onGatePlane ? knownChangedFileProvenance(all) : provenance,
      scope,
      allFiles: all,
      configFile: spec.projectConfig,
      enumeration,
    });

    const { applicability, files: matched, selectionComplete } = selection;
    if (!selectionComplete) {
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        applicability,
        detail: {
          reason: 'workspace enumeration incomplete',
          matches: sensor.matches ?? null,
          scope,
          applicability,
          provenance,
          enumeration: summarizeEnumeration(enumeration),
        },
      };
    }
    if (matched.length === 0) {
      if (onGatePlane) {
        return {
          ...notApplicable('no matching deliverable at the gate', {
            fireOn: FIRE_ON_GATE,
            matches: sensor.matches ?? null,
            provenance,
          }),
          applicability,
        };
      }
      const reason = globbed.length === 0 ? 'no files match' : 'no changed files match';
      return {
        result: SENSOR_RESULT.INCONCLUSIVE,
        applicability,
        detail: {
          reason,
          matches: sensor.matches ?? null,
          scope,
          applicability,
          provenance,
          globbed: globbed.length,
          changed: provenance.state === 'known' ? provenance.files.length : null,
        },
      };
    }

    // Materialize the sensor's script into the runtime-private workspace dir so
    // the spawned interpreter can load it. The block carries the scriptRef.
    // A release-mode integrity failure surfaces as BLOCKED with the reason
    // attached rather than a bare "no script": the verdict must not read as if
    // the sensor simply had nothing to run. It also holds regardless of
    // severity, because the pinned check could not be executed at all.
    let script = '';
    let scriptError = null;
    try {
      script = await loadBlockScript(sensor);
    } catch (error) {
      if (isReleaseDependencyError(error)) {
        return {
          result: SENSOR_RESULT.BLOCKED,
          fatal: true,
          detail: {
            error: error.message,
            name: error.name,
            code: error.code,
            releaseIntegrityFailure: true,
            ...(error.details ? { details: error.details } : {}),
          },
        };
      }
      // Legacy and user-block loader errors stay best-effort: a missing script
      // has always produced an advisory note rather than holding the stage.
      scriptError = error;
    }
    if (!script) {
      // The verdict is shown to users, so it keeps the generic text; the loader's
      // own message (which can name storage keys) goes to the operator log only.
      if (scriptError) {
        logger.warn(
          'sensor script could not be loaded',
          redactDiagnostic(
            {
              sensorId: spec.sensorId ?? null,
              name: scriptError?.name ?? null,
              code: scriptError?.code ?? null,
              msg: scriptError?.message ?? String(scriptError),
            },
            sensitiveValues,
          ),
        );
      }
      return {
        result: SENSOR_RESULT.BLOCKED,
        applicability,
        detail: { error: 'sensor has no script' },
      };
    }
    // Resolve the script's import closure BEFORE writing anything: an
    // incomplete closure must leave no half-materialized script behind for a
    // later pass to pick up.
    let closureFiles = [];
    if (loadScriptClosure) {
      try {
        closureFiles = await loadScriptClosure(spec.sensorId, script);
      } catch (error) {
        if (!isReleaseDependencyError(error)) throw error;
        return {
          result: SENSOR_RESULT.BLOCKED,
          fatal: true,
          detail: {
            error: error.message,
            name: error.name,
            code: error.code,
            releaseIntegrityFailure: true,
            ...(error.details ? { details: error.details } : {}),
          },
        };
      }
    }
    const scriptDir = path.join(workspaceDir, '.aidlc', 'sensors');
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `${spec.sensorId ?? 'sensor'}.ts`);
    await writeFile(scriptPath, script, 'utf8');
    for (const dependency of closureFiles) {
      const dependencyPath = path.resolve(scriptDir, dependency.relativePath);
      await mkdir(path.dirname(dependencyPath), { recursive: true });
      await writeFile(dependencyPath, dependency.content, 'utf8');
    }
    const { file, args } = buildScriptArgv(spec, { scriptPath, substitutions });

    // One run per matching file (each upstream script takes a single path, on
    // the flag its own manifest declares). The stage budget is re-read
    // immediately before EVERY launch — after materialization, which itself
    // costs time — because the sampled allowance of the first file is not the
    // allowance the tenth one has left. An exhausted budget stops the pass: the
    // files it never reached are recorded non-PASS, so an expired stage never
    // reads as a clean sweep.
    const verdictMode = spec.verdictMode;
    const fileResults = [];
    let worst = SENSOR_RESULT.PASS;
    let tightest = null;
    let exhausted = false;
    const dispatcherExitCodes = Boolean(sensor.dispatcherExitCodes);
    for (const rel of matched) {
      const bound = scriptTimeoutBound(spec.timeoutSeconds, readRemainingStageMs());
      if (bound.exhausted) {
        exhausted = true;
        break;
      }
      if (tightest === null || bound.timeoutMs < tightest.timeoutMs) tightest = bound;
      const run = await runChild({
        file,
        args: [...args, '--stage', stageId ?? '', spec.pathFlag, rel],
        timeoutMs: bound.timeoutMs,
        cwd: workspaceDir,
        env: childEnv,
        spawnFn,
      });
      const { result, detail } = resultFromScript({
        ...run,
        verdictMode,
        sensitiveValues,
        dispatcherExitCodes,
      });
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
    if (exhausted) {
      for (const rel of matched.slice(fileResults.length)) {
        fileResults.push({
          file: rel,
          result: SENSOR_RESULT.BLOCKED,
          timedOut: false,
          detail: { error: STAGE_BUDGET_EXHAUSTED },
        });
      }
      if (worst !== SENSOR_RESULT.FAIL) worst = SENSOR_RESULT.BLOCKED;
    }
    // The reason the gate finding and the activity note read lives at the sensor
    // level, not on the per-file rows, so the contract's explanation is
    // summarized here too. Read off the unsummarized rows, because grouping
    // collapses them. Null when no file hit a documented exit, which keeps every
    // other sweep's detail exactly as it was.
    const exitReason = dispatcherExitCodes
      ? dispatcherExitReason(fileResults, matched.length)
      : null;
    return {
      result: worst,
      applicability,
      detail: {
        scope,
        applicability,
        provenance,
        ...summarizeFileResults(fileResults, sensitiveValues),
        ...(exitReason ? { reason: exitReason } : {}),
        // A budget the stage deadline shortened is reported, so a run cut short
        // does not read as the sensor's own timeout. The narrowest bound any
        // launch got is the one reported; exhaustion without a launch contributes
        // no bound. Callers with no deadline retain their legacy detail.
        ...(tightest?.boundedBy === 'stage-deadline'
          ? { timeoutMs: tightest.timeoutMs, boundedBy: tightest.boundedBy }
          : {}),
        ...(exhausted ? { stageBudgetExhausted: true } : {}),
      },
    };
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
        outcome = {
          result: SENSOR_RESULT.BLOCKED,
          applicability: SENSOR_APPLICABILITY.UNKNOWN,
          detail: { error: e.message },
        };
      }
      const applicability = outcome.applicability ?? SENSOR_APPLICABILITY.APPLICABLE;
      const { held: severityHeld } = severityGate(outcome.result, sensor.severity, applicability);
      const held = outcome.fatal === true || severityHeld;
      verdicts.push({
        sensorId: sensor.sensorId,
        kind,
        severity: sensor.severity ?? 'advisory',
        result: outcome.result,
        applicability,
        held,
        detail: redactDiagnostic(outcome.detail ?? null, sensitiveValues),
        // Only a plane-aware call states the plane, so a legacy verdict object
        // stays exactly the shape every historical consumer reads.
        ...(plane ? { plane } : {}),
      });
    }
    return verdicts;
  };

  return { runStageSensors, runGraphSensor, runScriptSensor };
};

export const __test = {
  notApplicable,
  globToRegExp,
  listFiles,
  resultFromScript,
  scopeToChangedFiles,
  expandToAffectedProjects,
  selectSensorFiles,
  projectRootOf,
  tailDiagnostic,
  summarizeFileResults,
  redactCredentialText,
  redactDiagnostic,
  sensitiveEnvironmentValues,
};
