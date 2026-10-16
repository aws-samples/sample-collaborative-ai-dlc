// Recovery is private runtime state, independent of optional debug archives.
// The caller must fence and reap every writer before capture, and authorize a
// committed waiting-point manifest before restore. This module grants neither
// ownership nor permission to invoke a model. Portable traversal is not an
// openat sandbox against a concurrently hostile process running as the same UID.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalNativePath } from './execution-files.js';
import { nativeCredentialPath } from '../../shared/native-project-files.js';

export const NATIVE_RECOVERY_FILE_LIMITS = Object.freeze({
  maxFiles: 100_000,
  maxEntries: 150_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxDepth: 128,
});
export const NATIVE_RECOVERY_HARNESS_VERSIONS = Object.freeze({
  codex: '0.162.1',
  claude: '2.1.296',
  opencode: '1.19.0',
  kiro: '2.29.1',
});
const OPENCODE_EXPORT = '.native-recovery/opencode-session.json';
const FORMATS = {
  codex: 'codex-rollout-jsonl-v1',
  claude: 'claude-project-jsonl-v1',
  opencode: 'opencode-export-json-v1',
  kiro: 'kiro-v2-session-pair-v1',
};
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const UINT = /^(?:0|[1-9][0-9]{0,19})$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameStat = (a, b) =>
  sameNode(a, b) &&
  ['mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]);
const scopePath = (item) => `${item.scope}:${item.path}`;
const inside = (root, path) => path === root || path.startsWith(`${root}/`);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nsValid = (value) =>
  typeof value === 'string' && UINT.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const modeValid = (value) => Number.isInteger(value) && value >= 0 && value <= 0o777;

export class NativeSessionRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeSessionRecoveryError';
    this.code = code;
  }
}
const fail = (suffix) => {
  throw new NativeSessionRecoveryError(`native_recovery_${suffix}`);
};
const abort = (signal) => {
  if (signal?.aborted) fail('cancelled');
};

// Only platform-private/credential locations are excluded. Git, generated
// harness files, ignored code, native engine keys and unfamiliar artifacts
// deliberately survive; the public publication filter is not used here.
export const nativeRecoveryProjectExclusion = (path) => {
  if (!canonicalNativePath(path)) fail('path_invalid');
  const parts = path.split('/');
  if (parts.some((p) => ['.native-control', '.native-homes'].includes(p)))
    return 'platform-control';
  if (nativeCredentialPath(path)) return 'credentials';
  return null;
};

const context = (input) => {
  const { project, home, harness, nativeSessionId, signal, forbiddenBytes = [] } = input ?? {};
  const limits = { ...NATIVE_RECOVERY_FILE_LIMITS, ...input?.limits };
  if (
    !Object.hasOwn(FORMATS, harness) ||
    typeof nativeSessionId !== 'string' ||
    !ID.test(nativeSessionId ?? '') ||
    ![project, home].every(
      (p) => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && p !== '/',
    ) ||
    inside(project, home) ||
    inside(home, project) ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    !Array.isArray(forbiddenBytes) ||
    forbiddenBytes.length > 64 ||
    forbiddenBytes.some(
      (v) =>
        !(typeof v === 'string' || Buffer.isBuffer(v)) ||
        Buffer.byteLength(v) < 1 ||
        Buffer.byteLength(v) > 64 * 1024,
    ) ||
    Object.entries(limits).some(
      ([k, v]) =>
        !Object.hasOwn(NATIVE_RECOVERY_FILE_LIMITS, k) || !Number.isSafeInteger(v) || v < 1,
    )
  )
    fail('arguments_invalid');
  abort(signal);
  return {
    project,
    home,
    harness,
    nativeSessionId,
    signal,
    limits,
    secrets: forbiddenBytes.map((v) => Buffer.from(v)),
    io: input.io ?? fs,
    run: input.run ?? runRecoveryCommand,
  };
};
const rootStat = async (path, io) => {
  const stat = await io.lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.geteuid === 'function' && stat.uid !== BigInt(process.geteuid())) ||
    (await io.realpath(path)) !== path
  )
    fail('root_invalid');
  return stat;
};
const json = (bytes) => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('session_invalid');
  }
};
const jsonl = (bytes) => {
  if (!bytes.length || bytes.at(-1) !== 10) fail('session_incomplete');
  const rows = [];
  let start = 0;
  for (let end = 0; end < bytes.length; end++)
    if (bytes[end] === 10) {
      const line = bytes.subarray(start, end);
      if (!line.length) fail('session_invalid');
      const row = json(line);
      if (!plain(row)) fail('session_invalid');
      rows.push(row);
      start = end + 1;
    }
  return rows;
};
const credentialCheck = (ctx, content, path = '') => {
  if (ctx.secrets.some((secret) => content.includes(secret))) fail('credential_content');
  if (
    /(?:^|\/)\.git$/.test(path) ||
    (/(?:^|\/)\.git\/(?:commondir|objects\/info\/alternates)$/.test(path) &&
      content.toString('utf8').trim())
  )
    fail('project_gitdir_unsupported');
  if (
    /(?:^|\/)\.git\/config(?:\.worktree)?$/.test(path) &&
    /(?:^\s*\[credential\b|^\s*(?:extraheader|helper)\s*=|url\s*=\s*\w+:\/\/[^/\s]+@)/im.test(
      content.toString('utf8'),
    )
  )
    fail('credential_config');
};

// These commands only read/export/import local session state. No run, prompt,
// resume or inference command is accepted through the production runner.
async function runRecoveryCommand({
  operation,
  path,
  project,
  home,
  nativeSessionId,
  signal,
  limit,
}) {
  if (!['opencode-export', 'opencode-import'].includes(operation)) fail('adapter_invalid');
  const args =
    operation === 'opencode-export'
      ? ['export', nativeSessionId, '--pure']
      : ['import', path, '--pure'];
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('/opt/opencode/bin/opencode', args, {
      cwd: project,
      env: {
        HOME: home,
        PATH: '/opt/opencode/bin:/usr/local/bin:/usr/bin:/bin',
        XDG_DATA_HOME: join(home, '.data'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        AWS_EC2_METADATA_DISABLED: 'true',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const chunks = [];
    let size = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) stop();
      else chunks.push(chunk);
    });
    child.once('error', () => {
      signal?.removeEventListener('abort', stop);
      reject(new NativeSessionRecoveryError('native_recovery_adapter_failed'));
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new NativeSessionRecoveryError('native_recovery_cancelled'));
      else if (stopped || code !== 0)
        reject(new NativeSessionRecoveryError('native_recovery_adapter_failed'));
      else resolvePromise(Buffer.concat(chunks));
    });
  });
}

const homeAllowed = (harness, id, path, metadata) => {
  if (harness === 'opencode') return path === OPENCODE_EXPORT;
  if (harness === 'kiro')
    return [`.kiro/sessions/cli/${id}.json`, `.kiro/sessions/cli/${id}.jsonl`].includes(path);
  if (harness === 'codex')
    return /^\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(path);
  const key = metadata?.claudeProjectKey;
  if (!key || !canonicalNativePath(key) || key.includes('/')) return false;
  const base = `.claude/projects/${key}/${id}`;
  return (
    path === `${base}.jsonl` ||
    path.startsWith(`${base}/tool-results/`) ||
    (path.startsWith(`${base}/subagents/`) &&
      (path.endsWith('.jsonl') || /\/agent-[A-Za-z0-9_-]{1,128}\.meta\.json$/.test(path))) ||
    path === `${base}/journal.jsonl` ||
    path.startsWith(`.claude/projects/${key}/memory/`) ||
    path.startsWith(`.claude/file-history/${id}/`) ||
    path.startsWith(`.claude/scratch/${id}/`) ||
    (path.startsWith(`.claude/tasks/${id}/`) &&
      (path.endsWith('.json') || path.endsWith('/.highwatermark'))) ||
    /^\.claude\/plans\/[^/]+\.md$/.test(path)
  );
};

// The pinned Claude CLI persists agent metadata alongside its transcript.
// Retain only paired, recognized metadata within the selected session tree;
// restore still verifies all bytes, paths, ownership and credential exclusions.
const validateClaudeAgentMetadata = (entry, paths) => {
  const transcript = entry.path.replace(/\.meta\.json$/, '.jsonl');
  if (!paths.has(transcript)) fail('session_missing');
  const metadata = json(entry.content);
  if (!plain(metadata) || typeof metadata.agentType !== 'string' || !metadata.agentType.length)
    fail('session_invalid');
};
const homeDirectoryAllowed = (harness, id, path, metadata) => {
  if (path === '') return true;
  if (harness === 'codex')
    return /^\.codex(?:\/sessions(?:\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?)?)?$/.test(path);
  if (harness === 'kiro') return ['.kiro', '.kiro/sessions', '.kiro/sessions/cli'].includes(path);
  if (harness === 'opencode') return path === '.native-recovery';
  const key = metadata?.claudeProjectKey;
  const selected = `.claude/projects/${key}/${id}`;
  return (
    ['.claude', '.claude/projects', `.claude/projects/${key}`, selected].includes(path) ||
    path === `${selected}/tool-results` ||
    path.startsWith(`${selected}/tool-results/`) ||
    path === `${selected}/subagents` ||
    path.startsWith(`${selected}/subagents/`) ||
    path === `.claude/projects/${key}/memory` ||
    path.startsWith(`.claude/projects/${key}/memory/`) ||
    ['tasks', 'file-history', 'scratch'].some(
      (kind) =>
        path === `.claude/${kind}` ||
        path === `.claude/${kind}/${id}` ||
        path.startsWith(`.claude/${kind}/${id}/`),
    ) ||
    path === '.claude/plans'
  );
};

const validateClaudeSession = (ctx, entries, metadata) => {
  const base = `.claude/projects/${metadata.claudeProjectKey}/${ctx.nativeSessionId}`;
  const main = entries.find((entry) => entry.path === `${base}.jsonl`);
  if (!main) fail('session_missing');
  const rows = jsonl(main.content);
  if (
    !rows.some((row) => row.sessionId === ctx.nativeSessionId) ||
    rows.some((row) => row.sessionId !== undefined && row.sessionId !== ctx.nativeSessionId)
  )
    fail('session_id_mismatch');
  // Claude's transcript cwd follows Bash cd; it is not the session's immutable
  // project identity. Keep the exact session/project-key checks and accept only
  // canonical directories that this checkpoint actually captures. The same
  // check runs before restore writes anything. Excluded/private directories,
  // external paths and symlinks cannot become recoverable working directories.
  const directories = new Set(
    metadata.directories
      .filter((entry) => entry.scope === 'project')
      .map((entry) => join(ctx.project, entry.path)),
  );
  if (
    rows.some(
      (row) =>
        row.cwd !== undefined &&
        (typeof row.cwd !== 'string' ||
          !isAbsolute(row.cwd) ||
          resolve(row.cwd) !== row.cwd ||
          !inside(ctx.project, row.cwd) ||
          !directories.has(row.cwd)),
    )
  )
    fail('session_cwd_invalid');
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (!entry.path.startsWith(`${base}/`)) continue;
    if (entry.path.endsWith('.jsonl')) jsonl(entry.content);
    if (entry.path.startsWith(`${base}/subagents/`) && entry.path.endsWith('.meta.json'))
      validateClaudeAgentMetadata(entry, paths);
  }
};

const validateSession = (ctx, files, metadata) => {
  const entries = files.filter((f) => f.scope === 'home');
  if (!entries.length) fail('session_missing');
  if (entries.some((f) => !homeAllowed(ctx.harness, ctx.nativeSessionId, f.path, metadata)))
    fail('home_path_invalid');
  if (ctx.harness === 'opencode') {
    if (entries.length !== 1) fail('session_invalid');
    const value = json(entries[0].content);
    if (
      value?.info?.id !== ctx.nativeSessionId ||
      value.info.directory !== ctx.project ||
      !Array.isArray(value.messages) ||
      !value.messages.length ||
      value.messages.some(
        (m) =>
          m?.info?.sessionID !== ctx.nativeSessionId ||
          !Array.isArray(m.parts) ||
          m.parts.some((p) => p?.sessionID !== ctx.nativeSessionId || p.messageID !== m.info.id),
      )
    )
      fail('session_identity');
    // The CLI JSON export omits independent task/todo and filesystem snapshot
    // stores. Reject known dependencies until those stores have an adapter.
    if (
      value.info.revert ||
      value.info.parentID ||
      value.messages.some((m) =>
        m.parts.some(
          (p) =>
            ['snapshot', 'patch', 'subtask'].includes(p.type) ||
            p.snapshot !== undefined ||
            (p.type === 'tool' && ['task', 'todowrite', 'todoread'].includes(p.tool)),
        ),
      )
    )
      fail('session_layout_unsupported');
    return;
  }
  if (ctx.harness === 'kiro') {
    if (entries.length !== 2) fail('session_missing');
    const meta = json(entries.find((f) => f.path.endsWith('.json')).content);
    if (meta?.session_id !== ctx.nativeSessionId || meta.cwd !== ctx.project)
      fail('session_identity');
    jsonl(entries.find((f) => f.path.endsWith('.jsonl')).content);
    return;
  }
  if (ctx.harness === 'claude') return validateClaudeSession(ctx, entries, metadata);
  const sessions = new Map();
  for (const entry of entries) {
    const rows = jsonl(entry.content);
    const first = rows[0];
    const meta = first.payload;
    if (
      first.type !== 'session_meta' ||
      !ID.test(meta?.id ?? '') ||
      !entry.path.endsWith(`-${meta.id}.jsonl`) ||
      meta.cwd !== ctx.project ||
      sessions.has(meta.id)
    )
      fail('session_identity');
    // Pinned 0.162.1 pages are SQLite projections of ordinal JSONL, not
    // separate durable page files. Fork history_base points to an immutable
    // prefix of an ancestor rollout. Unknown prefix formats remain closed.
    if (
      ![undefined, 'legacy', 'paginated'].includes(meta.history_mode) ||
      meta.history_prefix != null ||
      (meta.history_base != null && meta.history_mode !== 'paginated')
    )
      fail('session_layout_unsupported');
    if (meta.history_mode === 'paginated') {
      const start = meta.history_base?.end_ordinal_exclusive ?? 0;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        rows.some((row, i) => !Number.isSafeInteger(row.ordinal) || row.ordinal !== start + i)
      )
        fail('session_invalid');
      const inheritedEnd = meta.subagent_history_start_ordinal;
      if (
        inheritedEnd !== undefined &&
        (!Number.isSafeInteger(inheritedEnd) ||
          inheritedEnd < start ||
          inheritedEnd > rows.at(-1).ordinal + 1)
      )
        fail('session_incomplete');
    }
    sessions.set(meta.id, { meta, rows, content: entry.content });
  }
  if (!sessions.has(ctx.nativeSessionId)) fail('session_missing');
  const parentOf = (meta) =>
    meta.parent_thread_id ??
    meta.source?.subagent?.thread_spawn?.parent_thread_id ??
    meta.forked_from_id;
  const owned = new Set([ctx.nativeSessionId]);
  for (let i = 0; i < sessions.size; i++)
    for (const [id, { meta }] of sessions) {
      if (owned.has(parentOf(meta))) owned.add(id);
    }
  if (owned.size !== sessions.size) fail('session_unrelated');
  for (const [id, { meta }] of sessions) {
    if (meta.history_mode !== 'paginated') continue;
    // A user fork starts its own session; spawned subagents share their
    // parent's root session. Neither may substitute an unrelated session.
    const spawnedParent =
      meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
    const expectedSession = spawnedParent
      ? (sessions.get(spawnedParent)?.meta.session_id ?? ctx.nativeSessionId)
      : id;
    if (meta.session_id !== expectedSession) fail('session_identity');
    const base = meta.history_base;
    if (base == null) continue;
    if (
      !plain(base) ||
      !ID.test(base.thread_id ?? '') ||
      !Number.isSafeInteger(base.end_ordinal_exclusive) ||
      base.end_ordinal_exclusive < 1 ||
      !Number.isSafeInteger(base.end_byte_offset) ||
      base.end_byte_offset < 1
    )
      fail('session_invalid');
    const source = sessions.get(base.thread_id);
    if (!source) fail('session_missing');
    // A reference cannot import a sibling/unrelated session or make a cycle.
    let parent = parentOf(meta);
    const seen = new Set([id]);
    while (parent !== base.thread_id) {
      if (!parent || seen.has(parent) || seen.size >= ctx.limits.maxDepth)
        fail('session_unrelated');
      seen.add(parent);
      parent = parentOf(sessions.get(parent)?.meta ?? {});
    }
    if (seen.has(parent) || source.meta.history_mode !== 'paginated') fail('session_invalid');
    const index = base.end_ordinal_exclusive - source.rows[0].ordinal - 1;
    if (index < 1 || index >= source.rows.length || base.end_byte_offset > source.content.length)
      fail('session_incomplete');
    // Both coordinates must identify the same complete immutable JSONL prefix.
    let end = 0;
    for (let i = 0; i <= index; i++) end = source.content.indexOf(10, end) + 1;
    if (end !== base.end_byte_offset) fail('session_invalid');
  }
};

export const captureNativeSessionRecovery = async (input = {}) => {
  const ctx = context(input);
  const { io, project, home, limits, signal } = ctx;
  try {
    const roots = {
      project: await rootStat(project, io),
      home: await rootStat(home, io),
    };
    const metadata = {
      schemaVersion: 1,
      harness: ctx.harness,
      harnessVersion: NATIVE_RECOVERY_HARNESS_VERSIONS[ctx.harness],
      nativeSessionId: ctx.nativeSessionId,
      format: FORMATS[ctx.harness],
      project,
      home,
      directories: [],
      hardlinks: [],
    };
    const files = [];
    const exclusions = [];
    const observed = new Map();
    const links = new Map();
    const directoryKeys = new Set();
    let entries = 0;
    let totalBytes = 0;
    const unchanged = async (scope, path, before) => {
      abort(signal);
      if (!sameStat(before, await io.lstat(join(ctx[scope], path), { bigint: true })))
        fail('changed');
    };
    const homeAncestors = async (path) => {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/');
        const key = `home:${parent}`;
        if (observed.has(key)) continue;
        const stat = await io.lstat(join(home, parent), { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('symlink');
        if (stat.dev !== roots.home.dev) fail('mount');
        if ((stat.mode & 0o7000n) !== 0n) fail('mode_invalid');
        observed.set(key, { scope: 'home', path: parent, stat });
        directoryKeys.add(key);
        metadata.directories.push({
          scope: 'home',
          path: parent,
          mode: Number(stat.mode & 0o777n),
          mtimeNs: String(stat.mtimeNs),
        });
      }
    };
    const walk = async (scope, path, depth = 0) => {
      abort(signal);
      if (++entries > limits.maxEntries || depth > limits.maxDepth) fail('limit');
      if (path && !canonicalNativePath(path)) fail('path_invalid');
      if (scope === 'project' && path) {
        const reason = nativeRecoveryProjectExclusion(path);
        if (reason) {
          exclusions.push({ scope, path, reason });
          return;
        }
      }
      if (scope === 'home') await homeAncestors(path);
      const absolute = join(ctx[scope], path);
      const stat = await io.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) fail('symlink');
      if (stat.dev !== roots[scope].dev) fail('mount');
      if ((stat.mode & 0o7000n) !== 0n) fail('mode_invalid');
      observed.set(`${scope}:${path}`, { scope, path, stat });
      const attributes = {
        scope,
        path,
        mode: Number(stat.mode & 0o777n),
        mtimeNs: String(stat.mtimeNs),
      };
      if (!nsValid(attributes.mtimeNs)) fail('time_invalid');
      if (stat.isDirectory()) {
        if (
          scope === 'home' &&
          !homeDirectoryAllowed(ctx.harness, ctx.nativeSessionId, path, metadata)
        )
          fail('home_path_invalid');
        if (!directoryKeys.has(scopePath(attributes))) {
          metadata.directories.push(attributes);
          directoryKeys.add(scopePath(attributes));
        }
        for (const name of (await io.readdir(absolute)).toSorted())
          await walk(scope, path ? `${path}/${name}` : name, depth + 1);
      } else {
        if (!stat.isFile()) fail('special_file');
        if (scope === 'home' && !homeAllowed(ctx.harness, ctx.nativeSessionId, path, metadata))
          fail('home_path_invalid');
        if (
          files.length >= limits.maxFiles ||
          stat.size > BigInt(limits.maxFileBytes) ||
          stat.size > BigInt(limits.maxTotalBytes - totalBytes)
        )
          fail('limit');
        const handle = await io.open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let content;
        try {
          if (!sameStat(stat, await handle.stat({ bigint: true }))) fail('changed');
          content = Buffer.alloc(Number(stat.size));
          let offset = 0;
          while (offset < content.length) {
            abort(signal);
            const { bytesRead } = await handle.read(
              content,
              offset,
              Math.min(64 * 1024, content.length - offset),
              offset,
            );
            if (!bytesRead) fail('changed');
            offset += bytesRead;
          }
          if (
            BigInt(content.length) !== stat.size ||
            !sameStat(stat, await handle.stat({ bigint: true }))
          )
            fail('changed');
        } finally {
          await handle.close();
        }
        credentialCheck(ctx, content, scope === 'project' ? path : '');
        files.push({ ...attributes, bytes: content.length, sha256: hash(content), content });
        totalBytes += content.length;
        const key = `${scope}:${stat.dev}:${stat.ino}`;
        const group = links.get(key) ?? { scope, nlink: stat.nlink, paths: [] };
        group.paths.push(path);
        links.set(key, group);
      }
      await unchanged(scope, path, stat);
    };
    await walk('project', '');
    // Inspect only the selected harness's session area, never arbitrary HOME.
    if (ctx.harness === 'opencode') {
      const content = await ctx.run({
        operation: 'opencode-export',
        ...ctx,
        limit: limits.maxFileBytes,
      });
      if (!Buffer.isBuffer(content) || content.length > limits.maxFileBytes)
        fail('adapter_invalid');
      credentialCheck(ctx, content);
      files.push({
        scope: 'home',
        path: OPENCODE_EXPORT,
        mode: 0o600,
        mtimeNs: '0',
        bytes: content.length,
        sha256: hash(content),
        content,
      });
      totalBytes += content.length;
    } else if (ctx.harness === 'claude') {
      const base = join(home, '.claude/projects');
      await homeAncestors('.claude/projects/selected');
      const matches = [];
      for (const key of (await io.readdir(base)).toSorted()) {
        if (!canonicalNativePath(key) || key.includes('/')) fail('path_invalid');
        const parent = await io.lstat(join(base, key), { bigint: true });
        if (parent.isSymbolicLink() || !parent.isDirectory()) fail('symlink');
        try {
          await io.lstat(join(base, key, `${ctx.nativeSessionId}.jsonl`));
          matches.push(key);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (matches.length !== 1) fail('session_missing');
      metadata.claudeProjectKey = matches[0];
      const selected = `.claude/projects/${matches[0]}/${ctx.nativeSessionId}`;
      await walk('home', `${selected}.jsonl`);
      try {
        await io.lstat(join(home, selected));
        await walk('home', selected);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const extra of [
        `.claude/projects/${matches[0]}/memory`,
        `.claude/tasks/${ctx.nativeSessionId}`,
        `.claude/file-history/${ctx.nativeSessionId}`,
        `.claude/scratch/${ctx.nativeSessionId}`,
        '.claude/plans',
      ]) {
        try {
          await io.lstat(join(home, extra));
          await walk('home', extra);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    } else if (ctx.harness === 'kiro') {
      for (const ext of ['json', 'jsonl'])
        await walk('home', `.kiro/sessions/cli/${ctx.nativeSessionId}.${ext}`);
    } else await walk('home', '.codex/sessions');
    if (totalBytes > limits.maxTotalBytes || files.length > limits.maxFiles) fail('limit');
    validateSession(ctx, files, metadata);
    for (const group of links.values()) {
      if (group.nlink > BigInt(group.paths.length)) {
        // AI-DLC projects hard-link generated projection files to the pinned
        // machine installation. Export their bytes, not the external alias.
        if (
          group.scope !== 'project' ||
          group.paths.some(
            (path) =>
              !/^(?:\.aidlc|\.agents|\.claude|\.codex|\.kiro|\.opencode|aidlc)\//.test(path),
          )
        )
          fail('external_hardlink');
      }
      if (group.paths.length > 1)
        metadata.hardlinks.push({ scope: group.scope, paths: group.paths });
    }
    for (const item of observed.values()) await unchanged(item.scope, item.path, item.stat);
    if (!sameNode(roots.home, await rootStat(home, io))) fail('changed');
    return {
      schemaVersion: 1,
      harness: ctx.harness,
      nativeSessionId: ctx.nativeSessionId,
      files,
      metadata,
      totalBytes,
      exclusions,
    };
  } catch (error) {
    if (error instanceof NativeSessionRecoveryError) throw error;
    fail(error?.code === 'ENOENT' ? 'session_missing' : 'capture_failed');
  }
};

// Node's utimes API converts through floating point seconds. Python's stdlib
// accepts integer nanoseconds, so preserve the committed mtime without rounding.
const restoreTimes = async (roots, entries, signal) =>
  await new Promise((resolvePromise, reject) => {
    const code = [
      'import json,os,sys,stat',
      'v=json.load(sys.stdin)',
      'for e in v["entries"]:',
      ' p=os.path.join(v["roots"][e["scope"]],e["path"])',
      ' s=os.lstat(p)',
      ' if stat.S_ISLNK(s.st_mode): raise RuntimeError("link")',
      ' os.utime(p,ns=(int(e["mtimeNs"]),int(e["mtimeNs"])),follow_symlinks=False)',
    ].join('\n');
    const child = spawn('/usr/bin/python3', ['-I', '-c', code], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false,
    });
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin.on('error', () => {});
    child.once('error', () => {
      signal?.removeEventListener('abort', stop);
      reject(new NativeSessionRecoveryError('native_recovery_time_failed'));
    });
    child.once('close', (status) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new NativeSessionRecoveryError('native_recovery_cancelled'));
      else if (status !== 0) reject(new NativeSessionRecoveryError('native_recovery_time_failed'));
      else resolvePromise();
    });
    child.stdin.end(JSON.stringify({ roots, entries }));
  });

export const restoreNativeSessionRecovery = async (input = {}) => {
  const ctx = context(input);
  const { io, project, home, signal, limits } = ctx;
  try {
    const { metadata, files } = input;
    if (
      !plain(metadata) ||
      metadata.schemaVersion !== 1 ||
      metadata.harness !== ctx.harness ||
      metadata.harnessVersion !== NATIVE_RECOVERY_HARNESS_VERSIONS[ctx.harness] ||
      metadata.nativeSessionId !== ctx.nativeSessionId ||
      metadata.format !== FORMATS[ctx.harness] ||
      metadata.project !== project ||
      metadata.home !== home ||
      !Array.isArray(metadata.directories) ||
      !Array.isArray(metadata.hardlinks) ||
      !Array.isArray(files) ||
      files.length > limits.maxFiles ||
      metadata.hardlinks.length > files.length ||
      metadata.directories.length + files.length > limits.maxEntries
    )
      fail('manifest_invalid');
    const roots = { project: await rootStat(project, io), home: await rootStat(home, io) };
    if ((await io.readdir(project)).length || (await io.readdir(home)).length)
      fail('restore_not_empty');
    const byPath = new Map();
    let total = 0;
    for (const entry of [...metadata.directories, ...files]) {
      abort(signal);
      if (
        !plain(entry) ||
        !['project', 'home'].includes(entry.scope) ||
        !(entry.path === '' || canonicalNativePath(entry.path)) ||
        entry.path.split('/').length > limits.maxDepth ||
        !modeValid(entry.mode) ||
        !nsValid(entry.mtimeNs) ||
        byPath.has(scopePath(entry)) ||
        (entry.scope === 'project' && entry.path && nativeRecoveryProjectExclusion(entry.path))
      )
        fail('manifest_invalid');
      byPath.set(scopePath(entry), entry);
    }
    for (const file of files) {
      if (
        !file.path ||
        !Buffer.isBuffer(file.content) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes !== file.content.length ||
        file.bytes > limits.maxFileBytes ||
        !SHA.test(file.sha256 ?? '') ||
        hash(file.content) !== file.sha256
      )
        fail('manifest_invalid');
      total += file.bytes;
      if (total > limits.maxTotalBytes) fail('limit');
      credentialCheck(ctx, file.content, file.scope === 'project' ? file.path : '');
    }
    validateSession(ctx, files, metadata);
    const links = new Map();
    const fileMap = new Map(files.map((f) => [scopePath(f), f]));
    for (const entry of byPath.values()) {
      const parts = entry.path.split('/');
      for (let length = 1; length < parts.length; length++)
        if (fileMap.has(`${entry.scope}:${parts.slice(0, length).join('/')}`))
          fail('manifest_invalid');
      if (
        entry.scope === 'home' &&
        !fileMap.has(scopePath(entry)) &&
        !homeDirectoryAllowed(ctx.harness, ctx.nativeSessionId, entry.path, metadata)
      )
        fail('home_path_invalid');
    }
    for (const group of metadata.hardlinks) {
      if (
        !plain(group) ||
        !['project', 'home'].includes(group.scope) ||
        !Array.isArray(group.paths) ||
        group.paths.length < 2 ||
        group.paths.length > files.length
      )
        fail('manifest_invalid');
      const first = fileMap.get(`${group.scope}:${group.paths[0]}`);
      if (!first) fail('manifest_invalid');
      for (const path of group.paths) {
        const member = fileMap.get(`${group.scope}:${path}`);
        if (
          !member ||
          links.has(scopePath(member)) ||
          ['sha256', 'bytes', 'mode', 'mtimeNs'].some((k) => member[k] !== first[k])
        )
          fail('manifest_invalid');
        links.set(scopePath(member), first);
      }
    }
    // Parent directories for allowlisted HOME files may not have been part of
    // a full HOME traversal. They are freshly created as private directories.
    for (const directory of metadata.directories.toSorted((a, b) => a.path.length - b.path.length))
      if (directory.path)
        await io.mkdir(join(ctx[directory.scope], directory.path), {
          recursive: true,
          mode: 0o700,
        });
    const written = new Set();
    const orderedFiles = files.toSorted(
      (a, b) =>
        Number(links.has(scopePath(a)) && links.get(scopePath(a)) !== a) -
        Number(links.has(scopePath(b)) && links.get(scopePath(b)) !== b),
    );
    for (const file of orderedFiles) {
      abort(signal);
      const target = join(ctx[file.scope], file.path);
      await io.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const first = links.get(scopePath(file));
      if (first && written.has(scopePath(first)) && first !== file) {
        await io.link(join(ctx[first.scope], first.path), target);
      } else {
        const handle = await io.open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(file.content);
          await handle.chmod(file.mode);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      written.add(scopePath(file));
    }
    for (const directory of metadata.directories)
      if (directory.path)
        await io.chmod(join(ctx[directory.scope], directory.path), directory.mode);
    if (ctx.harness === 'opencode') {
      await ctx.run({
        ...ctx,
        operation: 'opencode-import',
        path: join(home, OPENCODE_EXPORT),
        limit: limits.maxFileBytes,
      });
      const actual = json(
        await ctx.run({ ...ctx, operation: 'opencode-export', limit: limits.maxFileBytes }),
      );
      const expected = json(files.find((f) => f.scope === 'home').content);
      if (
        actual?.info?.id !== ctx.nativeSessionId ||
        actual.info.directory !== project ||
        // OpenCode's real import/export reorders JSON object properties.
        // Values and array order must remain exact; checkpoint bytes stay immutable.
        !isDeepStrictEqual(actual.messages, expected.messages)
      )
        fail('restore_unverified');
      await io.rm(join(home, OPENCODE_EXPORT));
      await io.rmdir(join(home, '.native-recovery'));
    }
    // Never restore credentials or trusted configuration from HOME.
    await io.mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 });
    await io.writeFile(
      join(home, '.codex/config.toml'),
      `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const restoredFiles =
      ctx.harness === 'opencode' ? files.filter((f) => f.scope !== 'home') : files;
    const entries = [
      ...restoredFiles,
      ...metadata.directories.toSorted((a, b) => b.path.length - a.path.length),
    ];
    await (input.restoreTimes ?? restoreTimes)({ project, home }, entries, signal);
    for (const entry of entries) {
      const path = join(ctx[entry.scope], entry.path);
      const stat = await io.lstat(path, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        String(stat.mtimeNs) !== entry.mtimeNs ||
        Number(stat.mode & 0o777n) !== entry.mode ||
        (fileMap.has(scopePath(entry))
          ? !stat.isFile() || hash(await io.readFile(path)) !== entry.sha256
          : !stat.isDirectory())
      )
        fail('restore_unverified');
    }
    for (const group of metadata.hardlinks) {
      const first = await io.lstat(join(ctx[group.scope], group.paths[0]), { bigint: true });
      for (const path of group.paths.slice(1))
        if (!sameNode(first, await io.lstat(join(ctx[group.scope], path), { bigint: true })))
          fail('restore_unverified');
    }
    for (const scope of ['project', 'home']) {
      if (!sameNode(roots[scope], await rootStat(ctx[scope], io))) fail('changed');
      const handle = await io.open(ctx[scope], constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    abort(signal);
    return {
      restored: true,
      harness: ctx.harness,
      nativeSessionId: ctx.nativeSessionId,
      filesCount: files.length,
      totalBytes: total,
    };
  } catch (error) {
    // Partial restores are deliberately left unusable (non-empty). The caller
    // must discard the staging roots, never retry into them or start a writer.
    if (error instanceof NativeSessionRecoveryError) throw error;
    fail('restore_failed');
  }
};
