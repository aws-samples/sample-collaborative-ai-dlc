// capabilities — report what this runtime can actually run, for the project
// settings UI. Three facts the control plane can't get any other way:
//   1. which supported CLIs are INSTALLED in the image (discoverInstalledClis),
//   2. which of them are AUTHED for this invocation (claude needs
//      AWS_BEARER_TOKEN_BEDROCK, kiro needs KIRO_API_KEY),
//   3. Kiro's available MODELS — Kiro uses its own model namespace (not Bedrock
//      inference profiles), so the only source is `kiro-cli --list-models`, which
//      must run inside this container where the binary lives.
//
// IAM model discovery uses the invocation's broker credentials here so a
// central inference account or different region is reflected in the picker.
//
// Pure of process spawning: the CLI discovery + the Kiro model spawn are injected
// so the command is unit-tested without a real kiro-cli.

import { SUPPORTED_CLIS, buildKiroListModels, parseKiroModels } from '../cli/drivers.js';
import { discoverInstalledClis as defaultDiscover } from '../cli/discover.js';
import { captureChild as defaultCapture } from '../cli/spawn.js';
import { listIamBedrockModels } from '../bedrock-iam.js';

// The env var that proves each CLI is authed (mirrors auth-resolver's targets).
const AUTH_ENV = {
  claude: 'AWS_BEARER_TOKEN_BEDROCK',
  kiro: 'KIRO_API_KEY',
  opencode: 'AWS_BEARER_TOKEN_BEDROCK',
  codex: 'AWS_BEARER_TOKEN_BEDROCK',
};

export const capabilities = async (_payload, deps = {}) => {
  const {
    discoverInstalledClis = defaultDiscover,
    captureChild = defaultCapture,
    env = process.env,
    listBedrockModels = listIamBedrockModels,
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
    const iam = cli !== 'kiro' && Boolean(env.BEDROCK_IAM_CREDENTIALS_URI);
    const isAuthed = iam || (authEnv ? Boolean(env[authEnv]) : true);
    return {
      cli,
      installed: isInstalled,
      authed: isAuthed,
      available: isInstalled && isAuthed,
      ...(iam ? { authType: 'iam', region: env.BEDROCK_REGION } : {}),
    };
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

  const bedrockModels = env.BEDROCK_IAM_CREDENTIALS_URI
    ? await listBedrockModels(env).catch(() => [])
    : null;
  return { ok: true, clis, kiroModels, ...(bedrockModels ? { bedrockModels } : {}) };
};
