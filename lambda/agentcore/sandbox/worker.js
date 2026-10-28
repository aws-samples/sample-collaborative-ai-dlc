// One process owns one SandboxManager and its proxies. Its IPC channel is not
// inherited by the sandboxed command; stdout/stderr remain the harness protocol.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../cli/environment.js';

const commandEntry = fileURLToPath(new URL('./command.js', import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const bounded = (value) =>
  String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}<>]/gu, ' ')
    .slice(0, 256);

export const violationEvent = (violation, secrets = []) => {
  let line = String(violation.line ?? '');
  for (const secret of secrets) {
    if (secret) line = line.split(secret).join('[REDACTED]');
  }
  const network = /^deny network-outbound (.+):(\d+) \((.*)\)$/.exec(line);
  if (network) {
    return {
      type: 'sandbox.denied',
      source: 'proxy',
      host: bounded(network[1]),
      port: Number(network[2]),
      reason: bounded(network[3]),
    };
  }
  const file = /^deny ([a-z][a-z0-9_]*) (\/.*)$/.exec(line);
  if (file) {
    return {
      type: 'sandbox.file_observation',
      source: 'linux_write_monitor',
      operation: bounded(file[1]),
      path: bounded(file[2]),
      confirmedDenial: false,
    };
  }
  // Do not copy command text, arbitrary URLs or unknown messages into logs.
  return { type: 'sandbox.observation', source: 'srt', detail: 'unclassified_violation' };
};

export const runSandboxWorker = async (
  request,
  { manager, spawnFn = spawn, emit = () => {}, signal } = {},
) => {
  const { command, args, env, settings, invocationId } = request;
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string') ||
    settings?.enableWeakerNestedSandbox
  ) {
    throw new Error('Invalid sandbox launch configuration');
  }
  const secrets = Object.entries(env ?? {})
    .filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(key))
    .map(([, value]) => value);
  let unsubscribe;
  let child;
  let launchDirectory;
  const cancel = () => child?.kill('SIGKILL');
  try {
    signal?.throwIfAborted();
    // Shells and native helpers run before bwrap enters its namespaces. Give
    // them only the trusted worker environment. Deliver the harness's argv and
    // environment through a read-only file consumed *inside* the sandbox.
    const outerEnv = childEnvironment({}, process.env);
    launchDirectory = await mkdtemp(join(tmpdir(), 'srt-launch-'));
    const launchPath = join(launchDirectory, 'command.json');
    await writeFile(launchPath, JSON.stringify({ command, args, env, outerEnv }), { mode: 0o600 });
    const effectiveSettings = {
      ...settings,
      filesystem: {
        ...settings.filesystem,
        denyWrite: [...(settings.filesystem?.denyWrite ?? []), launchDirectory],
      },
    };
    // SRT does not interpret strictAllowlist:false as allow-all by itself.
    // In our permissive mode, approve unlisted destinations explicitly.
    // Denied domains still take precedence inside SRT.
    const approveUnlisted =
      settings.network.strictAllowlist === false ? async () => true : undefined;
    await manager.initialize(
      effectiveSettings,
      approveUnlisted,
      request.observeFileWrites === true,
    );
    const store = manager.getSandboxViolationStore();
    let seen = store.getTotalCount();
    unsubscribe = store.subscribe((violations) => {
      const total = store.getTotalCount();
      const added = Math.max(0, total - seen);
      seen = total;
      if (added > violations.length) {
        emit({ type: 'sandbox.log_gap', count: added - violations.length });
      }
      if (added > 0) {
        for (const violation of violations.slice(-Math.min(added, violations.length))) {
          emit(violationEvent(violation, secrets));
        }
      }
    });
    const wrapped = await manager.wrapWithSandboxArgv(
      [process.execPath, commandEntry, launchPath].map(quote).join(' '),
      '/bin/bash',
      undefined,
      signal,
      undefined,
      { commandId: invocationId, commandText: 'agent invocation' },
    );
    signal?.throwIfAborted();
    child = spawnFn(wrapped.argv[0], wrapped.argv.slice(1), {
      env: outerEnv,
      shell: false,
      stdio: 'inherit',
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    emit({
      type: 'sandbox.starting',
      fileWriteObservation: request.observeFileWrites ? 'requested' : 'disabled',
    });
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Attempt every cleanup step without replacing the command's result or
    // hiding an earlier setup error. Never log cleanup exception contents.
    for (const [step, cleanup] of [
      ['unsubscribe', () => unsubscribe?.()],
      ['command', () => manager.cleanupAfterCommand()],
      ['manager', () => manager.reset()],
      [
        'launch_files',
        () => launchDirectory && rm(launchDirectory, { recursive: true, force: true }),
      ],
    ]) {
      try {
        await cleanup();
      } catch {
        emit({ type: 'sandbox.cleanup_failed', step });
      }
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('disconnect', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  process.once('message', async (request) => {
    const pendingEvents = new Set();
    const emit = (event) => {
      if (!process.connected) return;
      const pending = new Promise((resolve) => process.send(event, () => resolve()));
      pendingEvents.add(pending);
      void pending.then(() => pendingEvents.delete(pending));
    };
    try {
      if (process.platform !== 'linux') throw new Error('Unsupported sandbox host');
      const { SandboxManager, SandboxRuntimeConfigSchema } =
        await import('@anthropic-ai/sandbox-runtime');
      request.settings = SandboxRuntimeConfigSchema.parse(request.settings);
      const outcome = await runSandboxWorker(request, {
        manager: SandboxManager,
        emit,
        signal: controller.signal,
      });
      await Promise.all(pendingEvents);
      process.exit(outcome.code ?? 1);
    } catch {
      // Library errors can contain configuration/command secrets.
      emit({ type: 'sandbox.error', code: 'sandbox_start_failed' });
      await Promise.all(pendingEvents);
      process.exit(1);
    }
  });
}
