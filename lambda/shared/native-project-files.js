// Shared publication visibility policy. Recovery contains private files too;
// its public project subset must match the exact committed publication.
import { isAbsolute } from 'node:path';

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

// Existing private-recovery credential classification. Kept separate from
// public admission: changing historical visibility is an independent policy
// decision. Derived indexes also avoid copying these files' content.
export const nativeCredentialPath = (path) => {
  const parts = path.split('/');
  return (
    parts.some((part) => ['.aws', '.ssh'].includes(part)) ||
    ['.git-credentials', '.netrc', '.npmrc', '.pypirc'].includes(parts.at(-1)) ||
    (/^\.env(?:\.|$)/.test(parts.at(-1)) &&
      !/\.env(?:\.[\w-]+)*\.(?:example|sample|template)$/.test(parts.at(-1))) ||
    /^\.codex\/auth\.json$/.test(path) ||
    /^\.claude\/(?:\.credentials\.json|credentials\.json)$/.test(path)
  );
};

// Independent of .gitignore: normal workflow state, directives, questions,
// audit, verification and unknown artifact formats remain public run content.
export const nativeFileExclusion = (path) => {
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
  return null;
};
