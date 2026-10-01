import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeWorkflowExport } from '@/services/intents';
import { NativeExportSetupDialog } from './NativeExportSetupDialog';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(['manual-workspace', 'manual-clone'] as const)(
  'native export commands: %s',
  (mode) => {
    it.each(['-repo', '.github', 'test...plop'])(
      'clones into %s using the rendered shell commands',
      (directory) => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-export-commands-')));
        roots.push(root);
        const remote = path.join(root, "remote's source");
        const workspace = path.join(root, 'workspace');
        mkdirSync(workspace);
        const env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          ),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        };
        const branch = "feature/it's-ready";
        const git = (args: string[], cwd = root) =>
          execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            cwd,
            env,
            encoding: 'utf8',
            stdio: 'pipe',
          });
        git(['init', `--initial-branch=${branch}`, remote]);
        writeFileSync(path.join(remote, 'README.md'), 'source repository\n');
        git(['add', 'README.md'], remote);
        git(
          [
            '-c',
            'user.name=Native Export Test',
            '-c',
            'user.email=native-export@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-m',
            'seed',
          ],
          remote,
        );
        const exportResult: NativeWorkflowExport = {
          exportId: 'export-test',
          filename: 'workspace.zip',
          downloadUrl: 'https://example.invalid/workspace.zip',
          expiresAt: '2026-09-15T12:00:00Z',
          warnings: [],
          setup: {
            workspaceLayout: mode === 'manual-workspace' ? 'spaces' : 'flat',
            mode,
            harnessDir: '.codex',
            launchCommand: 'codex',
            continueCommand: '$aidlc',
            showWorkspaceSetup: true,
            repositories: [
              {
                id: `owner/${directory}`,
                directory,
                url: pathToFileURL(remote).href,
                branch,
              },
            ],
          },
        };
        render(<NativeExportSetupDialog exportResult={exportResult} onClose={() => {}} />);

        const command = screen.getByText(/git clone --branch/, { selector: 'code' }).textContent!;
        const output = execFileSync('/bin/sh', ['-eu', '-c', `${command}\npwd`], {
          cwd: workspace,
          env,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        const checkout = path.join(workspace, directory);
        expect(readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe('source repository\n');
        expect(git(['branch', '--show-current'], checkout).trim()).toBe(branch);
        expect(output.trim()).toBe(mode === 'manual-clone' ? checkout : workspace);

        if (mode === 'manual-workspace') {
          const update = screen.getByText(/git -C/, { selector: 'code' }).textContent!;
          execFileSync('/bin/sh', ['-eu', '-c', update], {
            cwd: workspace,
            env,
            stdio: 'pipe',
          });
          expect(git(['branch', '--show-current'], checkout).trim()).toBe(branch);
        }
      },
      15_000,
    );
  },
);
