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
    expect(prompt).toContain('Do NOT call `trigger_pr_creation` while any task branch is unmerged');
    expect(prompt).toContain('Do NOT delete the task branch yourself');
  });
});

describe('discussion-assist phase (plan §8)', () => {
  it('builds the discussion prompt with the post_discussion_message contract', () => {
    expect(poolWorker).toContain("if (phase === 'discussion') return buildDiscussionPrompt(job);");
    const promptSrc = poolWorker.slice(
      poolWorker.indexOf('function buildDiscussionPrompt('),
      poolWorker.indexOf('function buildInceptionPrompt('),
    );
    expect(promptSrc).toContain('post_discussion_message');
    expect(promptSrc).toContain('EXACTLY ONCE');
    // suggest-answer is ADVICE ONLY (D5) — never modifies the question.
    expect(promptSrc).toContain('ADVICE ONLY');
    for (const cmd of ["'suggest-answer'", 'summarize:', 'explain:', 'custom:']) {
      expect(promptSrc).toContain(cmd);
    }
  });

  it('is excluded from branch checkout and push phases (no-workspace mode)', () => {
    const needsBranchSrc = poolWorker.slice(
      poolWorker.indexOf('const needsBranch = ['),
      poolWorker.indexOf('].includes(job.agentType)'),
    );
    expect(needsBranchSrc).not.toContain('discussion');
    const pushGate = poolWorker.slice(
      poolWorker.indexOf("phase === 'construction' ||"),
      poolWorker.indexOf('job.branch') + 20,
    );
    expect(pushGate).not.toContain('discussion');
  });

  it('heartbeats and releases the assist lock around the session, conditioned on the executionId', () => {
    expect(poolWorker).toContain('function startAssistLockHeartbeat(');
    const heartbeatSrc = poolWorker.slice(
      poolWorker.indexOf('function startAssistLockHeartbeat('),
      poolWorker.indexOf('function runAcpSession('),
    );
    expect(heartbeatSrc).toContain("ConditionExpression: 'executionId = :eid'");
    expect(heartbeatSrc).toContain('clearInterval(timer)');
    // Wired around the session with a guaranteed release.
    expect(poolWorker).toContain('const assistLock = startAssistLockHeartbeat(job);');
    expect(poolWorker).toMatch(/finally \{\s*if \(assistLock\) await assistLock\.stop\(\);/);
  });

  it('passes the discussion job fields to acp-client', () => {
    for (const name of [
      'DISCUSSION_ID: job.discussionId',
      'DISCUSSION_COMMAND: job.command',
      'DISCUSSION_REQUESTED_BY: job.requestedBy',
      'DISCUSSION_REQUESTED_BY_NAME: job.requestedByName',
    ]) {
      expect(poolWorker).toContain(name);
    }
  });
});

describe('discussions nudge in phase prompts (plan §5)', () => {
  it('appends the get_discussions nudge to every non-discussion prompt', () => {
    expect(poolWorker).toContain('const DISCUSSIONS_NUDGE');
    expect(poolWorker).toContain('return prompt + DISCUSSIONS_NUDGE;');
    // The discussion phase itself returns early — no recursive nudge.
    expect(poolWorker).toContain("if (phase === 'discussion') return buildDiscussionPrompt(job);");
  });
});
