import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const loadBranchCleanup = async () => await import('../branch-cleanup.js');
const loadConstructionOrchestratorPrompt = async () =>
  await import('../construction-orchestrator-prompt.js');

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const poolWorker = readFileSync(new URL('../pool-worker.js', import.meta.url), 'utf8');

const dockerfileCopiesPath = (requiredPath) => {
  const relativePath = requiredPath.slice('./'.length);
  const pathWithExtension = `${relativePath}.js`;
  return dockerfile
    .split('\n')
    .some((line) => line.startsWith('COPY ') && line.includes(`${pathWithExtension} `));
};

describe('pool-worker construction task branch cleanup', () => {
  it('packages local pool-worker modules into the ECS image', () => {
    const localRequires = [...poolWorker.matchAll(/require\('(?<path>\.\/[\w-]+)'\)/g)].map(
      (match) => match.groups.path,
    );

    expect(localRequires).toEqual(
      expect.arrayContaining(['./branch-cleanup', './construction-orchestrator-prompt']),
    );
    expect(localRequires.filter((requiredPath) => !dockerfileCopiesPath(requiredPath))).toEqual([
      './drivers',
    ]);
    expect(dockerfile).toContain('COPY drivers/ /opt/acp-client/drivers/');
  });

  it('builds task branch names with the same task id normalization as launch_construction_agent', async () => {
    const { getTaskBranchName } = await loadBranchCleanup();

    expect(getTaskBranchName('ai-dlc/sprint-1', 'task-auth')).toBe('ai-dlc/sprint-1--task-auth');
    expect(getTaskBranchName('ai-dlc/sprint-1', 'auth')).toBe('ai-dlc/sprint-1--task-auth');
    expect(getTaskBranchName('', 'auth')).toBe('');
    expect(getTaskBranchName('ai-dlc/sprint-1', '')).toBe('');
  });

  it('deletes the remote task branch only after verifying it is merged', async () => {
    const { cleanupMergedTaskBranch } = await loadBranchCleanup();
    const commands = [];
    const exec = (command) => {
      commands.push(command);
      if (command.includes('git ls-remote'))
        return 'abc123\trefs/heads/ai-dlc/sprint-1--task-auth\n';
      return '';
    };

    const deleted = cleanupMergedTaskBranch(
      {
        branch: 'ai-dlc/sprint-1',
        event: { event: 'task_completed', taskId: 'task-auth', pushSucceeded: true },
      },
      exec,
    );

    expect(deleted).toBe(true);
    expect(commands).toEqual([
      "cd /workspace && git ls-remote --heads origin 'ai-dlc/sprint-1--task-auth'",
      "cd /workspace && git fetch origin 'ai-dlc/sprint-1--task-auth'",
      'cd /workspace && git merge-base --is-ancestor FETCH_HEAD HEAD',
      "cd /workspace && git push origin --delete 'ai-dlc/sprint-1--task-auth'",
    ]);
  });

  it('does not delete when the construction task push failed', async () => {
    const { cleanupMergedTaskBranch } = await loadBranchCleanup();
    const commands = [];

    const deleted = cleanupMergedTaskBranch(
      {
        branch: 'ai-dlc/sprint-1',
        event: { event: 'task_completed', taskId: 'task-auth', pushSucceeded: false },
      },
      (command) => commands.push(command),
    );

    expect(deleted).toBe(false);
    expect(commands).toEqual([]);
  });

  it('does not delete for non-completion events', async () => {
    const { cleanupMergedTaskBranch } = await loadBranchCleanup();
    const commands = [];

    const deleted = cleanupMergedTaskBranch(
      {
        branch: 'ai-dlc/sprint-1',
        event: { event: 'start', taskId: 'task-auth', pushSucceeded: true },
      },
      (command) => commands.push(command),
    );

    expect(deleted).toBe(false);
    expect(commands).toEqual([]);
  });

  it('skips cleanup when the remote task branch is already gone', async () => {
    const { cleanupMergedTaskBranch } = await loadBranchCleanup();
    const commands = [];
    const exec = (command) => {
      commands.push(command);
      return '';
    };

    const deleted = cleanupMergedTaskBranch(
      {
        branch: 'ai-dlc/sprint-1',
        event: { event: 'task_completed', taskId: 'task-auth', pushSucceeded: true },
      },
      exec,
    );

    expect(deleted).toBe(false);
    expect(commands).toEqual([
      "cd /workspace && git ls-remote --heads origin 'ai-dlc/sprint-1--task-auth'",
    ]);
  });

  it('does not delete when the task branch is not merged into HEAD', async () => {
    const { cleanupMergedTaskBranch } = await loadBranchCleanup();
    const commands = [];
    const exec = (command) => {
      commands.push(command);
      if (command.includes('git ls-remote'))
        return 'abc123\trefs/heads/ai-dlc/sprint-1--task-auth\n';
      if (command.includes('git merge-base')) throw new Error('not merged');
      return '';
    };

    const deleted = cleanupMergedTaskBranch(
      {
        branch: 'ai-dlc/sprint-1',
        event: { event: 'task_completed', taskId: 'auth', pushSucceeded: true },
      },
      exec,
    );

    expect(deleted).toBe(false);
    expect(commands).not.toContain(
      "cd /workspace && git push origin --delete 'ai-dlc/sprint-1--task-auth'",
    );
  });

  it('documents automatic cleanup in the construction orchestrator prompt', async () => {
    const { buildConstructionOrchestratorPrompt } = await loadConstructionOrchestratorPrompt();

    const prompt = buildConstructionOrchestratorPrompt({
      branch: 'ai-dlc/sprint-1',
      baseBranch: 'main',
      event: { event: 'task_completed', taskId: 'task-auth', pushSucceeded: true },
    });

    expect(prompt).toContain('git merge origin/ai-dlc/sprint-1--task-auth --no-edit');
    expect(prompt).toContain(
      'Delete merged remote task branches AFTER the sprint branch push succeeds',
    );
    expect(prompt).toContain('Do NOT delete the task branch yourself');
  });
});
