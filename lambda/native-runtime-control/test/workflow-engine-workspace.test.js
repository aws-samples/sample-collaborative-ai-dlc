import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { encodeNativeEngineFiles } from '../../shared/native-workflow-protocol.js';
import { openNativeEngineWorkspace } from '../workflow-engine/workspace.js';
import { prepareNativeEngine } from '../workflow-engine/package.js';

vi.mock('../workflow-engine/package.js', () => ({ prepareNativeEngine: vi.fn() }));

it('records real writes of declared stage documents in the protected workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-engine-audit-'));
  prepareNativeEngine.mockImplementation(async ({ directory }) => {
    const installation = join(directory, '.codex');
    await mkdir(installation, { recursive: true });
    return { installation };
  });
  const path = 'aidlc/spaces/default/intents/sample/ideation/intent.md';
  const file = (path, bytes, mode = '100644') => ({ path, content: Buffer.from(bytes), mode });
  const recorded = [];
  const runner = {
    async hook(name, input) {
      if (name === 'aidlc-write-audit-log.ts') {
        expect(input).toMatchObject({
          hook_event_name: 'PostToolUse',
          session_id: 'engine-session',
          tool_name: 'Write',
          tool_input: { file_path: join(root, 'project', path) },
        });
        recorded.push(await readFile(input.tool_input.file_path, 'utf8'));
      }
      return { exitCode: 0 };
    },
  };
  try {
    const workspace = await openNativeEngineWorkspace({ root });
    workspace.state.directive = { produces: [path] };
    const sync = (...files) =>
      workspace.importAuthored(encodeNativeEngineFiles(files), runner, 'engine-session');
    await sync(file(path, 'draft'), file('src/app', 'code'));
    await sync(file(path, 'draft'), file('src/app', 'edit'));
    await sync(file(path, 'draft', '100755'));
    await sync(file(path, 'regenerated after confirmation'));
    await sync();
    expect(recorded).toEqual(['draft', 'regenerated after confirmation']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('checks the proposed bytes and pinned guards against the approved attempt and visible plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-engine-approval-'));
  prepareNativeEngine.mockImplementation(async ({ directory }) => {
    const installation = join(directory, '.claude');
    await mkdir(installation, { recursive: true });
    return { installation };
  });
  const workspace = await openNativeEngineWorkspace({ root });
  const path =
    'aidlc/spaces/default/intents/sample/construction/code-generation/code-generation-plan.md';
  const files = (text) => encodeNativeEngineFiles([{ path, content: Buffer.from(text) }]);
  const runner = { hook: vi.fn(async () => ({ exitCode: 0 })) };
  const check = (text) =>
    workspace.checkProposedEdit(
      { files: files(text), guard: { tool: 'Write', path: 'src/app', content: 'exact edit' } },
      runner,
      'attempt-session',
    );
  try {
    workspace.state.directive = {
      kind: 'run-stage',
      stage: 'code-generation',
      unit: 'A',
      produces: [path],
    };
    await workspace.importAuthored(files('approved plan'), runner, 'attempt-session');
    await expect(check('approved plan')).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    workspace.state.directive.plan_approval = { status: 'approved' };
    runner.hook.mockClear();
    await expect(check('changed plan')).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    expect(runner.hook).not.toHaveBeenCalled();
    await check('approved plan');
    const proposed = {
      hook_event_name: 'PreToolUse',
      cwd: workspace.project,
      session_id: 'attempt-session',
      tool_name: 'Write',
      tool_input: { file_path: join(workspace.project, 'src/app'), content: 'exact edit' },
    };
    expect(runner.hook.mock.calls).toEqual([
      ['aidlc-plan-approval-guard.ts', proposed],
      ['aidlc-review-freeze.ts', proposed],
    ]);
    const form = { tool: 'Write', path: '.native-control/pending-question.json', content: '{}' };
    const display = () =>
      workspace.checkProposedEdit(
        { files: files('approved plan'), guard: form },
        runner,
        'attempt-session',
      );
    await expect(display()).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    Object.assign(workspace.state.directive, { gate_only: true, gate: true });
    await expect(check('approved plan')).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    await expect(display()).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    workspace.state.awaitingApproval = 'code-generation';
    await display();
    expect(runner.hook).toHaveBeenLastCalledWith('aidlc-review-freeze.ts', {
      ...proposed,
      tool_input: { file_path: join(workspace.project, form.path), content: form.content },
    });
    delete workspace.state.directive.gate_only;
    runner.hook.mockImplementation(async (name) => ({
      exitCode: name === 'aidlc-review-freeze.ts' ? 2 : 0,
    }));
    await expect(check('approved plan')).rejects.toThrow('NATIVE_ENGINE_EDIT_DENIED');
    await expect(readFile(join(workspace.project, 'src/app'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
  } finally {
    await workspace.close();
  }
});
