// Dependency aliases reference an independently captured, closed project
// inventory. This planner never reads/follows a filesystem path.
import {
  canonicalNativePath,
  nativeCredentialPath,
  nativeFileExclusion,
} from './native-project-files.js';

export const NATIVE_DEPENDENCY_POLICY = 'node-dependencies-v1';
export const NATIVE_DEPENDENCY_LINK_LIMITS = Object.freeze({ links: 1024, chain: 16 });
const invalid = () => {
  throw Object.assign(new Error('Invalid native dependency link'), {
    code: 'NATIVE_RECOVERY_BIN_LINK_INVALID',
  });
};
const publicPath = (path) =>
  canonicalNativePath(path) &&
  !nativeCredentialPath(path) &&
  path
    .split('/')
    .every((_, index, parts) => !nativeFileExclusion(parts.slice(0, index + 1).join('/')));
export const nativeDependencyLinkPath = (path) => {
  if (!publicPath(path)) return false;
  const parts = path.split('/');
  const index = parts.indexOf('node_modules');
  return index >= 0 && index < parts.length - 1;
};
export const nativeDependencyLinkSyntax = (link, { depth = 64, pathBytes = 2048 } = {}) => {
  const descriptors = Object.getOwnPropertyDescriptors(link ?? {});
  const keys = ['scope', 'path', 'target', 'mode', 'mtimeNs'];
  if (
    !link ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(link)) ||
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))
  )
    invalid();
  if (
    link.scope !== 'project' ||
    !nativeDependencyLinkPath(link.path) ||
    link.mode !== 0o777 ||
    typeof link.mtimeNs !== 'string' ||
    !/^(?:0|[1-9]\d{0,18})$/.test(link.mtimeNs) ||
    BigInt(link.mtimeNs) > (1n << 63n) - 1n ||
    typeof link.target !== 'string' ||
    !link.target ||
    link.target.startsWith('/') ||
    /^[A-Za-z]:/.test(link.target) ||
    link.target.includes('\\') ||
    [...link.target].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)
  )
    invalid();
  for (const text of [link.path, link.target])
    if (
      Buffer.byteLength(text) > pathBytes ||
      Buffer.from(text).toString('utf8') !== text ||
      text.split('/').length > depth ||
      text.split('/').some((part) => !part || Buffer.byteLength(part) > 255)
    )
      invalid();
};

const resolveTarget = (link, aliases, regular, directories, limits) => {
  const parts = link.path.split('/').slice(0, -1);
  const pending = link.target.split('/');
  const seen = new Set([link.path]);
  while (pending.length) {
    if (!directories.has(parts.join('/'))) invalid();
    const part = pending.shift();
    if (part === '.') continue;
    if (part === '..') {
      if (!parts.length) invalid();
      parts.pop();
      continue;
    }
    parts.push(part);
    const path = parts.join('/');
    if (
      !publicPath(path) ||
      parts.length > limits.depth ||
      Buffer.byteLength(path) > limits.pathBytes
    )
      invalid();
    const alias = aliases.get(path);
    if (alias) {
      if (seen.has(path) || seen.size >= NATIVE_DEPENDENCY_LINK_LIMITS.chain) invalid();
      seen.add(path);
      parts.pop();
      pending.unshift(...alias.target.split('/'));
      if (pending.length > limits.depth * NATIVE_DEPENDENCY_LINK_LIMITS.chain) invalid();
    } else if (!regular.has(path) && !directories.has(path)) invalid();
  }
  const target = parts.join('/');
  if (!target || !publicPath(target) || (!regular.has(target) && !directories.has(target)))
    invalid();
  return target;
};

const rejectDirectoryCycles = (plan, directories) => {
  const edges = plan.map(({ target }) =>
    directories.has(target)
      ? plan.flatMap(({ link }, index) => (link.path.startsWith(`${target}/`) ? [index] : []))
      : [],
  );
  const active = new Set();
  const lengths = new Map();
  const visit = (index) => {
    if (lengths.has(index)) return lengths.get(index);
    if (active.has(index) || active.size >= NATIVE_DEPENDENCY_LINK_LIMITS.chain) invalid();
    active.add(index);
    const length = 1 + edges[index].reduce((max, next) => Math.max(max, visit(next)), 0);
    active.delete(index);
    if (length > NATIVE_DEPENDENCY_LINK_LIMITS.chain) invalid();
    // Retain the suffix length so a previously visited subtree still counts
    // toward every incoming path's bound, independent of inventory order.
    lengths.set(index, length);
    return length;
  };
  for (let index = 0; index < plan.length; index++) visit(index);
};

export const nativeDependencyLinks = (metadata, files, bounds = {}) => {
  const limits = {
    entries: 40_000,
    depth: 64,
    pathBytes: 2048,
    totalBytes: 256 * 1024 * 1024,
    ...bounds,
  };
  const links = metadata.dependencyLinks;
  if (
    metadata.filesystemPolicy !== NATIVE_DEPENDENCY_POLICY ||
    !Array.isArray(links) ||
    links.length > NATIVE_DEPENDENCY_LINK_LIMITS.links ||
    Object.keys(links).length !== links.length ||
    links.length + metadata.directories.length + files.length > limits.entries
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(links);
  if (
    Reflect.ownKeys(descriptors).length !== links.length + 1 ||
    Array.from({ length: links.length }, (_, index) => descriptors[index]).some(
      (entry) => !entry?.enumerable || !Object.hasOwn(entry, 'value'),
    )
  )
    invalid();
  const regular = new Map(files.filter((f) => f.scope === 'project').map((f) => [f.path, f]));
  const directories = new Set(
    metadata.directories.filter((d) => d.scope === 'project').map((d) => d.path),
  );
  // Capture rejects dependency hardlinks even when no symlink references them.
  // Enforce the same contract before admitting or restoring a stored inventory.
  if (
    metadata.hardlinks.some(
      (group) => group.scope === 'project' && group.paths.some(nativeDependencyLinkPath),
    )
  )
    invalid();
  const aliases = new Map();
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  for (const link of links) {
    nativeDependencyLinkSyntax(link, limits);
    if (aliases.has(link.path) || regular.has(link.path) || directories.has(link.path)) invalid();
    aliases.set(link.path, link);
    bytes += Buffer.byteLength(link.target);
    if (bytes > limits.totalBytes) invalid();
  }
  // All real entries and alias parents must have independently captured real
  // directories. Never materialize children underneath an alias.
  for (const path of [...regular.keys(), ...directories, ...aliases.keys()]) {
    const parts = path.split('/');
    for (let n = 0; n < parts.length; n++) {
      const parent = parts.slice(0, n).join('/');
      if (!directories.has(parent) || aliases.has(parent) || regular.has(parent)) invalid();
    }
  }
  const plan = links.map((link) => ({
    link,
    target: resolveTarget(link, aliases, regular, directories, limits),
  }));
  for (const { target } of plan)
    if (
      metadata.hardlinks.some(
        (group) =>
          group.scope === 'project' &&
          group.paths.some((path) => path === target || path.startsWith(`${target}/`)),
      )
    )
      invalid();
  rejectDirectoryCycles(plan, directories);
  return plan;
};
