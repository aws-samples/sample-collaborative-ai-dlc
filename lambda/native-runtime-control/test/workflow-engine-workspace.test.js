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
