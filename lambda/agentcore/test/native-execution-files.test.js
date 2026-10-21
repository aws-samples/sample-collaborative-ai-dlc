import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalNativePath, snapshotNativeExecutionFiles } from '../native/execution-files.js';

let root;
let project;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-exact-files-')));
  project = join(root, 'project');
  await fs.mkdir(project, { mode: 0o700 });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const write = async (path, bytes) => {
  await fs.mkdir(dirname(join(project, path)), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(project, path), bytes);
};
const snapshot = (options = {}) => snapshotNativeExecutionFiles({ project, ...options });
const intent = 'aidlc/spaces/design/intents/real-request';

describe('exact native execution files', () => {
  it('retains binary, empty, CRLF and all native intent documents without redaction', async () => {
    const input = {
      'src/game.bin': Buffer.from([0, 0xff, 0x80, 13, 10]),
      'src/empty': Buffer.alloc(0),
      'src/game.js': Buffer.from('// exact\r\n'),
      [`${intent}/notes/unfamiliar-format.xyz`]: Buffer.from('not a standard artifact\n'),
      [`${intent}/ideation/intent-capture/intent-capture-questions.md`]: Buffer.from(
        '# Questions\r\n[Answer]:\r\n',
      ),
      [`${intent}/aidlc-state.md`]: Buffer.from('native state'),
      [`${intent}/.aidlc-engine/active-directive.json`]: Buffer.from('{"exact":true}'),
      '.gitignore': Buffer.from('src/game.bin\n'),
    };
    for (const [path, bytes] of Object.entries(input)) await write(path, bytes);
    const result = await snapshot();
    expect(result.complete).toBe(true);
    expect(result.files).toHaveLength(Object.keys(input).length);
    for (const file of result.files) {
      expect(file.content).toEqual(input[file.path]);
      expect(file.bytes).toBe(input[file.path].length);
      expect(file.sha256).toBe(createHash('sha256').update(input[file.path]).digest('hex'));
    }
    expect(result.files.find((f) => f.path.endsWith('unfamiliar-format.xyz')).role).toBe(
      'artifact',
    );
    expect(result.files.find((f) => f.path.endsWith('questions.md')).role).toBe('question');
    expect(result.files.find((f) => f.path.endsWith('active-directive.json')).role).toBe('state');
  });

  it('never reads excluded Git, active homes/config, steering keys and private locks', async () => {
    for (const path of [
      '.git/config',
      '.codex/config.toml',
      '.claude/settings.json',
      '.kiro/agent.json',
      '.opencode/session',
      '.agents/skills/aidlc/SKILL.md',
      'opencode.json',
      '.native-control/owner',
      '.native-homes/secret',
      'nested/.codex/auth.json',
      'aidlc/.aidlc-sessions/session',
      `${intent}/.aidlc-engine/steering-token-key`,
      `${intent}/.aidlc-engine/active-directive.lock.gate-mutex`,
    ])
      await write(path, 'private-known-secret');
    await write(`${intent}/requirements.md`, 'legitimate native document');
    const result = await snapshot({ forbiddenBytes: ['private-known-secret'] });
    expect(result.files.map((f) => f.path)).toEqual([`${intent}/requirements.md`]);
    expect(result.exclusions.length).toBe(13);
    expect(JSON.stringify(result.exclusions)).not.toContain('private-known-secret');
  });

  it.each(['link', 'hardlink'])('rejects %s instead of silently omitting it', async (kind) => {
    await fs.writeFile(join(root, 'outside'), 'private');
    if (kind === 'link') await fs.symlink(join(root, 'outside'), join(project, 'unsafe'));
    else await fs.link(join(root, 'outside'), join(project, 'unsafe'));
    await expect(snapshot()).rejects.toMatchObject({
      code: kind === 'link' ? 'native_snapshot_link' : 'native_snapshot_hardlink',
    });
  });

  it.each([
    ['node_modules/.bin/fixture-tool', 'dependency_bin'],
    ['nested/node_modules/fixture-tool', 'dependency'],
    ['aidlc/generated-link', 'workflow'],
    ['generated-link', 'other'],
  ])(
    'identifies a rejected public link category without reading its target: %s',
    async (path, pathClass) => {
      await write('target', 'safe fixture bytes');
      await fs.mkdir(dirname(join(project, path)), { recursive: true, mode: 0o700 });
      await fs.symlink(join(root, 'private-target-not-to-be-read'), join(project, path));
      const diagnostics = [];
      const io = {
        ...fs,
        readlink: () => {
          throw Error('must not read target');
        },
      };
      await expect(
        snapshot({
          io,
          onDiagnostic: (value) => {
            diagnostics.push(value);
            throw Error('advisory sink unavailable');
          },
        }),
      ).rejects.toMatchObject({
        code: 'native_snapshot_link',
        snapshotDiagnostic: {
          reason: 'symbolic_link',
          pathClass,
          pathDepth: path.split('/').length,
          pathSha256: createHash('sha256').update(path).digest('hex'),
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].entries).toBeGreaterThan(0);
      expect(JSON.stringify(diagnostics)).not.toContain('private-target');
      expect(JSON.stringify(diagnostics)).not.toContain(path);
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', async () => {
    execFileSync('/usr/bin/mkfifo', [join(project, 'pipe')]);
    await expect(snapshot()).rejects.toMatchObject({ code: 'native_snapshot_special_file' });
  });

  it('rejects symlink directories, including the root and root ancestors', async () => {
    await fs.mkdir(join(root, 'real'), { mode: 0o700 });
    await fs.symlink(join(root, 'real'), join(project, 'directory'));
    await expect(snapshot()).rejects.toMatchObject({ code: 'native_snapshot_link' });
    await fs.symlink(project, join(root, 'alias'));
    await expect(
      snapshotNativeExecutionFiles({ project: join(root, 'alias') }),
    ).rejects.toMatchObject({ code: 'native_snapshot_root_invalid' });
  });

  it.each(['../x', '/x', 'x//y', 'x/./y', 'x/../y', 'x\\y', 'x\nname', '', 'x/'])(
    'rejects noncanonical logical path %j',
    (path) => expect(canonicalNativePath(path)).toBe(false),
  );

  it('rejects invalid on-disk names', async () => {
    await write('bad\\name', 'data');
    await expect(snapshot()).rejects.toMatchObject({ code: 'native_snapshot_path_invalid' });
  });

  it.each([
    { maxFiles: 1 },
    { maxFileBytes: 2 },
    { maxTotalBytes: 5 },
    { maxEntries: 2 },
    { maxDepth: 1 },
  ])('fails the entire publication when limits are exceeded: %j', async (limits) => {
    await write('nested/a', 'abc');
    await write('nested/b', 'def');
    await expect(snapshot({ limits })).rejects.toMatchObject({ code: 'native_snapshot_limit' });
  });

  it('rejects known credential bytes, including binary content, without disclosing them', async () => {
    const secret = Buffer.from([0xff, 0, 0x80, 0x81]);
    await write(
      'src/payload',
      Buffer.concat([Buffer.from('prefix'), secret, Buffer.from('suffix')]),
    );
    await expect(snapshot({ forbiddenBytes: [secret] })).rejects.toMatchObject({
      message: 'native_snapshot_credential_content',
      code: 'native_snapshot_credential_content',
    });
  });

  it('detects replacement between lstat and open', async () => {
    await write('a', 'same-size');
    let replaced = false;
    const io = {
      ...fs,
      open: async (...args) => {
        if (!replaced && args[0] === join(project, 'a')) {
          replaced = true;
          await fs.rename(join(project, 'a'), join(root, 'old'));
          await write('a', 'new-bytes');
        }
        return fs.open(...args);
      },
    };
    await expect(snapshot({ io })).rejects.toMatchObject({ code: 'native_snapshot_changed' });
  });

  it('detects a previously read file changing during a later read', async () => {
    await write('a', 'old');
    await write('b', 'later');
    const io = {
      ...fs,
      open: async (...args) => {
        if (args[0] === join(project, 'b')) await write('a', 'new-size');
        return fs.open(...args);
      },
    };
    await expect(snapshot({ io })).rejects.toMatchObject({ code: 'native_snapshot_changed' });
  });

  it('detects additions after the directory was enumerated', async () => {
    await write('a', 'old');
    const io = {
      ...fs,
      open: async (...args) => {
        await write('late', 'addition');
        return fs.open(...args);
      },
    };
    await expect(snapshot({ io })).rejects.toMatchObject({ code: 'native_snapshot_changed' });
  });

  it('honors cancellation and rejects a shared root', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(snapshot({ signal: controller.signal })).rejects.toMatchObject({
      code: 'native_snapshot_cancelled',
    });
    await fs.chmod(project, 0o755);
    await expect(snapshot()).rejects.toMatchObject({ code: 'native_snapshot_root_invalid' });
  });
});
