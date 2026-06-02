const { execSync } = require('child_process');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getTaskBranchName(sprintBranch, taskId) {
  if (!sprintBranch || !taskId) return '';
  const cleanId = String(taskId).replace(/^task-/, '');
  return `${sprintBranch}--task-${cleanId}`;
}

function cleanupMergedTaskBranch(job, exec = execSync) {
  const event = job.event || {};
  if (event.event !== 'task_completed' || event.pushSucceeded !== true) return false;

  const taskBranch = getTaskBranchName(job.branch, event.taskId);
  if (!taskBranch) return false;

  const quotedTaskBranch = shellQuote(taskBranch);
  try {
    const remoteBranch = exec(`cd /workspace && git ls-remote --heads origin ${quotedTaskBranch}`, {
      encoding: 'utf8',
    }).trim();
    if (!remoteBranch) {
      console.log(
        `[pool-worker] Task branch ${taskBranch} no longer exists on remote; skipping cleanup`,
      );
      return false;
    }

    exec(`cd /workspace && git fetch origin ${quotedTaskBranch}`, { stdio: 'inherit' });
    exec('cd /workspace && git merge-base --is-ancestor FETCH_HEAD HEAD', { stdio: 'inherit' });
    exec(`cd /workspace && git push origin --delete ${quotedTaskBranch}`, { stdio: 'inherit' });
    console.log(`[pool-worker] Deleted merged task branch ${taskBranch}`);
    return true;
  } catch (err) {
    console.error(
      `[pool-worker] Failed to delete task branch ${taskBranch}; continuing: ${err.message}`,
    );
    return false;
  }
}

module.exports = {
  cleanupMergedTaskBranch,
  getTaskBranchName,
};
