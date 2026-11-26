// Disposable operator experiment, not a project execution or approval service.
// Native hook output is evidence to inspect, never proof of a person's approval.
// Only the two fixed prompts below can reach a model. There is no platform annex.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDriver } from '../cli/drivers.js';
import { parseCodexJsonl } from '../cli/codex-parser.js';
import { parseOpenCodeJsonl } from '../cli/opencode-parser.js';
import { parseClaudeOneShot } from '../cli/one-shot.js';
import { resolveStageModel } from '../model-resolver.js';
import { runNativeCommand } from './command-runner.js';
import { inspectNativeInitialization } from './initialization-evidence.js';
import { inspectNativeEfsWorkspace } from './efs-workspace.js';
import { kiroAssistantHash } from './kiro-acp-turn.js';
import fixture from './probe-package.json' with { type: 'json' };

export const NATIVE_INTERACTION_PROMPT =
  '/aidlc poc Build a tiny local HTML page. This is a disposable integration test. ' +
  'Start the native AI-DLC workflow and capture its intent in the normal native artifact directory. ' +
  'Before choosing the page title, ask me what title I want, as an ordinary free-text clarification. ' +
  'Do not choose a title yourself. Stop for my answer. Do not implement or deploy the page yet.';
export const NATIVE_INTERACTION_ANSWER =
  'Use "Blue Lake" as the page title. This answers only the title question; it is not approval ' +
  'of a plan or a workflow gate. Update the native intent artifact with that answer and ' +
  'continue only until the next question or approval gate, then stop for my response.';
const CLIS = ['claude', 'codex', 'kiro', 'opencode'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HOST_PATH =
  '/opt/kiro/bin:/opt/opencode/bin:/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin';
const BINARIES = {
  claude: '/usr/local/bin/claude',
  codex: '/usr/local/bin/codex',
  kiro: '/usr/local/bin/kiro-cli',
  opencode: '/opt/opencode/bin/opencode',
};
const ACTIVE = new Set(['INITIALIZING', 'RUNNING', 'ANSWERING', 'CANCELLING']);
const failed = (reason) => ({ ok: false, reason });
const success = (r) =>
  r.exitCode === 0 &&
  !r.signal &&
  !r.spawnError &&
  !r.timedOut &&
  !r.outputLimitExceeded &&
  r.cleanupComplete === true;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const redact = (text, secrets) =>
  secrets.reduce(
    (value, secret) => (secret ? value.replaceAll(secret, '[credential removed]') : value),
    String(text),
  );

export const nativeProbeInvocation = ({
  harness,
  prompt,
  sessionId,
  model,
  project,
  priorAssistantSha256,
  priorUserPromptSha256,
}) => {
  const modelArgs = model ? [harness === 'codex' ? '-m' : '--model', model] : [];
  if (harness === 'claude')
    return {
      command: BINARIES.claude,
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--max-turns',
        '12',
        ...(sessionId ? ['--resume', sessionId] : []),
        ...modelArgs,
      ],
    };
  if (harness === 'kiro')
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./kiro-acp-turn.js', import.meta.url)),
        '--project',
        project,
        ...(sessionId
          ? [
              '--resume-id',
              sessionId,
              '--prior-user-prompt-sha256',
              priorUserPromptSha256,
              '--prior-assistant-sha256',
              priorAssistantSha256,
            ]
          : []),
        ...modelArgs,
        '--prompt',
        prompt,
      ],
    };
  if (harness === 'opencode')
    return {
      command: BINARIES.opencode,
      args: [
        'run',
        '--format',
        'json',
        '--auto',
        ...(sessionId ? ['--session', sessionId] : []),
        ...(model ? ['--model', model.includes('/') ? model : `amazon-bedrock/${model}`] : []),
        prompt,
      ],
    };
  if (harness === 'codex')
    return {
      command: BINARIES.codex,
      args: [
        'exec',
        ...(sessionId ? ['resume', sessionId] : []),
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        // Exec cannot answer request_user_input. The feature flag alone still
        // offers it for Plan mode, so also disable tool registration.
        '-c',
        'features.default_mode_request_user_input=false',
        '-c',
        'tools.experimental_request_user_input.enabled=false',
        '-c',
        'model_provider="amazon-bedrock"',
        '-c',
        `projects.${JSON.stringify(project)}.trust_level="trusted"`,
        ...modelArgs,
        prompt,
      ],
    };
  throw new Error('Unsupported native probe harness');
};

const CLAUDE_SESSION_END_HOOK_ERROR = 'native_claude_session_end_hook_missing_or_ambiguous';
const unsafeClaudeSettings = () => {
  throw new Error('Native Claude settings are unsafe');
};
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const configureClaudeSessionEnd = async ({ project, projectIdentity }) => {
  const path = join(project, '.claude/settings.json');
  const parents = [];
  for (const directory of [project, join(project, '.claude')]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafeClaudeSettings();
    parents.push({ directory, stat });
  }
  if (
    !sameNode(parents[0].stat, projectIdentity) ||
    projectIdentity.path !== project ||
    (await realpath(project)) !== projectIdentity.path
  )
    unsafeClaudeSettings();
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 1024 * 1024)
      unsafeClaudeSettings();
    const recheck = async () => {
      for (const { directory, stat } of parents) {
        const current = await lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(stat, current))
          unsafeClaudeSettings();
      }
      if ((await realpath(project)) !== projectIdentity.path) unsafeClaudeSettings();
      const current = await lstat(path);
      const opened = await handle.stat();
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        opened.nlink !== 1 ||
        !sameNode(before, current) ||
        !sameNode(before, opened)
      )
        unsafeClaudeSettings();
      return opened;
    };
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) unsafeClaudeSettings();
    const settings = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    );
    const groups = settings?.hooks?.SessionEnd;
    const hooks = (Array.isArray(groups) ? groups : [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .filter(
        (hook) => hook?.type === 'command' && hook.command === 'aidlc engine hook session-end',
      );
    if (hooks.length !== 1) throw new Error(CLAUDE_SESSION_END_HOOK_ERROR);
    const current = await recheck();
    if (
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      unsafeClaudeSettings();
    if (Object.hasOwn(hooks[0], 'timeout')) return;
    // Claude's 1.5-second SessionEnd default cuts off the native hook. Only
    // adjust the generated project file; the signed package stays untouched.
    hooks[0].timeout = 30;
    const output = `${JSON.stringify(settings, null, 2)}\n`;
    if (Buffer.byteLength(output) > 1024 * 1024) unsafeClaudeSettings();
    await handle.writeFile(output);
    await handle.truncate(Buffer.byteLength(output));
    await handle.sync();
    await recheck();
  } finally {
    await handle.close();
  }
};

// Bounded snapshots of native records only. Never walk CLI homes, package
// caches or arbitrary paths from a model. Links/devices are refused.
export const snapshotNativeProbeArtifacts = async ({ project, secrets = [], projectIdentity }) => {
  const files = [];
  let bytes = 0;
  let visited = 0;
  let bounded = false;
  const rootStat = await lstat(project);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (projectIdentity &&
      (rootStat.ino !== projectIdentity.ino ||
        rootStat.dev !== projectIdentity.dev ||
        (await realpath(project)) !== projectIdentity.path))
  ) {
    throw new Error('Native project identity changed');
  }
  const walk = async (relative, depth = 0) => {
    if (depth > 16 || files.length >= 128 || bytes >= 384 * 1024 || visited >= 512) {
      bounded = true;
      return;
    }
    visited += 1;
    // Starting roots contain multiple components. A linked ancestor must not
    // redirect an otherwise ordinary leaf outside the disposable project.
    let ancestor = project;
    for (const name of relative.split(sep).slice(0, -1)) {
      ancestor = join(ancestor, name);
      let parent;
      try {
        parent = await lstat(ancestor);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new Error('Native evidence contains an unsafe ancestor');
      }
    }
    const path = join(project, relative);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Native evidence contains a link');
    if (stat.isDirectory()) {
      const entries = await readdir(path);
      if (entries.length > 512) throw new Error('Native evidence directory is too large');
      for (const name of entries.toSorted()) await walk(join(relative, name), depth + 1);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('Native evidence is not a private regular file');
    // Native AI-DLC creates this signing key beside the intent records. It is
    // internal authority material, not an artifact for operator/UI viewing.
    if (relative.endsWith(`${sep}.aidlc-engine${sep}steering-token-key`)) {
      files.push({ path: redact(relative, secrets), omitted: 'internal-key' });
      return;
    }
    if (stat.size > 64 * 1024 || bytes + stat.size > 384 * 1024) {
      bounded = true;
      files.push({ path: redact(relative, secrets), bytes: stat.size, omitted: 'size-limit' });
      return;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.size > 64 * 1024)
        throw new Error('Native evidence changed');
      const buffer = Buffer.alloc(current.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== current.size) throw new Error('Native evidence changed');
      const data = buffer.subarray(0, bytesRead);
      bytes += data.length;
      files.push({
        path: redact(relative, secrets),
        bytes: data.length,
        sha256: hash(data),
        content: redact(data.toString('utf8'), secrets),
      });
    } finally {
      await handle.close();
    }
  };
  for (const root of [
    'aidlc/spaces/default/intents',
    'aidlc/active-space',
    'aidlc/.aidlc-sessions',
  ])
    await walk(root);
  return { files, bounded };
};

export const nativeProbeResponse = (report) => {
  const result = { ok: true, ...structuredClone(report) };
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= 1_500_000;
  if (fits()) return result;
  result.evidenceTruncated = true;
  for (const turn of result.turns || []) {
    for (const snapshot of [turn.before, turn.after]) {
      if (!snapshot) continue;
      snapshot.bounded = true;
      for (const file of snapshot.files) {
        delete file.content;
        file.omitted = 'response-size-limit';
      }
    }
  }
  if (fits()) return result;
  // Preserve questions and control even if the file inventory alone is large.
  for (const turn of result.turns || []) {
    for (const snapshot of [turn.before, turn.after]) {
      if (snapshot) snapshot.files = [];
    }
  }
  return result;
};

export const createNativeInteractionProbe = ({
  enabled = false,
  workspaceDir = '/mnt/workspace',
  localHomeRoot = '/home/node/.native-probe-homes',
  requireEfs = false,
  inspectEfsWorkspace = inspectNativeEfsWorkspace,
  packageDirectory = '/opt/aidlc-native-probe-package',
  commandRunner = runNativeCommand,
  inspectInitialization = inspectNativeInitialization,
  prepareWorkspace = null,
  persistReport = null,
  snapshot = snapshotNativeProbeArtifacts,
  busy,
  turnTimeoutMs = 600_000,
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  let current = null;
  let poisoned = false;
  const verifyWorkspace = async () => {
    if (!requireEfs) return;
    try {
      current.report.storage.mount = await inspectEfsWorkspace({ workspaceDir });
    } catch {
      current.report.failure = 'native_efs_mount_unavailable';
      throw new Error('Native EFS workspace unavailable');
    }
  };
  const response = () =>
    current ? nativeProbeResponse(current.report) : failed('probe_not_found');
  const save = async (report) => {
    if (persistReport) return persistReport(report);
    // A new file each time avoids following an agent-replaced summary path.
    const directory = await mkdtemp(join(current.evidence, 'snapshot-'));
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  };
  const run = async (invocation, env, options = {}) => {
    const r = await commandRunner({
      ...invocation,
      env,
      cwd: current.project,
      signal: current.abort.signal,
      timeoutMs: options.timeoutMs || 120_000,
      stdoutBytes: 2 * 1024 * 1024,
      stderrBytes: 256 * 1024,
    });
    if (r.cleanupComplete !== true) poisoned = true;
    return r;
  };
  const initialize = async () => {
    const build = JSON.parse(await readFile(join(packageDirectory, 'build-verification.json')));
    if (
      build.packageId !== fixture.packageId ||
      build.materializationId !== fixture.materializationId ||
      build.signature !== 'verified'
    )
      throw new Error('Fixture was not verified at image build');
    for (const file of fixture.files) {
      const data = await readFile(join(packageDirectory, file.name));
      if (data.length !== file.bytes || hash(data) !== file.sha256)
        throw new Error('Fixture bytes changed');
    }
    const { root, project, baseEnv } = current;
    const binary = join(root, 'machine/bin/aidlc');
    const commands = [
      [
        join(packageDirectory, 'aidlc-linux-arm64'),
        ['use', fixture.version, '--from', packageDirectory, '--offline', '--json'],
      ],
      ['/usr/bin/git', ['init', '--quiet', project]],
      [
        binary,
        [
          'config',
          '--pin',
          fixture.version,
          '--project-dir',
          project,
          '--from',
          packageDirectory,
          '--offline',
          '--json',
        ],
      ],
      [
        binary,
        [
          'config',
          '--harness',
          current.report.harness,
          '--project-dir',
          project,
          '--from',
          join(root, 'machine/data/versions', fixture.version, 'runtime', current.report.harness),
          '--mcp',
          'none',
          '--yes',
          '--json',
        ],
      ],
    ];
    for (const [command, args] of commands) {
      // Signed installation on AgentCore EFS took 137 seconds in the live
      // probe. Allow five minutes per setup command; model-turn limits are
      // configured separately.
      const r = await run({ command, args }, baseEnv, { timeoutMs: 300_000 });
      current.report.initialization.push({
        command: args[0],
        ok: success(r),
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 16 * 1024),
        stderr: r.stderr.slice(0, 4096),
      });
      if (!success(r)) throw new Error('Initialization command failed');
    }
    const inspection = await inspectInitialization({
      projectDirectory: project,
      installRoot: join(root, 'machine/data'),
      version: fixture.version,
      harness: current.report.harness,
    });
    current.report.filesystem = inspection;
    if (inspection.ok !== true) throw new Error('Native initialization inspection failed');
  };
  const executeTurn = async (context, answer) => {
    if (answer) await verifyWorkspace();
    for (const value of [context.env.AWS_BEARER_TOKEN_BEDROCK, context.env.KIRO_API_KEY]) {
      if (value) current.redactionSecrets.add(value);
    }
    const secrets = [...current.redactionSecrets];
    const harness = current.report.harness;
    const model = current.report.model;
    const auth = getDriver(harness).envForAuth(context.env);
    // Set native hook PATH and each CLI's isolated home explicitly. Do not merge
    // process.env or copy runtime grants, AWS role credentials, platform MCP or
    // global AIDLC_UNATTENDED settings into the model subprocess.
    const env = {
      ...auth,
      ...current.baseEnv,
      ...(auth.AWS_REGION ? { AWS_REGION: auth.AWS_REGION } : {}),
      CLAUDE_CONFIG_DIR: join(current.home, '.claude'),
      CODEX_HOME: join(current.home, '.codex'),
      XDG_CONFIG_HOME: join(current.home, '.config'),
      XDG_DATA_HOME: join(current.home, '.data'),
      XDG_CACHE_HOME: join(current.home, '.cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      AIDLC_PROJECT_DIR: current.project,
    };
    if (!answer) {
      if (prepareWorkspace)
        await prepareWorkspace({ root: current.root, project: current.project });
      else await initialize();
      if (harness === 'claude') {
        try {
          await configureClaudeSessionEnd(current);
        } catch (error) {
          current.report.failure =
            error.message === CLAUDE_SESSION_END_HOOK_ERROR
              ? CLAUDE_SESSION_END_HOOK_ERROR
              : 'native_claude_session_end_settings_invalid';
          throw error;
        }
      }
    }
    current.report.status = answer ? 'ANSWERING' : 'RUNNING';
    const before = await snapshot({
      project: current.project,
      secrets,
      projectIdentity: current.projectIdentity,
    });
    const requestedSessionId = answer ? current.sessionId : null;
    const r = await run(
      nativeProbeInvocation({
        harness,
        prompt: answer ? NATIVE_INTERACTION_ANSWER : NATIVE_INTERACTION_PROMPT,
        sessionId: requestedSessionId,
        model,
        project: current.project,
        priorAssistantSha256: current.kiroAssistantSha256,
        priorUserPromptSha256: current.kiroUserPromptSha256,
      }),
      env,
      { timeoutMs: turnTimeoutMs },
    );
    let parsed;
    let kiroIdentitySource = null;
    if (harness === 'codex') parsed = parseCodexJsonl(r.stdout);
    else if (harness === 'opencode') parsed = parseOpenCodeJsonl(r.stdout);
    else if (harness === 'claude') {
      parsed = parseClaudeOneShot(r.stdout);
      for (const line of r.stdout.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.session_id) parsed.sessionId = event.session_id;
        } catch {}
      }
    } else {
      parsed = { text: '', sessionId: null, ok: false };
      try {
        const value = JSON.parse(r.stdout);
        if (value?.schemaVersion === 1 && value.transport === 'kiro-acp') {
          parsed = { ...value, text: typeof value.text === 'string' ? value.text : '' };
          if (
            typeof parsed.sessionId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.sessionId)
          )
            parsed.sessionId = null;
          kiroIdentitySource = answer ? 'kiro-acp-session-load' : 'kiro-acp-session-new';
        }
      } catch {}
      if (!answer && parsed.text.trim())
        current.kiroAssistantSha256 = kiroAssistantHash(parsed.text);
      if (!answer && /^[a-f0-9]{64}$/.test(parsed.expectedUserPromptSha256 || ''))
        current.kiroUserPromptSha256 = parsed.expectedUserPromptSha256;
    }
    current.sessionId ||= parsed?.sessionId;
    if (
      typeof current.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(current.sessionId)
    ) {
      current.sessionId = null;
    }
    // A surviving process could race filesystem containment checks. Do not
    // inspect or write workspace evidence again once cleanup is unconfirmed.
    const after = poisoned
      ? { files: [], bounded: true }
      : await snapshot({
          project: current.project,
          secrets,
          projectIdentity: current.projectIdentity,
        });
    current.report.turns.push({
      kind: answer ? 'synthetic-test-answer' : 'synthetic-test-start',
      ...(harness === 'kiro'
        ? {
            requestedSessionId: requestedSessionId ? redact(requestedSessionId, secrets) : null,
            observedSessionId: parsed.sessionId ? redact(parsed.sessionId, secrets) : null,
            identitySource: kiroIdentitySource,
            ...Object.fromEntries(
              [
                'requestedModel',
                'observedModel',
                'modelSource',
                'modelVerified',
                'sessionLoadAcknowledged',
                'replayedUserChunks',
                'replayedAssistantChunks',
                'priorPromptObserved',
                'priorAssistantObserved',
                'expectedUserPromptSha256',
                'replayedUserPromptSha256',
                'userPromptSource',
                'expectedAssistantSha256',
                'replayedAssistantSha256',
                'protocolPhase',
                'protocolFailure',
                'transportFailure',
                'rpcErrorCode',
                'stopReason',
              ]
                .filter(
                  (key) =>
                    ['string', 'number', 'boolean'].includes(typeof parsed[key]) ||
                    parsed[key] === null,
                )
                .map((key) => [
                  key,
                  typeof parsed[key] === 'string' ? redact(parsed[key], secrets) : parsed[key],
                ]),
            ),
          }
        : {}),
      process: {
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        outputLimitExceeded: r.outputLimitExceeded,
        cleanupComplete: r.cleanupComplete,
        spawnError: r.spawnError,
      },
      assistantText: redact(parsed?.text || '', secrets).slice(0, 32 * 1024),
      diagnostics: redact(
        [r.stderr, ...(parsed?.errors || []), ...(parsed?.diagnostics || [])].join('\n'),
        secrets,
      ).slice(0, 16 * 1024),
      stdoutTail: redact(r.stdout, secrets).slice(-32 * 1024),
      // Full bounded CLI output remains private on the disposable mount.
      before,
      after,
    });
    if (poisoned) {
      current.report.failure = 'process-cleanup-incomplete';
      current.finalStatus = 'FAILED';
      current.report.resumable = false;
      return;
    }
    const evidence = await mkdtemp(join(current.evidence, 'turn-'));
    await writeFile(
      join(evidence, 'cli.json'),
      JSON.stringify({
        stdout: redact(r.stdout, secrets),
        stderr: redact(r.stderr, secrets),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    // Keep the original stored ID. The ACP wrapper must acknowledge the load,
    // replay prior messages and verify model choice before sending an answer.
    // Compare raw fields before redaction; equal redacted secrets prove nothing.
    const identityFailure =
      harness === 'kiro' &&
      answer &&
      !current.abort.signal.aborted &&
      parsed.sessionId !== requestedSessionId
        ? parsed.sessionId
          ? 'native_kiro_resume_session_mismatch'
          : 'native_kiro_resume_session_missing'
        : null;
    const protocolFailure =
      harness === 'kiro' &&
      !current.abort.signal.aborted &&
      (parsed.ok !== true ||
        !parsed.sessionId ||
        !current.kiroAssistantSha256 ||
        !current.kiroUserPromptSha256 ||
        parsed.modelVerified !== true ||
        parsed.stopReason !== 'end_turn' ||
        Boolean(parsed.protocolFailure) ||
        !parsed.observedModel ||
        (model && parsed.observedModel !== model) ||
        (answer &&
          (parsed.sessionLoadAcknowledged !== true ||
            parsed.priorPromptObserved !== true ||
            parsed.priorAssistantObserved !== true ||
            parsed.expectedUserPromptSha256 !== current.kiroUserPromptSha256 ||
            parsed.replayedUserPromptSha256 !== current.kiroUserPromptSha256 ||
            parsed.replayedAssistantSha256 !== current.kiroAssistantSha256 ||
            !(parsed.replayedUserChunks > 0) ||
            !(parsed.replayedAssistantChunks > 0))))
        ? 'native_kiro_acp_failed'
        : null;
    if (identityFailure || protocolFailure)
      current.report.failure = identityFailure || protocolFailure;
    current.report.resumable = Boolean(current.sessionId) && !identityFailure && !protocolFailure;
    current.finalStatus = current.abort.signal.aborted
      ? 'CANCELLED'
      : !success(r) || identityFailure || protocolFailure
        ? 'FAILED'
        : answer
          ? 'ANSWER_TURN_FINISHED'
          : 'FIRST_TURN_FINISHED';
    // Exit success / transcript text alone never qualifies a native question,
    // answer, gate or workflow completion. The operator reviews the snapshots.
    current.report.qualification = 'requires-evidence-review';
  };
  const launch = (context, answer) => {
    busy?.enter();
    current.turnActive = true;
    current.task = Promise.resolve()
      .then(() => executeTurn(context, answer))
      .catch(() => {
        current.finalStatus = current.abort.signal.aborted ? 'CANCELLED' : 'FAILED';
        current.report.failure = poisoned
          ? 'process-cleanup-incomplete'
          : current.report.failure || 'probe_step_failed';
      })
      .finally(async () => {
        try {
          if (poisoned) {
            current.report.status = 'FAILED';
            current.report.failure = 'process-cleanup-incomplete';
          } else if (current.report.failure === 'native_efs_mount_unavailable') {
            // Do not write evidence into an unmounted backing directory.
            current.report.status = 'FAILED';
          } else {
            await save({ ...current.report, status: current.finalStatus });
            current.report.status = current.abort.signal.aborted
              ? 'CANCELLED'
              : current.finalStatus;
          }
        } catch {
          current.report.status = 'FAILED';
          current.report.failure = 'evidence_write_failed';
        }
        current.turnActive = false;
        busy?.leave();
      });
  };
  const invoke = async (payload, context = {}) => {
    if (!enabled) return failed('native_probe_disabled');
    if (platform !== 'linux' || arch !== 'arm64') return failed('native_probe_platform');
    const { action, probeId, requestedCli: harness } = payload || {};
    const keys = [
      'command',
      'action',
      'probeId',
      'requestedCli',
      'executionId',
      'credentialBinding',
      'cliModels',
    ];
    if (
      !payload ||
      Object.keys(payload).some((key) => !keys.includes(key)) ||
      !UUID.test(probeId || '') ||
      !CLIS.includes(harness) ||
      payload.executionId !== probeId ||
      !['start', 'status', 'answer', 'cancel'].includes(action)
    )
      return failed('native_probe_invalid');
    if (current && (current.report.probeId !== probeId || current.report.harness !== harness)) {
      return failed('native_probe_session_mismatch');
    }
    if (action === 'status') return response();
    if (action === 'cancel') {
      if (current && (current.turnActive || ACTIVE.has(current.report.status))) {
        current.report.status = 'CANCELLING';
        current.abort.abort();
      }
      return response();
    }
    if (!context.availableClis?.includes(harness))
      return failed('native_probe_credential_unavailable');
    if (poisoned) return failed('native_probe_runtime_unhealthy');
    if (action === 'answer') {
      if (
        !current ||
        current.turnActive ||
        current.report.status !== 'FIRST_TURN_FINISHED' ||
        !current.sessionId
      ) {
        return failed('native_probe_not_answerable');
      }
      current.report.status = 'ANSWERING';
      launch(context, true);
      return response();
    }
    if (current) return response(); // At most one start and one answer per session.
    const root = join(workspaceDir, 'native-interaction-probes', probeId);
    const project = join(root, 'project');
    // Claim before yielding so duplicate concurrent starts cannot launch twice.
    current = {
      report: {
        probeId,
        harness,
        status: 'INITIALIZING',
        turns: [],
        initialization: [],
        experiment: 'native-question-answer-v1',
        version: fixture.version,
        packageId: fixture.packageId,
        humanAuthority: 'not-tested-synthetic-operator-fixture',
        recovery: 'not-tested',
        storage: {
          workspaceDir,
          efsRequired: requireEfs,
          harnessState: 'local-ephemeral',
        },
        model:
          resolveStageModel({ cli: harness, cliModels: payload.cliModels, env: context.env }) ??
          null,
      },
      root,
      project,
      abort: new AbortController(),
      sessionId: null,
      redactionSecrets: new Set(),
    };
    try {
      await verifyWorkspace();
      await mkdir(join(workspaceDir, 'native-interaction-probes'), {
        recursive: true,
        mode: 0o700,
      });
      // Refuse old session state: cold recovery is a separate acceptance test.
      await mkdir(root, { mode: 0o700 });
      current.evidence = join(root, 'evidence');
      // Codex refuses to create its PATH helpers beneath /tmp. Keep active
      // harness state on private local disk outside the shared temp hierarchy.
      await mkdir(localHomeRoot, { recursive: true, mode: 0o700 });
      const homeRootStat = await lstat(localHomeRoot);
      if (
        !homeRootStat.isDirectory() ||
        homeRootStat.isSymbolicLink() ||
        (await realpath(localHomeRoot)) !== localHomeRoot
      )
        throw new Error('Native harness home root is not a direct directory');
      current.home = await mkdtemp(join(localHomeRoot, 'probe-'));
      for (const path of [
        project,
        current.evidence,
        join(root, 'machine/data'),
        join(root, 'machine/bin'),
        join(current.home, '.codex'),
      ]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      const projectStat = await lstat(project);
      current.projectIdentity = {
        dev: projectStat.dev,
        ino: projectStat.ino,
        path: await realpath(project),
      };
      current.baseEnv = {
        HOME: current.home,
        TMPDIR: '/tmp',
        PATH: `${join(root, 'machine/bin')}:${HOST_PATH}`,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        AIDLC_INSTALL_ROOT: join(root, 'machine/data'),
        AIDLC_BIN_DIR: join(root, 'machine/bin'),
        AIDLC_OFFLINE: '1',
        AIDLC_RELEASE_REPOSITORY: fixture.source.repository,
        AIDLC_RELEASE_WORKFLOW: `${fixture.source.repository}/.github/workflows/release.yml`,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      // Trust only this disposable project so its native Codex config/hooks load.
      await writeFile(
        join(current.home, '.codex/config.toml'),
        `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
        { flag: 'wx', mode: 0o600 },
      );
      launch(context, false);
      return response();
    } catch {
      current.report.status = 'FAILED';
      current.report.failure ||= 'workspace_exists_or_unavailable';
      return response();
    }
  };
  return { invoke, settle: async () => current?.task };
};
