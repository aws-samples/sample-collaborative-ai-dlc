import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureNativeSessionRecovery,
  nativeRecoveryProjectExclusion,
  restoreNativeSessionRecovery,
  NATIVE_RECOVERY_HARNESS_VERSIONS,
} from '../native/session-recovery-files.js';

const id = '019a0011-2222-7333-8444-555555555555';
const childId = '019a0011-2222-7333-8444-666666666666';
const hash = (value) => createHash('sha256').update(value).digest('hex');
let root;
let project;
let home;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-recovery-files-')));
  project = join(root, 'project');
  home = join(root, 'home');
  await fs.mkdir(project, { mode: 0o700 });
  await fs.mkdir(home, { mode: 0o700 });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const write = async (scope, path, content, mode = 0o600) => {
  const target = join(scope === 'home' ? home : project, path);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode });
  return target;
};
const options = (extra = {}) => ({
  project,
  home,
  harness: 'codex',
  nativeSessionId: id,
  ...extra,
});
const rollout = async (sessionId = id, extra = {}) =>
  await write(
    'home',
    `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${sessionId}.jsonl`,
    `${JSON.stringify({
      ...(extra.history_mode === 'paginated'
        ? { ordinal: extra.history_base?.end_ordinal_exclusive ?? 0 }
        : {}),
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: project,
        ...(extra.history_mode === 'paginated' ? { session_id: sessionId } : {}),
        ...extra,
      },
    })}\n${JSON.stringify({
      ...(extra.history_mode === 'paginated'
        ? { ordinal: (extra.history_base?.end_ordinal_exclusive ?? 0) + 1 }
        : {}),
      type: 'response_item',
      payload: { text: 'retained context' },
    })}\n`,
  );
const emptyRestoreRoots = async () => {
  await fs.rename(project, join(root, 'original-project'));
  await fs.rename(home, join(root, 'original-home'));
  await fs.mkdir(project, { mode: 0o700 });
  await fs.mkdir(home, { mode: 0o700 });
};
const withContent = (file, content) => ({
  ...file,
  content,
  bytes: content.length,
  sha256: hash(content),
});

const binPath = '.opencode/node_modules/.bin/tool';
const binTarget = '.opencode/node_modules/pkg/bin/tool.js';
const writeBinLink = async (target, path = join(project, binPath)) => {
  await fs.symlink(target, path);
  // Linux's symlink mode is fixed at 0777; macOS applies the host umask.
  if (process.platform === 'darwin') await fs.lchmod(path, 0o777);
};
const openCodeOptions = () =>
  options({
    harness: 'opencode',
    run: async ({ operation }) =>
      operation === 'opencode-import'
        ? Buffer.from('Imported')
        : Buffer.from(
            JSON.stringify({
              info: { id, directory: project },
              messages: [
                {
                  info: { id: 'message', sessionID: id },
                  parts: [
                    {
                      type: 'text',
                      text: 'Fixture question?',
                      sessionID: id,
                      messageID: 'message',
                    },
                  ],
                },
              ],
            }),
          ),
  });
const generatedBin = async () => {
  await write('project', binTarget, '#!/usr/bin/env node\n', 0o755);
  await fs.mkdir(join(project, '.opencode/node_modules/.bin'), { mode: 0o755 });
  await writeBinLink('../pkg/bin/tool.js');
  return captureNativeSessionRecovery(openCodeOptions());
};

describe('private native recovery files', () => {
  it('round-trips generated OpenCode bin links with independent exact target bytes and metadata', async () => {
    const checkpoint = await generatedBin();
    expect(checkpoint.metadata.schemaVersion).toBe(2);
    expect(checkpoint.metadata.binLinks).toEqual([
      {
        scope: 'project',
        path: binPath,
        target: '../pkg/bin/tool.js',
        mode: 0o777,
        mtimeNs: String((await fs.lstat(join(project, binPath), { bigint: true })).mtimeNs),
      },
    ]);
    expect(checkpoint.files.some((file) => file.path === binPath)).toBe(false);
    const target = checkpoint.files.find((file) => file.path === binTarget);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...openCodeOptions(), ...checkpoint });
    expect(await fs.readlink(join(project, binPath))).toBe('../pkg/bin/tool.js');
    expect(await fs.readFile(join(project, binTarget))).toEqual(target.content);
    const stat = await fs.lstat(join(project, binPath), { bigint: true });
    expect(stat.isSymbolicLink()).toBe(true);
    expect(String(stat.mtimeNs)).toBe(checkpoint.metadata.binLinks[0].mtimeNs);
    expect(Number(stat.mode & 0o777n)).toBe(0o777);
  });

  it.each([
    ['absolute', '/tmp/external'],
    ['escape', '../../../outside'],
    ['escape-and-return', '../../../.opencode/node_modules/pkg/bin/tool.js'],
    ['dangling', '../missing.js'],
    ['directory', '../pkg'],
    ['missing-intermediate-directory', '../pkg/missing/../bin/tool.js'],
    ['file-intermediate-directory', '../pkg/bin/tool.js/../tool.js'],
    ['chain', './other'],
    ['credential', '../pkg/.npmrc'],
  ])('rejects generated bin target %s at capture', async (_name, target) => {
    await generatedBin();
    await fs.unlink(join(project, binPath));
    await writeBinLink(target);
    if (_name === 'chain')
      await writeBinLink('../pkg/bin/tool.js', join(project, '.opencode/node_modules/.bin/other'));
    if (_name === 'credential')
      await write('project', '.opencode/node_modules/pkg/.npmrc', 'private');
    await expect(captureNativeSessionRecovery(openCodeOptions())).rejects.toMatchObject({
      code: expect.stringMatching(/^native_recovery_(symlink|bin_link_invalid)$/),
    });
  });

  it.each(['parent-link', 'link-mutation', 'target-mutation', 'external-device'])(
    'rejects generated bin concurrent/source condition %s',
    async (kind) => {
      await generatedBin();
      let changed = false;
      const io = { ...fs };
      if (kind === 'parent-link') {
        await fs.rename(join(project, '.opencode/node_modules/pkg'), join(root, 'outside-package'));
        await fs.symlink(
          join(root, 'outside-package'),
          join(project, '.opencode/node_modules/pkg'),
        );
      } else if (kind === 'link-mutation') {
        io.readlink = async (path, opts) => {
          const result = await fs.readlink(path, opts);
          if (path === join(project, binPath) && !changed) {
            changed = true;
            await fs.unlink(path);
            await fs.symlink('../missing.js', path);
          }
          return result;
        };
      } else if (kind === 'target-mutation') {
        io.open = async (path, ...args) => {
          if (path === join(project, binTarget) && !changed) {
            changed = true;
            await fs.writeFile(path, 'changed target');
          }
          return fs.open(path, ...args);
        };
      } else {
        io.lstat = async (path, opts) => {
          const stat = await fs.lstat(path, opts);
          if (path === join(project, binTarget)) stat.dev += 1n;
          return stat;
        };
      }
      await expect(
        captureNativeSessionRecovery({ ...openCodeOptions(), io }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^native_recovery_(symlink|changed|mount)$/),
      });
    },
  );

  // macOS link(2) follows the source symlink; Linux links the alias inode itself.
  it.runIf(process.platform === 'linux')(
    'rejects hard-linked bin aliases whose inode relationship is not represented',
    async () => {
      await generatedBin();
      await fs.link(join(project, binPath), join(project, '.opencode/node_modules/.bin/other'));
      expect(
        (await fs.lstat(join(project, '.opencode/node_modules/.bin/other'))).isSymbolicLink(),
      ).toBe(true);
      await expect(captureNativeSessionRecovery(openCodeOptions())).rejects.toMatchObject({
        code: 'native_recovery_symlink',
      });
    },
  );

  it.runIf(process.platform === 'linux')(
    'rejects a same-device bind mount in the bin target ancestry',
    async () => {
      await generatedBin();
      const io = {
        ...fs,
        readFile: async (path, ...args) =>
          path === '/proc/self/mountinfo'
            ? Buffer.from(`1 0 0:1 / ${project}/.opencode/node_modules/pkg rw - tmpfs tmpfs rw\n`)
            : fs.readFile(path, ...args),
      };
      await expect(
        captureNativeSessionRecovery({ ...openCodeOptions(), io }),
      ).rejects.toMatchObject({ code: 'native_recovery_mount' });
    },
  );

  it.each([
    'missing-target',
    'changed-bytes',
    'alias-parent',
    'missing-parent',
    'old-version',
    'extra-field',
    'wrong-scope',
    'entry-limit',
    'byte-limit',
  ])('rejects a bin recovery plan before writing: %s', async (kind) => {
    const checkpoint = await generatedBin();
    const extra = {};
    if (kind === 'missing-target')
      checkpoint.files = checkpoint.files.filter((file) => file.path !== binTarget);
    if (kind === 'changed-bytes')
      checkpoint.files.find((file) => file.path === binTarget).content[0] ^= 1;
    if (kind === 'alias-parent')
      checkpoint.metadata.directories.push({
        scope: 'project',
        path: `${binPath}/nested`,
        mode: 0o700,
        mtimeNs: '0',
      });
    if (kind === 'missing-parent')
      checkpoint.metadata.directories = checkpoint.metadata.directories.filter(
        (entry) => entry.path !== '.opencode/node_modules/pkg',
      );
    if (kind === 'old-version') checkpoint.metadata.schemaVersion = 1;
    if (kind === 'extra-field') checkpoint.metadata.binLinks[0].follow = true;
    if (kind === 'wrong-scope') checkpoint.metadata.binLinks[0].scope = 'home';
    if (kind === 'entry-limit')
      extra.limits = {
        maxEntries: checkpoint.files.length + checkpoint.metadata.directories.length,
      };
    if (kind === 'byte-limit') extra.limits = { maxTotalBytes: checkpoint.totalBytes };
    await emptyRestoreRoots();
    await expect(
      restoreNativeSessionRecovery({ ...openCodeOptions(), ...checkpoint, ...extra }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^native_recovery_(manifest_invalid|bin_link_invalid)$/),
    });
    expect(await fs.readdir(project)).toEqual([]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it.each(['parent-replaced', 'target-changed', 'link-changed'])(
    'rejects bin restore mutation %s without following aliases for writes',
    async (kind) => {
      const checkpoint = await generatedBin();
      await emptyRestoreRoots();
      const outside = join(root, 'external-restore');
      await fs.mkdir(outside);
      let changed = false;
      const io = {
        ...fs,
        mkdir: async (path, ...args) => {
          const result = await fs.mkdir(path, ...args);
          if (
            kind === 'parent-replaced' &&
            path === join(project, '.opencode/node_modules/pkg') &&
            !changed
          ) {
            changed = true;
            await fs.rmdir(path);
            await fs.symlink(outside, path);
          }
          return result;
        },
        symlink: async (target, path) => {
          await fs.symlink(target, path);
          if (kind === 'target-changed') await fs.writeFile(join(project, binTarget), 'corrupt');
          if (kind === 'link-changed') {
            await fs.unlink(path);
            await fs.symlink('../missing', path);
          }
        },
      };
      await expect(
        restoreNativeSessionRecovery({ ...openCodeOptions(), ...checkpoint, io }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^native_recovery_(changed|time_failed|restore_unverified)$/),
      });
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it('stamps the installed image CLI pin and refuses a different-version restore before writing', async () => {
    const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    for (const [harness, arg] of Object.entries({
      claude: 'CLAUDE_CODE_VERSION',
      codex: 'CODEX_VERSION',
      opencode: 'OPENCODE_VERSION',
      kiro: 'KIRO_CLI_VERSION',
    })) {
      const version = dockerfile.match(new RegExp(`^ARG ${arg}=([^\\s]+)$`, 'm'))?.[1];
      expect(NATIVE_RECOVERY_HARNESS_VERSIONS[harness]).toBe(version);
    }
    await rollout();
    const checkpoint = await captureNativeSessionRecovery(options());
    expect(checkpoint.metadata.harnessVersion).toBe(NATIVE_RECOVERY_HARNESS_VERSIONS.codex);
    await emptyRestoreRoots();
    checkpoint.metadata.harnessVersion = '0.145.0';
    await expect(
      restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
    ).rejects.toMatchObject({
      code: 'native_recovery_manifest_invalid',
    });
    expect(await fs.readdir(project)).toEqual([]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it('round-trips Git, generated harness and engine state, binary bytes, modes, mtimes and empty directories', async () => {
    await rollout();
    const values = {
      '.git/HEAD': Buffer.from('ref: refs/heads/pilot\n'),
      '.git/config': Buffer.from('[remote "origin"]\nurl = https://github.com/example/repo\n'),
      '.git/objects/ab/123': Buffer.from([0, 255, 128, 13, 10]),
      '.codex/config.toml': Buffer.from('[features]\nhooks=true\n'),
      '.agents/skills/aidlc/SKILL.md': Buffer.from('generated workflow\n'),
      'aidlc/.aidlc-sessions/native.json': Buffer.from('{"session":"engine-session"}'),
      'aidlc/spaces/default/.aidlc-engine/steering-token-key': Buffer.from('native-gate-key'),
      'src/game.bin': Buffer.from([0, 255, 128]),
      'notes/bom.md': Buffer.from('\uFEFFexact\r\n'),
      'src/run.sh': Buffer.from('#!/bin/sh\nexit 0\n'),
      'empty-file': Buffer.alloc(0),
    };
    for (const [path, bytes] of Object.entries(values))
      await write('project', path, bytes, path.endsWith('.sh') ? 0o755 : 0o640);
    await fs.mkdir(join(project, '.git/refs/heads'), { recursive: true, mode: 0o700 });
    const checkpoint = await captureNativeSessionRecovery(options());
    expect(checkpoint.files.filter((f) => f.scope === 'project')).toHaveLength(
      Object.keys(values).length,
    );
    await emptyRestoreRoots();
    const result = await restoreNativeSessionRecovery({ ...options(), ...checkpoint });
    expect(result.restored).toBe(true);
    for (const file of checkpoint.files) {
      const path = join(file.scope === 'home' ? home : project, file.path);
      expect(await fs.readFile(path)).toEqual(file.content);
      const stat = await fs.stat(path, { bigint: true });
      expect(Number(stat.mode & 0o777n)).toBe(file.mode);
      expect(String(stat.mtimeNs)).toBe(file.mtimeNs);
    }
    expect(await fs.readdir(join(project, '.git/refs/heads'))).toEqual([]);
    expect(await fs.readFile(join(home, '.codex/config.toml'), 'utf8')).toContain(
      'trust_level = "trusted"',
    );
  });

  it('preserves internal hard links even when manifest files are reordered', async () => {
    await rollout();
    const first = await write('project', 'src/one', 'same inode');
    await fs.link(first, join(project, 'src/two'));
    const checkpoint = await captureNativeSessionRecovery(options());
    expect(checkpoint.metadata.hardlinks).toEqual([
      { scope: 'project', paths: ['src/one', 'src/two'] },
    ]);
    checkpoint.files.reverse();
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options(), ...checkpoint });
    expect((await fs.stat(join(project, 'src/one'), { bigint: true })).ino).toBe(
      (await fs.stat(join(project, 'src/two'), { bigint: true })).ino,
    );
  });

  it('materializes an external generated-workflow hard link without recreating its outside alias', async () => {
    await rollout();
    const original = join(root, 'machine-projection');
    await fs.writeFile(original, 'pinned workflow', { mode: 0o600 });
    await fs.mkdir(join(project, '.agents/skills'), { recursive: true, mode: 0o700 });
    await fs.link(original, join(project, '.agents/skills/workflow.md'));
    const checkpoint = await captureNativeSessionRecovery(options());
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options(), ...checkpoint });
    const restored = join(project, '.agents/skills/workflow.md');
    expect(await fs.readFile(restored, 'utf8')).toBe('pinned workflow');
    expect((await fs.stat(restored, { bigint: true })).ino).not.toBe(
      (await fs.stat(original, { bigint: true })).ino,
    );
  });

  it('rejects an external hard link outside the generated workflow paths', async () => {
    await rollout();
    const outside = join(root, 'outside');
    await fs.writeFile(outside, 'unrelated');
    await fs.link(outside, join(project, 'outside-link'));
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_external_hardlink',
    });
  });

  it.each(['.git', '.git/commondir', '.git/objects/info/alternates'])(
    'refuses incomplete Git recovery through an external pointer in %s',
    async (path) => {
      await rollout();
      await write('project', path, 'gitdir: /outside/repository');
      await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
        code: 'native_recovery_project_gitdir_unsupported',
      });
    },
  );

  it('excludes control and credential files without reading them or capturing HOME wholesale', async () => {
    await rollout();
    for (const path of [
      '.native-control/owner.json',
      '.native-homes/token',
      '.aws/credentials',
      '.ssh/id_ed25519',
      '.git-credentials',
      '.env.local',
      '.codex/auth.json',
    ])
      await write('project', path, 'forbidden-credential');
    for (const path of [
      '.codex/auth.json',
      '.claude/.credentials.json',
      '.data/kiro-cli/data.sqlite3',
    ])
      await write('home', path, 'forbidden-credential');
    await write('project', '.environment.md', 'keep this document');
    await write('project', '.env.example', 'TOKEN=your-token');
    const checkpoint = await captureNativeSessionRecovery(
      options({ forbiddenBytes: ['forbidden-credential'] }),
    );
    expect(checkpoint.exclusions).toHaveLength(7);
    expect(checkpoint.files.some((f) => f.path === '.environment.md')).toBe(true);
    expect(checkpoint.files.some((f) => f.path === '.env.example')).toBe(true);
    expect(checkpoint.files.filter((f) => f.scope === 'home')).toHaveLength(1);
  });

  it.each([
    '[credential]\nhelper = store\n',
    '[http]\nextraHeader = Authorization: private\n',
    '[remote "origin"]\nurl = https://private@example.com/repo\n',
  ])('refuses Git credentials in an otherwise required config', async (config) => {
    await rollout();
    await write('project', '.git/config', config);
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_credential_config',
    });
  });

  it('rejects credential bytes in required state without putting them in the error', async () => {
    await rollout();
    await write('project', 'notes.md', 'prefix SECRET_CANARY suffix');
    try {
      await captureNativeSessionRecovery(options({ forbiddenBytes: ['SECRET_CANARY'] }));
      expect.unreachable();
    } catch (error) {
      expect(error.code).toBe('native_recovery_credential_content');
      expect(String(error)).not.toContain('SECRET_CANARY');
    }
  });

  it('rejects symlink files, roots and intermediate HOME ancestors', async () => {
    await rollout();
    await fs.symlink(join(root, 'outside'), join(project, 'link'));
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_symlink',
    });
    await fs.unlink(join(project, 'link'));
    await fs.rename(join(home, '.codex'), join(root, 'codex-outside'));
    await fs.symlink(join(root, 'codex-outside'), join(home, '.codex'));
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_symlink',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects FIFOs without hanging', async () => {
    await rollout();
    execFileSync('/usr/bin/mkfifo', [join(project, 'pipe')]);
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_special_file',
    });
  });

  it('rejects unsafe root permissions and overlapping roots', async () => {
    await rollout();
    await fs.chmod(project, 0o755);
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_root_invalid',
    });
    await expect(
      captureNativeSessionRecovery(options({ home: join(project, 'home') })),
    ).rejects.toMatchObject({
      code: 'native_recovery_arguments_invalid',
    });
    await expect(
      captureNativeSessionRecovery(options({ nativeSessionId: 123 })),
    ).rejects.toMatchObject({
      code: 'native_recovery_arguments_invalid',
    });
  });

  it('rejects bounded-size overflow instead of publishing a partial checkpoint', async () => {
    await rollout();
    await write('project', 'large', Buffer.alloc(100));
    await expect(
      captureNativeSessionRecovery(options({ limits: { maxFileBytes: 99 } })),
    ).rejects.toMatchObject({
      code: 'native_recovery_limit',
    });
  });

  it('detects a file changed between stat and open', async () => {
    await rollout();
    const path = await write('project', 'changing', 'before');
    const io = {
      ...fs,
      open: async (target, ...args) => {
        if (target === path) await fs.writeFile(target, 'after - larger');
        return fs.open(target, ...args);
      },
    };
    await expect(captureNativeSessionRecovery(options({ io }))).rejects.toMatchObject({
      code: 'native_recovery_changed',
    });
  });

  it('supports signed inode values without rounding their identity', async () => {
    await rollout();
    const wrap = (stat) => {
      stat.ino = -9_007_199_254_740_993n;
      return stat;
    };
    // An actual distinct inode is kept distinct; only the private root's
    // representation is changed here, as observed with Node on EFS.
    const io = {
      ...fs,
      lstat: async (path, flags) => {
        const stat = await fs.lstat(path, flags);
        return flags?.bigint && path === project ? wrap(stat) : stat;
      },
    };
    expect((await captureNativeSessionRecovery(options({ io }))).files).toHaveLength(1);
  });
});

describe('harness session selection', () => {
  it('captures linked Codex children but rejects unrelated sessions and incomplete JSONL', async () => {
    await rollout();
    await rollout(childId, { forked_from_id: id });
    const capture = await captureNativeSessionRecovery(options());
    expect(capture.files.filter((f) => f.scope === 'home')).toHaveLength(2);
    await rollout(childId);
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_session_unrelated',
    });
    await fs.rm(join(home, '.codex/sessions'), { recursive: true });
    const path = await rollout();
    await fs.appendFile(path, '{"partial":');
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_session_incomplete',
    });
  });

  it('rejects a selected session bound to a different working directory', async () => {
    await rollout(id, { cwd: '/different/project' });
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_session_identity',
    });
  });

  it.each([
    { parent_thread_id: id },
    { source: { subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } } },
  ])('uses the pinned Codex parent identity representation %j', async (metadata) => {
    await rollout();
    await rollout(childId, metadata);
    expect((await captureNativeSessionRecovery(options())).files).toHaveLength(2);
  });

  it('round-trips the pinned local-store legacy history mode without inherited history', async () => {
    const path = await rollout(id, { history_mode: 'legacy', history_base: null });
    const original = await fs.readFile(path);
    const checkpoint = await captureNativeSessionRecovery(options());
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options(), ...checkpoint });
    expect(await fs.readFile(path)).toEqual(original);
  });

  it.each([
    { history_mode: 'future' },
    { history_prefix: { path: 'other-rollout' } },
    {
      history_mode: 'legacy',
      history_base: {
        thread_id: childId,
        end_ordinal_exclusive: 4,
        end_byte_offset: 500,
      },
    },
  ])('refuses an unqualified Codex history dependency %j', async (metadata) => {
    await rollout(id, metadata);
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: 'native_recovery_session_layout_unsupported',
    });
  });

  it('cold-restores paginated rollout ancestry with exact ordinal/byte prefixes and no SQLite state', async () => {
    const parent = await rollout(id, { history_mode: 'paginated', session_id: id });
    const child = await rollout(childId, {
      history_mode: 'paginated',
      session_id: childId,
      forked_from_id: id,
      history_base: {
        thread_id: id,
        end_ordinal_exclusive: 2,
        end_byte_offset: (await fs.stat(parent)).size,
      },
    });
    await rollout('grandchild', {
      history_mode: 'paginated',
      session_id: 'grandchild',
      forked_from_id: childId,
      history_base: {
        thread_id: childId,
        end_ordinal_exclusive: 4,
        end_byte_offset: (await fs.stat(child)).size,
      },
    });
    const checkpoint = await captureNativeSessionRecovery(options());
    expect(checkpoint.files).toHaveLength(3);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options(), ...checkpoint });
    for (const file of checkpoint.files)
      expect(await fs.readFile(join(home, file.path))).toEqual(file.content);
  });

  it.each([
    'missing-parent',
    'wrong-byte',
    'missing-ordinal',
    'wrong-session',
    'sibling-prefix',
    'partial-inheritance',
  ])('rejects incomplete or mismatched paginated recovery: %s', async (kind) => {
    const parent = await rollout(id, { history_mode: 'paginated', session_id: id });
    const extra = {
      history_mode: 'paginated',
      session_id: childId,
      forked_from_id: id,
      history_base: {
        thread_id: id,
        end_ordinal_exclusive: 2,
        end_byte_offset: (await fs.stat(parent)).size,
      },
    };
    if (kind === 'missing-parent') extra.history_base.thread_id = 'missing';
    if (kind === 'wrong-byte') extra.history_base.end_byte_offset--;
    if (kind === 'wrong-session') extra.session_id = 'unrelated';
    if (kind === 'partial-inheritance') extra.subagent_history_start_ordinal = 100;
    if (kind === 'sibling-prefix') {
      const sibling = await rollout('sibling', { history_mode: 'paginated', forked_from_id: id });
      extra.history_base = {
        thread_id: 'sibling',
        end_ordinal_exclusive: 2,
        end_byte_offset: (await fs.stat(sibling)).size,
      };
    }
    const child = await rollout(childId, extra);
    if (kind === 'missing-ordinal') {
      const bytes = (await fs.readFile(child, 'utf8')).replace('"ordinal":3', '"ordinal":4');
      await fs.writeFile(child, bytes);
    }
    await expect(captureNativeSessionRecovery(options())).rejects.toMatchObject({
      code: {
        'missing-parent': 'native_recovery_session_missing',
        'wrong-byte': 'native_recovery_session_invalid',
        'missing-ordinal': 'native_recovery_session_invalid',
        'wrong-session': 'native_recovery_session_identity',
        'sibling-prefix': 'native_recovery_session_unrelated',
        'partial-inheritance': 'native_recovery_session_incomplete',
      }[kind],
    });
  });

  it('retains the selected Claude transcript and external tool output but never a sibling session', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write(
      'home',
      `${base}.jsonl`,
      `${JSON.stringify({ type: 'user', sessionId: id, cwd: project, message: 'proposal' })}\n`,
    );
    await write('home', `${base}/tool-results/tool.txt`, Buffer.from([0, 255, 7]));
    await write('home', `${base}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    await write('home', `.claude/projects/project-key/${childId}.jsonl`, 'unrelated-secret');
    const checkpoint = await captureNativeSessionRecovery(
      options({ harness: 'claude', forbiddenBytes: ['unrelated-secret'] }),
    );
    expect(checkpoint.files.filter((f) => f.scope === 'home')).toHaveLength(3);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...checkpoint });
    expect(await fs.readFile(join(home, `${base}/tool-results/tool.txt`))).toEqual(
      Buffer.from([0, 255, 7]),
    );
    await expect(
      fs.lstat(join(home, `.claude/projects/project-key/${childId}.jsonl`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on an unknown Claude session sidecar', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    await write('home', `${base}/unknown.sqlite`, 'not qualified');
    await expect(
      captureNativeSessionRecovery(options({ harness: 'claude' })),
    ).rejects.toMatchObject({ code: 'native_recovery_home_path_invalid' });
  });

  it('captures and restores two Claude turns whose Bash cwd moved inside the project', async () => {
    const path = `.claude/projects/project-key/${id}.jsonl`;
    const firstRow = JSON.stringify({ type: 'user', sessionId: id, cwd: project }) + '\n';
    await write('home', path, firstRow);
    const first = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    await fs.mkdir(join(project, 'nested'), { mode: 0o700 });
    // Actual Claude 2.1.296 emits the tool-result and later assistant rows with
    // its current Bash cwd, while keeping the original project key and session.
    const secondRow =
      JSON.stringify({ type: 'user', sessionId: id, cwd: join(project, 'nested') }) + '\n';
    await fs.appendFile(join(home, path), secondRow);
    const second = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    expect(first.files[0].content).toEqual(Buffer.from(firstRow));
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...second });
    expect(await fs.readFile(join(home, path))).toEqual(Buffer.from(firstRow + secondRow));
    expect((await fs.stat(join(project, 'nested'))).isDirectory()).toBe(true);
  });

  it.each(['outside', 'traversal', 'relative', 'wrong-type', 'foreign-session', 'uncaptured'])(
    'still rejects Claude %s identity evidence before capture or restore',
    async (kind) => {
      const path = `.claude/projects/project-key/${id}.jsonl`;
      const firstRow = JSON.stringify({ type: 'user', sessionId: id, cwd: project }) + '\n';
      await write('home', path, firstRow);
      const checkpoint = await captureNativeSessionRecovery(options({ harness: 'claude' }));
      const cwd =
        {
          outside: `${project}-other`,
          traversal: `${project}/nested/..`,
          relative: 'nested',
          'wrong-type': null,
          uncaptured: `${project}/missing`,
        }[kind] ?? project;
      const row = {
        type: 'user',
        sessionId: kind === 'foreign-session' ? childId : id,
        cwd: kind === 'wrong-type' ? null : cwd,
      };
      const content = Buffer.from(firstRow + JSON.stringify(row) + '\n');
      await fs.writeFile(join(home, path), content);
      const code =
        kind === 'foreign-session'
          ? 'native_recovery_session_id_mismatch'
          : 'native_recovery_session_cwd_invalid';
      await expect(
        captureNativeSessionRecovery(options({ harness: 'claude' })),
      ).rejects.toMatchObject({ code });
      checkpoint.files[0] = withContent(checkpoint.files[0], content);
      await emptyRestoreRoots();
      await expect(
        restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...checkpoint }),
      ).rejects.toMatchObject({ code });
      expect(await fs.readdir(project)).toEqual([]);
      expect(await fs.readdir(home)).toEqual([]);
    },
  );

  it('captures a second Claude turn with the pinned CLI agent metadata and restores exact bytes', async () => {
    const base = `.claude/projects/project-key/${id}`;
    const transcript = `${JSON.stringify({ sessionId: id, cwd: project })}\n`;
    await write('home', `${base}.jsonl`, transcript);
    const first = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    // Claude 2.1.257 persistAgentMetadata writes this sibling when Agent runs.
    const sidecar = Buffer.from(
      JSON.stringify({ agentType: 'Explore', toolUseId: 'tool-local', description: 'inspect' }),
    );
    await write('home', `${base}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    await write('home', `${base}/subagents/agent-child.meta.json`, sidecar);
    await fs.appendFile(join(home, `${base}.jsonl`), transcript);
    const second = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    expect(first.files).toHaveLength(1);
    expect(second.files).toHaveLength(3);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...second });
    expect(await fs.readFile(join(home, `${base}/subagents/agent-child.meta.json`))).toEqual(
      sidecar,
    );
    expect(await fs.readFile(join(home, `${base}.jsonl`), 'utf8')).toBe(transcript.repeat(2));
  });

  it.each([
    { content: '{', code: 'session_invalid' },
    { content: 'null', code: 'session_invalid' },
    { content: '[]', code: 'session_invalid' },
    { content: '{}', code: 'session_invalid' },
    { content: '{"agentType":false}', code: 'session_invalid' },
    { content: '{"agentType":"Explore"}', orphan: true, code: 'session_missing' },
    { content: '{"agentType":"Explore"}', foreign: true, code: 'home_path_invalid' },
    { content: '{"agentType":"fixture-credential"}', credential: true, code: 'credential_content' },
  ])('rejects unqualified Claude agent metadata: %j', async (scenario) => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    if (!scenario.orphan)
      await write('home', `${base}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    await write(
      'home',
      `${base}/subagents/${scenario.foreign ? 'unknown' : 'agent-child'}.meta.json`,
      scenario.content,
    );
    await expect(
      captureNativeSessionRecovery(
        options({
          harness: 'claude',
          forbiddenBytes: scenario.credential ? ['fixture-credential'] : [],
        }),
      ),
    ).rejects.toMatchObject({ code: `native_recovery_${scenario.code}` });
  });

  it('rejects late writes and size overflow in a recognized Claude metadata sidecar', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    await write('home', `${base}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    const path = await write(
      'home',
      `${base}/subagents/agent-child.meta.json`,
      '{"agentType":"Explore"}',
    );
    const io = {
      ...fs,
      open: async (target, ...args) => {
        if (target === path) await fs.appendFile(path, ' ');
        return fs.open(target, ...args);
      },
    };
    await expect(
      captureNativeSessionRecovery(options({ harness: 'claude', io })),
    ).rejects.toMatchObject({ code: 'native_recovery_changed' });
    await fs.writeFile(
      path,
      JSON.stringify({ agentType: 'Explore', description: 'x'.repeat(2048) }),
    );
    await expect(
      captureNativeSessionRecovery(options({ harness: 'claude', limits: { maxFileBytes: 1024 } })),
    ).rejects.toMatchObject({ code: 'native_recovery_limit' });
  });

  it('rejects symlinked metadata and modified recovery metadata bytes', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    await write('home', `${base}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    const path = await write(
      'home',
      `${base}/subagents/agent-child.meta.json`,
      '{"agentType":"Explore"}',
    );
    const checkpoint = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    await fs.unlink(path);
    await fs.symlink(`${base}.jsonl`, path);
    await expect(
      captureNativeSessionRecovery(options({ harness: 'claude' })),
    ).rejects.toMatchObject({ code: 'native_recovery_symlink' });
    await emptyRestoreRoots();
    checkpoint.files.find((file) => file.path.endsWith('.meta.json')).content = Buffer.from('{}');
    await expect(
      restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...checkpoint }),
    ).rejects.toMatchObject({ code: 'native_recovery_manifest_invalid' });
  });

  it('preserves known empty Claude sidecar directories and rejects unknown empty ones', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    await fs.mkdir(join(home, base, 'tool-results'), { recursive: true, mode: 0o700 });
    const checkpoint = await captureNativeSessionRecovery(options({ harness: 'claude' }));
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...checkpoint });
    expect(await fs.readdir(join(home, base, 'tool-results'))).toEqual([]);
    await fs.mkdir(join(home, base, 'unknown-store'), { mode: 0o700 });
    await expect(
      captureNativeSessionRecovery(options({ harness: 'claude' })),
    ).rejects.toMatchObject({
      code: 'native_recovery_home_path_invalid',
    });
  });

  it('retains scoped Claude task, plan, memory and file-history context, including arbitrary backup bytes', async () => {
    const base = `.claude/projects/project-key/${id}`;
    await write('home', `${base}.jsonl`, `${JSON.stringify({ sessionId: id, cwd: project })}\n`);
    const values = {
      [`.claude/tasks/${id}/1.json`]: Buffer.from('{"subject":"retained task"}'),
      [`.claude/tasks/${id}/.highwatermark`]: Buffer.from('1'),
      [`.claude/file-history/${id}/original.jsonl`]: Buffer.from([0, 255, 128]),
      [`.claude/scratch/${id}/notes.txt`]: Buffer.from('required scratch context'),
      '.claude/plans/selected-plan.md': Buffer.from('required plan'),
      '.claude/projects/project-key/memory/MEMORY.md': Buffer.from('required memory'),
    };
    for (const [path, value] of Object.entries(values)) await write('home', path, value);
    await write('home', `.claude/tasks/${childId}/private.json`, 'unrelated-secret');
    const checkpoint = await captureNativeSessionRecovery(
      options({ harness: 'claude', forbiddenBytes: ['unrelated-secret'] }),
    );
    expect(checkpoint.files).toHaveLength(7);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'claude' }), ...checkpoint });
    for (const [path, value] of Object.entries(values))
      expect(await fs.readFile(join(home, path))).toEqual(value);
  });

  it('captures and restores only the Kiro v2 metadata/event pair; excludes the auth database', async () => {
    const base = `.kiro/sessions/cli/${id}`;
    await write('home', `${base}.json`, JSON.stringify({ session_id: id, cwd: project }));
    await write('home', `${base}.jsonl`, '{"kind":"Prompt","data":{"content":[]}}\n');
    await write('home', '.data/kiro-cli/data.sqlite3', 'secret-auth-kv');
    const checkpoint = await captureNativeSessionRecovery(
      options({ harness: 'kiro', forbiddenBytes: ['secret-auth-kv'] }),
    );
    expect(checkpoint.files.filter((f) => f.scope === 'home').map((f) => f.path)).toEqual([
      `${base}.json`,
      `${base}.jsonl`,
    ]);
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'kiro' }), ...checkpoint });
    expect(JSON.parse(await fs.readFile(join(home, `${base}.json`), 'utf8')).session_id).toBe(id);
    await expect(fs.lstat(join(home, '.data/kiro-cli/data.sqlite3'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses a scoped OpenCode export and verifies exact messages after import, with no model credentials passed', async () => {
    const data = Buffer.from(
      JSON.stringify({
        info: { id, directory: project },
        messages: [
          {
            info: { id: 'message', sessionID: id },
            parts: [{ sessionID: id, messageID: 'message', type: 'text', text: 'retained' }],
          },
        ],
      }),
    );
    const operations = [];
    const run = async (request) => {
      operations.push(request.operation);
      expect(request.credentials).toBeUndefined();
      return request.operation === 'opencode-import' ? Buffer.from('Imported') : data;
    };
    const checkpoint = await captureNativeSessionRecovery(options({ harness: 'opencode', run }));
    expect(checkpoint.files[0].path).toBe('.native-recovery/opencode-session.json');
    await emptyRestoreRoots();
    await restoreNativeSessionRecovery({ ...options({ harness: 'opencode', run }), ...checkpoint });
    expect(operations).toEqual(['opencode-export', 'opencode-import', 'opencode-export']);
    await expect(fs.lstat(join(home, '.native-recovery'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['key-order', 'changed-text', 'message-order', 'part-order'])(
    'verifies the parsed OpenCode import while preserving message/part order: %s',
    async (variant) => {
      const value = {
        info: { id, directory: project },
        messages: ['one', 'two'].map((message) => ({
          info: { id: message, sessionID: id },
          parts: [
            { sessionID: id, messageID: message, type: 'text', text: 'retained' },
            { sessionID: id, messageID: message, type: 'text', text: 'second part' },
          ],
        })),
      };
      const data = Buffer.from(JSON.stringify(value));
      // The actual installed 1.19 export/import reorders object properties.
      const after = structuredClone(value);
      after.messages = after.messages.map(({ info, parts }) => ({
        parts: parts.map(({ text, type, messageID, sessionID }) => ({
          text,
          type,
          messageID,
          sessionID,
        })),
        info,
      }));
      if (variant === 'changed-text') after.messages[0].parts[0].text = 'changed';
      if (variant === 'message-order') after.messages.reverse();
      if (variant === 'part-order') after.messages[0].parts.reverse();
      let imported = false;
      const run = async ({ operation }) => {
        if (operation === 'opencode-import') {
          imported = true;
          return Buffer.from('Imported');
        }
        return imported ? Buffer.from(JSON.stringify(after)) : data;
      };
      const checkpoint = await captureNativeSessionRecovery(options({ harness: 'opencode', run }));
      await emptyRestoreRoots();
      const restored = restoreNativeSessionRecovery({
        ...options({ harness: 'opencode', run }),
        ...checkpoint,
      });
      if (variant === 'key-order')
        await expect(restored).resolves.toMatchObject({ restored: true });
      else
        await expect(restored).rejects.toMatchObject({
          code: 'native_recovery_restore_unverified',
        });
      expect(checkpoint.files[0].content).toEqual(data); // Immutable checkpoint bytes never rewritten.
    },
  );

  it.each([
    { type: 'snapshot', snapshot: 'requires-git-snapshot-store' },
    { type: 'tool', tool: 'task' },
    { type: 'tool', tool: 'todowrite' },
  ])('refuses an OpenCode export with an unexported dependency %j', async (part) => {
    const data = Buffer.from(
      JSON.stringify({
        info: { id, directory: project },
        messages: [
          {
            info: { id: 'message', sessionID: id },
            parts: [{ ...part, sessionID: id, messageID: 'message' }],
          },
        ],
      }),
    );
    await expect(
      captureNativeSessionRecovery(options({ harness: 'opencode', run: async () => data })),
    ).rejects.toMatchObject({ code: 'native_recovery_session_layout_unsupported' });
  });
});

describe('controller-validated restore input defenses', () => {
  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\u0000b'])(
    'refuses unsafe path %j before writing',
    async (path) => {
      await rollout();
      const checkpoint = await captureNativeSessionRecovery(options());
      checkpoint.files[0].path = path;
      await emptyRestoreRoots();
      await expect(
        restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
      ).rejects.toMatchObject({ code: 'native_recovery_manifest_invalid' });
      expect(await fs.readdir(project)).toEqual([]);
      expect(await fs.readdir(home)).toEqual([]);
    },
  );

  it.each(['hash', 'bytes', 'duplicate', 'home-directory', 'version', 'identity', 'relocation'])(
    'rejects %s manifest corruption before writing',
    async (kind) => {
      await rollout();
      const checkpoint = await captureNativeSessionRecovery(options());
      if (kind === 'hash') checkpoint.files[0].sha256 = '0'.repeat(64);
      if (kind === 'bytes') checkpoint.files[0].bytes += 1;
      if (kind === 'duplicate') checkpoint.files.push(checkpoint.files[0]);
      if (kind === 'home-directory')
        checkpoint.metadata.directories.push({
          scope: 'home',
          path: '.aws',
          mode: 0o700,
          mtimeNs: '0',
        });
      if (kind === 'version') checkpoint.metadata.harnessVersion = 'future-version';
      if (kind === 'identity') checkpoint.metadata.nativeSessionId = childId;
      if (kind === 'relocation') checkpoint.metadata.project = '/another/path';
      await emptyRestoreRoots();
      await expect(
        restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
      ).rejects.toBeTruthy();
      expect(await fs.readdir(project)).toEqual([]);
      expect(await fs.readdir(home)).toEqual([]);
    },
  );

  it('rejects a file/directory prefix conflict', async () => {
    await rollout();
    await write('project', 'code', 'file');
    const checkpoint = await captureNativeSessionRecovery(options());
    checkpoint.metadata.directories.push({
      scope: 'project',
      path: 'code/child',
      mode: 0o700,
      mtimeNs: '0',
    });
    await emptyRestoreRoots();
    await expect(
      restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
    ).rejects.toMatchObject({ code: 'native_recovery_manifest_invalid' });
  });

  it('refuses an existing destination instead of overwriting a possible owner', async () => {
    await rollout();
    const checkpoint = await captureNativeSessionRecovery(options());
    await expect(
      restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
    ).rejects.toMatchObject({ code: 'native_recovery_restore_not_empty' });
  });

  it('checks cancellation during capture and before restore', async () => {
    await rollout();
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureNativeSessionRecovery(options({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'native_recovery_cancelled' });
    const checkpoint = await captureNativeSessionRecovery(options());
    await emptyRestoreRoots();
    await expect(
      restoreNativeSessionRecovery({ ...options({ signal: controller.signal }), ...checkpoint }),
    ).rejects.toMatchObject({ code: 'native_recovery_cancelled' });
    expect(await fs.readdir(home)).toEqual([]);
  });

  it('rechecks credential bytes on restore', async () => {
    await rollout();
    await write('project', 'code', 'ordinary');
    const checkpoint = await captureNativeSessionRecovery(options());
    const index = checkpoint.files.findIndex((f) => f.scope === 'project');
    checkpoint.files[index] = withContent(checkpoint.files[index], Buffer.from('TOKEN_CANARY'));
    await emptyRestoreRoots();
    await expect(
      restoreNativeSessionRecovery({
        ...options({ forbiddenBytes: ['TOKEN_CANARY'] }),
        ...checkpoint,
      }),
    ).rejects.toMatchObject({ code: 'native_recovery_credential_content' });
  });

  it('leaves a partial restore non-retryable when the precise timestamp operation fails', async () => {
    await rollout();
    const checkpoint = await captureNativeSessionRecovery(options());
    await emptyRestoreRoots();
    await expect(
      restoreNativeSessionRecovery({
        ...options(),
        ...checkpoint,
        restoreTimes: async () => {
          throw new Error('private raw error');
        },
      }),
    ).rejects.toMatchObject({ code: 'native_recovery_restore_failed' });
    await expect(
      restoreNativeSessionRecovery({ ...options(), ...checkpoint }),
    ).rejects.toMatchObject({ code: 'native_recovery_restore_not_empty' });
  });

  it('does not confuse ordinary filenames with private controls', () => {
    expect(nativeRecoveryProjectExclusion('aidlc/.aidlc-engine/steering-token-key')).toBeNull();
    expect(nativeRecoveryProjectExclusion('.codex/config.toml')).toBeNull();
    expect(nativeRecoveryProjectExclusion('src/credentials-model.ts')).toBeNull();
  });
});
