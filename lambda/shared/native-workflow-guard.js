import { join } from 'node:path';
import { NATIVE_PENDING_SPEC_PATH } from './native-pending-input.js';
import {
  canonicalNativePath,
  nativeFileExclusion,
  NATIVE_DEPENDENCY_POLICY,
} from './native-project-files.js';
import { engineFailure, nativeEngineAuthoredPath } from './native-workflow-protocol.js';

// Only literal, project-relative shell words are transferable between roots.
// The pinned hook inspects this command. The protected host never executes it.
const localShell = (command) =>
  typeof command === 'string' &&
  command.length <= 4096 &&
  command
    .split(/ +&& +/)
    .every((part) =>
      part
        .split(/ +/)
        .every(
          (word) =>
            /^[A-Za-z0-9_.+-][A-Za-z0-9_.+/-]*$/.test(word) && !word.split('/').includes('..'),
        ),
    );

export function nativeGuardToolInput(guard, project, harness) {
  if (guard?.tool === 'Write' && canonicalNativePath(guard.path)) {
    // The single display file is checked as a proposed hook target, never
    // imported into the protected workspace or treated as a human answer.
    if (
      guard.path !== NATIVE_PENDING_SPEC_PATH &&
      (nativeFileExclusion(guard.path, NATIVE_DEPENDENCY_POLICY) !== null ||
        !nativeEngineAuthoredPath(guard.path))
    )
      throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
    const file_path = join(project, guard.path);
    if (
      Object.keys(guard).length === 3 &&
      typeof guard.content === 'string' &&
      Buffer.byteLength(guard.content) <= 256 * 1024
    )
      return { file_path, content: guard.content };
    // The pinned OpenCode plugin supplies only file_path to its plan guard.
    // The ordinary promotion checks the subsequently observed file bytes.
    if (harness === 'opencode' && Object.keys(guard).length === 2) return { file_path };
  }
  if (guard?.tool === 'Bash' && Object.keys(guard).length === 2 && localShell(guard.command))
    return { command: guard.command };
  throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
}
