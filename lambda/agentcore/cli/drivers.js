// Headless CLI drivers — one consistent interface across agent CLIs.
//
// We run each CLI HEADLESS (one prompt, non-interactive, exit when done) with our
// MCP server wired in via the CLI's mcp-config flag. The agent's human-facing
// output flows through the MCP `send_output` tool (so streaming is identical
// across CLIs), not by parsing CLI stdout — the runner only cares about the exit
// code.
//
// Each driver exposes a SMALL surface:
//   buildInvocation({ prompt, mcpConfigPath, model, allowedTools }) ->
//     { command, args, env, promptViaStdin }
//   envForAuth(env) -> { ...auth env vars }   (Bedrock bearer / Kiro key)
// Pure of process spawning so argv construction is unit-tested directly. Auth
// secret loading is the caller's job (loadSecrets), kept out of argv.

// The MCP server name we register under in mcp-config (see stage-materializer).
export const MCP_SERVER_NAME = 'aidlc';

// ── Claude Code (headless) ──
// `claude -p --mcp-config <file> --permission-mode bypassPermissions
//  --model <id> --output-format stream-json --verbose` — prompt piped on STDIN.
// Bedrock auth via env (CLAUDE_CODE_USE_BEDROCK + AWS_BEARER_TOKEN_BEDROCK),
// mirroring the v1 claude driver.
//
// Prompt on STDIN, not argv: a large materialized prompt (graph context pack)
// overflows the OS ARG_MAX and makes spawn() throw `E2BIG` (the 2026-07 frontend
// nfr-design failure). `claude -p` with no prompt argument reads the prompt from
// stdin (verified: `echo … | claude -p`), so we pass `promptViaStdin: true` and
// the spawn shell pipes it in (see cli/spawn.js). --input-format defaults to
// "text", unaffected by the stream-json OUTPUT format.
const claudeDriver = {
  name: 'claude',
  buildInvocation({ prompt, mcpConfigPath, model, allowedTools = [], sessionId = null }) {
    const args = ['-p'];
    // MCP config is optional: a plain one-shot prompt (e.g. derive-time
    // enrichment) runs without any tool surface.
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    args.push('--permission-mode', 'bypassPermissions');
    // Force the conversation id up front so the orchestrator persists it without
    // scraping it back. `--session-id` is NEW-session-only — resume uses --resume.
    if (sessionId) args.push('--session-id', sessionId);
    if (model) args.push('--model', model);
    if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
    args.push('--output-format', 'stream-json', '--verbose');
    return { command: 'claude', args, env: {}, prompt, promptViaStdin: true };
  },
  // Resume the SAME conversation with the human's answer. Re-attach the MCP
  // servers (--mcp-config) so the parked tool surface is live again. Never reuse
  // --session-id here (it errors "already in use") — only --resume <uuid>.
  // Answer piped on STDIN too, for the same ARG_MAX reason as the fresh run.
  buildResumeInvocation({ sessionId, answerMessage, mcpConfigPath, model }) {
    const args = [
      '--resume',
      sessionId,
      '-p',
      '--mcp-config',
      mcpConfigPath,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (model) args.push('--model', model);
    args.push('--output-format', 'stream-json', '--verbose');
    return { command: 'claude', args, env: {}, prompt: answerMessage, promptViaStdin: true };
  },
  envForAuth(env) {
    const region = env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1';
    const out = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: region,
      IS_SANDBOX: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    if (env.AWS_BEARER_TOKEN_BEDROCK) out.AWS_BEARER_TOKEN_BEDROCK = env.AWS_BEARER_TOKEN_BEDROCK;
    return out;
  },
};

// ── Kiro CLI (headless) ──
// `kiro-cli chat --no-interactive --trust-all-tools --agent <name>` — prompt
// piped on STDIN. Kiro has NO `--mcp-config` flag (unlike Claude) — it discovers
// MCP servers from an AGENT config at <cwd>/.kiro/agents/<name>.json (written by
// the materializer) and is pointed at it with `--agent`. (Kiro reads the model
// via --model.) API-key auth via env (KIRO_API_KEY).
//
// Prompt on STDIN, not argv: `kiro-cli chat` takes the prompt as a POSITIONAL
// arg, and a large materialized prompt overflows ARG_MAX → spawn() throws
// `E2BIG` (the 2026-07 frontend nfr-design failure). With the positional
// omitted, Kiro reads the prompt from stdin (verified: `echo … | kiro-cli chat
// --no-interactive`), so we pass `promptViaStdin: true` and the spawn shell
// pipes it in (see cli/spawn.js).
const kiroDriver = {
  name: 'kiro',
  buildInvocation({ prompt, agentName, model }) {
    const args = ['chat', '--no-interactive', '--trust-all-tools'];
    if (agentName) args.push('--agent', agentName);
    if (model) args.push('--model', model);
    return { command: 'kiro-cli', args, env: {}, prompt, promptViaStdin: true };
  },
  // Kiro has NO start-time session-id flag; the orchestrator captures the id after
  // the fresh run (see buildListSessions / parseLatestKiroSession) and resumes by
  // it. `--resume-id <id>` resolves the session regardless of cwd (verified).
  // Answer piped on STDIN too, for the same ARG_MAX reason as the fresh run.
  buildResumeInvocation({ sessionId, answerMessage, agentName }) {
    const args = ['chat', '--no-interactive', '--trust-all-tools'];
    if (agentName) args.push('--agent', agentName);
    args.push('--resume-id', sessionId);
    return { command: 'kiro-cli', args, env: {}, prompt: answerMessage, promptViaStdin: true };
  },
  envForAuth(env) {
    return env.KIRO_API_KEY ? { KIRO_API_KEY: env.KIRO_API_KEY } : {};
  },
};

// ── OpenCode (headless) ──
// `opencode run --format json --auto --model amazon-bedrock/<id>` emits JSONL
// and reads the prompt from stdin. OpenCode chooses the session id; the runtime
// captures the first `sessionID` event and resumes it with `--session`.
const openCodeModel = (model) => {
  if (!model) return null;
  const value = String(model);
  return value.includes('/') ? value : `amazon-bedrock/${value}`;
};

const opencodeDriver = {
  name: 'opencode',
  buildInvocation({ prompt, model, opencodeConfigContent = null }) {
    const args = ['run', '--format', 'json', '--auto'];
    const resolvedModel = openCodeModel(model);
    if (resolvedModel) args.push('--model', resolvedModel);
    return {
      command: 'opencode',
      args,
      env: opencodeConfigContent ? { OPENCODE_CONFIG_CONTENT: opencodeConfigContent } : {},
      prompt,
      promptViaStdin: true,
    };
  },
  buildResumeInvocation({ sessionId, answerMessage, model, opencodeConfigContent = null }) {
    const args = ['run', '--format', 'json', '--auto', '--session', sessionId];
    const resolvedModel = openCodeModel(model);
    if (resolvedModel) args.push('--model', resolvedModel);
    return {
      command: 'opencode',
      args,
      env: opencodeConfigContent ? { OPENCODE_CONFIG_CONTENT: opencodeConfigContent } : {},
      prompt: answerMessage,
      promptViaStdin: true,
    };
  },
  envForAuth(env) {
    const out = {
      AWS_REGION: env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1',
      XDG_DATA_HOME: env.OPENCODE_XDG_DATA_HOME || '/home/node/.opencode-data',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    if (env.AWS_BEARER_TOKEN_BEDROCK) {
      out.AWS_BEARER_TOKEN_BEDROCK = env.AWS_BEARER_TOKEN_BEDROCK;
    }
    return out;
  },
};

// The argv that lists Kiro's stored conversations as JSON. Run AFTER a fresh Kiro
// stage exits to capture the id it created (Kiro can't be told the id up front).
export const buildKiroListSessions = () => ({
  command: 'kiro-cli',
  args: ['chat', '--list-sessions', '--format', 'json'],
});

// The argv that lists Kiro's available models as JSON. Kiro uses its OWN model
// namespace (e.g. "auto", "claude-sonnet-4.6"), not Bedrock inference profiles, so
// its models can only be discovered by asking the CLI — there is no Bedrock list
// for them. Output shape: { models: [{ model_id, model_name, description, ... }],
// default_model }. Used by the `capabilities` command (runs inside the container).
export const buildKiroListModels = () => ({
  command: 'kiro-cli',
  args: ['chat', '--list-models', '--format', 'json'],
});

// The argv that prints Kiro's plan usage summary — the `/usage` slash command
// run headless. Its report (plan, credits used/limit, and the overage rate
// "billed at $X.XX per credit") goes to STDERR, so run it with captureStderr.
// It only calls Kiro's GetUsageLimits API — it does not spend credits itself.
export const buildKiroUsage = () => ({
  command: 'kiro-cli',
  args: ['chat', '--no-interactive', '/usage'],
});

// Parse the per-request credit footer kiro-cli prints on STDERR after each
// headless chat turn: ` ▸ Credits: 0.03 • Time: 2s`. The label and number are
// plain text (ANSI color codes never split them), so a regex on the raw tail is
// safe. Returns the LAST match (the footer of the final turn) as a number, or
// null when absent/unparseable — callers treat null as "credits unknown".
export const parseKiroCredits = (stderrTail = '') => {
  const matches = [...String(stderrTail).matchAll(/Credits:\s*([\d.]+)/g)];
  if (!matches.length) return null;
  const n = Number(matches[matches.length - 1][1]);
  return Number.isFinite(n) ? n : null;
};

// Parse the $/credit overage rate out of `/usage` output ("Overages: Enabled
// billed at $0.04 per credit"). Returns a positive number or null — a missing
// rate (plan without overages, or a wording change) degrades to "credits
// recorded, cost unpriced", never a guessed dollar figure.
export const parseKiroCreditRate = (usageText = '') => {
  const m = String(usageText).match(/\$\s*([\d.]+)\s+per\s+credit/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Parse `kiro-cli chat --list-models --format json` into a compact, UI-friendly
// list plus the CLI's default. Returns { models: [{ id, name, description }],
// default } — empty list when the stdout is unparseable.
export const parseKiroModels = (stdout) => {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { models: [], default: null };
  }
  const rows = Array.isArray(parsed?.models) ? parsed.models : [];
  const models = rows
    .filter((m) => m && m.model_id)
    .map((m) => ({
      id: m.model_id,
      name: m.model_name ?? m.model_id,
      description: m.description ?? null,
    }));
  return { models, default: parsed?.default_model ?? null };
};

// Parse `kiro-cli chat --list-sessions --format json` and return the newest
// session id for `cwd` (newest by `updatedAt`). The output is keyed by cwd:
//   [{ cwd, sessions: [{ sessionId, updatedAt, ... }] }]
// Returns null when the stdout is unparseable or no session exists for the cwd —
// the caller treats a null capture as "could not link" (resume then can't run).
export const parseLatestKiroSession = (stdout, cwd) => {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const groups = Array.isArray(parsed) ? parsed : [];
  const group = cwd ? groups.find((g) => g?.cwd === cwd) : groups[0];
  const sessions = group?.sessions ?? [];
  if (!sessions.length) return null;
  const newest = sessions.reduce((a, b) => ((b?.updatedAt ?? '') > (a?.updatedAt ?? '') ? b : a));
  return newest?.sessionId ?? null;
};

export const DRIVERS = { claude: claudeDriver, kiro: kiroDriver, opencode: opencodeDriver };

// CLIs the runtime can drive, in stable preference order.
export const SUPPORTED_CLIS = ['claude', 'kiro', 'opencode'];

export const getDriver = (cli) => {
  const d = DRIVERS[cli];
  if (!d) throw new Error(`unsupported CLI "${cli}" (have: ${SUPPORTED_CLIS.join(', ')})`);
  return d;
};

// Pick the CLI to drive a stage. An EXPLICIT request is honoured strictly: if the
// requested CLI is not installed (e.g. its credentials aren't configured), return
// null rather than silently running a different CLI — the project's choice depends
// on which CLI is authed, so a quiet fallback would run the wrong agent. Only when
// NO CLI is requested (the test-harness path) do we pick the first installed CLI in
// preference order. Returns null when nothing usable is available.
export const selectCli = ({ requested, availableClis = [] } = {}) => {
  const installed = availableClis.filter((c) => SUPPORTED_CLIS.includes(c));
  if (requested) return installed.includes(requested) ? requested : null;
  for (const cli of SUPPORTED_CLIS) if (installed.includes(cli)) return cli;
  return null;
};

export { claudeDriver, kiroDriver, opencodeDriver };
