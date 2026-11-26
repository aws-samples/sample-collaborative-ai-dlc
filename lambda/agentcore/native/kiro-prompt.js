import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const SKILL_LIMIT = 256 * 1024;
const PROMPT_LIMIT = 1024 * 1024;
const SLOT = '$ARGUMENTS';
const reject = () => {
  throw new Error('Invalid native Kiro prompt evidence');
};
const requireValid = (condition) => {
  if (!condition) reject();
};
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameMetadata = (a, b) =>
  sameNode(a, b) &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const trustedOwner = (stat) => stat.uid === 0n || stat.uid === BigInt(process.geteuid());

export const kiroPromptHash = (text) =>
  createHash('sha256').update(text.replaceAll('\r\n', '\n').trim()).digest('hex');

const readSkill = async (project) => {
  const file = join(project, '.kiro', 'skills', 'aidlc', 'SKILL.md');
  const parent = dirname(file);
  const root = parse(parent).root;
  const chain = [];
  let path = root;
  for (const part of ['', ...parent.slice(root.length).split('/')]) {
    path = part ? join(path, part) : path;
    const stat = await lstat(path, { bigint: true });
    const withinProject = path === project || path.startsWith(`${project}/`);
    // Only ancestors above the project may be shared sticky temporary directories.
    const stickyParent = !withinProject && (stat.mode & 0o1000n) !== 0n && trustedOwner(stat);
    requireValid(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        trustedOwner(stat) &&
        ((stat.mode & 0o022n) === 0n || stickyParent),
    );
    chain.push({ path, stat, withinProject });
  }
  requireValid((await realpath(project)) === project);
  const before = await lstat(file, { bigint: true });
  requireValid(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      trustedOwner(before) &&
      (before.mode & 0o022n) === 0n &&
      before.size > 0n &&
      before.size <= BigInt(SKILL_LIMIT),
  );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValid(sameMetadata(before, await handle.stat({ bigint: true })));
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    requireValid(bytes === Number(before.size));
    requireValid(sameMetadata(before, await handle.stat({ bigint: true })));
    requireValid(sameMetadata(before, await lstat(file, { bigint: true })));
    for (const entry of chain) {
      const current = await lstat(entry.path, { bigint: true });
      requireValid(
        current.isDirectory() &&
          !current.isSymbolicLink() &&
          sameNode(entry.stat, current) &&
          entry.stat.mode === current.mode &&
          entry.stat.uid === current.uid &&
          entry.stat.gid === current.gid &&
          (!entry.withinProject || sameMetadata(entry.stat, current)),
      );
    }
    requireValid((await realpath(project)) === project);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    requireValid(!text.includes('\0'));
    return text.replaceAll('\r\n', '\n');
  } finally {
    await handle.close();
  }
};

const skillBody = (text) => {
  if (!text.startsWith('---')) return text;
  const lines = text.split('\n');
  requireValid(lines[0] === '---');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  requireValid(end > 1);
  return lines.slice(end + 1).join('\n');
};

export const resolveKiroPromptEvidence = async ({ project, prompt }) => {
  try {
    requireValid(
      typeof project === 'string' &&
        project.length <= 4096 &&
        !project.includes('\0') &&
        isAbsolute(project) &&
        resolve(project) === project &&
        project !== parse(project).root &&
        typeof prompt === 'string' &&
        prompt.trim().length > 0 &&
        !prompt.includes('\0') &&
        Buffer.byteLength(prompt) <= PROMPT_LIMIT,
    );
    if (!prompt.trimStart().startsWith('/')) {
      return { userPromptSha256: kiroPromptHash(prompt), userPromptSource: 'literal' };
    }
    // Only this installed skill expansion has been observed in the pinned CLI.
    requireValid(prompt.startsWith('/aidlc ') && prompt.slice(7).trim().length > 0);
    const body = skillBody(await readSkill(project));
    requireValid(body.trim().length > 0 && body.includes(SLOT));
    const argumentsText = prompt.slice(7);
    const parts = body.split(SLOT);
    const expandedBytes =
      parts.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0) +
      (parts.length - 1) * Buffer.byteLength(argumentsText);
    requireValid(expandedBytes <= PROMPT_LIMIT);
    // join preserves dollar sequences in the arguments; replacement strings do not.
    return {
      userPromptSha256: kiroPromptHash(parts.join(argumentsText)),
      userPromptSource: 'aidlc-skill-expansion',
    };
  } catch {
    reject();
  }
};
