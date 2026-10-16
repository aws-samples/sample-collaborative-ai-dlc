// Private recovery bytes, never writer, approval, or configuration authority.
// Capture must inventory a quiescent workspace and exclude credentials. Restore
// must independently authorize each destination/configuration and obtain fresh
// credentials; this module neither traverses nor writes a local filesystem.
// Required recovery has no dependency on optional debugging or retention flags.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { canonicalJson } from './workflow-checkpoint.js';
import { nativeRecoveryBinLinks } from './native-recovery-bin-links.js';

export const NATIVE_RECOVERY_LIMITS = Object.freeze({
  files: 20_000,
  entries: 40_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  pathBytes: 2048,
  depth: 64,
});

const SHA = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const SESSION_FORMATS = {
  codex: 'codex-rollout-jsonl-v1',
  claude: 'claude-project-jsonl-v1',
  opencode: 'opencode-export-json-v1',
  kiro: 'kiro-v2-session-pair-v1',
};
const IDENTITY = [
  'projectId',
  'executionId',
  'bindingId',
  'attemptId',
  'epoch',
  'runtimeSessionId',
];
const METADATA = [
  'sequence',
  'writerGeneration',
  'nativeSessionId',
  'harness',
  'configurationSha256',
  'packageId',
  'imageDigest',
  'publicationId',
  'interactionId',
  'continuation',
  'filesystem',
];
const FILE = ['scope', 'path', 'bytes', 'sha256', 'mode', 'mtimeNs'];
const DIRECTORY = ['scope', 'path', 'mode', 'mtimeNs'];
const invalid = () => {
  throw Object.assign(new Error('Native recovery checkpoint could not be verified'), {
    code: 'NATIVE_RECOVERY_INVALID',
  });
};
const unavailable = () => {
  // SDK errors can contain request context or credentials. Do not expose them.
  throw Object.assign(new Error('Native recovery storage is unavailable'), {
    code: 'NATIVE_RECOVERY_UNAVAILABLE',
  });
};
const missing = () => {
  throw Object.assign(new Error('Native recovery checkpoint object version is missing'), {
    code: 'NATIVE_RECOVERY_MISSING',
  });
};
const missingObject = (error) =>
  ['NoSuchKey', 'NoSuchVersion'].includes(error?.name) ||
  (error?.name === 'NotFound' && error.$metadata?.httpStatusCode === 404);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const shape = (value, required, optional = []) => {
  if (!record(value)) invalid();
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.has(key) ||
        !Object.hasOwn(descriptors[key], 'value') ||
        !descriptors[key].enumerable,
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    invalid();
};
const array = (value, maximum) => {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => descriptors[index]).some(
      (entry) => !entry || !Object.hasOwn(entry, 'value') || !entry.enumerable,
    )
  )
    invalid();
};
const safeVersion = (value) => matches(value, /^[A-Za-z0-9._~+/=-]{1,1024}$/) && value !== 'null';
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const clone = (value) => structuredClone(value);
const pick = (value, fields) => Object.fromEntries(fields.map((key) => [key, value[key]]));
const pathKey = (entry) => `${entry.scope}/${entry.path}`;

export const nativeRecoveryScope = (identity) => {
  shape(identity, IDENTITY);
  if (
    !matches(identity.projectId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/) ||
    !['executionId', 'bindingId', 'attemptId', 'runtimeSessionId'].every((key) =>
      matches(identity[key], UUID),
    ) ||
    !integer(identity.epoch, 1)
  )
    invalid();
  const scope = pick(identity, IDENTITY);
  const scopeHash = hash(
    canonicalJson({ projectId: scope.projectId, executionId: scope.executionId }),
  );
  return {
    scope,
    prefix: `native-recovery/v1/${scopeHash}/${scope.attemptId}/${scope.epoch}/`,
  };
};

export const nativeRecoveryPath = (scope, path) => {
  if (
    !['project', 'home'].includes(scope) ||
    typeof path !== 'string' ||
    !path ||
    Buffer.byteLength(path) > NATIVE_RECOVERY_LIMITS.pathBytes ||
    Buffer.from(path).toString('utf8') !== path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    [...path].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    })
  )
    invalid();
  const parts = path.split('/');
  if (
    parts.length > NATIVE_RECOVERY_LIMITS.depth ||
    parts.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)
  )
    invalid();
  return path;
};

const fileKey = (identity, file) =>
  `${nativeRecoveryScope(identity).prefix}files/${hash(canonicalJson({ scope: file.scope, path: file.path }))}/${file.sha256}`;
const manifestKey = (identity, sha256) =>
  `${nativeRecoveryScope(identity).prefix}manifests/${sha256}.json`;
const metadata = (value) => {
  if (
    !integer(value.sequence, 1) ||
    !integer(value.writerGeneration, 1) ||
    !matches(value.nativeSessionId, /^[A-Za-z0-9_-]{1,128}$/) ||
    !HARNESSES.includes(value.harness) ||
    !matches(value.configurationSha256, SHA) ||
    !matches(value.packageId, DIGEST) ||
    !matches(value.imageDigest, DIGEST) ||
    !matches(value.publicationId, SHA) ||
    !matches(value.interactionId, SHA)
  )
    invalid();
  shape(value.continuation, ['promptEvidence', 'priorAssistantSha256']);
  if (!matches(value.continuation.priorAssistantSha256, SHA)) invalid();
  const evidence = value.continuation.promptEvidence;
  if (evidence !== null) {
    shape(evidence, ['userPromptSha256', 'userPromptSource']);
    if (
      value.harness !== 'kiro' ||
      !matches(evidence.userPromptSha256, SHA) ||
      !['literal', 'aidlc-skill-expansion'].includes(evidence.userPromptSource)
    )
      invalid();
  }
};
const attributes = (value, directory = false) => {
  if (directory && value.path === '') {
    if (!['project', 'home'].includes(value.scope)) invalid();
  } else nativeRecoveryPath(value.scope, value.path);
  if (
    !integer(value.mode, 0, 0o777) ||
    !matches(value.mtimeNs, /^(?:0|-?[1-9]\d{0,18})$/) ||
    BigInt(value.mtimeNs) < -(1n << 63n) ||
    BigInt(value.mtimeNs) > (1n << 63n) - 1n
  )
    invalid();
};
const inventory = (files, identity, writing = false) => {
  array(files, NATIVE_RECOVERY_LIMITS.files);
  const paths = new Set();
  let total = 0;
  for (const file of files) {
    shape(file, [...FILE, writing ? 'content' : 'object']);
    attributes(file);
    if (!integer(file.bytes, 0, NATIVE_RECOVERY_LIMITS.fileBytes) || !matches(file.sha256, SHA))
      invalid();
    total += file.bytes;
    if (total > NATIVE_RECOVERY_LIMITS.totalBytes) invalid();
    const key = `${file.scope}/${file.path}`;
    if (paths.has(key)) invalid();
    paths.add(key);
    if (writing) {
      if (!Buffer.isBuffer(file.content) || file.content.length !== file.bytes) invalid();
    } else {
      shape(file.object, ['key', 'versionId']);
      if (file.object.key !== fileKey(identity, file) || !safeVersion(file.object.versionId))
        invalid();
    }
  }
  // All entries are regular files; a file cannot also be another file's parent.
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 2; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join('/'))) invalid();
  }
};
const sessionMetadata = (value) => {
  const data = value.filesystem;
  shape(data, [
    'schemaVersion',
    'harness',
    'harnessVersion',
    'nativeSessionId',
    'format',
    'project',
    'home',
    'directories',
    'hardlinks',
    ...(data?.schemaVersion === 2 ? ['binLinks'] : []),
    ...(value.harness === 'claude' ? ['claudeProjectKey'] : []),
  ]);
  if (
    ![1, 2].includes(data.schemaVersion) ||
    data.harness !== value.harness ||
    data.nativeSessionId !== value.nativeSessionId ||
    data.format !== SESSION_FORMATS[value.harness] ||
    !matches(
      data.harnessVersion,
      /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$/,
    )
  )
    invalid();
  for (const root of ['project', 'home']) {
    if (typeof data[root] !== 'string' || !data[root].startsWith('/')) invalid();
    nativeRecoveryPath(root, data[root].slice(1));
  }
  if (
    data.project === data.home ||
    data.project.startsWith(`${data.home}/`) ||
    data.home.startsWith(`${data.project}/`)
  )
    invalid();
  if (value.harness === 'claude') {
    nativeRecoveryPath('home', data.claudeProjectKey);
    if (data.claudeProjectKey.includes('/')) invalid();
  }
  array(data.directories, NATIVE_RECOVERY_LIMITS.entries - value.files.length);
  array(data.hardlinks, NATIVE_RECOVERY_LIMITS.files);
  const files = new Map(value.files.map((file) => [pathKey(file), file]));
  const paths = new Set(files.keys());
  for (const directory of data.directories) {
    shape(directory, DIRECTORY);
    attributes(directory, true);
    const key = pathKey(directory);
    if (paths.has(key)) invalid();
    paths.add(key);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 2; index < parts.length; index++)
      if (files.has(parts.slice(0, index).join('/'))) invalid();
  }
  const linked = new Set();
  for (const group of data.hardlinks) {
    shape(group, ['scope', 'paths']);
    array(group.paths, NATIVE_RECOVERY_LIMITS.files);
    if (group.paths.length < 2) invalid();
    let first;
    for (const path of group.paths) {
      nativeRecoveryPath(group.scope, path);
      const key = `${group.scope}/${path}`;
      const file = files.get(key);
      if (!file || linked.has(key)) invalid();
      if (
        first &&
        ['bytes', 'sha256', 'mode', 'mtimeNs'].some((field) => file[field] !== first[field])
      )
        invalid();
      first ??= file;
      linked.add(key);
    }
  }
  try {
    nativeRecoveryBinLinks(data, value.files, NATIVE_RECOVERY_LIMITS);
  } catch {
    invalid();
  }
};
const manifestValue = (value, identity) => {
  shape(value, ['schemaVersion', 'scope', ...METADATA, 'files']);
  if (value.schemaVersion !== 1) invalid();
  const expected = nativeRecoveryScope(identity);
  const observed = nativeRecoveryScope(value.scope);
  if (!same(observed.scope, expected.scope)) invalid();
  metadata(value);
  inventory(value.files, identity);
  sessionMetadata(value);
  return clone(value);
};

export const nativeRecoveryReceipt = (value, identity) => {
  shape(value, ['id', 'sequence', 'manifest']);
  shape(value.manifest, ['key', 'versionId', 'sha256', 'bytes']);
  if (
    !matches(value.id, SHA) ||
    !integer(value.sequence, 1) ||
    value.manifest.sha256 !== value.id ||
    value.manifest.key !== manifestKey(identity, value.id) ||
    !safeVersion(value.manifest.versionId) ||
    !integer(value.manifest.bytes, 1, NATIVE_RECOVERY_LIMITS.manifestBytes)
  )
    invalid();
  return clone(value);
};

const secretBytes = (value = []) => {
  array(value, 64);
  return value.map((entry) => {
    if (
      !(typeof entry === 'string' || Buffer.isBuffer(entry)) ||
      Buffer.byteLength(entry) < 1 ||
      Buffer.byteLength(entry) > 64 * 1024
    )
      invalid();
    return Buffer.from(entry);
  });
};
const excludeSecrets = (bytes, secrets) => {
  if (secrets.some((secret) => bytes.includes(secret))) invalid();
};
const destroy = (body) => {
  try {
    body?.destroy?.();
  } catch {
    // Cleanup must not expose a raw SDK error or override a verification error.
  }
};

/**
 * publish({identity,...pins,sequence,writerGeneration,publicationId,interactionId,
 *   continuation,filesystem:<capture.metadata>,
 *   files:[{scope,path,bytes,sha256,mode,mtimeNs,content}],forbiddenBytes?})
 *   -> {id,sequence,manifest:{key,versionId,sha256,bytes}}
 * read(identity,receipt,{verifyFiles:true}) -> manifest (ALL versions verified)
 * readFiles(identity,receipt) -> {manifest,files:[...descriptor,content:Buffer]}
 * file(identity,receipt,entry) -> Buffer (entry must match the pinned manifest)
 *
 * writerGeneration identifies the CHECKPOINT PRODUCER, not permission for the
 * recovering writer. Capture metadata retains directories (including empty
 * directories/root records), hardlink groups, modes and exact nanosecond mtimes.
 * Its source project/home paths must be matched to trusted restore destinations;
 * they are not instructions to write there or permission to restore HOME config.
 *
 * The first proof is bounded to 256 MiB of file bodies, 64 MiB per file, 20,000
 * files and 40,000 file/directory entries. This is not arbitrary-workspace
 * recovery. readFiles retains those bodies plus metadata/SDK overhead in memory;
 * read streams hashes only. Capture must apply these stricter bounds up front.
 *
 * read never skips file verification, including when options are omitted.
 * Hashes establish exact bytes, not completeness of a filesystem capture or
 * permission to execute them. The controller must compare all pins and the
 * publication/interaction sequence with its own protected records before commit.
 * Runtime roles need PutObject/GetObject/GetObjectVersion on their own prefix;
 * latest GetObject is used only to reconcile a create-only upload, never restore.
 */
export const createNativeRecoveryCheckpoints = (options) => {
  shape(options, ['s3', 'bucket', 'accountId']);
  const { s3, bucket, accountId } = options;
  if (
    typeof s3?.send !== 'function' ||
    !matches(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) ||
    !matches(accountId, /^\d{12}$/)
  )
    invalid();
  const send = s3.send.bind(s3);
  const base = { Bucket: bucket, ExpectedBucketOwner: accountId };
  const readObject = async (pointer, bytes, sha256, collect = false) => {
    let result;
    try {
      result = await send(
        new GetObjectCommand({
          ...base,
          Key: pointer.key,
          ...(pointer.versionId === null ? {} : { VersionId: pointer.versionId }),
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
    } catch (error) {
      // A committed exact version cannot be recovered by retrying a missing
      // object. A latest read during upload reconciliation proves no committed
      // receipt yet, so an absent upload remains a retryable storage failure.
      if (pointer.versionId !== null && missingObject(error)) missing();
      unavailable();
    }
    try {
      if (
        !safeVersion(result?.VersionId) ||
        (pointer.versionId !== null && result.VersionId !== pointer.versionId) ||
        result.ContentLength !== bytes ||
        typeof result.Body?.[Symbol.asyncIterator] !== 'function'
      )
        invalid();
      const content = collect ? Buffer.alloc(bytes) : null;
      const digest = createHash('sha256');
      let count = 0;
      for await (const chunk of result.Body) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > bytes - count) invalid();
        digest.update(chunk);
        if (content) content.set(chunk, count);
        count += chunk.byteLength;
      }
      if (count !== bytes || digest.digest('hex') !== sha256) invalid();
      return { content, versionId: result.VersionId };
    } catch (error) {
      if (error?.code === 'NATIVE_RECOVERY_INVALID') throw error;
      unavailable();
    } finally {
      destroy(result?.Body);
    }
  };
  const put = async (key, bytes, contentType) => {
    let result;
    try {
      result = await send(
        new PutObjectCommand({
          ...base,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          CacheControl: 'no-store',
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
    } catch {
      // Includes precondition conflicts and acknowledged-but-lost writes.
      // Only exact readback can turn uncertain upload into a returned receipt.
    }
    if (safeVersion(result?.VersionId)) return { key, versionId: result.VersionId };
    const recovered = await readObject({ key, versionId: null }, bytes.length, hash(bytes));
    return { key, versionId: recovered.versionId };
  };
  const readManifest = async (identity, receipt) => {
    const { scope } = nativeRecoveryScope(identity);
    const expected = nativeRecoveryReceipt(receipt, scope);
    const { content } = await readObject(
      expected.manifest,
      expected.manifest.bytes,
      expected.id,
      true,
    );
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    } catch {
      invalid();
    }
    const manifest = manifestValue(parsed, scope);
    if (
      manifest.sequence !== expected.sequence ||
      !Buffer.from(canonicalJson(manifest)).equals(content)
    )
      invalid(); // Also rejects duplicate JSON keys and noncanonical encodings.
    return manifest;
  };
  const readInventory = async (manifest, collect) => {
    let next = 0;
    let failure;
    const files = collect ? Array.from({ length: manifest.files.length }) : null;
    // Both callers share bounded concurrency and wait for every started read.
    await Promise.all(
      Array.from({ length: Math.min(4, manifest.files.length) }, async () => {
        while (!failure && next < manifest.files.length) {
          const index = next++;
          const file = manifest.files[index];
          try {
            const result = await readObject(file.object, file.bytes, file.sha256, collect);
            if (files) files[index] = { ...clone(file), content: result.content };
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    if (failure) {
      if (files) files.length = 0; // Never return a partially verified workspace.
      throw failure;
    }
    return files;
  };
  const uploadInventory = async (scope, files, manifest) => {
    let next = 0;
    let failure;
    // Keep each exact-version receipt at its canonical inventory index. Drain
    // every started upload before returning or rejecting; the manifest is the
    // commit record and must never be written for an incomplete inventory.
    await Promise.all(
      Array.from({ length: Math.min(4, files.length) }, async () => {
        while (!failure && next < files.length) {
          const index = next++;
          try {
            manifest.files[index].object = await put(
              fileKey(scope, files[index]),
              files[index].content,
              'application/octet-stream',
            );
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    if (failure) throw failure;
  };
  return Object.freeze({
    async publish(input) {
      shape(input, ['identity', ...METADATA, 'files'], ['forbiddenBytes']);
      const { scope } = nativeRecoveryScope(input.identity);
      metadata(input);
      inventory(input.files, scope, true);
      sessionMetadata(input);
      const secrets = secretBytes(input.forbiddenBytes);
      // Copy all caller-owned bytes and metadata before the first await.
      const files = input.files.map((file) => {
        const content = Buffer.from(file.content);
        if (hash(content) !== file.sha256) invalid();
        excludeSecrets(content, secrets);
        return { ...pick(file, FILE), content };
      });
      files.sort((a, b) => {
        const left = `${a.scope}/${a.path}`;
        const right = `${b.scope}/${b.path}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
      const manifest = manifestValue(
        {
          schemaVersion: 1,
          scope,
          ...clone(pick(input, METADATA)),
          files: files.map((file) => ({
            ...pick(file, FILE),
            object: { key: fileKey(scope, file), versionId: 'prospective' },
          })),
        },
        scope,
      );
      const prospective = Buffer.from(canonicalJson(manifest));
      if (prospective.length > NATIVE_RECOVERY_LIMITS.manifestBytes) invalid();
      excludeSecrets(prospective, secrets);
      await uploadInventory(scope, files, manifest);
      const bytes = Buffer.from(canonicalJson(manifest));
      if (bytes.length > NATIVE_RECOVERY_LIMITS.manifestBytes) invalid();
      excludeSecrets(bytes, secrets);
      const id = hash(bytes);
      const pointer = await put(manifestKey(scope, id), bytes, 'application/json');
      return nativeRecoveryReceipt(
        {
          id,
          sequence: manifest.sequence,
          manifest: { ...pointer, sha256: id, bytes: bytes.length },
        },
        scope,
      );
    },
    async read(identity, receipt, readOptions = { verifyFiles: true }) {
      shape(readOptions, ['verifyFiles']);
      if (readOptions.verifyFiles !== true) invalid();
      const manifest = await readManifest(identity, receipt);
      // Bounded streaming verification: do not accumulate a whole workspace in
      // a controller Lambda, and do not leave background reads after rejection.
      await readInventory(manifest, false);
      return manifest;
    },
    async readFiles(identity, receipt) {
      // One exact manifest download, then one exact-version download per file.
      const manifest = await readManifest(identity, receipt);
      const files = await readInventory(manifest, true);
      return { manifest, files };
    },
    async file(identity, receipt, entry) {
      const { scope } = nativeRecoveryScope(identity);
      inventory([entry], scope);
      const selected = clone(entry);
      const manifest = await readManifest(scope, receipt);
      const committed = manifest.files.find(
        (file) => file.scope === selected.scope && file.path === selected.path,
      );
      if (!committed || !same(committed, selected)) invalid();
      return (await readObject(committed.object, committed.bytes, committed.sha256, true)).content;
    },
  });
};
