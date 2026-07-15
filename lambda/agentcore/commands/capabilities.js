// capabilities — report what this runtime can actually run, for the project
// settings UI. Three facts the control plane can't get any other way:
//   1. which supported CLIs are INSTALLED in the image (discoverInstalledClis),
//   2. which of them are AUTHED (the auth secret resolved into env at startup —
//      claude needs AWS_BEARER_TOKEN_BEDROCK, kiro needs KIRO_API_KEY),
//   3. Kiro's available MODELS — Kiro uses its own model namespace (not Bedrock
//      inference profiles), so the only source is `kiro-cli --list-models`, which
//      must run inside this container where the binary lives.
//
// Claude/OpenCode models are Bedrock inference profiles and are listed by the
// control-plane lambda via ListInferenceProfiles, NOT here.
//
// Pure of process spawning: the CLI discovery + the Kiro model spawn are injected
// so the command is unit-tested without a real kiro-cli.

import { SUPPORTED_CLIS, buildKiroListModels, parseKiroModels } from '../cli/drivers.js';
import { discoverInstalledClis as defaultDiscover } from '../cli/discover.js';
import { captureChild as defaultCapture } from '../cli/spawn.js';

// The env var that proves each CLI is authed (mirrors auth-resolver's targets).
const AUTH_ENV = {
  claude: 'AWS_BEARER_TOKEN_BEDROCK',
  kiro: 'KIRO_API_KEY',
  opencode: 'AWS_BEARER_TOKEN_BEDROCK',
};

export const capabilities = async (_payload, deps = {}) => {
  const {
    discoverInstalledClis = defaultDiscover,
    captureChild = defaultCapture,
    env = process.env,
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
    const authEnv = AUTH_ENV[cli];
    const isAuthed = authEnv ? Boolean(env[authEnv]) : true;
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
