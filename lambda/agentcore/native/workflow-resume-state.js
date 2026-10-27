// AI-DLC 2.11.1 writes the initialized state, then commits intents.json and
// selects the record (aidlc-utility.ts handleIntentCreate; aidlc-lib.ts
// registerIntentRecord). Observe that boundary on the surviving workspace.
// This does not reconcile the workflow or authorize any gate/answer.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const POINTER_BYTES = 257;
const REGISTRY_BYTES = 256 * 1024;
const STATE_BYTES = 1024 * 1024;
const MAX_RECORDS = 256;
const SPACE = /^[a-z][a-z0-9-]{0,254}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sameStat = (a, b) =>
  a !== null &&
  b !== null &&
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
    (key) => a[key] === b[key],
  );
const requireValue = (valid) => {
  if (!valid) throw new Error('native_workflow_resume_unavailable');
};

const pointer = (text, grammar) => {
  const value = text.trim();
  requireValue(grammar.test(value) && text.replace(/\r?\n$/, '') === value);
  return value;
};

const registry = (text) => {
  if (text === null) return [];
  const rows = JSON.parse(text);
  requireValue(Array.isArray(rows) && rows.length <= MAX_RECORDS);
  const names = new Set();
  const ids = new Set();
  for (const row of rows) {
    requireValue(
      row &&
        typeof row === 'object' &&
        typeof row.uuid === 'string' &&
        UUID.test(row.uuid) &&
        ['dirName', 'slug', 'scope'].every(
          (key) => typeof row[key] === 'string' && SEGMENT.test(row[key]),
        ) &&
        ['in-flight', 'complete', 'archived'].includes(row.status) &&
        !names.has(row.dirName) &&
        !ids.has(row.uuid.toLowerCase()),
    );
    names.add(row.dirName);
    ids.add(row.uuid.toLowerCase());
  }
  return rows;
};

// Check the stable schema-8 envelope, not stage completion, gate decisions or
// the graph. A creation stub and a truncated/conflicted state are not proof.
const initializedState = (text, scope) => {
  requireValue(text.startsWith('# AI-DLC State Tracking\n') && !/^(?:<{7}|={7}|>{7})/m.test(text));
  for (const character of text) {
    const code = character.charCodeAt(0);
    requireValue(code === 9 || code === 10 || (code >= 32 && code !== 127));
  }
  const required = [
    'Project Information',
    'Scope Configuration',
    'Workspace State',
    'Execution Plan Summary',
    'Runtime State',
    'Phase Progress',
    'Stage Progress',
    'Current Status',
    'Session Resume Point',
  ];
  const sections = new Map();
  let current;
  const fields = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3);
      requireValue(!sections.has(current));
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
    const match = /^- \*\*([^*]+)\*\*:[ \t]*(.*)$/.exec(line);
    if (match) {
      const [, key, value] = match;
      const existing = fields.get(key) ?? [];
      existing.push({ section: current, value: value.trim() });
      fields.set(key, existing);
    }
  }
  const positions = required.map((name) => [...sections.keys()].indexOf(name));
  requireValue(
    positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
  );
  const field = (name, section) => {
    const found = fields.get(name);
    requireValue(found?.length === 1 && found[0].section === section && found[0].value);
    return found[0].value;
  };
  requireValue(
    field('State Version', 'Project Information') === '8' &&
      field('Scope', 'Project Information') === scope &&
      SEGMENT.test(field('Current Stage', 'Current Status')) &&
      field('Lifecycle Phase', 'Current Status') &&
      field('Status', 'Current Status') &&
      Number.isFinite(Date.parse(field('Last Updated', 'Current Status'))) &&
      field('Next Action', 'Session Resume Point') &&
      field('Pending Artifacts', 'Session Resume Point') &&
      sections
        .get('Stage Progress')
        .some((line) =>
          /^- \[[ x?RS-]\] [a-z0-9][a-z0-9-]*[ \t]+—[ \t]+(?:EXECUTE|SKIP)\b/.test(line),
        ),
  );
};

/**
 * Return created | not_created | unavailable from CURRENT package-owned files.
 * This is eligibility evidence only; concurrent writes can yield unavailable.
 * Consumers must bind it to runtime ownership, confirm the previous writer has
 * stopped, and recheck the surviving files before a recovery model launch.
 * Portable Node path/stat checks detect observed replacement, but are not an
 * openat sandbox against a hostile process running with the same UID.
 * io is a test seam; production uses node:fs/promises. No bytes/paths escape.
 */
export const observeNativeWorkflowResumeState = async ({ project, io = fs } = {}) => {
  try {
    requireValue(
      typeof project === 'string' && isAbsolute(project) && resolve(project) === project,
    );
    const observed = new Map();
    const stat = async (path) => {
      try {
        return await io.lstat(path, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };
    const observe = async (path) => {
      const node = await stat(path);
      observed.set(path, node);
      return node;
    };
    const root = await observe(project);
    requireValue(
      root?.isDirectory() &&
        !root.isSymbolicLink() &&
        (root.mode & 0o077n) === 0n &&
        (typeof process.geteuid !== 'function' || root.uid === BigInt(process.geteuid())) &&
        (await io.realpath(project)) === project,
    );
    const directory = async (path, optional = false) => {
      const node = await observe(path);
      if (optional && node === null) return false;
      requireValue(node?.isDirectory() && !node.isSymbolicLink() && node.dev === root.dev);
      return true;
    };
    const unchanged = async () => {
      for (const [path, before] of observed) {
        const now = await stat(path);
        requireValue(before === null ? now === null : sameStat(before, now));
      }
      requireValue((await io.realpath(project)) === project);
    };
    const read = async (path, limit, optional = false) => {
      const before = await observe(path);
      if (optional && before === null) return null;
      requireValue(
        before?.isFile() &&
          !before.isSymbolicLink() &&
          before.nlink === 1n &&
          before.dev === root.dev &&
          before.size <= BigInt(limit),
      );
      await unchanged();
      const file = await io.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        requireValue(sameStat(before, await file.stat({ bigint: true })));
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          requireValue(bytesRead > 0);
          offset += bytesRead;
        }
        requireValue(sameStat(before, await file.stat({ bigint: true })));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
      } finally {
        await file.close();
      }
    };
    const roof = join(project, 'aidlc');
    await directory(roof);
    const space = pointer(await read(join(roof, 'active-space'), POINTER_BYTES), SPACE);
    await directory(join(roof, 'spaces'));
    const spaceRoot = join(roof, 'spaces', space);
    await directory(spaceRoot);
    const intents = join(spaceRoot, 'intents');
    let result = 'not_created';
    if (await directory(intents, true)) {
      const selected = await read(join(intents, 'active-intent'), POINTER_BYTES, true);
      const rows = registry(await read(join(intents, 'intents.json'), REGISTRY_BYTES, true));
      if (selected === null) {
        requireValue(rows.length === 0);
        // One bounded directory level distinguishes normal intake metadata
        // from an orphan/partially-created record. Never descend into records.
        const entries = await io.opendir(intents);
        try {
          let count = 0;
          for (let entry; (entry = await entries.read()) !== null;) {
            requireValue(++count <= MAX_RECORDS);
            requireValue(['.aidlc-engine', 'intents.json'].includes(entry.name));
            if (entry.name === '.aidlc-engine') await directory(join(intents, entry.name));
          }
        } finally {
          await entries.close();
        }
      } else {
        const name = pointer(selected, SEGMENT);
        const row = rows.find((candidate) => candidate.dirName === name);
        requireValue(row);
        const record = join(intents, name);
        await directory(record);
        initializedState(await read(join(record, 'aidlc-state.md'), STATE_BYTES), row.scope);
        result = 'created';
      }
    }
    await unchanged();
    return result;
  } catch {
    return 'unavailable';
  }
};
