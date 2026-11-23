import { join } from 'node:path';
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

export function nativeGuardToolInput(guard, project) {
  if (
    guard?.tool === 'Write' &&
    Object.keys(guard).length === 3 &&
    canonicalNativePath(guard.path) &&
    nativeFileExclusion(guard.path, NATIVE_DEPENDENCY_POLICY) === null &&
    nativeEngineAuthoredPath(guard.path) &&
    typeof guard.content === 'string' &&
    Buffer.byteLength(guard.content) <= 256 * 1024
  )
    return { file_path: join(project, guard.path), content: guard.content };
  if (guard?.tool === 'Bash' && Object.keys(guard).length === 2 && localShell(guard.command))
    return { command: guard.command };
  throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
}
