import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';
import { canonicalNativePath } from './native-project-files.js';
import { nativeRuntimeBindingKey, nativeRuntimeResourceNames } from './native-runtime-binding.js';
import {
  NATIVE_ENGINE_PROFILE,
  engineFailure,
  nativeEnginePin,
  nativeWorkflowProfile,
} from './native-workflow-pin.js';

export {
  NATIVE_ENGINE_PROFILE,
  engineFailure,
  nativeEnginePin,
  nativeWorkflowProfile,
} from './native-workflow-pin.js';

export const NATIVE_ENGINE_SETTINGS_PATHS = Object.freeze([
  'aidlc.settings.json',
  'aidlc.settings.local.json',
  'aidlc/spaces/default/memory/org.md',
  'aidlc/spaces/default/memory/team.md',
  'aidlc/spaces/default/memory/project.md',
  ...['ideation', 'inception', 'construction', 'operation'].map(
    (phase) => `aidlc/spaces/default/memory/phases/${phase}.md`,
  ),
]);
export const NATIVE_ENGINE_TEXT_FLAGS = Object.freeze([
  '--details',
  '--user-input',
  '--decision',
  '--options',
  '--rationale',
  '--reason',
  '--test-command',
  '--feedback',
  '--label',
]);
export const relocateNativeEngineArguments = (args, from, to) =>
  args.map((arg, index) =>
    NATIVE_ENGINE_TEXT_FLAGS.includes(args[index - 1])
      ? arg
      : arg === from
        ? to
        : arg.startsWith(`${from}/`)
          ? `${to}${arg.slice(from.length)}`
          : arg,
  );
export const engineDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const shape = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).toSorted().join(',') === keys.toSorted().join(',');

export const nativeEngineAlias = (identity) => nativeRuntimeResourceNames(identity).roleName;
export const nativeReviewerAlias = (identity) => `review_${nativeEngineAlias(identity).slice(7)}`;
export const nativeEngineArn = (identity, pin) =>
  `${nativeEnginePin(pin).functionArn}:${nativeEngineAlias(identity)}`;

export const nativeEngineDeploymentPin = (env, pins) => {
  if (!nativeWorkflowProfile(pins.packageId, pins.harness)) return null;
  return nativeEnginePin(
    {
      profileId: NATIVE_ENGINE_PROFILE.id,
      producerSha256: env.NATIVE_WORKFLOW_ENGINE_SHA256,
      functionArn: env.NATIVE_WORKFLOW_ENGINE_ARN,
      version: env.NATIVE_WORKFLOW_ENGINE_VERSION,
    },
    { ...pins, accountId: env.NATIVE_RUNTIME_ACCOUNT_ID },
  );
};

export const nativeEngineObjectPrefix = (identity, purpose = 'state') => {
  if (
    !['state', 'input', 'output', 'job'].includes(purpose) ||
    !UUID.test(identity?.bindingId ?? '') ||
    !UUID.test(identity?.attemptId ?? '') ||
    !Number.isSafeInteger(identity?.epoch) ||
    identity.epoch < 1
  )
    throw engineFailure();
  const { pk } = nativeRuntimeBindingKey(identity);
  return `native-workflow-${purpose}/v1/${pk.slice(7)}/${identity.bindingId}/${identity.attemptId}/${identity.epoch}/`;
};

// Legacy snapshots carry bytes only. New observations also preserve the Git
// executable bit. Neither format represents links or arbitrary host paths.
export const nativeEngineFiles = (value) => {
  if (!Array.isArray(value) || value.length > 20_000)
    throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
  const seen = new Set();
  const directories = new Set();
  let total = 0;
  return value
    .map((file) => {
      if (
        !(
          shape(file, ['path', 'bytes', 'sha256', 'content']) ||
          (['100644', '100755'].includes(file?.mode) &&
            shape(file, ['path', 'bytes', 'sha256', 'content', 'mode']))
        ) ||
        !canonicalNativePath(file.path) ||
        seen.has(file.path) ||
        directories.has(file.path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > 16 * 1024 * 1024 ||
        (total += file.bytes) > 128 * 1024 * 1024 ||
        typeof file.sha256 !== 'string' ||
        !SHA.test(file.sha256) ||
        typeof file.content !== 'string' ||
        file.content.length > 24 * 1024 * 1024
      )
        throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
      const content = Buffer.from(file.content, 'base64');
      if (
        content.toString('base64') !== file.content ||
        content.length !== file.bytes ||
        engineDigest(content) !== file.sha256
      )
        throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        if (seen.has(parent)) throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
        directories.add(parent);
      }
      seen.add(file.path);
      return { ...file, content };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};
export const nativeEngineFileDigest = (files) =>
  engineDigest(
    canonicalJson(
      files
        .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
export const encodeNativeEngineFiles = (files) =>
  files.map(({ path, content, mode }) => ({
    path,
    ...(mode === undefined ? {} : { mode }),
    bytes: content.length,
    sha256: engineDigest(content),
    content: Buffer.from(content).toString('base64'),
  }));

// Authored files may be inspected by the engine; the coding workspace's
// workflow ledger, engine code, memory policy and review records are never
// imported as authority. Stage artifacts are selected by the issued directive,
// not by a runtime's request to make a filename authoritative.
export const nativeEngineAuthoredPath = (path, artifacts = []) => {
  if (!canonicalNativePath(path)) throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
  const parts = path.split('/');
  if (
    parts.some((part) =>
      [
        '.git',
        '.aidlc',
        '.codex',
        '.claude',
        '.kiro',
        '.opencode',
        '.agents',
        '.native-control',
        '.native-homes',
        '.aidlc-engine',
        '.aidlc-sessions',
      ].includes(part),
    ) ||
    [
      'AGENTS.md',
      'CLAUDE.md',
      'opencode.json',
      'opencode.jsonc',
      'aidlc.settings.json',
      'aidlc.settings.local.json',
    ].includes(path)
  )
    return false;
  if (parts[0] !== 'aidlc') return true;
  return (
    artifacts.includes(path) &&
    !parts.includes('audit') &&
    !parts.includes('reviews') &&
    !parts.includes('memory') &&
    !path.endsWith('/aidlc-state.md')
  );
};
