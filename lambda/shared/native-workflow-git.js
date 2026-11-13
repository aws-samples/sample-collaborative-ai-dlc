import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { engineFailure } from './native-workflow-protocol.js';

// Git is metadata over a private inspection repository. No executable project
// config, hooks, filters, credential helpers, remotes or delivery are imported.
// The real application's admitted source commit remains a separate NE-09 pin.
export const createNativeInspectionGit = ({ project, home, signal }) => {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper',
    GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'protocol.allow',
    GIT_CONFIG_VALUE_3: 'never',
    GIT_CONFIG_KEY_4: 'core.attributesFile',
    GIT_CONFIG_VALUE_4: '/dev/null',
    GIT_AUTHOR_NAME: 'Native inspection',
    GIT_AUTHOR_EMAIL: 'native@localhost',
    GIT_COMMITTER_NAME: 'Native inspection',
    GIT_COMMITTER_EMAIL: 'native@localhost',
  };
  const run = (args, input) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(engineFailure('NATIVE_ENGINE_CANCELLED'));
      const child = spawn('/usr/bin/git', args, {
        cwd: project,
        env,
        signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let length = 0;
      let overflow = false;
      const timer = setTimeout(() => {
        overflow = true;
        child.kill('SIGKILL');
      }, 15_000);
      for (const [stream, chunks] of [
        [child.stdout, stdout],
        [child.stderr, stderr],
      ]) {
        stream.on('data', (chunk) => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) {
            overflow = true;
            child.kill('SIGKILL');
          } else chunks.push(chunk);
        });
      }
      child.stdin.on('error', () => {});
      child.once('error', reject);
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        if (overflow || exitCode === null)
          reject(engineFailure('NATIVE_ENGINE_METADATA_UNAVAILABLE'));
        else resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.end(input);
    });
  return {
    async initialize(files, sourceCommit) {
      for (const args of [
        ['init', '--initial-branch=native-inspection'],
        ['config', 'core.fileMode', 'false'],
      ]) {
        if ((await run(args)).exitCode !== 0)
          throw engineFailure('NATIVE_ENGINE_METADATA_UNAVAILABLE');
      }
      await mkdir(join(project, '.git/info'), { recursive: true });
      await writeFile(
        join(project, '.git/info/exclude'),
        'aidlc/\n.codex/\n.claude/\n.aidlc/\n.kiro/\n.opencode/\n.agents/\n.native-control/\n',
      );
      if (
        files.length &&
        (
          await run(
            ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
            Buffer.from(files.map((file) => file.path).join('\0') + '\0'),
          )
        ).exitCode !== 0
      )
        throw engineFailure('NATIVE_ENGINE_METADATA_UNAVAILABLE');
      if (
        (
          await run([
            'commit',
            '--allow-empty',
            '-m',
            `Inspection snapshot of admitted source ${sourceCommit}`,
          ])
        ).exitCode !== 0
      )
        throw engineFailure('NATIVE_ENGINE_METADATA_UNAVAILABLE');
    },
    async metadata(request) {
      if (!['git', '/usr/bin/git'].includes(request.command) || request.cwd !== project)
        return null;
      const args = request.args;
      const exact = [
        ['rev-parse', '--show-toplevel'],
        ['rev-parse', '--show-prefix'],
        ['rev-parse', '--git-dir'],
        ['rev-parse', '--git-common-dir'],
        ['rev-parse', '--is-inside-work-tree'],
        ['rev-parse', 'HEAD'],
        ['rev-parse', '--verify', 'HEAD'],
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        ['status', '--porcelain'],
        ['status', '--porcelain=v1'],
        ['ls-files'],
        ['ls-files', '-z'],
      ];
      const readonly = {
        status: new Set([
          '--porcelain',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--untracked-files=no',
        ]),
        'ls-files': new Set([
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--stage',
          '--error-unmatch',
        ]),
        diff: new Set([
          '--name-only',
          '--name-status',
          '--numstat',
          '--stat',
          '--no-ext-diff',
          '--no-textconv',
          '--cached',
          '--staged',
          '-z',
          '--diff-filter=ACDMRTUXB',
          '--diff-filter=ACMR',
          'HEAD',
        ]),
      };
      const flagsOnly =
        args.length > 1 &&
        readonly[args[0]] &&
        args.slice(1).every((arg) => readonly[args[0]].has(arg));
      if (!flagsOnly && !exact.some((value) => JSON.stringify(value) === JSON.stringify(args)))
        return null;
      const selected =
        args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
      return { ...(await run(selected)), observation: { kind: 'inspection-metadata' } };
    },
  };
};
