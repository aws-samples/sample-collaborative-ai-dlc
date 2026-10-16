// Filesystem v2 adds only OpenCode's project dependency executable aliases.
// Targets are references into the independently verified regular-file inventory,
// never authority to read another path or reconstruct a missing dependency.
import { canonicalNativePath, nativeCredentialPath } from './native-project-files.js';

const TREE = '.opencode/node_modules';
const BIN = `${TREE}/.bin/`;
const invalid = () => {
  throw Object.assign(new Error('Invalid recovery dependency bin link'), {
    code: 'NATIVE_RECOVERY_BIN_LINK_INVALID',
  });
};
const allowedPath = (path, depth, bytes) =>
  canonicalNativePath(path) &&
  Buffer.byteLength(path) <= bytes &&
  Buffer.from(path).toString('utf8') === path &&
  path.split('/').length <= depth &&
  path.split('/').every((part) => Buffer.byteLength(part) <= 255) &&
  !nativeCredentialPath(path) &&
  !path.split('/').some((part) => ['.native-control', '.native-homes'].includes(part));

const resolveBinLink = (harness, link, depth, bytes) => {
  if (
    harness !== 'opencode' ||
    link?.scope !== 'project' ||
    !allowedPath(link.path, depth, bytes) ||
    !link.path.startsWith(BIN) ||
    link.path.slice(BIN.length).includes('/') ||
    typeof link.target !== 'string' ||
    !link.target.length ||
    link.target.split('/').length > depth ||
    Buffer.byteLength(link.target) > bytes ||
    Buffer.from(link.target).toString('utf8') !== link.target ||
    link.target.includes('\\') ||
    [...link.target].some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    ) ||
    link.target.startsWith('/') ||
    /^[A-Za-z]:/.test(link.target)
  )
    invalid();
  const parts = [TREE, '.bin'];
  const parents = [];
  for (const part of link.target.split('/')) {
    parents.push(parts.join('/'));
    if (!part || Buffer.byteLength(part) > 255) invalid();
    if (part === '..') {
      if (parts.length === 1) invalid(); // Even an intermediate escape is forbidden.
      parts.pop();
    } else if (part !== '.') parts.push(part);
  }
  const target = parts.join('/');
  if (!target.startsWith(`${TREE}/`) || !allowedPath(target, depth, bytes)) invalid();
  return { target, parents };
};

export const nativeRecoveryBinLinkTarget = (harness, link, depth = 64, bytes = 2048) =>
  resolveBinLink(harness, link, depth, bytes).target;

export const nativeRecoveryBinLinks = (
  metadata,
  files,
  { entries = 40_000, depth = 64, pathBytes = 2048, totalBytes = 256 * 1024 * 1024 } = {},
) => {
  if (metadata.schemaVersion === 1) {
    if (Object.hasOwn(metadata, 'binLinks')) invalid();
    return [];
  }
  if (
    metadata.schemaVersion !== 2 ||
    metadata.harness !== 'opencode' ||
    !Array.isArray(metadata.binLinks) ||
    !metadata.binLinks.length ||
    metadata.binLinks.length + metadata.directories.length + files.length > entries ||
    Object.keys(metadata.binLinks).length !== metadata.binLinks.length
  )
    invalid();
  const regular = new Map(files.map((entry) => [`${entry.scope}:${entry.path}`, entry]));
  const directories = new Set(metadata.directories.map((entry) => `${entry.scope}:${entry.path}`));
  const aliases = new Set();
  let bytes = files.reduce((total, file) => total + file.bytes, 0);
  const plan = metadata.binLinks.map((link) => {
    const descriptors = Object.getOwnPropertyDescriptors(link ?? {});
    const fields = ['scope', 'path', 'target', 'mode', 'mtimeNs'];
    if (
      link === null ||
      typeof link !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(link)) ||
      Reflect.ownKeys(descriptors).length !== fields.length ||
      fields.some(
        (key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'),
      ) ||
      link.mode !== 0o777 ||
      typeof link.mtimeNs !== 'string' ||
      !/^(?:0|[1-9]\d{0,18})$/.test(link.mtimeNs) ||
      BigInt(link.mtimeNs) > (1n << 63n) - 1n
    )
      invalid();
    const { target, parents } = resolveBinLink(metadata.harness, link, depth, pathBytes);
    const key = `project:${link.path}`;
    if (aliases.has(key) || regular.has(key) || directories.has(key)) invalid();
    aliases.add(key);
    bytes += Buffer.byteLength(link.target);
    if (bytes > totalBytes) invalid();
    return { link, target, parents };
  });
  for (const { link, target, parents } of plan) {
    if (!regular.has(`project:${target}`) || aliases.has(`project:${target}`)) invalid();
    for (const parent of parents) {
      const key = `project:${parent}`;
      if (!directories.has(key) || regular.has(key) || aliases.has(key)) invalid();
    }
    for (const path of [link.path, target]) {
      const parts = path.split('/');
      for (let length = 0; length < parts.length; length++) {
        const key = `project:${parts.slice(0, length).join('/')}`;
        if (!directories.has(key) || regular.has(key) || aliases.has(key)) invalid();
      }
    }
  }
  // No alias can be a parent of any inventory entry, even an unrelated one.
  for (const entry of [...files, ...metadata.directories]) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length++)
      if (aliases.has(`${entry.scope}:${parts.slice(0, length).join('/')}`)) invalid();
  }
  return plan;
};
