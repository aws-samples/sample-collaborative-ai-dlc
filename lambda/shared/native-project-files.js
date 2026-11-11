// Shared publication visibility policy. Repository content, including .env and
// .npmrc, belongs to the space's members; filenames do not classify it as secret.
// Platform workspace/harness files stay private; generated dependencies remain
// on EFS. Capture separately rejects actual credentials injected by the platform.
import { isAbsolute } from 'node:path';

export const NATIVE_DEPENDENCY_POLICY = 'node-dependencies-v1';

export const canonicalNativePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 4096 &&
  !isAbsolute(value) &&
  !value.includes('\\') &&
  ![...value].some(
    (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
  ) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

// Independent of .gitignore: normal workflow state, directives, questions,
// audit, verification and unknown artifact formats remain public run content.
export const nativeFileExclusion = (path, filesystemPolicy) => {
  if (!canonicalNativePath(path))
    throw Object.assign(new Error('native_snapshot_path_invalid'), {
      code: 'native_snapshot_path_invalid',
    });
  const parts = path.split('/');
  if (parts.includes('.git')) return 'git';
  if (
    parts.some((part) =>
      ['.claude', '.codex', '.kiro', '.opencode', '.agents', '.aidlc'].includes(part),
    )
  )
    return 'harness';
  if (['AGENTS.md', 'CLAUDE.md', 'opencode.json', 'opencode.jsonc'].includes(path))
    return 'harness';
  if (parts.some((part) => ['.native-control', '.native-homes'].includes(part)))
    return 'private-control';
  if (parts[0] === 'aidlc' && parts[1] === '.aidlc-sessions') return 'harness-session';
  if (parts.at(-1) === 'steering-token-key') return 'steering-key';
  if (parts.includes('.aidlc-engine')) {
    const name = parts.at(-1);
    if (/(?:lock|mutex|key)(?:\.|$)/.test(name)) return 'private-lock';
  }
  if (filesystemPolicy === NATIVE_DEPENDENCY_POLICY && parts.includes('node_modules'))
    return 'private-dependency';
  return null;
};
