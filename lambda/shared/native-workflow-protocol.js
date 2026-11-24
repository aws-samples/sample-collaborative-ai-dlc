import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';
import { canonicalNativePath } from './native-project-files.js';
import { nativeRuntimeBindingKey } from './native-runtime-binding.js';
import { engineFailure } from './native-workflow-pin.js';

export {
  NATIVE_ENGINE_PROFILE,
  engineFailure,
  nativeEnginePin,
  nativeWorkflowProfile,
} from './native-workflow-pin.js';

export const engineDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const nativeEngineObjectPrefix = (identity, purpose = 'output') => {
  if (
    purpose !== 'output' ||
    !UUID.test(identity?.bindingId ?? '') ||
    !UUID.test(identity?.attemptId ?? '') ||
    !Number.isSafeInteger(identity?.epoch) ||
    identity.epoch < 1
  )
    throw engineFailure();
  const { pk } = nativeRuntimeBindingKey(identity);
  return `native-workflow-${purpose}/v1/${pk.slice(7)}/${identity.bindingId}/${identity.attemptId}/${identity.epoch}/`;
};

export const nativeEngineFileDigest = (files) =>
  engineDigest(
    canonicalJson(
      files
        .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
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
