// One-shot CLI prompt — run a single bounded prompt through an ALREADY
// CONFIGURED agent CLI (claude/kiro) and capture the text answer. MCP is
// caller-controlled: derive-time enrichment passes no tool surface; Quorum
// passes a read-only MCP config. There is no stage session persistence or
// workspace mutation: this is the inference path for small machine-to-machine
// calls, reusing the exact CLI + auth + model selection the stage runs use (no
// separate LLM integration to configure or secure).
//
// Composition of existing pieces:
//   selectCli (driver preference) → resolveStageModel (Admin/project model
//   knobs) → driver.buildInvocation (argv, optionally with an mcp-config) →
//   captureChild (spawn + capture stdout/stderr).
//
// Contract: never throws. Resolves
//   { ok, text, cli, model, exitCode, metrics }
// where `metrics` is a numeric bag ready for store.recordMetric (claude:
// tokens from the stream-json result event; kiro: the stderr credit footer)
// or null when the CLI reports nothing usable.

import { getDriver, selectCli, parseKiroCredits } from './drivers.js';
import { captureChild } from './spawn.js';
import { resolveStageModel } from '../model-resolver.js';
import {
  restoreKiroStore as defaultRestoreKiroStore,
  persistKiroStore as defaultPersistKiroStore,
} from './kiro-store.js';
import { parseOpenCodeJsonl } from './opencode-parser.js';
import { withOpenCodeStore as defaultWithOpenCodeStore } from './opencode-store.js';

// Extract the assistant text + token usage from Claude's `--output-format
// stream-json` stdout (one JSON event per line). Per the headless CLI docs the
// final `result` event mirrors the `--output-format json` payload (`result`
// string, `usage`, `subtype: 'success' | 'error_*'`); on error subtypes the
// `result` string may be absent, so accumulated assistant text is the
// fallback. Tolerant: unparseable lines are skipped, missing usage degrades
// to null.
export const parseClaudeOneShot = (stdout = '') => {
  let text = '';
  let usage = null;
  let resultSubtype = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'result') {
      resultSubtype = event.subtype ?? null;
      if (typeof event.result === 'string' && event.result) text = event.result;
      const u = event.usage ?? event.message?.usage ?? null;
      if (u) usage = u;
    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const t = event.message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      if (t) text = t;
      if (event.message?.usage) usage = event.message.usage;
    }
  }
  const tokensInput = Number(usage?.input_tokens);
  const tokensOutput = Number(usage?.output_tokens);
  const metrics = {};
  if (Number.isFinite(tokensInput) && tokensInput > 0) metrics.tokensInput = tokensInput;
  if (Number.isFinite(tokensOutput) && tokensOutput > 0) metrics.tokensOutput = tokensOutput;
  return { text, metrics: Object.keys(metrics).length ? metrics : null, resultSubtype };
};

// Bounded raw-output sample attached to FAILED one-shot results so a field
// failure is diagnosable from the event log without container access.
const SAMPLE_BYTES = 300;
const sampleOf = (raw = '') => String(raw ?? '').slice(0, SAMPLE_BYTES);

// Strip ANSI escape sequences + non-printing control chars from CLI stdout
// (kiro-cli colorizes headless output). Keeps tab/newline/CR. Also removes
// orphaned CSI color fragments some terminal layers leave behind.
const stripAnsi = (text = '') =>
  String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\u001B\[|\u009B)[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '');

// Run one prompt, capture one answer. `requestedCli`/`cliModels` carry the
// same Admin/project selection the orchestrator forwards for stages; `env`
// supplies auth (AWS_BEARER_TOKEN_BEDROCK / KIRO_API_KEY, resolved at
// container boot). `cwd` defaults to /tmp so a Kiro one-shot's throwaway
// conversation lands in its own cwd group and never collides with the
// workspace session run-stage resumes by cwd. `timeoutMs` bounds the call —
// a hung CLI must never wedge the derive command. Failure results carry a
// bounded raw `sample` for field diagnosis.
export const DEFAULT_ONE_SHOT_TIMEOUT_MS = 120_000;

export const runOneShotPrompt = async ({
  prompt,
  requestedCli = null,
  cliModels = null,
  availableClis = [],
  env = process.env,
  cwd = '/tmp',
  mcpConfigPath = null,
  agentName = null,
  opencodeConfigContent = null,
  timeoutMs = DEFAULT_ONE_SHOT_TIMEOUT_MS,
  spawnFn,
  restoreKiroStore = defaultRestoreKiroStore,
  persistKiroStore = defaultPersistKiroStore,
  withOpenCodeStore = defaultWithOpenCodeStore,
} = {}) => {
  const cli = selectCli({ requested: requestedCli, availableClis });
  if (!cli) return { ok: false, reason: 'no_cli', text: '', cli: null, model: null, metrics: null };

  const model = resolveStageModel({ cliModels, agentBlock: null, cli, env });
  const driver = getDriver(cli);
  const invocation = driver.buildInvocation({
    prompt,
    model,
    mcpConfigPath,
    agentName,
    opencodeConfigContent,
  });
  // Kiro's SQLite conversation store: bracket exactly like resolve-conflict —
  // restore (mount → local) before the spawn so we never run against a stale
  // local store after a microVM reap, persist after so lane conversations the
  // SAME local store holds are never lost to a later reap. The throwaway
  // one-shot session itself rides along; its distinct cwd keeps it out of the
  // session-capture path (parseLatestKiroSession filters by cwd).
  if (cli === 'kiro') await restoreKiroStore({ env }).catch(() => false);
  const execute = () =>
    captureChild({
      command: invocation.command,
      args: invocation.args,
      env: { ...invocation.env, ...driver.envForAuth(env) },
      cwd,
      prompt: invocation.prompt,
      promptViaStdin: invocation.promptViaStdin,
      captureStderr: cli === 'kiro',
      timeoutMs,
      ...(spawnFn ? { spawnFn } : {}),
    });
  let capture;
  try {
    capture =
      cli === 'opencode' ? await withOpenCodeStore({ env, operation: execute }) : await execute();
  } finally {
    if (cli === 'kiro') await persistKiroStore({ env }).catch(() => false);
  }
  const { exitCode, stdout, stderr, timedOut } = capture;

  if (timedOut) {
    return {
      ok: false,
      reason: 'timeout',
      text: '',
      cli,
      model: model ?? null,
      exitCode: null,
      metrics: null,
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      reason: 'cli_failed',
      text: '',
      cli,
      model: model ?? null,
      exitCode,
      metrics: null,
      sample: sampleOf(cli === 'kiro' ? stderr : stdout),
    };
  }

  if (cli === 'claude') {
    const { text, metrics, resultSubtype } = parseClaudeOneShot(stdout);
    return {
      ok: Boolean(text),
      reason: text ? null : 'empty_answer',
      text,
      cli,
      model: model ?? null,
      exitCode,
      metrics,
      ...(text ? {} : { sample: sampleOf(stdout), resultSubtype }),
    };
  }
  if (cli === 'opencode') {
    const parsed = parseOpenCodeJsonl(stdout);
    const text = parsed.text.trim();
    return {
      ok: Boolean(text),
      reason: text ? null : 'empty_answer',
      text,
      cli,
      model: model ?? null,
      exitCode,
      metrics: parsed.metrics,
      ...(text
        ? {}
        : {
            sample: sampleOf(parsed.errors.join('\n') || parsed.diagnostics.join('\n') || stdout),
          }),
    };
  }
  // Kiro: plain stdout answer (ANSI-stripped); the per-turn credit footer
  // lands on stderr.
  const text = stripAnsi(stdout).trim();
  const credits = parseKiroCredits(stderr);
  return {
    ok: Boolean(text),
    reason: text ? null : 'empty_answer',
    text,
    cli,
    model: model ?? null,
    exitCode,
    metrics: credits != null ? { credits } : null,
    ...(text ? {} : { sample: sampleOf(stderr) }),
  };
};

// Pull a JSON object out of a model answer that may be wrapped in prose or a
// ```json fence. Returns the parsed object or null — enrichment is strictly
// fail-open, so an unparseable answer is a skip, never an error.
export const extractJsonObject = (text = '') => {
  const body = String(text ?? '');
  const fenced = body.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
};
