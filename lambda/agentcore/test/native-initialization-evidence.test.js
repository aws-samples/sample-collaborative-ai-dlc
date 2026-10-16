import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureNativeInitializationBaseline,
  inspectNativeInitialization,
  nativeInitializationBaselineReason,
  nativeInitializationCheckStatuses,
} from '../native/initialization-evidence.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actualFilesystem = await vi.importActual('node:fs/promises');
const VERSION = '2.9.0';
const exec = promisify(execFile);
const roots = [];
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const rows = {
  claude: {
    engine: '.claude',
    rules: 'rules',
    product: 'Claude Code',
    next: 'open Claude Code in this project and run `/aidlc --doctor`',
    files: {
      '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [] } }),
      '.claude/skills/aidlc/SKILL.md':
        '---\nname: aidlc\ndescription: Authored fixture\n---\n# Inert fixture\n',
    },
  },
  kiro: {
    engine: '.kiro',
    rules: 'steering',
    product: 'Kiro CLI',
    next: 'run `kiro-cli chat`, then `/aidlc --doctor`',
    files: {
      '.kiro/agents/aidlc.json': JSON.stringify({
        name: 'aidlc',
        description: 'Authored fixture',
        tools: [],
        hooks: { agentSpawn: [{ command: 'aidlc engine adapter kiro session-start' }] },
      }),
      '.kiro/hooks/aidlc-kiro-adapter.ts': '// Authored inert adapter; never executed.\n',
      'AGENTS.md': '# Authored initialization fixture\n',
    },
  },
  opencode: {
    engine: '.aidlc',
    rules: 'rules',
    product: 'opencode',
    next: 'run `opencode`, then `/aidlc --doctor`',
    files: {
      '.opencode/plugin/aidlc-opencode-adapter.ts': '// Authored inert plugin; never executed.\n',
      'opencode.json': JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        skills: { paths: ['.aidlc/skills'] },
        instructions: ['aidlc/spaces/default/memory/**/*.md'],
        permission: { edit: { '*': 'allow' }, bash: { '*': 'ask' } },
      }),
    },
  },
  codex: {
    engine: '.codex',
    rules: 'aidlc-rules',
    product: 'Codex CLI',
    next: 'run `codex`, then `$aidlc --doctor`',
    files: {
      '.codex/hooks.json': JSON.stringify({ hooks: { SessionStart: [] } }),
      '.codex/config.toml':
        '# Authored fixture, not host qualification\n[features]\nmulti_agent = true\n',
      '.codex/trust-seed.toml': '# Authored fixture; no trust has been granted\n[hooks.state]\n',
      '.agents/skills/aidlc/SKILL.md':
        '---\nname: aidlc\ndescription: Authored fixture\n---\n# Inert fixture\n',
    },
  },
};

const write = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
};
const fixture = async (harness = 'codex', version = VERSION) => {
  // Canonical paths are part of the supervisor contract (/var aliases /private
  // on macOS). No cached upstream code is imported or executed by these tests.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'initialization-evidence-')));
  roots.push(root);
  const projectDirectory = join(root, 'projects', harness);
  const installRoot = join(root, 'machine', 'data');
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  const row = rows[harness];
  const data = join(projectDirectory, row.engine, 'tools', 'data');
  const identity = { schemaVersion: 1, distribution: harness, harnessDir: row.engine };
  // These authored records follow upstream ProjectionStamp, ProjectionDescriptor,
  // Baseline and HARNESS_IDENTITY_KEYS. Descriptor/harness have no version field.
  const files = {
    ...row.files,
    [`${row.engine}/tools/data/aidlc-stamp.json`]: JSON.stringify({
      ...identity,
      frameworkVersion: version,
    }),
    [`${row.engine}/tools/data/aidlc-projection.json`]: JSON.stringify({
      ...identity,
      productName: row.product,
      configNextStep: row.next,
      managedDirectories: [
        row.engine,
        'aidlc',
        ...(harness === 'codex' ? ['.agents'] : []),
        ...(harness === 'opencode' ? ['.opencode'] : []),
      ],
      rootIntegrations:
        harness === 'kiro'
          ? [{ path: 'AGENTS.md', policy: 'managed-block', marker: 'agents' }]
          : [],
    }),
    [`${row.engine}/tools/data/harness.json`]: JSON.stringify({
      ...identity,
      productName: row.product,
      configNextStep: row.next,
      rulesSubdir: row.rules,
    }),
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => write(join(projectDirectory, name), contents)),
  );
  await write(
    join(data, 'aidlc-manifest.json'),
    JSON.stringify({
      ...identity,
      frameworkVersion: version,
      mcpMode: 'none',
      files: Object.fromEntries(
        Object.entries(files)
          .filter(([name]) => name !== 'AGENTS.md')
          .map(([name, contents]) => [name, digest(contents)]),
      ),
      rootContributions:
        harness === 'kiro'
          ? {
              'AGENTS.md': {
                policy: 'managed-block',
                hash: digest(files['AGENTS.md']),
                marker: 'agents',
              },
            }
          : {},
    }),
  );
  const executable = join(installRoot, 'versions', version, 'aidlc');
  await write(executable, 'Authored synthetic executable bytes; never executed.\n');
  await chmod(executable, 0o500);
  await write(join(projectDirectory, '.aidlc-version'), `${version}\n`);
  const pinTarget = join(projectDirectory, 'aidlc', '.aidlc-sessions', 'pin-target');
  await write(pinTarget, `${executable}\n`);
  await write(join(installRoot, 'pins.json'), JSON.stringify({ [projectDirectory]: version }));
  const memory = join(projectDirectory, 'aidlc', 'spaces', 'default', 'memory');
  await mkdir(memory, { recursive: true });
  return {
    root,
    projectDirectory,
    installRoot,
    data,
    executable,
    memory,
    pinTarget,
    harness,
    version,
    inspect: (options = {}) =>
      inspectNativeInitialization({ projectDirectory, installRoot, version, harness, ...options }),
  };
};
afterEach(async () => {
  vi.mocked(lstat).mockImplementation(actualFilesystem.lstat);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const checkFor = (result, id) => {
  const check = result.checks.find((entry) => entry.id === id);
  expect(check).toBeDefined();
  return check;
};
const expectFailed = async (f, id) => {
  const result = await f.inspect();
  expect(result.ok).toBe(false);
  expect(checkFor(result, id).status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-FILE-CONTENT');
  return result;
};
const mutateJson = async (path, edit) => {
  const value = JSON.parse(await readFile(path, 'utf8'));
  edit(value);
  await writeFile(path, JSON.stringify(value));
};

describe('existing repository harness baseline', () => {
  const brownfield = async () => {
    const f = await fixture();
    const path = join(f.projectDirectory, '.kiro/steering/core-workflow.md');
    const bytes = Buffer.from('\uFEFF# Existing repository instructions\r\nKeep these bytes.\r\n');
    await write(path, bytes);
    const harnessBaseline = await captureNativeInitializationBaseline(f);
    return { ...f, path, bytes, harnessBaseline };
  };

  it('preserves existing Kiro bytes for Codex while default G1 inspection stays strict', async () => {
    const f = await brownfield();
    expect(f.harnessBaseline.directories.map(({ directory }) => directory)).toEqual(['.kiro']);
    expect(Object.isFrozen(f.harnessBaseline)).toBe(true);
    expect(Object.isFrozen(f.harnessBaseline.directories)).toBe(true);
    expect(Object.isFrozen(f.harnessBaseline.directories[0].identity)).toBe(true);
    expect(JSON.stringify(f.harnessBaseline)).not.toContain(f.root);
    await expectFailed(f, 'harness-layout');
    expect((await f.inspect({ harnessBaseline: f.harnessBaseline })).ok).toBe(true);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it.each(['empty', 'existing'])(
    'rejects a new harness directory after an %s baseline',
    async (kind) => {
      const f = kind === 'existing' ? await brownfield() : await fixture();
      const harnessBaseline = f.harnessBaseline ?? (await captureNativeInitializationBaseline(f));
      await mkdir(join(f.projectDirectory, '.claude'));
      const result = await f.inspect({ harnessBaseline });
      expect(checkFor(result, 'harness-layout').status).toBe('failed');
      expect(result.checks.filter(({ status }) => status === 'failed')).toHaveLength(1);
    },
  );

  it.each(['symlink', 'file', 'fifo'])(
    'rejects an unsafe %s before capturing the baseline',
    async (kind) => {
      const f = await fixture();
      const path = join(f.projectDirectory, '.kiro');
      if (kind === 'symlink') await symlink(f.installRoot, path);
      if (kind === 'file') await writeFile(path, 'PRIVATE-FILE-CONTENT');
      if (kind === 'fifo') await exec('mkfifo', [path]);
      await expect(captureNativeInitializationBaseline(f)).rejects.toThrow(
        'Invalid initialization evidence',
      );
    },
  );

  it.each(['replacement', 'removed', 'symlink', 'file'])(
    'rejects a %s baseline directory',
    async (kind) => {
      const f = await brownfield();
      const path = join(f.projectDirectory, '.kiro');
      const previous = join(f.root, 'previous-kiro');
      await rename(path, previous);
      if (kind === 'replacement') await mkdir(path);
      if (kind === 'symlink') await symlink(previous, path);
      if (kind === 'file') await writeFile(path, 'PRIVATE-FILE-CONTENT');
      const result = await f.inspect({ harnessBaseline: f.harnessBaseline });
      expect(checkFor(result, 'harness-layout').status).toBe('failed');
      expect(result.checks.filter(({ status }) => status === 'failed')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(await readFile(join(previous, 'steering/core-workflow.md'))).toEqual(f.bytes);
    },
  );

  it.each([
    [
      'schema',
      (b) => {
        b.schemaVersion = 2;
      },
    ],
    [
      'harness',
      (b) => {
        b.harness = 'kiro';
      },
    ],
    [
      'project',
      (b) => {
        b.project.ino += '1';
      },
    ],
    [
      'directory identity',
      (b) => {
        b.directories[0].identity.ino += '1';
      },
    ],
    [
      'invalid identity',
      (b) => {
        b.directories[0].identity.dev = '../private';
      },
    ],
    [
      'numeric identity',
      (b) => {
        b.directories[0].identity.ino = 123;
      },
    ],
    [
      'unknown directory',
      (b) => {
        b.directories[0].directory = '.unknown';
      },
    ],
    [
      'path traversal',
      (b) => {
        b.directories[0].directory = '../private';
      },
    ],
    [
      'selected harness',
      (b) => {
        b.directories[0].directory = '.codex';
      },
    ],
    [
      'duplicate',
      (b) => {
        b.directories.push(b.directories[0]);
      },
    ],
    [
      'unbounded entries',
      (b) => {
        b.directories = Array(4).fill(b.directories[0]);
      },
    ],
    [
      'extra fields',
      (b) => {
        b.untrustedPath = '/private';
      },
    ],
  ])('rejects a malformed baseline: %s', async (_name, edit) => {
    const f = await brownfield();
    const baseline = structuredClone(f.harnessBaseline);
    edit(baseline);
    expect(checkFor(await f.inspect({ harnessBaseline: baseline }), 'harness-layout').status).toBe(
      'failed',
    );
  });

  it.each([null, [], {}])('rejects explicit malformed baseline %j', async (harnessBaseline) => {
    const f = await fixture();
    expect(checkFor(await f.inspect({ harnessBaseline }), 'harness-layout').status).toBe('failed');
  });

  it('binds the baseline to one project even when another has the same harness directories', async () => {
    const first = await brownfield();
    const second = await brownfield();
    expect(
      checkFor(await second.inspect({ harnessBaseline: first.harnessBaseline }), 'harness-layout')
        .status,
    ).toBe('failed');
  });

  it('keeps the selected harness and version-pin checks when a baseline is supplied', async () => {
    const f = await brownfield();
    await writeFile(join(f.projectDirectory, '.codex/hooks.json'), 'invalid-json');
    await writeFile(join(f.projectDirectory, '.aidlc-version'), '1.0.0');
    const result = await f.inspect({ harnessBaseline: f.harnessBaseline });
    expect(checkFor(result, 'harness-layout').status).toBe('passed');
    expect(checkFor(result, 'representative-codex-hooks').status).toBe('failed');
    expect(checkFor(result, 'version-pin').status).toBe('failed');
  });

  it('bounds diagnostic output to fixed IDs and statuses, preserving failures over duplicates', () => {
    const secret = 'PRIVATE-FILE-CONTENT';
    expect(
      nativeInitializationCheckStatuses([
        { id: 'harness-layout', status: 'failed', message: secret, path: '/private' },
        { id: secret, status: 'failed' },
        { id: 'inputs', status: secret },
        { id: 'harness-layout', status: 'passed' },
        { id: 'version-pin', status: 'passed' },
        ...Array.from({ length: 100 }, () => ({ id: 'version-pin', status: 'passed', secret })),
      ]),
    ).toEqual([
      { id: 'harness-layout', status: 'failed' },
      { id: 'version-pin', status: 'passed' },
    ]);
    for (const value of [null, {}, undefined, 'private']) {
      expect(nativeInitializationCheckStatuses(value)).toEqual([]);
    }
  });
});

describe('exact uint64 NFS directory identities', () => {
  const simulate = (changes) => {
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      const stat = await actualFilesystem.lstat(path, options);
      if (options?.bigint && changes.has(String(path))) {
        Object.assign(stat, changes.get(String(path)));
      }
      return stat;
    });
  };
  const setup = async () => {
    const f = await fixture();
    await mkdir(join(f.projectDirectory, '.kiro'));
    return f;
  };

  it.each(['root', 'kiro', 'both'])(
    'accepts signed Node bigint inode values on %s',
    async (target) => {
      const f = await setup();
      const changes = new Map();
      const projectInode = -(1n << 63n) + 1n;
      const kiroInode = -2n;
      if (target !== 'kiro') changes.set(f.projectDirectory, { ino: projectInode });
      if (target !== 'root') changes.set(join(f.projectDirectory, '.kiro'), { ino: kiroInode });
      simulate(changes);
      const harnessBaseline = await captureNativeInitializationBaseline(f);
      if (target !== 'kiro') expect(harnessBaseline.project.ino).toBe('9223372036854775809');
      if (target !== 'root') {
        expect(harnessBaseline.directories[0].identity.ino).toBe('18446744073709551614');
      }
      expect((await f.inspect({ harnessBaseline })).ok).toBe(true);
      expect(checkFor(await f.inspect(), 'harness-layout').status).toBe('failed');
    },
  );

  it.each([
    [-(1n << 63n), '9223372036854775808'],
    [-1n, '18446744073709551615'],
    [0n, '0'],
    [(1n << 63n) - 1n, '9223372036854775807'],
    [(1n << 64n) - 1n, '18446744073709551615'],
  ])('normalizes the exact valid inode boundary %s', async (ino, expected) => {
    const f = await setup();
    simulate(new Map([[f.projectDirectory, { ino }]]));
    const harnessBaseline = await captureNativeInitializationBaseline(f);
    expect(harnessBaseline.project.ino).toBe(expected);
    expect((await f.inspect({ harnessBaseline })).ok).toBe(true);
  });

  it.each(['root', 'kiro'])('rejects adjacent inode changes above 2^53 on %s', async (target) => {
    const f = await setup();
    const path = target === 'root' ? f.projectDirectory : join(f.projectDirectory, '.kiro');
    for (const ino of [(1n << 53n) + 3n, -(1n << 63n) + 1n]) {
      const changes = new Map([[path, { ino }]]);
      simulate(changes);
      const harnessBaseline = await captureNativeInitializationBaseline(f);
      expect(Number(ino)).toBe(Number(ino + 1n));
      changes.set(path, { ino: ino + 1n });
      const result = await f.inspect({ harnessBaseline });
      expect(checkFor(result, 'harness-layout').status).toBe('failed');
      expect(result.checks.filter(({ status }) => status === 'failed')).toHaveLength(1);
    }
  });

  it.each([-(1n << 63n) - 1n, 1n << 64n, -(1n << 64n), 2 ** 60, '123', null])(
    'rejects invalid inode input without coercion or modular aliasing: %s',
    async (ino) => {
      const f = await setup();
      simulate(new Map([[f.projectDirectory, { ino }]]));
      await expect(captureNativeInitializationBaseline(f)).rejects.toMatchObject({
        baselineReason: 'baseline-inode-invalid',
      });
    },
  );

  it.each([
    ['dev', -1n, 'baseline-metadata-invalid'],
    ['dev', 1n << 64n, 'baseline-metadata-invalid'],
    ['dev', 123, 'baseline-metadata-invalid'],
    ['uid', -1n, 'baseline-owner-mismatch'],
    ['uid', 1n << 64n, 'baseline-owner-mismatch'],
  ])('does not normalize invalid %s as an inode', async (field, value, baselineReason) => {
    const f = await setup();
    simulate(new Map([[f.projectDirectory, { [field]: value }]]));
    await expect(captureNativeInitializationBaseline(f)).rejects.toMatchObject({ baselineReason });
  });

  it.each(['dev', 'ino', 'uid'])('rejects out-of-range serialized baseline %s', async (field) => {
    const f = await setup();
    const harnessBaseline = structuredClone(await captureNativeInitializationBaseline(f));
    harnessBaseline.project[field] = '18446744073709551616';
    expect(checkFor(await f.inspect({ harnessBaseline }), 'harness-layout').status).toBe('failed');
  });

  it('does not let signed inode normalization admit a symlink', async () => {
    const f = await setup();
    await rm(join(f.projectDirectory, '.kiro'), { recursive: true });
    await symlink(f.installRoot, join(f.projectDirectory, '.kiro'));
    simulate(new Map([[join(f.projectDirectory, '.kiro'), { ino: -2n }]]));
    await expect(captureNativeInitializationBaseline(f)).rejects.toMatchObject({
      baselineReason: 'baseline-directory-unsafe',
    });
  });

  it('allowlists only fixed baseline diagnostic reasons', () => {
    expect(nativeInitializationBaselineReason('baseline-inode-invalid')).toBe(
      'baseline-inode-invalid',
    );
    for (const value of ['/private/path', 'known-model-credential', {}, null, undefined]) {
      expect(nativeInitializationBaselineReason(value)).toBeUndefined();
    }
  });
});

describe('G1 native initialization filesystem evidence', () => {
  it.each(Object.keys(rows))(
    'accepts authored upstream-shaped %s configuration without intent or audit state',
    async (harness) => {
      const f = await fixture(harness);
      const result = await f.inspect();
      expect(result.ok).toBe(true);
      expect(Object.keys(result)).toEqual(['schemaVersion', 'ok', 'checks']);
      expect(result.schemaVersion).toBe(1);
      expect(result.checks.length).toBeLessThanOrEqual(18);
      expect(new Set(result.checks.map(({ id }) => id)).size).toBe(result.checks.length);
      for (const check of result.checks) {
        expect(Object.keys(check)).toEqual(['id', 'status', 'message']);
        expect(check.status).toBe('passed');
        expect(check.message.length).toBeLessThan(120);
      }
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(await readFile(join(f.data, 'harness.json'), 'utf8')).not.toContain(
        'frameworkVersion',
      );
      expect(await readFile(join(f.data, 'aidlc-projection.json'), 'utf8')).not.toContain(
        'frameworkVersion',
      );
    },
  );

  it('accepts the exact upstream preview-version grammar', async () => {
    expect((await (await fixture('codex', '2.9.1-preview.20260918.1')).inspect()).ok).toBe(true);
  });

  it('accepts AI-DLC 2.11 OpenCode json-entries contributions but still requires entry hashes', async () => {
    const f = await fixture('opencode', '2.11.0');
    const entry = JSON.stringify({ path: ['skills', 'paths'], item: '.aidlc/skills' });
    await mutateJson(join(f.data, 'aidlc-manifest.json'), (manifest) => {
      manifest.rootContributions['opencode.json'] = {
        policy: 'json-entries',
        entries: { [entry]: digest('.aidlc/skills') },
        created: true,
      };
    });
    expect((await f.inspect()).ok).toBe(true);
    await mutateJson(join(f.data, 'aidlc-manifest.json'), (manifest) => {
      manifest.rootContributions['opencode.json'].entries[entry] = 'not-a-digest';
    });
    await expectFailed(f, 'configuration-manifest');
  });

  it('reports all missing independent evidence instead of stopping at one file', async () => {
    const f = await fixture();
    await rm(join(f.projectDirectory, '.aidlc-version'));
    await rm(join(f.data, 'aidlc-stamp.json'));
    await rm(f.memory, { recursive: true });
    const result = await expectFailed(f, 'version-pin');
    expect(checkFor(result, 'projection-stamp').status).toBe('failed');
    expect(checkFor(result, 'memory-directory').status).toBe('failed');
    expect(checkFor(result, 'installed-executable').status).toBe('passed');
  });

  it.each([
    ['aidlc-stamp.json', 'projection-stamp'],
    ['aidlc-projection.json', 'projection-descriptor'],
    ['aidlc-manifest.json', 'configuration-manifest'],
    ['harness.json', 'harness-identity'],
  ])('requires %s to be a valid bounded JSON record', async (name, id) => {
    const f = await fixture();
    for (const contents of [
      '{"PRIVATE-FILE-CONTENT"',
      'null',
      '[]',
      Buffer.from([0xff]),
      Buffer.alloc(1024 * 1024 + 1, 32),
    ]) {
      await writeFile(join(f.data, name), contents);
      await expectFailed(f, id);
    }
  });

  it.each([
    ['aidlc-stamp.json', 'frameworkVersion', '1.0.0', 'projection-stamp'],
    ['aidlc-stamp.json', 'distribution', 'claude', 'projection-stamp'],
    ['aidlc-projection.json', 'harnessDir', '.claude', 'projection-descriptor'],
    ['aidlc-projection.json', 'managedDirectories', ['../private'], 'projection-descriptor'],
    ['aidlc-manifest.json', 'frameworkVersion', '1.0.0', 'configuration-manifest'],
    ['aidlc-manifest.json', 'mcpMode', 'defaults', 'configuration-manifest'],
    [
      'aidlc-manifest.json',
      'files',
      { '../private': `sha256:${'a'.repeat(64)}` },
      'configuration-manifest',
    ],
    ['harness.json', 'schemaVersion', 2, 'harness-identity'],
    ['harness.json', 'distribution', 'opencode', 'harness-identity'],
    ['harness.json', 'rulesSubdir', 'rules', 'harness-identity'],
    ['harness.json', 'productName', 'another product', 'harness-identity'],
  ])('rejects inconsistent %s %s', async (file, key, value, id) => {
    const f = await fixture();
    await mutateJson(join(f.data, file), (record) => {
      record[key] = value;
    });
    await expectFailed(f, id);
  });

  it('uses the installed aidlc executable path, not the release asset name or dispatcher', async () => {
    const f = await fixture();
    await writeFile(
      f.pinTarget,
      `${join(f.installRoot, 'versions', VERSION, 'aidlc-linux-arm64')}\n`,
    );
    await expectFailed(f, 'pin-target');
    await writeFile(f.pinTarget, `${join(f.root, 'machine', 'bin', 'aidlc')}\n`);
    await expectFailed(f, 'pin-target');
  });

  it('requires the installed binary to exist, be executable, and have a bounded regular-file size', async () => {
    const f = await fixture();
    await chmod(f.executable, 0o600);
    await expectFailed(f, 'installed-executable');
    await chmod(f.executable, 0o700);
    await truncate(f.executable, 256 * 1024 * 1024 + 1);
    await expectFailed(f, 'installed-executable');
    await rm(f.executable);
    await expectFailed(f, 'installed-executable');
  });

  it('requires the canonical current-project registration in the plain upstream pins map', async () => {
    const f = await fixture();
    const path = join(f.installRoot, 'pins.json');
    for (const value of [
      { schemaVersion: 1, pins: { [f.projectDirectory]: VERSION } },
      { [f.projectDirectory]: '1.0.0' },
      { [`${f.projectDirectory}/.`]: VERSION },
      { '/unrelated/project': VERSION },
    ]) {
      await writeFile(path, JSON.stringify(value));
      await expectFailed(f, 'pin-registry');
    }
    await writeFile(
      path,
      JSON.stringify({ [f.projectDirectory]: VERSION, '/unrelated/project': VERSION }),
    );
    expect((await f.inspect()).ok).toBe(true);
  });

  it.each(Object.keys(rows))(
    'requires each representative %s file at its actual projected location',
    async (harness) => {
      const f = await fixture(harness);
      for (const [name, contents] of Object.entries(rows[harness].files)) {
        const path = join(f.projectDirectory, name);
        await rm(path);
        const missing = await f.inspect();
        expect(missing.ok).toBe(false);
        expect(
          missing.checks.filter(
            ({ id, status }) => id.startsWith('representative-') && status === 'failed',
          ),
        ).toHaveLength(1);
        await writeFile(path, contents);
      }
    },
  );

  it('rejects malformed representative JSON and empty text without echoing either', async () => {
    const f = await fixture();
    await writeFile(join(f.projectDirectory, '.codex/hooks.json'), '{"PRIVATE-FILE-CONTENT"');
    await expectFailed(f, 'representative-codex-hooks');
    await writeFile(join(f.projectDirectory, '.codex/config.toml'), '   \n');
    await expectFailed(f, 'representative-codex-config');
  });

  it('accepts Kiro CLI session-start registration without the obsolete hook file', async () => {
    const f = await fixture('kiro');
    await expect(
      readFile(join(f.projectDirectory, '.kiro/hooks/aidlc-session-start.kiro.hook')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.inspect()).ok).toBe(true);
  });

  it.each(
    [undefined, [], [{}], [{ command: '' }], [{ command: '   ' }]].map((hooks) => ({ hooks })),
  )('requires a usable Kiro CLI agentSpawn hook: $hooks', async ({ hooks }) => {
    const f = await fixture('kiro');
    await mutateJson(join(f.projectDirectory, '.kiro/agents/aidlc.json'), (value) => {
      value.hooks.agentSpawn = hooks;
    });
    await expectFailed(f, 'representative-kiro-agent');
  });

  it.each([
    ['version-pin', 'project', '.aidlc-version'],
    ['projection-stamp', 'project', '.codex/tools/data/aidlc-stamp.json'],
    ['representative-codex-skill', 'project', '.agents/skills/aidlc/SKILL.md'],
    ['installed-executable', 'machine', `versions/${VERSION}/aidlc`],
    ['pin-registry', 'machine', 'pins.json'],
  ])('rejects a symlink replacing %s', async (id, space, name) => {
    const f = await fixture();
    const path = join(space === 'project' ? f.projectDirectory : f.installRoot, name);
    const outside = join(f.root, 'outside-file');
    await rename(path, outside);
    await symlink(outside, path);
    await expectFailed(f, id);
  });

  it.each([
    ['.codex/tools', 'projection-stamp'],
    ['.agents', 'representative-codex-skill'],
    ['aidlc/spaces/default', 'memory-directory'],
  ])(
    'rejects an ancestor symlink at %s even if the referenced evidence is valid',
    async (name, id) => {
      const f = await fixture();
      const path = join(f.projectDirectory, name);
      const outside = join(f.root, 'outside-tree');
      await rename(path, outside);
      await symlink(outside, path);
      await expectFailed(f, id);
    },
  );

  it('rejects install-version ancestor links', async () => {
    const f = await fixture();
    const path = join(f.installRoot, 'versions');
    const outside = join(f.root, 'outside-versions');
    await rename(path, outside);
    await symlink(outside, path);
    await expectFailed(f, 'installed-executable');
  });

  it('rejects hard-linked evidence', async () => {
    const f = await fixture();
    await link(join(f.projectDirectory, '.aidlc-version'), join(f.root, 'linked-pin'));
    await expectFailed(f, 'version-pin');
  });

  it.each([
    ['.aidlc-version', 'version-pin'],
    ['.codex/tools/data/harness.json', 'harness-identity'],
  ])(
    'rejects a FIFO at %s without waiting for a writer',
    async (name, id) => {
      const f = await fixture();
      const path = join(f.projectDirectory, name);
      await rm(path);
      await exec('mkfifo', [path]);
      await expectFailed(f, id);
    },
    2000,
  );

  it('rejects a directory in place of a file or a file in place of memory', async () => {
    const f = await fixture();
    await rm(join(f.projectDirectory, '.aidlc-version'));
    await mkdir(join(f.projectDirectory, '.aidlc-version'));
    await expectFailed(f, 'version-pin');
    await rm(f.memory, { recursive: true });
    await writeFile(f.memory, 'PRIVATE-FILE-CONTENT');
    await expectFailed(f, 'memory-directory');
  });

  it.each(['projectDirectory', 'installRoot'])('requires a private %s', async (field) => {
    const f = await fixture();
    await chmod(f[field], 0o755);
    await expectFailed(f, field === 'projectDirectory' ? 'project-root' : 'install-root');
  });

  it('rejects root and root-ancestor symlink aliases rather than canonicalizing them silently', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias-projects');
    await symlink(dirname(f.projectDirectory), alias);
    const result = await inspectNativeInitialization({
      ...f,
      projectDirectory: join(alias, f.harness),
    });
    expect(result.ok).toBe(false);
    expect(checkFor(result, 'project-root').status).toBe('failed');
  });

  it('rejects overlapping machine/project roots and multiple harness engines', async () => {
    const f = await fixture();
    const result = await inspectNativeInitialization({ ...f, installRoot: f.root });
    expect(result.ok).toBe(false);
    expect(checkFor(result, 'root-separation').status).toBe('failed');
    await mkdir(join(f.projectDirectory, '.claude'));
    await expectFailed(f, 'harness-layout');
  });

  it.each([
    { version: '../private' },
    { version: `${VERSION}\n` },
    { harness: 'copilot' },
    { harness: '__proto__' },
  ])('rejects unsupported input %j before reading evidence', async (change) => {
    const f = await fixture();
    const result = await inspectNativeInitialization({ ...f, ...change });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('inputs');
  });

  it.each([null, undefined, []])('sanitizes malformed input %j', async (input) => {
    expect(await inspectNativeInitialization(input)).toEqual({
      schemaVersion: 1,
      ok: false,
      checks: [
        {
          id: 'inputs',
          status: 'failed',
          message: 'Inspection inputs missing, unsafe or inconsistent',
        },
      ],
    });
  });
});
