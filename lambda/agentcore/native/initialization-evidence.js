// G1 filesystem evidence, exercised against the official v2.9.0 package at
// 22f5d1b15a064c9ae80046e5b1761d5877e2f69f, including Kiro CLI agent hooks.
// This reads configuration only; it never loads or executes projected code.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const METADATA_BYTES = 1024 * 1024;
const EXECUTABLE_BYTES = 256 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const HARNESSES = Object.freeze({
  claude: {
    directory: '.claude',
    rules: 'rules',
    files: [
      ['claude-settings', '.claude/settings.json', 'json'],
      ['claude-skill', '.claude/skills/aidlc/SKILL.md', 'text'],
    ],
  },
  kiro: {
    directory: '.kiro',
    rules: 'steering',
    files: [
      ['kiro-agent', '.kiro/agents/aidlc.json', 'json'],
      ['kiro-adapter', '.kiro/hooks/aidlc-kiro-adapter.ts', 'text'],
      ['kiro-instructions', 'AGENTS.md', 'text'],
    ],
  },
  opencode: {
    directory: '.aidlc',
    rules: 'rules',
    files: [
      ['opencode-adapter', '.opencode/plugin/aidlc-opencode-adapter.ts', 'text'],
      ['opencode-config', 'opencode.json', 'json'],
    ],
  },
  codex: {
    directory: '.codex',
    rules: 'aidlc-rules',
    files: [
      ['codex-hooks', '.codex/hooks.json', 'json'],
      ['codex-config', '.codex/config.toml', 'text'],
      ['codex-trust-seed', '.codex/trust-seed.toml', 'text'],
      ['codex-skill', '.agents/skills/aidlc/SKILL.md', 'text'],
    ],
  },
});
const CHECK_IDS = new Set([
  'inputs',
  'project-root',
  'install-root',
  'root-separation',
  'harness-layout',
  'version-pin',
  'pin-target',
  'installed-executable',
  'pin-registry',
  'projection-stamp',
  'projection-descriptor',
  'configuration-manifest',
  'harness-identity',
  'memory-directory',
  ...Object.values(HARNESSES).flatMap(({ files }) => files.map(([id]) => `representative-${id}`)),
]);

// Runtime diagnostics never retain inspector messages, paths or extra fields.
export const nativeInitializationCheckStatuses = (checks) => {
  const statuses = new Map();
  if (Array.isArray(checks)) {
    for (const check of checks.slice(0, CHECK_IDS.size)) {
      if (
        CHECK_IDS.has(check?.id) &&
        ['passed', 'failed'].includes(check.status) &&
        statuses.get(check.id) !== 'failed'
      )
        statuses.set(check.id, check.status);
    }
  }
  return [...statuses].map(([id, status]) => ({ id, status }));
};

const reject = () => {
  throw new Error('Invalid initialization evidence');
};
const assert = (condition) => {
  if (!condition) reject();
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, expression) =>
  typeof value === 'string' && expression.exec(value)?.[0] === value;
const text = (value, max = 4096) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some(
    (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
  );
const safeRelative = (value) =>
  text(value) &&
  !isAbsolute(value) &&
  !value.includes('\\') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const sameNode = (before, after) => before.dev === after.dev && before.ino === after.ino;
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

const privateRoot = async (path) => {
  assert(text(path) && isAbsolute(path) && resolve(path) === path);
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  assert(typeof process.geteuid !== 'function' || stat.uid === process.geteuid());
  // Supervisor inputs must already be canonical. This also rejects ancestor
  // aliases, rather than silently following a project-root symlink elsewhere.
  assert((await realpath(path)) === path);
  return { path, stat };
};

const exactKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MIN = -(1n << 63n);
const BASELINE_REASONS = new Set([
  'baseline-inode-invalid',
  'baseline-metadata-invalid',
  'baseline-directory-unsafe',
  'baseline-owner-mismatch',
  'baseline-root-invalid',
  'baseline-identity-changed',
  'baseline-read-failed',
]);
export const nativeInitializationBaselineReason = (value) =>
  BASELINE_REASONS.has(value) ? value : undefined;
const baselineAssert = (condition, baselineReason) => {
  if (!condition)
    throw Object.assign(new Error('Invalid initialization evidence'), { baselineReason });
};
const unsignedStatIdentity = (value, { inode = false } = {}) => {
  baselineAssert(
    typeof value === 'bigint' && value >= (inode ? INT64_MIN : 0n) && value <= UINT64_MAX,
    inode ? 'baseline-inode-invalid' : 'baseline-metadata-invalid',
  );
  // Node 24 copies libuv's uint64 st_ino into a signed BigInt64Array.
  // Preserve its exact bits; Number coercion would merge adjacent NFS IDs.
  return BigInt.asUintN(64, value).toString();
};
const validUnsignedIdentity = (value) =>
  typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= UINT64_MAX;
const validDirectoryIdentity = (value) =>
  exactKeys(value, ['dev', 'ino', 'uid']) && Object.values(value).every(validUnsignedIdentity);
const sameDirectoryIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const directoryIdentity = async (path) => {
  const stat = await lstat(path, { bigint: true });
  baselineAssert(stat.isDirectory() && !stat.isSymbolicLink(), 'baseline-directory-unsafe');
  baselineAssert(
    typeof process.geteuid !== 'function' || stat.uid === BigInt(process.geteuid()),
    'baseline-owner-mismatch',
  );
  return Object.freeze({
    dev: unsignedStatIdentity(stat.dev),
    ino: unsignedStatIdentity(stat.ino, { inode: true }),
    uid: unsignedStatIdentity(stat.uid),
  });
};
const otherHarnessDirectories = (harness) =>
  Object.values(HARNESSES)
    .map(({ directory }) => directory)
    .filter((directory) => directory !== HARNESSES[harness].directory);

const inspectExistingHarnessDirectories = async (project, harness, baseline) => {
  const known = otherHarnessDirectories(harness);
  const allowed = new Map();
  if (baseline !== undefined) {
    baselineAssert(
      exactKeys(baseline, ['schemaVersion', 'harness', 'project', 'directories']) &&
        baseline.schemaVersion === 1 &&
        baseline.harness === harness &&
        validDirectoryIdentity(baseline.project) &&
        Array.isArray(baseline.directories) &&
        baseline.directories.length <= known.length,
      'baseline-metadata-invalid',
    );
    baselineAssert(
      sameDirectoryIdentity(baseline.project, await directoryIdentity(project.path)),
      'baseline-identity-changed',
    );
    for (const entry of baseline.directories) {
      baselineAssert(
        exactKeys(entry, ['directory', 'identity']) &&
          known.includes(entry.directory) &&
          !allowed.has(entry.directory) &&
          validDirectoryIdentity(entry.identity),
        'baseline-metadata-invalid',
      );
      allowed.set(entry.directory, entry.identity);
    }
  }
  for (const directory of known) {
    let identity;
    try {
      identity = await directoryIdentity(join(project.path, directory));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const expected = allowed.get(directory);
    baselineAssert(
      identity ? expected && sameDirectoryIdentity(identity, expected) : !expected,
      'baseline-identity-changed',
    );
  }
  assert(sameNode(project.stat, (await privateRoot(project.path)).stat));
};

/**
 * Capture only known non-selected harness directories from the verified,
 * quiescent checkout, before any package command. This is supervisor-owned
 * evidence, never an allowlist accepted from invocation JSON or project files.
 */
export const captureNativeInitializationBaseline = async ({ projectDirectory, harness }) => {
  assert(Object.hasOwn(HARNESSES, harness));
  let project;
  try {
    project = await privateRoot(projectDirectory);
  } catch {
    baselineAssert(false, 'baseline-root-invalid');
  }
  const identity = await directoryIdentity(project.path);
  const directories = [];
  for (const directory of otherHarnessDirectories(harness)) {
    try {
      directories.push(
        Object.freeze({
          directory,
          identity: await directoryIdentity(join(project.path, directory)),
        }),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const baseline = Object.freeze({
    schemaVersion: 1,
    harness,
    project: identity,
    directories: Object.freeze(directories),
  });
  await inspectExistingHarnessDirectories(project, harness, baseline);
  return baseline;
};

const directoryChain = async (root, nested = '') => {
  assert(nested === '' || safeRelative(nested));
  const entries = [];
  for (const part of ['', ...nested.split('/').filter(Boolean)]) {
    const path = entries.length ? join(entries.at(-1).path, part) : root.path;
    const stat = await lstat(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    if (!entries.length) assert(sameNode(root.stat, stat) && (stat.mode & 0o077) === 0);
    entries.push({ path, stat });
  }
  return entries;
};

const recheckChain = async (entries) => {
  for (const { path, stat } of entries) {
    const current = await lstat(path);
    assert(current.isDirectory() && !current.isSymbolicLink() && sameNode(stat, current));
  }
};

const regularFile = async (
  root,
  name,
  { limit = METADATA_BYTES, contents = true, executable = false } = {},
) => {
  assert(safeRelative(name));
  const parent = dirname(name);
  const chain = await directoryChain(root, parent === '.' ? '' : parent);
  let handle;
  try {
    handle = await open(
      join(root.path, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    assert(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= limit);
    if (executable) assert((before.mode & 0o111) !== 0);
    const chunks = [];
    if (contents) {
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        assert(bytes <= limit);
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      assert(bytes === before.size);
    }
    const after = await handle.stat();
    assert(
      sameNode(before, after) &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        after.nlink === 1,
    );
    await recheckChain(chain);
    const current = await lstat(join(root.path, name));
    assert(current.isFile() && !current.isSymbolicLink() && sameNode(before, current));
    return contents ? Buffer.concat(chunks) : undefined;
  } finally {
    await handle?.close();
  }
};

const readText = async (root, name, limit) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await regularFile(root, name, { limit }),
  );
const readJson = async (root, name) => {
  const value = JSON.parse(await readText(root, name, METADATA_BYTES));
  assert(record(value));
  return value;
};
const identityMatches = (value, harness, directory) =>
  value.schemaVersion === 1 && value.distribution === harness && value.harnessDir === directory;

const validContributions = (value) =>
  record(value) &&
  Object.entries(value).every(([path, contribution]) => {
    if (!safeRelative(path) || !record(contribution)) return false;
    if (['whole-file', 'managed-block'].includes(contribution.policy)) {
      return matches(contribution.hash, /^sha256:[a-f0-9]{64}$/);
    }
    return (
      // AI-DLC 2.11 records merged OpenCode root settings as json-entries.
      // Like the older map/array policies, each owned entry has a digest.
      ['json-map', 'json-array', 'json-entries'].includes(contribution.policy) &&
      record(contribution.entries) &&
      Object.values(contribution.entries).every((hash) => matches(hash, /^sha256:[a-f0-9]{64}$/))
    );
  });

/**
 * Return {schemaVersion:1, ok, checks:[{id,status:'passed'|'failed',message}]}.
 * IDs/messages are fixed, bounded strings; no paths or file content are returned.
 *
 * The supervisor must supply distinct, private, canonical machine/project roots
 * and quiesce writers for this observation. NOFOLLOW/NONBLOCK, ancestor checks
 * and rechecks reject observed links/changes; portable Node pathname operations
 * are not atomic openat traversal. Modes do not isolate a same-UID agent. This
 * evidence cannot establish execution trust, hook acceptance or human transport.
 * Omitting harnessBaseline preserves strict G1 single-harness isolation. Native
 * execution may pass only a baseline captured before package initialization.
 */
export const inspectNativeInitialization = async (input = {}) => {
  const checks = [];
  const check = async (id, label, inspect) => {
    try {
      const value = await inspect();
      checks.push({ id, status: 'passed', message: `${label} verified` });
      return value;
    } catch {
      checks.push({ id, status: 'failed', message: `${label} missing, unsafe or inconsistent` });
      return undefined;
    }
  };
  const result = () => ({
    schemaVersion: 1,
    ok: checks.every(({ status }) => status === 'passed'),
    checks,
  });
  const args = await check('inputs', 'Inspection inputs', async () => {
    assert(record(input));
    const { projectDirectory, installRoot, version, harness } = input;
    assert(text(version, 255) && matches(version, VERSION) && Object.hasOwn(HARNESSES, harness));
    assert(text(projectDirectory) && text(installRoot));
    return { projectDirectory, installRoot, version, harness };
  });
  if (!args) return result();
  const { projectDirectory, installRoot, version, harness } = args;
  const project = await check('project-root', 'Private canonical project root', () =>
    privateRoot(projectDirectory),
  );
  const machine = await check('install-root', 'Private canonical install root', () =>
    privateRoot(installRoot),
  );
  if (!project || !machine) return result();
  const separate = await check('root-separation', 'Machine and project separation', async () => {
    assert(!within(project.path, machine.path) && !within(machine.path, project.path));
    return true;
  });
  if (!separate) return result();
  const selected = HARNESSES[harness];
  const data = `${selected.directory}/tools/data`;
  const executable = `versions/${version}/aidlc`;

  await check('harness-layout', 'Single harness engine layout', async () => {
    await directoryChain(project, selected.directory);
    await inspectExistingHarnessDirectories(project, harness, input.harnessBaseline);
  });
  await check('version-pin', 'Project version pin', async () => {
    assert((await readText(project, '.aidlc-version', 1024)).trim() === version);
  });
  await check('pin-target', 'Project executable pin target', async () => {
    assert(
      (await readText(project, 'aidlc/.aidlc-sessions/pin-target', 8192)).trim() ===
        join(machine.path, executable),
    );
  });
  await check('installed-executable', 'Installed version executable', () =>
    regularFile(machine, executable, {
      limit: EXECUTABLE_BYTES,
      contents: false,
      executable: true,
    }),
  );
  await check('pin-registry', 'Canonical project pin registration', async () => {
    const pins = await readJson(machine, 'pins.json');
    assert(Object.hasOwn(pins, project.path) && pins[project.path] === version);
    // Never open paths obtained from this registry; unrelated projects do not
    // grant permission to inspect more filesystem trees.
  });
  await check('projection-stamp', 'Projection stamp identity', async () => {
    const stamp = await readJson(project, `${data}/aidlc-stamp.json`);
    assert(
      identityMatches(stamp, harness, selected.directory) && stamp.frameworkVersion === version,
    );
  });
  const projection = await check(
    'projection-descriptor',
    'Projection descriptor identity',
    async () => {
      const value = await readJson(project, `${data}/aidlc-projection.json`);
      assert(
        identityMatches(value, harness, selected.directory) &&
          text(value.productName, 512) &&
          text(value.configNextStep, 2048) &&
          Array.isArray(value.managedDirectories) &&
          value.managedDirectories.includes(selected.directory) &&
          value.managedDirectories.every((path) => safeRelative(path) && !path.includes('/')) &&
          Array.isArray(value.rootIntegrations) &&
          value.rootIntegrations.every(
            (entry) =>
              record(entry) &&
              safeRelative(entry.path) &&
              ['whole-file', 'managed-block', 'json-map', 'json-array'].includes(entry.policy),
          ),
      );
      return value;
    },
  );
  await check('configuration-manifest', 'Installed configuration manifest', async () => {
    const value = await readJson(project, `${data}/aidlc-manifest.json`);
    assert(
      identityMatches(value, harness, selected.directory) &&
        value.frameworkVersion === version &&
        value.mcpMode === 'none' &&
        record(value.files) &&
        Object.keys(value.files).length > 0 &&
        Object.entries(value.files).every(
          ([path, hash]) => safeRelative(path) && matches(hash, /^sha256:[a-f0-9]{64}$/),
        ) &&
        validContributions(value.rootContributions),
    );
  });
  await check('harness-identity', 'Harness configuration identity', async () => {
    const value = await readJson(project, `${data}/harness.json`);
    assert(
      identityMatches(value, harness, selected.directory) &&
        value.rulesSubdir === selected.rules &&
        projection &&
        value.productName === projection.productName &&
        value.configNextStep === projection.configNextStep,
    );
  });
  await check('memory-directory', 'Default memory directory', async () => {
    const chain = await directoryChain(project, 'aidlc/spaces/default/memory');
    await recheckChain(chain);
  });
  for (const [id, path, kind] of selected.files) {
    await check(`representative-${id}`, 'Representative harness file', async () => {
      if (kind === 'json') {
        const value = await readJson(project, path);
        if (id === 'kiro-agent') {
          // Kiro CLI registers session-start in the agent configuration. The
          // current projection does not ship the old session-start .kiro.hook.
          const hooks = value.hooks?.agentSpawn;
          assert(
            Array.isArray(hooks) &&
              hooks.length > 0 &&
              hooks.every(
                (hook) => record(hook) && text(hook.command) && hook.command.trim().length > 0,
              ),
          );
        }
      } else assert((await readText(project, path, METADATA_BYTES)).trim().length > 0);
    });
  }
  return result();
};
