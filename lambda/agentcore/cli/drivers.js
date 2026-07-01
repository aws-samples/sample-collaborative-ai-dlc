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
// `claude -p <prompt> --mcp-config <file> --permission-mode bypassPermissions
//  --model <id> --output-format stream-json --verbose`
// Bedrock auth via env (CLAUDE_CODE_USE_BEDROCK + AWS_BEARER_TOKEN_BEDROCK),
// mirroring the v1 claude driver. Prompt on argv (-p).
const claudeDriver = {
  name: 'claude',
  buildInvocation({ prompt, mcpConfigPath, model, allowedTools = [], sessionId = null }) {
    const args = [
      '-p',
      prompt,
      '--mcp-config',
      mcpConfigPath,
      '--permission-mode',
      'bypassPermissions',
    ];
    // Force the conversation id up front so the orchestrator persists it without
    // scraping it back. `--session-id` is NEW-session-only — resume uses --resume.
    if (sessionId) args.push('--session-id', sessionId);
    if (model) args.push('--model', model);
    if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
    args.push('--output-format', 'stream-json', '--verbose');
    return { command: 'claude', args, env: {}, promptViaStdin: false };
  },
  // Resume the SAME conversation with the human's answer. Re-attach the MCP
  // servers (--mcp-config) so the parked tool surface is live again. Never reuse
  // --session-id here (it errors "already in use") — only --resume <uuid>.
  buildResumeInvocation({ sessionId, answerMessage, mcpConfigPath, model }) {
    const args = [
      '--resume',
      sessionId,
      '-p',
      answerMessage,
      '--mcp-config',
      mcpConfigPath,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (model) args.push('--model', model);
    args.push('--output-format', 'stream-json', '--verbose');
    return { command: 'claude', args, env: {}, promptViaStdin: false };
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
// `kiro-cli chat --no-interactive --trust-all-tools --agent <name> <prompt>`
// Kiro has NO `--mcp-config` flag (unlike Claude) — it discovers MCP servers from
// an AGENT config at <cwd>/.kiro/agents/<name>.json (written by the materializer)
// and is pointed at it with `--agent`. (Kiro reads the model via --model.)
// API-key auth via env (KIRO_API_KEY). Prompt on argv.
const kiroDriver = {
  name: 'kiro',
  buildInvocation({ prompt, agentName, model }) {
    const args = ['chat', '--no-interactive', '--trust-all-tools'];
    if (agentName) args.push('--agent', agentName);
    if (model) args.push('--model', model);
    args.push(prompt);
    return { command: 'kiro-cli', args, env: {}, promptViaStdin: false };
  },
  // Kiro has NO start-time session-id flag; the orchestrator captures the id after
  // the fresh run (see buildListSessions / parseLatestKiroSession) and resumes by
  // it. `--resume-id <id>` resolves the session regardless of cwd (verified).
  buildResumeInvocation({ sessionId, answerMessage, agentName }) {
    const args = ['chat', '--no-interactive', '--trust-all-tools'];
    if (agentName) args.push('--agent', agentName);
    args.push('--resume-id', sessionId, answerMessage);
    return { command: 'kiro-cli', args, env: {}, promptViaStdin: false };
  },
  envForAuth(env) {
    return env.KIRO_API_KEY ? { KIRO_API_KEY: env.KIRO_API_KEY } : {};
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

export const DRIVERS = { claude: claudeDriver, kiro: kiroDriver };

// CLIs the runtime can drive, in stable preference order.
export const SUPPORTED_CLIS = ['claude', 'kiro'];

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

export { claudeDriver, kiroDriver };
