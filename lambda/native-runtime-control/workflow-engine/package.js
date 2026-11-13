// This adapter executes only this reviewed upstream engine. Package admission
// permits other owner-selected releases; it does not make them completion
// authorities or grant them this service's credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectNativeRuntimeArchive } from '../../shared/native-runtime-package.js';
import {
  NATIVE_ENGINE_PROFILE,
  engineDigest,
  engineFailure,
} from '../../shared/native-workflow-protocol.js';
export {
  NATIVE_ENGINE_PROFILE,
  engineDigest,
  engineFailure,
} from '../../shared/native-workflow-protocol.js';

const engineDirectory = { claude: '.claude', codex: '.codex', opencode: '.aidlc' };

// The destination is a new directory in the protected service, never the
// coding workspace or a path supplied by an API caller. The caller owns its
// disposal if validation or materialization fails.
export const prepareNativeEngine = async ({ archive, harness, directory, adapterDirectory }) => {
  if (
    !NATIVE_ENGINE_PROFILE.harnesses.includes(harness) ||
    !Buffer.isBuffer(archive) ||
    engineDigest(archive) !== NATIVE_ENGINE_PROFILE.runtimeSha256
  )
    throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
  const { retainedFiles } = await inspectNativeRuntimeArchive(archive, {
    version: NATIVE_ENGINE_PROFILE.version,
    retainPrefix: `runtime/${harness}/`,
  });
  const installation = engineDirectory[harness];
  const modules = {};
  const adaptations = [];
  await mkdir(directory, { mode: 0o700 });
  for (const [path, original] of retainedFiles) {
    let bytes = original;
    if (path.startsWith(`${installation}/`) && path.endsWith('.ts')) {
      // A literal capability import adaptation, tied to the whole upstream
      // archive digest above. Workflow rules and gate logic are not rewritten.
      const text = original.toString('utf8');
      let adapted = text.replaceAll(
        'from "node:child_process"',
        `from ${JSON.stringify(join(adapterDirectory, 'process-port.mjs'))}`,
      );
      if (path === `${installation}/hooks/aidlc-record-human-turn.ts`) {
        const entry = 'async function run(input: string): Promise<number> {';
        if (text.split(entry).length !== 2)
          throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
        // The host invokes the existing hook after authenticating a platform
        // decision. Exporting it changes visibility only, not its gate logic.
        adapted = adapted.replace(entry, `export ${entry}`);
      }
      if (path === `${installation}/tools/aidlc-sensor.ts`) {
        const elapsed = 'const elapsedMs = Date.now() - startedAt;';
        if (text.split(elapsed).length !== 2)
          throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
        // The existing budget applies to execution. CodeBuild provisioning
        // and input transfer are excluded using its observed BUILD duration,
        // never a duration reported by the project command.
        adapted = adapted.replace(
          elapsed,
          'const elapsedMs = (result as any).nativeExecutionMs ?? Date.now() - startedAt;',
        );
        const invocation = 'const result = spawnSync(command[0], command.slice(1), {';
        if (text.split(invocation).length !== 2)
          throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
        // Correlate the actual invocation with its engine-owned fire ID.
        // This metadata goes to the host port, never to project code.
        adapted = adapted.replace(
          invocation,
          `${invocation}\n env: { ...process.env, NATIVE_ENGINE_SENSOR_RECEIPT: JSON.stringify({ sensor: ctx.sensor.id, stage: ctx.stageSlug, unit: ctx.unit ?? null, fireId: ctx.fireId, outputPath: ctx.outputPath }) },`,
        );
      }
      if (path === `${installation}/tools/aidlc-message-store.ts`) {
        const limit = 'export const MESSAGE_TEXT_MAX_CHARS = 8000;';
        if (text.split(limit).length !== 2)
          throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
        // Native already admits prompts up to 64 KiB. Preserve the complete
        // authenticated text; truncation must never create a different answer.
        adapted = adapted.replace(limit, 'export const MESSAGE_TEXT_MAX_CHARS = 65536;');
        const bytesLimit = 'const MESSAGE_MAX_BYTES = 256 * 1024;';
        if (text.split(bytesLimit).length !== 2)
          throw engineFailure('NATIVE_ENGINE_PACKAGE_UNSUPPORTED');
        adapted = adapted.replace(bytesLimit, 'const MESSAGE_MAX_BYTES = 1024 * 1024;');
      }
      bytes = Buffer.from(adapted);
      if (adapted !== text)
        adaptations.push({ path, upstream: engineDigest(original), adapted: engineDigest(bytes) });
    }
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    modules[target] = engineDigest(bytes);
  }
  return {
    profileId: NATIVE_ENGINE_PROFILE.id,
    installation: join(directory, installation),
    modules,
    adaptations,
  };
};
