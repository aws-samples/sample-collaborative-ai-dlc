import { workflowSourceIdentity } from './workflow-source-bindings.js';

const STABLE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const PREVIEW_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.\d{8}\.[1-9]\d*)$/;
const MAX_CANDIDATES = 10_000;

export class NativeReleaseSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeReleaseSelectionError';
    this.code = code;
  }
}

const fail = (code, message) => {
  // Never reflect adapter data, provider responses or credentials in errors.
  throw new NativeReleaseSelectionError(code, message);
};
const invalid = () =>
  fail('native_release_selection_invalid', 'Invalid native release selection metadata');
const incomplete = () =>
  fail('native_release_discovery_incomplete', 'Complete release discovery is required');
const notFound = () =>
  fail('native_release_not_found', 'No matching native release was discovered in this source');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  [...value].every((character) => {
    const code = character.codePointAt(0);
    return code > 32 && code !== 127 && !/\s/u.test(character);
  });
const releaseIdentity = (value) => identifier(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

const sourceIdentity = (source) => {
  if (!record(source)) invalid();
  let identity;
  try {
    identity = workflowSourceIdentity(source.provider, source.repository);
  } catch {
    invalid();
  }
  if (source.sourceId !== undefined && source.sourceId !== identity.sourceId) invalid();
  return identity;
};

const parseTag = (tag) => {
  if (!identifier(tag)) return null;
  // Match the entire input: JS `$` alone can also match before a final newline.
  const stable = STABLE_TAG.exec(tag);
  if (stable?.[0] === tag) {
    return { version: stable[1], channel: 'stable', parts: stable[1].split('.') };
  }
  const preview = PREVIEW_TAG.exec(tag);
  if (preview?.[0] === tag) return { version: preview[1], channel: 'preview' };
  return null;
};

// Compare normalized decimal components without Number precision loss. The
// native version grammar has no Number.MAX_SAFE_INTEGER limit.
const newerStable = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const a = left.parts[index];
    const b = right.parts[index];
    if (a.length !== b.length) return a.length > b.length;
    if (a !== b) return a > b;
  }
  return false;
};

/**
 * Pure adapter contract:
 *
 * source: { provider, repository, sourceId? }
 * requestedRelease: "latest" (default) or an exact native v<version> tag.
 * discovery: {
 *   sourceId, complete: boolean,
 *   candidates: [{ sourceId, releaseId, tag, published: boolean,
 *                  draft: boolean, prerelease: boolean }]
 * }
 *
 * The adapter must use workflowSourceIdentity for every sourceId. releaseId is
 * a stable source-local ASCII identifier (letters/digits/dot/underscore/hyphen;
 * the native tag itself suffices for a provider without release IDs), never a
 * URL, credential or temporary download/asset identity.
 * published=true asserts CURRENT publication evidence in the selected source;
 * a historical git tag or a cached package alone is not a published release.
 * For a rolling Bitbucket package, the visible manifest and matching tag may
 * provide the sole current candidate. No publication history is invented here.
 * complete means all pages of the CURRENT inventory were exhausted. A release
 * still listed as published remains a candidate even if its assets are missing
 * or incompatible. Never mix cached historical packages into this inventory.
 * Inventories larger than 10,000 entries fail; they are never truncated.
 *
 * Latest requires complete discovery. An explicit tag may use a partial
 * discovery containing its unique match; absence on a partial page is unknown.
 * Unpublished entries and drafts are never selected. Latest excludes native
 * previews and host-marked prereleases. Explicit tags allow either.
 * channel describes the native tag grammar; prerelease is true for either a
 * native preview tag or the host's prerelease flag, including stable-shaped tags.
 *
 * This selects identity before any compatibility/asset checks. The resolver
 * must fail unavailable (or use an authorized, previously pinned package) if
 * that exact selection has no bytes. It must not select an older release.
 * Returned metadata is not yet a commit/digest pin or a compatibility claim.
 * Resume uses its existing packageId outside this selector.
 */
export const selectNativeRelease = (input = {}) => {
  if (!record(input)) invalid();
  const { source, requestedRelease = 'latest', discovery } = input;
  const identity = sourceIdentity(source);
  if (requestedRelease !== 'latest' && !parseTag(requestedRelease)) invalid();
  if (
    !record(discovery) ||
    discovery.sourceId !== identity.sourceId ||
    typeof discovery.complete !== 'boolean' ||
    !Array.isArray(discovery.candidates) ||
    discovery.candidates.length > MAX_CANDIDATES
  ) {
    invalid();
  }

  const ids = new Set();
  const tags = new Set();
  let selected = null;
  for (const candidate of discovery.candidates) {
    if (
      !record(candidate) ||
      candidate.sourceId !== identity.sourceId ||
      !releaseIdentity(candidate.releaseId) ||
      !identifier(candidate.tag) ||
      typeof candidate.published !== 'boolean' ||
      typeof candidate.draft !== 'boolean' ||
      typeof candidate.prerelease !== 'boolean' ||
      ids.has(candidate.releaseId) ||
      tags.has(candidate.tag)
    ) {
      invalid();
    }
    ids.add(candidate.releaseId);
    tags.add(candidate.tag);
    const parsed = parseTag(candidate.tag);
    if (!parsed) continue;
    const normalized = {
      releaseId: candidate.releaseId,
      tag: candidate.tag,
      published: candidate.published,
      draft: candidate.draft,
      prerelease: candidate.prerelease,
      ...parsed,
    };
    if (requestedRelease !== 'latest') {
      if (candidate.tag === requestedRelease) selected = normalized;
    } else if (
      candidate.published &&
      !candidate.draft &&
      !candidate.prerelease &&
      parsed.channel === 'stable' &&
      (!selected || newerStable(normalized, selected))
    ) {
      selected = normalized;
    }
  }

  if (requestedRelease === 'latest' && !discovery.complete) incomplete();
  if (!selected) {
    if (!discovery.complete) incomplete();
    notFound();
  }
  if (!selected.published || selected.draft) {
    fail('native_release_not_selectable', 'The requested release is unpublished or a draft');
  }
  return Object.freeze({
    source: identity,
    requestedRelease,
    releaseId: selected.releaseId,
    tag: selected.tag,
    version: selected.version,
    channel: selected.channel,
    prerelease: selected.prerelease || selected.channel === 'preview',
  });
};
