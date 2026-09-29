// capabilities — report what this runtime can actually run, for the project
// settings UI. Three facts the control plane can't get any other way:
//   1. which supported CLIs are INSTALLED in the image (discoverInstalledClis),
//   2. which of them are AUTHED for this invocation (a credential lease was
//      prepared for the CLI's provider: bedrock for claude/opencode/codex, kiro),
//   3. Kiro's available MODELS — Kiro uses its own model namespace (not Bedrock
//      inference profiles), so the only source is `kiro-cli --list-models`, which
//      must run inside this container where the binary lives.
//
// Claude/OpenCode models are Bedrock inference profiles and are listed by the
// control-plane lambda via ListInferenceProfiles, NOT here. A runtime auth
// provider whose material this invocation adapted may add its own fields.
//
// Pure of process spawning: the CLI discovery + the Kiro model spawn are injected
// so the command is unit-tested without a real kiro-cli.

import { SUPPORTED_CLIS, buildKiroListModels, parseKiroModels } from '../cli/drivers.js';
import { discoverInstalledClis as defaultDiscover } from '../cli/discover.js';
import { captureChild as defaultCapture } from '../cli/spawn.js';
import {
  AGENT_AUTH_PROTOCOL_VERSION,
  AGENT_CREDENTIAL_PROVIDERS,
  credentialEnvName,
  credentialProviderForCli,
} from '../../shared/agent-auth-contracts.js';
import {
  RUNTIME_AGENT_AUTH_MODES,
  runtimeCapabilityContributions,
} from '../credential-material-registry.js';

export const capabilities = async (_payload, deps = {}) => {
  const {
    discoverInstalledClis = defaultDiscover,
    captureChild = defaultCapture,
    env = process.env,
    // The invocation's resolvedProviders. Only direct and harness calls, which carry no
    // invocation context, fall back to key presence in env; an empty list never does.
    authenticatedProviders = AGENT_CREDENTIAL_PROVIDERS.filter(
      (provider) => env[credentialEnvName(provider)],
    ),
    materialTypes = [],
    agentAuthModes = RUNTIME_AGENT_AUTH_MODES,
    capabilityContributions = runtimeCapabilityContributions,
  } = deps;

  let installed = [];
  try {
    installed = await discoverInstalledClis();
  } catch {
    installed = [];
  }

  // Per-CLI availability: installed AND authed. The UI uses `available` to gate
  // selection (running an un-authed CLI just fails), and surfaces `installed` /
  // `authed` so it can explain WHY a CLI is unavailable.
  const clis = SUPPORTED_CLIS.map((cli) => {
    const isInstalled = installed.includes(cli);
    const provider = credentialProviderForCli(cli);
    const isAuthed = provider ? authenticatedProviders.includes(provider) : true;
    return { cli, installed: isInstalled, authed: isAuthed, available: isInstalled && isAuthed };
  });

  // Kiro models — only when kiro is installed (the binary must exist to ask it).
  let kiroModels = { models: [], default: null };
  if (installed.includes('kiro')) {
    try {
      const list = buildKiroListModels();
      const { stdout } = await captureChild({
        command: list.command,
        args: list.args,
        env: env.KIRO_API_KEY ? { KIRO_API_KEY: env.KIRO_API_KEY } : {},
      });
      kiroModels = parseKiroModels(stdout ?? '');
    } catch {
      kiroModels = { models: [], default: null };
    }
  }

  const contributions = await capabilityContributions({ env, materialTypes });
  return {
    ok: true,
    ...contributions,
    clis,
    kiroModels,
    agentAuthProtocol: AGENT_AUTH_PROTOCOL_VERSION,
    agentAuthModes: [...agentAuthModes],
    invocationAccounting: true,
  };
};
