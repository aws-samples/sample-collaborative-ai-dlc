import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { nativeGuardToolInput } from '../../shared/native-workflow-guard.js';
import { engineFailure } from '../../shared/native-workflow-protocol.js';

export const invokeInstalledGuard = (target, args, input) => {
  const child = spawnSync(target, args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (child.error || child.status === null) throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
};

// Run the installed hook on its actual stdin first. Only its missing private
// Plan Approval receipt can require another decision from the protected owner.
export async function nativeWorkflowHook({ args, input, project, local, check }) {
  const original = local(args, input);
  if (
    original.exitCode !== 2 ||
    !original.stderr.includes(
      'no current Plan Approval receipt matches this question, target, stage attempt, and plan content',
    )
  )
    return original;
  const [engine, hook, name, ...rest] = args;
  if (
    engine !== 'engine' ||
    hook !== 'hook' ||
    !['guard-tool-call', 'plan-approval-guard'].includes(name) ||
    !(
      rest.length === 0 ||
      (rest.length === 2 && rest[0] === '--project-dir' && rest[1] === project)
    )
  )
    return original;
  const event = JSON.parse(input);
  if (event.hook_event_name !== 'PreToolUse' || event.cwd !== project) return original;
  const tool = event.tool_input;
  let guard;
  if (event.tool_name === 'Write' && typeof tool?.file_path === 'string') {
    if (isAbsolute(tool.file_path) && !tool.file_path.startsWith(project + '/')) return original;
    guard = {
      tool: 'Write',
      path: isAbsolute(tool.file_path) ? tool.file_path.slice(project.length + 1) : tool.file_path,
      ...(Object.hasOwn(tool, 'content') ? { content: tool.content } : {}),
    };
  } else if (event.tool_name === 'Bash') guard = { tool: 'Bash', command: tool?.command };
  else return original;
  nativeGuardToolInput(guard, project, name === 'plan-approval-guard' ? 'opencode' : 'claude');
  if (name === 'guard-tool-call') {
    // Keep every other member of Claude 2.11.1's registered guard group in
    // the original harness/session scope. A different refusal still blocks.
    for (const member of ['state-transition-guard', 'reviewer-scope', 'review-freeze']) {
      const result = local([engine, hook, member, ...rest], input);
      if (result.exitCode !== 0 || result.stdout.trim()) return original;
    }
  }
  const result = await check(guard);
  if (result.exitCode !== 0) return original;
  return { exitCode: 0, stdout: '', stderr: '' };
}
