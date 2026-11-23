import { nativeWorkflowHook } from '../native/workflow-hook.js';
import { nativeGuardToolInput } from '../../shared/native-workflow-guard.js';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launcher = fileURLToPath(new URL('../native/aidlc-launcher.sh', import.meta.url));

let temp;
let bin;
let marker;

beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-workflow-launcher-')));
  bin = join(temp, 'bin');
  marker = join(temp, 'local-binary-arguments');
  await fs.mkdir(bin, { mode: 0o700 });
  // Stands in for the installed engine: records its arguments and exits 7.
  await fs.writeFile(
    join(bin, 'aidlc'),
    '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" > "$LOCAL_BINARY_MARKER"\necho local-binary\nexit 7\n',
    { mode: 0o755 },
  );
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const launch = (args, { context = true, env = {} } = {}) => {
  const result = spawnSync('/bin/sh', [launcher, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      AIDLC_BIN_DIR: bin,
      LOCAL_BINARY_MARKER: marker,
      ...(context ? { NATIVE_WORKFLOW_CONTEXT: join(temp, 'context.json') } : {}),
      ...env,
    },
  });
  return result;
};
const localArguments = async () => {
  try {
    const [count, ...args] = (await fs.readFile(marker, 'utf8')).split('\n').slice(0, -1);
    expect(args).toHaveLength(Number(count));
    return args;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const reachesLocalBinary = async (args, options) => {
  const result = launch(args, options);
  expect(await localArguments()).toEqual(args);
  expect(result.status).toBe(7);
  expect(result.stdout).toBe('local-binary\n');
};
// This host has neither the image's Node path nor its workflow client, so a
// forwarded command ends in the launcher's exec of that fixed path.
const forwardedToWorkflowClient = async (args) => {
  const result = launch(args);
  expect(await localArguments()).toBeNull();
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBe(7);
  expect(result.stdout).not.toContain('local-binary');
  expect(result.stderr).toMatch(/\/usr\/local\/bin\/node|workflow-cli\.mjs/);
  expect(result.stderr).not.toContain('Native AI-DLC');
};

const workflowCommands = [
  ['next'],
  ['continue'],
  ['engine', 'orchestrate', 'next'],
  ['engine', 'orchestrate', 'report', '--stage', 'intent-capture', '--result', 'approved'],
  ['engine', 'state', 'set', 'Status', 'Completed'],
  ['engine', 'audit', 'append', '--details', 'reviewed by a human'],
  ['engine', 'log', 'review', '--stage', 'requirements-analysis'],
  ['engine'],
  ['engine', 'hooks'],
  ['hook', 'engine'],
  ['--version', 'engine', 'state', 'set'],
  [],
];
const localCommands = [
  ['engine', 'hook', 'session-end'],
  ['engine', 'hook', 'session-start', '--json'],
  ['engine', 'hook'],
  ['--version'],
  ['version'],
  ['use'],
  ['project'],
];

describe('native aidlc launcher with a protected workflow context', () => {
  it.each(workflowCommands.map((args) => [args.join(' ') || '(no arguments)', args]))(
    'forwards the workflow command to the workflow client: %s',
    async (_name, args) => {
      await forwardedToWorkflowClient(args);
    },
  );

  it.each(localCommands.map((args) => [args.join(' '), args]))(
    'keeps the local helper on the installed binary: %s',
    async (_name, args) => {
      await reachesLocalBinary(args);
    },
  );

  // The dispatch table matches "$1 $2" against "use " and "project ", which
  // only equals a bare `use` / `project`. These assert the documented contract
  // that the local helpers keep their arguments.
  it.each([
    ['use 2.11.1', ['use', '2.11.1']],
    ['project list', ['project', 'list']],
  ])('keeps the local helper with its arguments on the installed binary: %s', async (_n, args) => {
    await reachesLocalBinary(args);
  });

  it('never forwards a workflow command to the local binary when its context is unusable', async () => {
    const result = launch(['next'], { env: { NATIVE_WORKFLOW_CONTEXT: '/nonexistent/context' } });
    expect(await localArguments()).toBeNull();
    expect(result.status).not.toBe(0);
  });

  it('passes arguments containing spaces and quotes unchanged to the local helper', async () => {
    await reachesLocalBinary(['engine', 'hook', 'session end', `it's "quoted" $HOME *`]);
  });
});

describe('native aidlc launcher without a workflow context', () => {
  it.each(
    [...workflowCommands, ...localCommands, ['use', '2.11.1'], ['project', 'list']].map((args) => [
      args.join(' ') || '(no arguments)',
      args,
    ]),
  )('runs the installed binary: %s', async (_name, args) => {
    await reachesLocalBinary(args, { context: false });
  });

  it('treats an empty context as no context', async () => {
    await reachesLocalBinary(['next'], { env: { NATIVE_WORKFLOW_CONTEXT: '' } });
  });

  it.each([
    ['no installation directory', { AIDLC_BIN_DIR: '' }],
    ['a relative installation directory', { AIDLC_BIN_DIR: 'bin' }],
  ])('fails with 127 for %s', async (_name, env) => {
    const result = launch(['next'], { context: false, env });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('Native AI-DLC installation is not configured.');
    expect(await localArguments()).toBeNull();
  });

  it('fails with 127 when the installed binary is missing or not executable', async () => {
    await fs.chmod(join(bin, 'aidlc'), 0o644);
    const unusable = launch(['next'], { context: false });
    expect(unusable.status).toBe(127);
    expect(unusable.stderr).toContain('Native AI-DLC executable is unavailable.');
    await fs.rm(join(bin, 'aidlc'));
    expect(launch(['next'], { context: false }).status).toBe(127);
    expect(await localArguments()).toBeNull();
  });

  it('refuses to run itself as the installed binary', async () => {
    await fs.rm(join(bin, 'aidlc'));
    await fs.copyFile(launcher, join(temp, 'aidlc'));
    await fs.chmod(join(temp, 'aidlc'), 0o755);
    await fs.symlink(join(temp, 'aidlc'), join(bin, 'aidlc'));
    const result = spawnSync('/bin/sh', [join(temp, 'aidlc'), 'next'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', AIDLC_BIN_DIR: bin },
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('Native AI-DLC executable is unavailable.');
  });
});

describe('receipt-bound PreToolUse', () => {
  const args = ['engine', 'hook', 'guard-tool-call'];
  const refused = {
    exitCode: 2,
    stdout: '',
    stderr:
      'no current Plan Approval receipt matches this question, target, stage attempt, and plan content',
  };
  const accepted = { exitCode: 0, stdout: '', stderr: '' };
  const event = {
    hook_event_name: 'PreToolUse',
    cwd: '/coding',
    tool_name: 'Write',
    tool_input: { file_path: '/coding/src/test.js', content: 'exact source' },
  };
  it('checks the actual proposed Write only after the other installed group members admit it', async () => {
    const calls = [];
    const local = (arguments_, input) => {
      calls.push(arguments_[2]);
      expect(JSON.parse(input)).toEqual(event);
      return arguments_[2] === 'guard-tool-call' ? refused : accepted;
    };
    const check = vi.fn(async () => accepted);
    expect(
      await nativeWorkflowHook({
        args,
        input: JSON.stringify(event),
        project: '/coding',
        local,
        check,
      }),
    ).toEqual(accepted);
    expect(check).toHaveBeenCalledWith({
      tool: 'Write',
      path: 'src/test.js',
      content: 'exact source',
    });
    expect(calls).toEqual([
      'guard-tool-call',
      'state-transition-guard',
      'reviewer-scope',
      'review-freeze',
    ]);
  });
  it('retains local review freezes, private or foreign target refusals and a protected denial', async () => {
    const check = vi.fn(async () => refused);
    const run = (local, ev = event) =>
      nativeWorkflowHook({ args, input: JSON.stringify(ev), project: '/coding', local, check });
    expect(await run(() => refused)).toEqual(refused);
    expect(await run(() => refused, { ...event, cwd: '/other' })).toEqual(refused);
    expect(
      await run(() => refused, { ...event, tool_input: { file_path: '/other/x', content: 'x' } }),
    ).toEqual(refused);
    await expect(
      run(() => refused, {
        ...event,
        tool_input: { file_path: '/coding/aidlc/.aidlc-sessions/x', content: 'x' },
      }),
    ).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    expect(check).not.toHaveBeenCalled();
    expect(await run((a) => (a[2] === 'guard-tool-call' ? refused : accepted))).toEqual(refused);
    expect(check).toHaveBeenCalledOnce();
  });
  it('transfers literal project-relative Bash input without executing it on the host', () => {
    expect(
      nativeGuardToolInput({ tool: 'Bash', command: 'chmod +x run && ./run' }, '/protected'),
    ).toEqual({ command: 'chmod +x run && ./run' });
    for (const command of [
      'cat /private/file',
      'cat ../private',
      'cat "$ROOT/file"',
      'cd .. && ./run',
    ])
      expect(() => nativeGuardToolInput({ tool: 'Bash', command }, '/protected')).toThrow(
        'NATIVE_ENGINE_EDIT_DENIED',
      );
  });
});
