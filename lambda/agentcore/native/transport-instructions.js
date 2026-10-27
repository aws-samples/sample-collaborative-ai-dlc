import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';

const INSTRUCTION_BYTES = 64 * 1024;
const CONFIG_BYTES = 256 * 1024;
const INVALID = 'native_execution_transport_invalid';
const CONFLICT = 'native_execution_transport_conflict';
const fail = (code = INVALID) => {
  throw Object.assign(new Error(code), { code });
};
const requireValid = (value) => {
  if (!value) fail();
};
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !value.includes('\0') &&
  Buffer.byteLength(value) <= max;
const canonicalPath = (value) =>
  text(value, 4096) && isAbsolute(value) && resolve(value) === value && value !== parse(value).root;
const contains = (parent, child) => child === parent || child.startsWith(`${parent}/`);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameMetadata = (a, b) =>
  sameNode(a, b) &&
  ['mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
const owner = (stat) => stat.uid === BigInt(process.geteuid());
const trustedOwner = (stat) => stat.uid === 0n || owner(stat);

// The writer already owns home. Check the whole path again here before creating
// context that a harness will load; never follow a replaced directory or file.
const privateContext = async (home) => {
  const chain = [];
  const root = parse(home).root;
  let current = root;
  for (const part of ['', ...home.slice(root.length).split('/')]) {
    current = part ? join(current, part) : current;
    const stat = await lstat(current, { bigint: true });
    const privatePath = current === home;
    requireValid(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        trustedOwner(stat) &&
        (privatePath
          ? owner(stat) && (stat.mode & 0o077n) === 0n
          : (stat.mode & 0o022n) === 0n || (stat.mode & 0o1000n) !== 0n),
    );
    chain.push({ path: current, stat });
  }
  const check = async () => {
    for (const entry of chain) {
      const stat = await lstat(entry.path, { bigint: true });
      requireValid(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          sameNode(entry.stat, stat) &&
          entry.stat.mode === stat.mode &&
          entry.stat.uid === stat.uid &&
          entry.stat.gid === stat.gid,
      );
    }
    requireValid((await realpath(chain.at(-1).path)) === chain.at(-1).path);
  };
  await check();
  const directory = async (name) => {
    await check();
    const path = join(chain.at(-1).path, name);
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(path, { bigint: true });
    requireValid(
      stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o077n) === 0n,
    );
    chain.push({ path, stat });
    await check();
    return path;
  };
  const absent = async (name) => {
    await check();
    try {
      await lstat(join(chain.at(-1).path, name));
      fail(CONFLICT);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await check();
  };
  const file = async (name, contents) => {
    await check();
    const path = join(chain.at(-1).path, name);
    let created;
    try {
      created = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await check();
      const stat = await created.stat({ bigint: true });
      requireValid(stat.isFile() && stat.nlink === 1n && owner(stat));
      await created.writeFile(contents, 'utf8');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await created?.close();
    }
    await check();
    const before = await lstat(path, { bigint: true });
    requireValid(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        owner(before) &&
        (before.mode & 0o077n) === 0n &&
        before.size > 0n &&
        before.size <= BigInt(INSTRUCTION_BYTES),
    );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      requireValid(sameMetadata(before, await handle.stat({ bigint: true })));
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      requireValid(
        offset === Number(before.size) &&
          sameMetadata(before, await handle.stat({ bigint: true })) &&
          sameMetadata(before, await lstat(path, { bigint: true })),
      );
      await check();
      if (!bytes.subarray(0, offset).equals(Buffer.from(contents))) fail(CONFLICT);
      return path;
    } finally {
      await handle.close();
    }
  };
  return { directory, absent, file };
};

/**
 * Add stable platform guidance outside the actual AI-DLC user entry.
 * Call for every turn with the same instructions and private writer home.
 * Files are exclusively created, then checked rather than overwritten on reuse.
 */
export const prepareNativeTransportInstructions = async (options) => {
  try {
    requireValid(record(options));
    const { harness, project, home, instructions, env = {} } = options;
    requireValid(
      ['claude', 'codex', 'opencode', 'kiro'].includes(harness) &&
        canonicalPath(project) &&
        canonicalPath(home) &&
        !contains(project, home) &&
        !contains(home, project) &&
        text(instructions, INSTRUCTION_BYTES) &&
        record(env),
    );
    if (harness === 'claude')
      return { env: { ...env }, invocation: { systemPrompt: instructions } };
    // The pinned CLI supports global agents and ACP --agent, but authenticated
    // evidence for the package's resources on that path is still missing. Do
    // not replace its agent or silently omit the transport instructions.
    if (harness === 'kiro') fail('native_execution_transport_kiro_unqualified');

    let config;
    if (harness === 'opencode') {
      requireValid(
        env.OPENCODE_CONFIG_CONTENT === undefined ||
          text(env.OPENCODE_CONFIG_CONTENT, CONFIG_BYTES),
      );
      config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
      requireValid(
        record(config) &&
          (config.instructions === undefined ||
            (Array.isArray(config.instructions) &&
              config.instructions.every((value) => text(value, 4096)))),
      );
    }
    const context = await privateContext(home);
    if (harness === 'codex') {
      const codexHome = join(home, '.codex');
      requireValid(env.CODEX_HOME === undefined || env.CODEX_HOME === codexHome);
      await context.directory('.codex');
      // An override would take precedence over the transport file.
      await context.absent('AGENTS.override.md');
      await context.file('AGENTS.md', instructions);
      return { env: { ...env, CODEX_HOME: codexHome }, invocation: {} };
    }
    await context.directory('.native-transport');
    const path = await context.file('instructions.md', instructions);
    const merged = JSON.stringify({
      ...config,
      instructions: [...new Set([...(config.instructions ?? []), path])],
    });
    requireValid(Buffer.byteLength(merged) <= CONFIG_BYTES);
    return {
      env: { ...env, OPENCODE_CONFIG_CONTENT: merged },
      invocation: {},
    };
  } catch (error) {
    if ([INVALID, CONFLICT, 'native_execution_transport_kiro_unqualified'].includes(error?.code))
      throw error;
    fail();
  }
};
