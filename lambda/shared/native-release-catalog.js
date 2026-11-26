import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { NativeReleaseSelectionError, selectNativeRelease } from './native-release-selection.js';
import { workflowSourceIdentity } from './workflow-source-bindings.js';

const PAGE_SIZE = 100;
const MAX_ENTRIES = 10_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TAG_OBJECTS = 8;
const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
const ORIGINS = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com/api/v4',
  bitbucket: 'https://api.bitbucket.org/2.0',
};
const MESSAGES = {
  native_release_catalog_invalid: 'Invalid native release catalog metadata',
  native_release_catalog_unavailable: 'Native release catalog could not be read',
  native_release_catalog_incomplete: 'Native release catalog exceeds discovery limits',
  native_release_catalog_unsupported: 'Native release asset route is unsupported',
  native_release_assets_unavailable: 'The selected native release is missing required assets',
  native_release_pin_mismatch: 'The published native release does not match its source tag',
  native_release_selection_invalid: 'Invalid native release selection metadata',
  native_release_discovery_incomplete: 'Complete release discovery is required',
  native_release_not_found: 'No matching native release was discovered in this source',
  native_release_not_selectable: 'The requested release is unpublished or a draft',
};

export class NativeReleaseCatalogError extends Error {
  constructor(code = 'native_release_catalog_invalid') {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'native_release_catalog_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'NativeReleaseCatalogError';
    this.code = safeCode;
  }
}

const fail = (code) => {
  throw new NativeReleaseCatalogError(code);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const safeName = (value) => matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]*$/) && value.length <= 255;
const tagName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  [...value].every((c) => c.codePointAt(0) > 32 && c.codePointAt(0) !== 127 && !/\s/u.test(c));
const commitId = (value) => matches(value, /^[a-f0-9]{40}$/);
const numericId = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (matches(value, /^[1-9][0-9]{0,19}$/)) return value;
  fail();
};
const timestamp = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !matches(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail();
  }
  return Date.parse(value);
};
const requiredNames = (version) => [
  'version.json',
  'checksums.txt',
  'aidlc-linux-arm64',
  `aidlc-runtime-${version}.tar.gz`,
];

// Provider cursors are inspected, never followed. Only numbered pagination on
// the same API route is supported. Opaque cursors need an explicit new adapter.
const pageNumber = (url, provider, endpoint, pageKey) => {
  if (typeof url !== 'string' || url.length > 4096) fail();
  const parsed = new URL(url);
  const expected = new URL(`${ORIGINS[provider]}${endpoint}`);
  if (
    parsed.origin !== expected.origin ||
    parsed.pathname !== expected.pathname ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((key) => !['page', pageKey].includes(key)) ||
    parsed.searchParams.getAll('page').length !== 1 ||
    parsed.searchParams.getAll(pageKey).length > 1 ||
    (parsed.searchParams.has(pageKey) && parsed.searchParams.get(pageKey) !== String(PAGE_SIZE))
  ) {
    fail();
  }
  const page = parsed.searchParams.get('page');
  if (!matches(page, /^[1-9][0-9]{0,5}$/)) fail();
  return Number(page);
};

const nextPage = ({ provider, endpoint, page, headers, data, entries }) => {
  if (!headers || typeof headers.get !== 'function') fail();
  let next;
  if (provider === 'github') {
    const link = headers.get('link');
    if (link !== null) {
      if (link.length > 8192) fail();
      const relations = new Set();
      next = false;
      for (const part of link.split(',')) {
        const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
        if (!match || relations.has(match[2])) fail();
        relations.add(match[2]);
        const linkedPage = pageNumber(match[1], provider, endpoint, 'per_page');
        if (match[2] === 'next') {
          if (linkedPage !== page + 1) fail();
          next = true;
        }
        if (match[2] === 'last' && linkedPage > page && !link.includes('rel="next"')) fail();
      }
    }
  } else if (provider === 'gitlab') {
    const current = headers.get('x-page');
    const perPage = headers.get('x-per-page');
    if (
      (current !== null && current !== String(page)) ||
      (perPage !== null && perPage !== String(PAGE_SIZE))
    ) {
      fail();
    }
    const nextHeader = headers.get('x-next-page');
    if (nextHeader !== null) {
      if (nextHeader !== '' && nextHeader !== String(page + 1)) fail();
      next = nextHeader !== '';
    }
    const totalPages = headers.get('x-total-pages');
    if (totalPages !== null) {
      if (!matches(totalPages, /^(?:0|[1-9][0-9]{0,5})$/)) fail();
      if (Number(totalPages) < page && entries.length > 0) fail();
      const more = Number(totalPages) > page;
      if (next !== undefined && next !== more) fail();
      next = more;
    }
  } else {
    if (
      (data.page !== undefined && data.page !== page) ||
      (data.pagelen !== undefined && data.pagelen !== PAGE_SIZE)
    ) {
      fail();
    }
    next = data.next !== undefined && data.next !== null;
    if (next && pageNumber(data.next, provider, endpoint, 'pagelen') !== page + 1) fail();
  }
  if (next && entries.length === 0) fail();
  return next ?? entries.length === PAGE_SIZE;
};

const json = async (transport, path) => {
  const response = await transport.json(path);
  if (!record(response) || !Object.hasOwn(response, 'data')) fail();
  return response;
};

const collect = async (transport, provider, endpoint) => {
  const rows = [];
  const pageKey = provider === 'bitbucket' ? 'pagelen' : 'per_page';
  let expectedCount;
  // The extra empty request permits exactly 10,000 entries when pagination
  // headers are absent. No partial inventory is ever returned as complete.
  for (let page = 1; page <= MAX_ENTRIES / PAGE_SIZE + 1; page += 1) {
    const { data, headers } = await json(
      transport,
      `${endpoint}?${pageKey}=${PAGE_SIZE}&page=${page}`,
    );
    if (provider === 'bitbucket' && !record(data)) fail();
    const entries = provider === 'bitbucket' ? data.values : data;
    if (
      !Array.isArray(entries) ||
      entries.length > PAGE_SIZE ||
      entries.some((entry) => !record(entry))
    ) {
      fail();
    }
    const total =
      provider === 'bitbucket'
        ? data.size
        : provider === 'gitlab'
          ? (headers?.get?.('x-total') ?? undefined)
          : undefined;
    if (total !== undefined) {
      if (
        (provider === 'bitbucket' && (!Number.isSafeInteger(total) || total < 0)) ||
        (provider === 'gitlab' && !matches(total, /^(?:0|[1-9][0-9]{0,9})$/))
      ) {
        fail();
      }
      const count = Number(total);
      if (count > MAX_ENTRIES) fail('native_release_catalog_incomplete');
      if (expectedCount !== undefined && expectedCount !== count) fail();
      expectedCount = count;
    }
    rows.push(...entries);
    if (rows.length > MAX_ENTRIES) fail('native_release_catalog_incomplete');
    if (expectedCount !== undefined && rows.length > expectedCount) fail();
    if (!nextPage({ provider, endpoint, page, headers, data, entries })) {
      if (expectedCount !== undefined && rows.length !== expectedCount) fail();
      return rows;
    }
  }
  fail('native_release_catalog_incomplete');
};

const select = (identity, requestedRelease, candidates) =>
  selectNativeRelease({
    source: identity,
    requestedRelease,
    discovery: { sourceId: identity.sourceId, complete: true, candidates },
  });

const releaseCandidate = (identity, row, now) => {
  if (!tagName(row.tag_name)) fail();
  let releaseId;
  let published;
  let draft = false;
  let prerelease = false;
  if (identity.provider === 'github') {
    releaseId = numericId(row.id);
    if (typeof row.draft !== 'boolean' || typeof row.prerelease !== 'boolean') fail();
    published = row.published_at !== null && timestamp(row.published_at) <= now;
    draft = row.draft;
    prerelease = row.prerelease;
    if (
      row.url !== undefined &&
      (typeof row.url !== 'string' ||
        row.url.toLowerCase() !==
          `${ORIGINS.github}/repos/${identity.repository}/releases/${releaseId}`)
    ) {
      fail();
    }
  } else {
    // GitLab has tag-addressed releases, including non-native tag names.
    releaseId = safeName(row.tag_name)
      ? row.tag_name
      : createHash('sha256').update(row.tag_name).digest('hex');
    if (row.upcoming_release !== undefined && typeof row.upcoming_release !== 'boolean') fail();
    published = timestamp(row.released_at) <= now && row.upcoming_release !== true;
  }
  return {
    sourceId: identity.sourceId,
    releaseId,
    tag: row.tag_name,
    published,
    draft,
    prerelease,
  };
};

const inventory = (rows, withIds) => {
  const names = new Map();
  const ids = new Set();
  for (const row of rows) {
    if (!record(row) || !safeName(row.name) || names.has(row.name)) fail();
    if (withIds) {
      const id = numericId(row.id);
      if (ids.has(id)) fail();
      ids.add(id);
    }
    names.set(row.name, row);
  }
  return names;
};

const assetsFor = (selection, names, locator) => {
  // D17 permits absent signatures. A listed proof is never silently dropped:
  // it goes through the same inventory and locator checks as the core assets.
  // Completed discovery lets intake record absence and compare it on recheck.
  const selectedNames = requiredNames(selection.version);
  if (names.has(ATTESTATION_NAME)) selectedNames.push(ATTESTATION_NAME);
  return Object.freeze(
    selectedNames.map((name) => {
      if (!names.has(name)) fail('native_release_assets_unavailable');
      return Object.freeze({ name, locator: locator(names.get(name)) });
    }),
  );
};

const githubCommit = async (transport, root, tag) => {
  const { data } = await json(transport, `${root}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!record(data) || data.ref !== `refs/tags/${tag}`) fail('native_release_pin_mismatch');
  let object = data.object;
  const seen = new Set();
  for (let depth = 0; depth <= MAX_TAG_OBJECTS; depth += 1) {
    if (!record(object) || !commitId(object.sha)) fail();
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag' || seen.has(object.sha) || depth === MAX_TAG_OBJECTS) fail();
    seen.add(object.sha);
    const { data: annotated } = await json(transport, `${root}/git/tags/${object.sha}`);
    if (!record(annotated) || annotated.sha !== object.sha) fail('native_release_pin_mismatch');
    object = annotated.object;
  }
  fail();
};

const gitlabLocator = (identity, selection, asset) => {
  const value = asset.direct_asset_url;
  if (typeof value !== 'string' || value.length > 2048) fail('native_release_catalog_unsupported');
  const project = `https://gitlab.com/${identity.repository}`;
  const route = `/-/releases/${encodeURIComponent(selection.tag)}/downloads/`;
  if (
    value.slice(0, project.length).toLowerCase() !== project ||
    !value.slice(project.length).startsWith(route)
  ) {
    fail('native_release_catalog_unsupported');
  }
  const parts = value.slice(project.length + route.length).split('/');
  // No query tokens, encoded traversal, foreign project, or arbitrary link.url.
  if (!parts.every(safeName) || parts.at(-1) !== asset.name) {
    fail('native_release_catalog_unsupported');
  }
  return value;
};

const githubOrGitlab = async (identity, requestedRelease, transport, now) => {
  const github = identity.provider === 'github';
  const root = github
    ? `/repos/${identity.repository}`
    : `/projects/${encodeURIComponent(identity.repository)}`;
  const rows = await collect(transport, identity.provider, `${root}/releases`);
  const candidates = rows.map((row) => releaseCandidate(identity, row, now));
  const selection = select(identity, requestedRelease, candidates);
  const selected = rows[candidates.findIndex((row) => row.releaseId === selection.releaseId)];
  let commit;
  let assets;
  if (github) {
    const assetRows = await collect(
      transport,
      'github',
      `${root}/releases/${selection.releaseId}/assets`,
    );
    assets = assetsFor(selection, inventory(assetRows, true), (asset) => {
      if (asset.state !== 'uploaded') fail('native_release_assets_unavailable');
      return `${root}/releases/assets/${numericId(asset.id)}`;
    });
    commit = await githubCommit(transport, root, selection.tag);
  } else {
    if (!record(selected.assets) || !Array.isArray(selected.assets.links)) fail();
    if (selected.assets.links.length > MAX_ENTRIES) fail('native_release_catalog_incomplete');
    assets = assetsFor(selection, inventory(selected.assets.links, true), (asset) =>
      gitlabLocator(identity, selection, asset),
    );
    const { data } = await json(
      transport,
      `${root}/repository/tags/${encodeURIComponent(selection.tag)}`,
    );
    if (
      !record(data) ||
      data.name !== selection.tag ||
      !record(data.commit) ||
      !commitId(data.commit.id)
    ) {
      fail('native_release_pin_mismatch');
    }
    commit = data.commit.id;
  }
  return { selection, commit, assets };
};

const bitbucket = async (identity, requestedRelease, transport) => {
  const root = `/repositories/${identity.repository}`;
  const rows = await collect(transport, 'bitbucket', `${root}/downloads`);
  const names = inventory(rows, false);
  if (!names.has('version.json')) fail('native_release_assets_unavailable');
  const downloaded = await transport.bytes(`${root}/downloads/version.json`, {
    maxBytes: MAX_METADATA_BYTES,
  });
  if (
    !Buffer.isBuffer(downloaded) ||
    downloaded.length === 0 ||
    downloaded.length > MAX_METADATA_BYTES
  ) {
    fail();
  }
  const bytes = Buffer.from(downloaded);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    fail();
  }
  if (!record(manifest) || manifest.schemaVersion !== 1 || !tagName(manifest.version)) fail();
  const tag = `v${manifest.version}`;
  const selection = select(identity, requestedRelease, [
    {
      sourceId: identity.sourceId,
      releaseId: tag,
      tag,
      published: true,
      draft: false,
      prerelease: false,
    },
  ]);
  const assets = assetsFor(selection, names, (asset) => `${root}/downloads/${asset.name}`);
  const { data } = await json(transport, `${root}/refs/tags/${encodeURIComponent(selection.tag)}`);
  if (
    !record(data) ||
    data.name !== selection.tag ||
    !record(data.target) ||
    (data.target.type !== undefined && data.target.type !== 'commit') ||
    !commitId(data.target.hash) ||
    !commitId(manifest.sourceDigest) ||
    manifest.sourceDigest !== data.target.hash ||
    manifest.sourceRef !==
      (selection.channel === 'preview' ? 'refs/heads/main' : `refs/tags/${selection.tag}`)
  ) {
    fail('native_release_pin_mismatch');
  }
  return {
    selection,
    commit: data.target.hash,
    assets,
    initialFiles: Object.freeze({ 'version.json': bytes }),
  };
};

/**
 * Catalog only: injected transport owns credentials, HTTP/redirect policy,
 * deadlines and response byte limits. Paths are relative to its provider API
 * base, except GitLab's source-scoped permanent release download route.
 * Required assets are selected after release selection, without fallback.
 * The attestation is included iff listed; absence is permitted by D17 but does
 * not imply compatibility with an installer that requires a bundle.
 * Neither a catalog result nor a saved rolling manifest verifies package
 * checksums, attestation, continued authorization or live provider support.
 */
export const discoverNativeRelease = async (input = {}) => {
  try {
    if (!record(input) || !record(input.source)) fail();
    const { source, requestedRelease = 'latest', transport, now = Date.now() } = input;
    const identity = workflowSourceIdentity(source.provider, source.repository);
    if (source.sourceId !== undefined && source.sourceId !== identity.sourceId) fail();
    if (
      !record(transport) ||
      typeof transport.json !== 'function' ||
      typeof transport.bytes !== 'function' ||
      !Number.isFinite(now) ||
      now < 0
    ) {
      fail();
    }
    // Validate the requested tag before any I/O using the shared grammar.
    try {
      select(identity, requestedRelease, []);
    } catch (error) {
      if (
        !(error instanceof NativeReleaseSelectionError) ||
        error.code !== 'native_release_not_found'
      ) {
        throw error;
      }
    }
    const result =
      identity.provider === 'bitbucket'
        ? await bitbucket(identity, requestedRelease, transport)
        : await githubOrGitlab(identity, requestedRelease, transport, now);
    return Object.freeze({
      selection: result.selection,
      source: Object.freeze({
        provider: identity.provider,
        repository: identity.repository,
        release: result.selection.tag,
        commit: result.commit,
      }),
      assets: result.assets,
      ...(result.initialFiles ? { initialFiles: result.initialFiles } : {}),
    });
  } catch (error) {
    if (error instanceof NativeReleaseCatalogError) throw error;
    if (error instanceof NativeReleaseSelectionError)
      throw new NativeReleaseCatalogError(error.code);
    if (error?.name === 'WorkflowSourceError' || error instanceof TypeError) {
      throw new NativeReleaseCatalogError();
    }
    throw new NativeReleaseCatalogError('native_release_catalog_unavailable');
  }
};
