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
  SENSOR_APPLICABILITY,
  sensorKind,
  severityGate,
  validateScriptSpec,
  resultFromExit,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  TOOL_UNAVAILABLE_EXIT,
} from '../shared/v2-sensor-contract.js';
import {
  normalizeChangedFileProvenance,
  unknownChangedFileProvenance,
} from '../shared/changed-file-provenance.js';

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
const REDACTED_DIAGNOSTIC = '[REDACTED]';
const CREDENTIAL_LABEL =
  '[A-Za-z0-9_-]*(?:secret|password|passwd|token|credential|private[-_]?key|api[-_]?key|authorization|cookie|signature)[A-Za-z0-9_-]*';
const JSON_DOUBLE_CREDENTIAL_PATTERN = new RegExp(
  `(["']${CREDENTIAL_LABEL}["']\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  'gi',
);
const JSON_SINGLE_CREDENTIAL_PATTERN = new RegExp(
  `(["']${CREDENTIAL_LABEL}["']\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`,
  'gi',
);
const ASSIGNED_CREDENTIAL_PATTERN = new RegExp(
  `(\\b(${CREDENTIAL_LABEL})\\b\\s*[:=]\\s*)(?!\\[REDACTED\\])([^\\s,;}\\][{]+)`,
  'gi',
);
const ARGUMENT_CREDENTIAL_PATTERN = new RegExp(`(--?${CREDENTIAL_LABEL}\\b\\s+)([^\\s]+)`, 'gi');
const QUERY_CREDENTIAL_PATTERN = new RegExp(`([?&]${CREDENTIAL_LABEL}=)([^&#\\s]+)`, 'gi');
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:secret|password|passwd|token|credentials?|private_key|api_key|authorization|cookie|signature|askpass|netrc|access_key_id)(?:_|$)/i;
const SENSITIVE_FIELD_NAME =
  /(?:secret|password|passwd|token|credential|privatekey|apikey|authorization|cookie|signature|askpass|netrc)/i;
const SENSITIVE_PATH_PATTERN =
  /(?:~|\/(?:[^/\s"'():]+\/)*)(?:\.aws\/credentials|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.config\/gcloud\/application_default_credentials\.json|run\/secrets\/[^\s"'():]+)/gi;

const sensitiveEnvironmentValues = (source = {}) =>
  [
    ...new Set(
      Object.entries(source)
        .filter(([name]) => SENSITIVE_ENV_NAME.test(String(name)))
        .map(([, value]) => (typeof value === 'string' ? value : ''))
        // Replacing very short values globally would destroy ordinary diagnostics;
        // labelled forms are still covered by the structural patterns below.
        .filter((value) => value.length >= 4 && value !== REDACTED_DIAGNOSTIC),
    ),
  ].toSorted((a, b) => b.length - a.length);

const credentialField = (key) => {
  const normalized = String(key).replaceAll(/[-_]/g, '').toLowerCase();
  return SENSITIVE_FIELD_NAME.test(normalized) || ['setcookie', 'accesskeyid'].includes(normalized);
};

// Sensor processes execute repository-controlled tooling. Treat every diagnostic
// as untrusted and redact credentials before it can become a SensorRun, activity
// note, UI payload, or deduplication key.
const redactCredentialText = (value, sensitiveValues = []) => {
  let text = String(value);
  for (const sensitiveValue of sensitiveValues) {
    text = text.replaceAll(sensitiveValue, REDACTED_DIAGNOSTIC);
  }
  text = text.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    REDACTED_DIAGNOSTIC,
  );
  text = text.replace(
    /\b((?:authorization|proxy-authorization)\s*[:=])([^\r\n,;]+)/gi,
    (_match, prefix) => `${prefix} ${REDACTED_DIAGNOSTIC}`,
  );
  text = text.replace(
    /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
    `$1 ${REDACTED_DIAGNOSTIC}`,
  );
  text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, `$1${REDACTED_DIAGNOSTIC}@`);
  text = text.replace(JSON_DOUBLE_CREDENTIAL_PATTERN, `$1"${REDACTED_DIAGNOSTIC}"`);
  text = text.replace(JSON_SINGLE_CREDENTIAL_PATTERN, `$1'${REDACTED_DIAGNOSTIC}'`);
  text = text.replace(ASSIGNED_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(ARGUMENT_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(QUERY_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(SENSITIVE_PATH_PATTERN, REDACTED_DIAGNOSTIC);
  text = text.replace(
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}(?:-[A-Za-z0-9-]{10,})*)\b|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    REDACTED_DIAGNOSTIC,
  );
  return text;
};

const redactDiagnostic = (value, sensitiveValues = [], seen = new WeakMap()) => {
  if (typeof value === 'string') return redactCredentialText(value, sensitiveValues);
  if (Array.isArray(value))
    return value.map((entry) => redactDiagnostic(entry, sensitiveValues, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const redacted = {};
  seen.set(value, redacted);
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = credentialField(key)
      ? entry == null
        ? entry
        : REDACTED_DIAGNOSTIC
      : redactDiagnostic(entry, sensitiveValues, seen);
  }
  return redacted;
};

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
const resultFromScript = ({
  exitCode,
  stdout,
  stderr = '',
  verdictMode = 'exit-code',
  sensitiveValues = [],
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
  changedFileProvenance = unknownChangedFileProvenance('not_provided'),
  fileListOptions = {},
} = {}) => {
  const sensitiveValues = sensitiveEnvironmentValues(childEnv);
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
  // materialize its script from S3, and spawn it once per selected file.
  // Known irrelevance records INCONCLUSIVE without holding a blocking stage;
  // unknown provenance widens to every glob match and remains fail-safe.
  const runScriptSensor = async ({ sensor, stageId }) => {
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
    const scope = spec.scope;
    const selection = selectSensorFiles({
      globbed,
      provenance: changedFileProvenance,
      scope,
      allFiles: all,
      configFile: spec.projectConfig,
      enumeration,
    });

    const { applicability, files: matched, provenance, selectionComplete } = selection;
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
    const script = await loadBlockScript(sensor).catch(() => '');
    if (!script) {
      return {
        result: SENSOR_RESULT.BLOCKED,
        applicability,
        detail: { error: 'sensor has no script' },
      };
    }
    const scriptDir = path.join(workspaceDir, '.aidlc', 'sensors');
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `${spec.sensorId ?? 'sensor'}.ts`);
    await writeFile(scriptPath, script, 'utf8');
    const { file, args } = buildScriptArgv(spec, { scriptPath, substitutions });

    // One run per matching file (the upstream scripts take a single --file-path).
    const verdictMode = spec.verdictMode;
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
      const { result, detail } = resultFromScript({ ...run, verdictMode, sensitiveValues });
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
    return {
      result: worst,
      applicability,
      detail: {
        scope,
        applicability,
        provenance,
        ...summarizeFileResults(fileResults, sensitiveValues),
      },
    };
  };

  // Run every sensor declared on a stage and return the verdicts. Each verdict:
  // { sensorId, kind, severity, result, applicability, held, detail }.
  // Best-effort per sensor —
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
        outcome = {
          result: SENSOR_RESULT.BLOCKED,
          applicability: SENSOR_APPLICABILITY.UNKNOWN,
          detail: { error: e.message },
        };
      }
      const applicability = outcome.applicability ?? SENSOR_APPLICABILITY.APPLICABLE;
      const { held } = severityGate(outcome.result, sensor.severity, applicability);
      verdicts.push({
        sensorId: sensor.sensorId,
        kind,
        severity: sensor.severity ?? 'advisory',
        result: outcome.result,
        applicability,
        held,
        detail: redactDiagnostic(outcome.detail ?? null, sensitiveValues),
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
