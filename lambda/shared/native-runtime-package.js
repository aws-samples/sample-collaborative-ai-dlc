// Offline verification shared by package intake and the operator CLI. This
// validates bytes and projection layout; it never runs release code, installs
// hooks, changes a workspace, or grants native execution qualification.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { canonicalJson } from './workflow-checkpoint.js';
import { verifyNativeReleaseManifest } from './native-release-manifest.js';

export const NATIVE_HARNESSES = Object.freeze(['claude', 'codex', 'kiro', 'opencode']);
export const NATIVE_PACKAGE_LIMITS = Object.freeze({
  metadataBytes: 1024 * 1024,
  assetBytes: 256 * 1024 * 1024,
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  decodedBytes: 288 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 20_000,
});

export class NativePackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativePackageError';
    this.code = 'native_package_invalid';
  }
}

const reject = (message) => {
  throw new NativePackageError(message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const containsControl = (value) =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });

const safePath = (value) => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.split('/').length > 64 ||
    containsControl(value) ||
    /[\\:]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    reject('Package contains an unsafe path');
  return value;
};

const metadataJson = (bytes) => {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    return reject('Package projection metadata is invalid JSON');
  }
};

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validateLegacyHashes = (hashes, harness) => {
  if (
    !Array.isArray(hashes) ||
    hashes.length === 0 ||
    hashes.some(
      (hash) =>
        typeof hash !== 'string' || hash.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(hash),
    ) ||
    new Set(hashes).size !== hashes.length
  ) {
    reject(`Package legacy signatures are invalid for ${harness}`);
  }
};

const validateProjection = ({ harness, version, metadata, files, directories }) => {
  const root = `runtime/${harness}/`;
  const candidates = [...metadata.keys()].filter(
    (name) => name.startsWith(root) && name.endsWith('/tools/data/aidlc-stamp.json'),
  );
  if (candidates.length !== 1) reject(`Package must contain one projection stamp for ${harness}`);
  const stampPath = candidates[0];
  const relative = stampPath.slice(root.length).split('/');
  if (relative.length !== 4) reject(`Package projection stamp is misplaced for ${harness}`);
  const harnessDir = relative[0];
  const descriptorPath = `${root}${harnessDir}/tools/data/aidlc-projection.json`;
  if (!metadata.has(descriptorPath))
    reject(`Package is missing the projection descriptor for ${harness}`);
  const stamp = metadataJson(metadata.get(stampPath));
  const descriptor = metadataJson(metadata.get(descriptorPath));
  if (
    stamp.schemaVersion !== 1 ||
    descriptor.schemaVersion !== 1 ||
    stamp.distribution !== harness ||
    descriptor.distribution !== harness ||
    stamp.frameworkVersion !== version ||
    stamp.harnessDir !== harnessDir ||
    descriptor.harnessDir !== harnessDir ||
    typeof descriptor.productName !== 'string' ||
    !descriptor.productName.trim() ||
    typeof descriptor.configNextStep !== 'string' ||
    !descriptor.configNextStep.trim() ||
    !Array.isArray(descriptor.managedDirectories) ||
    !Array.isArray(descriptor.rootIntegrations)
  )
    reject(`Package projection identity is inconsistent for ${harness}`);

  const declared = new Set();
  const declaredParents = new Set();
  const declare = (name) => {
    safePath(name);
    const segments = name.split('/');
    const parents = segments.slice(1).map((_part, index) => segments.slice(0, index + 1).join('/'));
    if (
      declared.has(name) ||
      declaredParents.has(name) ||
      parents.some((parent) => declared.has(parent))
    ) {
      reject(`Package projection paths overlap for ${harness}`);
    }
    declared.add(name);
    for (const parent of parents) declaredParents.add(parent);
  };
  const managed = new Set(descriptor.managedDirectories);
  for (const directory of descriptor.managedDirectories) {
    declare(directory);
    if (directory.includes('/') || !directories.has(`${root}${directory}`)) {
      reject(`Package managed directory is missing for ${harness}`);
    }
  }
  if (!managed.has(harnessDir)) {
    reject(`Package does not manage its harness directory for ${harness}`);
  }
  const managedSignatures = descriptor.legacyManagedFileHashes;
  if (managedSignatures !== undefined) {
    if (!record(managedSignatures) || Object.keys(managedSignatures).length === 0) {
      reject(`Package legacy managed-file signatures are invalid for ${harness}`);
    }
    for (const [file, hashes] of Object.entries(managedSignatures)) {
      safePath(file);
      if (!managed.has(file.split('/')[0]) || !files.has(`${root}${file}`)) {
        reject(
          `Package legacy managed file is missing or outside managed directories for ${harness}`,
        );
      }
      validateLegacyHashes(hashes, harness);
    }
  }
  const policies = new Set(['managed-block', 'json-map', 'json-array', 'whole-file']);
  for (const integration of descriptor.rootIntegrations) {
    if (!integration || !policies.has(integration.policy)) {
      reject(`Package root integration policy is unsupported for ${harness}`);
    }
    declare(integration.path);
    if (
      (integration.optional !== undefined && typeof integration.optional !== 'boolean') ||
      (integration.policy === 'managed-block' &&
        (typeof integration.marker !== 'string' ||
          containsControl(integration.marker) ||
          !/^[a-z0-9-]+$/.test(integration.marker))) ||
      (['json-map', 'json-array'].includes(integration.policy) &&
        (typeof integration.jsonKey !== 'string' || !integration.jsonKey.trim())) ||
      directories.has(`${root}${integration.path}`) ||
      (!integration.optional && !files.has(`${root}${integration.path}`))
    )
      reject(`Package root integration is invalid for ${harness}`);

    // Upstream skips absent optional integrations. Their migration metadata is
    // only used when the integration actually ships in this projection.
    if (integration.optional && !files.has(`${root}${integration.path}`)) continue;
    const legacy = integration.legacySignatures;
    if (legacy === undefined) continue;
    if (
      !record(legacy) ||
      Object.keys(legacy).length === 0 ||
      Object.keys(legacy).some((key) => key !== 'wholeFileHashes' && key !== 'jsonEntryHashes')
    ) {
      reject(`Package root integration legacy signatures are invalid for ${harness}`);
    }
    if (legacy.wholeFileHashes !== undefined) {
      if (!['managed-block', 'whole-file'].includes(integration.policy)) {
        reject(`Package root integration cannot use legacy whole-file signatures for ${harness}`);
      }
      validateLegacyHashes(legacy.wholeFileHashes, harness);
    }
    if (legacy.jsonEntryHashes !== undefined) {
      if (
        integration.policy !== 'json-map' ||
        !record(legacy.jsonEntryHashes) ||
        Object.keys(legacy.jsonEntryHashes).length === 0
      ) {
        reject(`Package root integration legacy JSON-entry signatures are invalid for ${harness}`);
      }
      for (const [entry, hashes] of Object.entries(legacy.jsonEntryHashes)) {
        if (!entry)
          reject(`Package root integration has an empty legacy JSON entry for ${harness}`);
        validateLegacyHashes(hashes, harness);
      }
    }
  }
  // Include directories, since an empty unclassified directory can still
  // invalidate the native installer projection.
  for (const name of [...files, ...directories]) {
    if (!name.startsWith(root)) continue;
    const local = name.slice(root.length);
    if (
      !declared.has(local) &&
      !managed.has(local.split('/')[0]) &&
      !(directories.has(name) && declaredParents.has(local))
    ) {
      reject(`Package has unclassified projection content for ${harness}`);
    }
  }
  return { harness, harnessDir, stampSha256: sha256(metadata.get(stampPath)) };
};

// tar-stream accepts another archive after a zero header; upstream stops at
// the first one. Check physical framing before forwarding bytes to the parser,
// retaining one header and bounded entry offsets, never the expanded archive.
const createTarFraming = (bounds) => {
  const header = Buffer.alloc(512);
  const zeroHeader = Buffer.alloc(512);
  const entrySizes = new Map();
  let offset = 0;
  let headerBytes = 0;
  let payloadBytes = 0;
  let terminationBytes = 0;

  const readSize = () => {
    const field = header.subarray(124, 136);
    let size = 0;
    if (field[0] === 0x80) {
      for (const byte of field.subarray(1)) {
        size = size * 256 + byte;
        if (!Number.isSafeInteger(size)) reject('Package tar entry size is invalid');
      }
    } else {
      const terminator = field.indexOf(0);
      const text = field.toString('ascii', 0, terminator < 0 ? field.length : terminator).trim();
      if (text && !/^[0-7]+$/.test(text)) reject('Package tar entry size is invalid');
      size = text ? Number.parseInt(text, 8) : 0;
    }
    if (!Number.isSafeInteger(size) || size > bounds.decodedBytes) {
      reject('Package archive exceeds its decoded size limit');
    }
    return size;
  };

  return {
    push(chunk) {
      let cursor = 0;
      while (cursor < chunk.length) {
        if (terminationBytes) {
          if (chunk.subarray(cursor).some((byte) => byte !== 0)) {
            reject('Package archive contains non-padding data after tar termination');
          }
          terminationBytes += chunk.length - cursor;
          return;
        }
        if (payloadBytes) {
          const count = Math.min(payloadBytes, chunk.length - cursor);
          payloadBytes -= count;
          cursor += count;
          offset += count;
          continue;
        }
        const count = Math.min(512 - headerBytes, chunk.length - cursor);
        chunk.copy(header, headerBytes, cursor, cursor + count);
        headerBytes += count;
        cursor += count;
        offset += count;
        if (headerBytes !== 512) continue;
        headerBytes = 0;
        if (header.equals(zeroHeader)) {
          terminationBytes = 512;
          continue;
        }
        const size = readSize();
        // PAX/GNU metadata retains its physical framing. A PAX size override
        // must agree with the file header, or the two readers could disagree
        // about which zero blocks are payload and which terminate the tar.
        if ([0, 48, 53].includes(header[156])) {
          if (entrySizes.size >= bounds.entries) reject('Package archive has too many entries');
          entrySizes.set(offset, size);
        }
        payloadBytes = Math.ceil(size / 512) * 512;
      }
    },
    acceptEntry(entryHeader) {
      if (entrySizes.get(entryHeader.byteOffset) !== entryHeader.size) {
        reject('Package archive entry size disagrees with its tar header');
      }
      entrySizes.delete(entryHeader.byteOffset);
    },
    finish() {
      if (headerBytes || payloadBytes || terminationBytes < 1024 || terminationBytes % 512) {
        reject('Package archive has missing or truncated tar termination');
      }
    },
    assertConsumed() {
      if (entrySizes.size) reject('Package archive contains unparsed tar headers');
    },
  };
};

export const inspectNativeRuntimeArchive = async (archive, { version, limits = {} } = {}) => {
  const bounds = { ...NATIVE_PACKAGE_LIMITS, ...limits };
  for (const bound of Object.values(bounds)) {
    if (!Number.isSafeInteger(bound) || bound < 1)
      reject('Package limits must be positive integers');
  }
  if (!Buffer.isBuffer(archive) || archive.length > bounds.compressedBytes) {
    reject('Package runtime archive exceeds the compressed size limit');
  }
  const extract = tar.extract();
  const framing = createTarFraming(bounds);
  const metadata = new Map();
  const files = new Set();
  const directories = new Set();
  const addDirectory = (name) => {
    if (!directories.has(name) && files.size + directories.size >= bounds.entries) {
      reject('Package archive has too many entries');
    }
    directories.add(name);
  };
  const explicitPaths = new Set();
  let expandedBytes = 0;
  let decodedBytes = 0;
  let entryCount = 0;
  extract.on('entry', (header, stream, next) => {
    stream.on('error', (error) => extract.destroy(error));
    void (async () => {
      if (++entryCount > bounds.entries) reject('Package archive has too many entries');
      if (header.type !== 'file' && header.type !== 'directory') {
        reject('Package archive contains a link or special file');
      }
      framing.acceptEntry(header);
      const name = safePath(
        header.type === 'directory' ? header.name.replace(/\/$/, '') : header.name,
      );
      const segments = name.split('/');
      if (!['runtime', 'plugins'].includes(segments[0]))
        reject('Package archive has an unknown root');
      if (explicitPaths.has(name)) reject('Package archive contains duplicate paths');
      explicitPaths.add(name);
      for (let depth = 1; depth < segments.length; depth += 1) {
        const parent = segments.slice(0, depth).join('/');
        if (files.has(parent)) reject('Package archive file shadows a directory');
        addDirectory(parent);
      }
      if (
        !Number.isSafeInteger(header.size) ||
        header.size < 0 ||
        header.size > bounds.entryBytes
      ) {
        reject('Package archive entry exceeds its size limit');
      }
      if (expandedBytes + header.size > bounds.expandedBytes)
        reject('Package archive exceeds its expanded size limit');
      if (header.type === 'directory') {
        if (header.size !== 0 || files.has(name)) reject('Package archive directory is invalid');
        addDirectory(name);
      } else {
        if (directories.has(name) || segments.length < 3)
          reject('Package archive file shadows a directory');
        if (files.size + directories.size >= bounds.entries) {
          reject('Package archive has too many entries');
        }
        files.add(name);
      }
      const keep = /\/tools\/data\/aidlc-(stamp|projection)\.json$/.test(name);
      if (keep && header.size > bounds.metadataBytes)
        reject('Package projection metadata is too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        expandedBytes += chunk.length;
        if (size > header.size || expandedBytes > bounds.expandedBytes) {
          reject('Package archive exceeds its declared size');
        }
        if (keep) chunks.push(chunk);
      }
      if (size !== header.size) reject('Package archive entry is truncated');
      if (keep) metadata.set(name, Buffer.concat(chunks));
      next();
    })().catch((error) => extract.destroy(error));
  });
  // Count headers, padding and extended metadata too: tar libraries can consume
  // PAX headers internally without ever emitting a file entry.
  const decodedLimit = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        decodedBytes += chunk.length;
        if (decodedBytes > bounds.decodedBytes) {
          reject('Package archive exceeds its decoded size limit');
        }
        framing.push(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        framing.finish();
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  try {
    await pipeline(Readable.from([archive]), createGunzip(), decodedLimit, extract);
    framing.assertConsumed();
  } catch (error) {
    if (error instanceof NativePackageError) throw error;
    reject('Package runtime archive is corrupt or truncated');
  }
  const projections = NATIVE_HARNESSES.map((harness) =>
    validateProjection({ harness, version, metadata, files, directories }),
  );
  return { fileCount: files.size, expandedBytes, projections };
};

const readReleaseFile = async (root, name, maxBytes, { retain = true } = {}) => {
  safePath(name);
  if (name.includes('/')) reject('Release asset name must be a filename');
  let handle;
  try {
    // A FIFO must not block open before we can reject it via fstat.
    handle = await open(
      join(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      reject(`Release asset ${name} is not a bounded regular file`);
    const hash = createHash('sha256');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) reject(`Release asset ${name} exceeds its size limit`);
      hash.update(chunk);
      if (retain) chunks.push(chunk);
    }
    return {
      bytes,
      sha256: hash.digest('hex'),
      ...(retain ? { content: Buffer.concat(chunks) } : {}),
    };
  } catch (error) {
    if (error instanceof NativePackageError) throw error;
    reject(`Release asset ${name} cannot be read as a regular file`);
  } finally {
    await handle?.close();
  }
};

const normalizeSource = (source) => {
  if (!source || !['github', 'gitlab', 'bitbucket'].includes(source.provider)) {
    reject('Package source provider is invalid');
  }
  if (
    typeof source.repository !== 'string' ||
    source.repository.length > 512 ||
    containsControl(source.repository)
  ) {
    reject('Package source repository is invalid');
  }
  const parts = source.repository.split('/');
  if (
    parts.length < 2 ||
    (source.provider !== 'gitlab' && parts.length !== 2) ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  ) {
    reject('Package source must be a repository identity without URL credentials');
  }
  if (
    typeof source.release !== 'string' ||
    !source.release ||
    source.release.length > 256 ||
    containsControl(source.release) ||
    /[\\ ]/.test(source.release) ||
    source.release === 'latest'
  ) {
    reject('Package source requires a resolved release tag');
  }
  if (
    typeof source.commit !== 'string' ||
    source.commit.length !== 40 ||
    !/^[0-9a-f]{40}$/i.test(source.commit)
  ) {
    reject('Package source requires a pinned commit');
  }
  return {
    provider: source.provider,
    repository: source.repository.toLowerCase(),
    release: source.release,
    commit: source.commit.toLowerCase(),
  };
};

export const verifyNativeReleaseDirectory = async ({
  directory,
  source,
  target = 'linux-arm64',
}) => {
  const pinnedSource = normalizeSource(source);
  const root = await realpath(directory);
  const [version, checksums] = await Promise.all([
    readReleaseFile(root, 'version.json', NATIVE_PACKAGE_LIMITS.metadataBytes),
    readReleaseFile(root, 'checksums.txt', NATIVE_PACKAGE_LIMITS.metadataBytes),
  ]);
  const manifest = verifyNativeReleaseManifest({
    versionJson: version.content,
    checksums: checksums.content,
    expectedCommit: pinnedSource.commit,
    expectedRelease: pinnedSource.release,
    target,
  });
  const [binary, runtime] = await Promise.all([
    readReleaseFile(root, manifest.assets.binary.name, NATIVE_PACKAGE_LIMITS.assetBytes, {
      retain: false,
    }),
    readReleaseFile(root, manifest.assets.runtime.name, NATIVE_PACKAGE_LIMITS.compressedBytes),
  ]);
  for (const [role, actual] of [
    ['binary', binary],
    ['runtime', runtime],
  ]) {
    if (
      manifest.assets[role].sha256 !== actual.sha256 ||
      manifest.assets[role].bytes !== actual.bytes
    ) {
      reject(`Release ${role} asset does not match its pinned checksum and size`);
    }
  }
  const inventory = await inspectNativeRuntimeArchive(runtime.content, {
    version: manifest.version,
  });
  const identity = {
    schemaVersion: 1,
    source: pinnedSource,
    target,
    version: manifest.version,
    manifestSha256: manifest.manifestSha256,
    checksumsSha256: manifest.checksumsSha256,
    assets: manifest.assets,
    harnesses: [...NATIVE_HARNESSES],
  };
  return {
    ...identity,
    packageId: `sha256:${sha256(canonicalJson(identity))}`,
    inventory,
    verification: {
      integrity: 'verified',
      projectionLayout: 'verified',
      attestation: 'not-verified',
      harnessExecution: 'not-verified',
    },
  };
};
