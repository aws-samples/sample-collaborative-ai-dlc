// capabilities — report what this runtime can actually run, for the project
// settings UI. Three facts the control plane can't get any other way:
//   1. which supported CLIs are INSTALLED in the image (discoverInstalledClis),
//   2. which of them are AUTHED for this invocation — answered from the
//      credential binding the broker RESOLVED for this invocation, never from
//      the presence of a secret environment variable,
//   3. Kiro's available MODELS — Kiro uses its own model namespace (not Bedrock
//      inference profiles), so the only source is `kiro-cli --list-models`, which
//      must run inside this container where the binary lives.
//
// Why not an env-var probe: a Bedrock binding can be an IAM role rather than a
// bearer token, in which case AWS_BEARER_TOKEN_BEDROCK is deliberately unset and
// an `env.AWS_BEARER_TOKEN_BEDROCK` test would report claude/opencode/codex
// unavailable — exactly the CLIs role mode enables. `resolvedProviders` is the
// broker's own answer to "is this scope's binding usable", so it is correct for
// every credential shape and needs no AssumeRole of its own
// (specs/bedrock-iam-role-credential-mode: req-capabilities-authed).
//
// Claude/OpenCode models are Bedrock inference profiles and are listed by the
// control-plane lambda via ListInferenceProfiles, NOT here.
//
// Pure of process spawning: the CLI discovery + the Kiro model spawn are injected
// so the command is unit-tested without a real kiro-cli.

import { SUPPORTED_CLIS, buildKiroListModels, parseKiroModels } from '../cli/drivers.js';
import { credentialProviderForCli } from '../../shared/agent-credentials.js';
import { discoverInstalledClis as defaultDiscover } from '../cli/discover.js';
import { captureChild as defaultCapture } from '../cli/spawn.js';

export const capabilities = async (_payload, deps = {}) => {
  const {
    discoverInstalledClis = defaultDiscover,
    captureChild = defaultCapture,
    env = process.env,
    // Providers whose binding the broker resolved to a usable credential for
    // THIS invocation. Absent means nothing was resolved, so every
    // credential-backed CLI is unavailable — fail closed, never fail open.
    resolvedProviders = [],
  } = deps;

  let installed = [];
  try {
    installed = await discoverInstalledClis();
  } catch {
    installed = [];
  }

  // Per-CLI availability: installed AND authed. The UI uses `available` to gate
  // selection (running an un-authed CLI just fails), and surfaces `installed` /
  // `authed` so it can explain WHY a CLI is unavailable. `authed` is a question
  // about the resolved BINDING, so it answers identically for a bearer token, an
  // IAM role, or any future key-based provider.
  const resolved = new Set(resolvedProviders);
  const clis = SUPPORTED_CLIS.map((cli) => {
    const isInstalled = installed.includes(cli);
    const provider = credentialProviderForCli(cli);
    const isAuthed = provider ? resolved.has(provider) : true;
    return { cli, installed: isInstalled, authed: isAuthed, available: isInstalled && isAuthed };
  });

  // Kiro models — only when kiro is installed (the binary must exist to ask it).
  let kiroModels = { models: [], default: null };
  if (installed.includes('kiro')) {
    try {
      const list = buildKiroListModels();
      const { stdout } = await captureChild({ command: list.command, args: list.args, env });
      kiroModels = parseKiroModels(stdout ?? '');
    } catch {
      kiroModels = { models: [], default: null };
    }
  }

  return { ok: true, clis, kiroModels };
};
