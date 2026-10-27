import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeTransportInstructions } from '../native/transport-instructions.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual('node:fs/promises');
const roots = [];
const instructions =
  'Platform transport instructions.\nRender the form and preserve every human gate.\n' +
  'Keep platform guidance outside the literal /aidlc --resume entry.\n';
const invalid = { code: 'native_execution_transport_invalid' };
const conflict = { code: 'native_execution_transport_conflict' };
const fixture = async (harness = 'codex', env = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-transport-')));
  roots.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  return {
    root,
    project,
    home,
    options: { harness, project, home, instructions, env },
  };
};
const instructionPath = ({ home }, harness = 'codex') =>
  join(home, harness === 'codex' ? '.codex/AGENTS.md' : '.native-transport/instructions.md');

afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native transport instruction channels', () => {
  it('returns Claude additive system context without generating project or home files', async () => {
    const f = await fixture('claude', { AWS_REGION: 'us-east-1' });
    const result = await prepareNativeTransportInstructions(f.options);
    expect(result).toEqual({
      env: { AWS_REGION: 'us-east-1' },
      invocation: { systemPrompt: instructions },
    });
    expect(result.env).not.toBe(f.options.env);
    expect(await readdir(f.home)).toEqual([]);
    expect(await readdir(f.project)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('adds private global Codex guidance without replacing trust or package developer instructions', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.codex'), { mode: 0o700 });
    await mkdir(join(f.project, '.codex'), { mode: 0o700 });
    const trust = `[projects.${JSON.stringify(f.project)}]\ntrust_level = "trusted"\n`;
    const pinned = 'developer_instructions = """\nFull pinned AI-DLC onboarding\n"""\n';
    await writeFile(join(f.home, '.codex/config.toml'), trust, { mode: 0o600 });
    await writeFile(join(f.project, '.codex/config.toml'), pinned, { mode: 0o600 });
    await writeFile(join(f.project, 'AGENTS.md'), 'Application instructions\n', { mode: 0o600 });
    const result = await prepareNativeTransportInstructions(f.options);
    expect(result).toEqual({
      env: { CODEX_HOME: join(f.home, '.codex') },
      invocation: {},
    });
    expect(await readFile(instructionPath(f), 'utf8')).toBe(instructions);
    expect(await readFile(join(f.home, '.codex/config.toml'), 'utf8')).toBe(trust);
    expect(await readFile(join(f.project, '.codex/config.toml'), 'utf8')).toBe(pinned);
    expect(await readFile(join(f.project, 'AGENTS.md'), 'utf8')).toBe('Application instructions\n');
    expect((await lstat(instructionPath(f))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(f.home, '.codex'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(f.project, '.codex'))).toEqual(['config.toml']);
  });

  it('preserves the OpenCode overlay and adds a private instruction path only once', async () => {
    const initial = {
      provider: { retained: { options: { region: 'us-east-1' } } },
      permission: { read: 'allow', edit: 'ask' },
      share: 'disabled',
      instructions: ['.aidlc/onboarding.md', 'aidlc/active-memory/**/*.md'],
    };
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(initial), OTHER_SETTING: 'keep' };
    const f = await fixture('opencode', env);
    const first = await prepareNativeTransportInstructions(f.options);
    const second = await prepareNativeTransportInstructions({ ...f.options, env: first.env });
    const path = instructionPath(f, 'opencode');
    expect(first.invocation).toEqual({});
    expect(second).toEqual(first);
    expect(JSON.parse(first.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      ...initial,
      instructions: [...initial.instructions, path],
    });
    expect(first.env.OTHER_SETTING).toBe('keep');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(initial));
    expect(await readFile(path, 'utf8')).toBe(instructions);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(f.home, '.native-transport'))).mode & 0o777).toBe(0o700);
    expect(await readdir(f.project)).toEqual([]);
  });

  it('creates the OpenCode overlay when no existing overlay is supplied', async () => {
    const f = await fixture('opencode');
    const result = await prepareNativeTransportInstructions(f.options);
    expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [instructionPath(f, 'opencode')],
    });
  });

  it.each(['codex', 'opencode'])(
    'reuses unchanged %s files without overwriting them',
    async (harness) => {
      const f = await fixture(harness);
      await prepareNativeTransportInstructions(f.options);
      const path = instructionPath(f, harness);
      const before = await lstat(path, { bigint: true });
      await prepareNativeTransportInstructions(f.options);
      const after = await lstat(path, { bigint: true });
      expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
        before.ino,
        before.mtimeNs,
        before.ctimeNs,
      ]);
    },
  );

  it.each(['codex', 'opencode'])(
    'refuses changed %s context without overwriting it',
    async (harness) => {
      const f = await fixture(harness);
      await prepareNativeTransportInstructions(f.options);
      const path = instructionPath(f, harness);
      await writeFile(path, 'Changed by another writer\n');
      await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(conflict);
      expect(await readFile(path, 'utf8')).toBe('Changed by another writer\n');
    },
  );

  it('refuses a Codex override that would hide the transport instructions', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.codex'), { mode: 0o700 });
    await writeFile(join(f.home, '.codex/AGENTS.override.md'), 'Higher precedence\n', {
      mode: 0o600,
    });
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(conflict);
    await expect(lstat(instructionPath(f))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to redirect Codex context to a different home', async () => {
    const f = await fixture('codex', { CODEX_HOME: '/other-home' });
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
    expect(await readdir(f.home)).toEqual([]);
  });

  it('refuses Kiro before reading or generating context until the installed agent path is qualified', async () => {
    const f = await fixture('kiro');
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject({
      code: 'native_execution_transport_kiro_unqualified',
      message: 'native_execution_transport_kiro_unqualified',
    });
    expect(open).not.toHaveBeenCalled();
    expect(await readdir(f.project)).toEqual([]);
    expect(await readdir(f.home)).toEqual([]);
  });
});

describe('native transport instruction validation', () => {
  it.each(['', ' ', '\0', 'x'.repeat(64 * 1024 + 1), '界'.repeat(24 * 1024)])(
    'rejects empty, invalid or oversized instruction bytes %#',
    async (invalidInstructions) => {
      const f = await fixture();
      await expect(
        prepareNativeTransportInstructions({ ...f.options, instructions: invalidInstructions }),
      ).rejects.toMatchObject(invalid);
      expect(await readdir(f.home)).toEqual([]);
    },
  );

  it.each([undefined, null, [], 'invalid'])(
    'returns a fixed error for missing preparation input %#',
    async (options) => {
      await expect(prepareNativeTransportInstructions(options)).rejects.toMatchObject({
        ...invalid,
        message: invalid.code,
      });
    },
  );

  it.each([
    { harness: 'other' },
    { home: 'relative' },
    { home: '/' },
    { home: '/tmp/home/../other' },
    { project: 'relative' },
    { project: '/' },
    { env: [] },
    { env: null },
  ])('rejects invalid preparation input %#', async (change) => {
    const f = await fixture();
    await expect(
      prepareNativeTransportInstructions({ ...f.options, ...change }),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects a home inside the published project or containing that project', async () => {
    const f = await fixture();
    for (const change of [
      { home: f.project },
      { home: join(f.project, 'private') },
      { project: join(f.home, 'project') },
    ]) {
      await expect(
        prepareNativeTransportInstructions({ ...f.options, ...change }),
      ).rejects.toMatchObject(invalid);
    }
    expect(await readdir(f.project)).toEqual([]);
  });

  it.each([
    '',
    'invalid JSON',
    '[]',
    'null',
    '{"instructions":"not an array"}',
    '{"instructions":[""]}',
    '{"instructions":[{}]}',
    JSON.stringify({ large: 'x'.repeat(256 * 1024) }),
  ])(
    'rejects malformed or oversized OpenCode overlays before writing context %#',
    async (config) => {
      const f = await fixture('opencode', { OPENCODE_CONFIG_CONTENT: config });
      await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
      expect(await readdir(f.home)).toEqual([]);
    },
  );

  it.each(['home', 'directory', 'file'])(
    'rejects a symbolic link at the %s boundary',
    async (boundary) => {
      const f = await fixture();
      await prepareNativeTransportInstructions(f.options);
      const path =
        boundary === 'home'
          ? f.home
          : boundary === 'directory'
            ? join(f.home, '.codex')
            : instructionPath(f);
      await rename(path, `${path}-original`);
      await symlink(`${path}-original`, path);
      await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
    },
  );

  it.each(['home', 'directory', 'file'])(
    'rejects unsafe permissions at the %s boundary',
    async (boundary) => {
      const f = await fixture();
      await prepareNativeTransportInstructions(f.options);
      const path =
        boundary === 'home'
          ? f.home
          : boundary === 'directory'
            ? join(f.home, '.codex')
            : instructionPath(f);
      await chmod(path, 0o777);
      await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
    },
  );

  it('rejects hard-linked context without changing either name', async () => {
    const f = await fixture();
    await prepareNativeTransportInstructions(f.options);
    const alias = join(f.root, 'alias');
    await link(instructionPath(f), alias);
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
    expect(await readFile(alias, 'utf8')).toBe(instructions);
  });

  it('rejects a directory in place of the instruction file', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.codex/AGENTS.md'), { recursive: true, mode: 0o700 });
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
  });

  it('bounds existing private file reads before allocating their contents', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.codex'), { mode: 0o700 });
    await writeFile(instructionPath(f), 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
  });

  it.each(['mutate-file', 'replace-file', 'replace-directory'])(
    'rejects %s during descriptor verification',
    async (change) => {
      const f = await fixture();
      await prepareNativeTransportInstructions(f.options);
      const path = instructionPath(f);
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        const read = handle.read.bind(handle);
        let changed = false;
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (!changed) {
            changed = true;
            if (change === 'mutate-file') await writeFile(path, 'Changed during read\n');
            if (change === 'replace-file') {
              await rename(path, `${path}-original`);
              await writeFile(path, instructions, { mode: 0o600 });
            }
            if (change === 'replace-directory') {
              const parent = join(f.home, '.codex');
              await rename(parent, `${parent}-original`);
              await symlink(`${parent}-original`, parent);
            }
          }
          return result;
        };
        return handle;
      });
      await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject(invalid);
    },
  );

  it('returns a fixed error without leaking an unavailable path', async () => {
    const f = await fixture();
    await rm(f.home, { recursive: true });
    await expect(prepareNativeTransportInstructions(f.options)).rejects.toMatchObject({
      ...invalid,
      message: invalid.code,
    });
  });
});
