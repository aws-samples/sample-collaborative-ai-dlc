import { api } from './api';
import type { Block, BlockType } from './blocks';

// AI-DLC release registry — the typed client over the
// registry routes in lambda/workflows. A "release" is one immutably imported
// upstream AI-DLC methodology closure; the registry decides which releases a
// NEW intent may pin. Nothing here touches execution: an existing intent keeps
// the release it was created with, whatever happens to these records.

export type ReleaseChannelName = 'stable' | 'candidate' | 'preview';

// Admin-decided support ladder. Only `selectable` and `certified` are
// offerable to new intents (and only on a visible + runnable record).
export type ReleaseSupportState =
  | 'importable'
  | 'structurally-valid'
  | 'certified'
  | 'selectable'
  | 'existing-only';

export const SELECTABLE_SUPPORT_STATES: readonly ReleaseSupportState[] = [
  'selectable',
  'certified',
];

// One registered release record (lambda/shared/release-registry.js releaseToApi).
// `releaseId` carries a colon ('aidlc:<sha>') — always percent-encode it in paths.
//
// Two projections share this shape: platform admins get the full record, while
// a non-admin GET /aidlc-releases returns only the selection fields (releaseId,
// upstreamVersion, upstreamChannel, profileId, supportState, trustTier,
// visible, runnable, certifiedAt, constructionAutonomy). Everything else is therefore optional —
// selection UIs (NewIntentPage) must not rely on the admin-only fields.
export interface AidlcRelease {
  releaseId: string;
  sourceSha?: string;
  importerRevision?: number;
  closureDigest?: string;
  manifestKey?: string;
  catalogKey?: string;
  profileId: string;
  // Provenance of the imported closure. A custom fork records its own
  // `owner/name`; an official import records 'awslabs/aidlc-workflows'. Optional
  // so a record written before custom forks existed still types cleanly; absent
  // is treated as "not custom".
  sourceRepository?: string | null;
  custom?: boolean;
  upstreamVersion: string | null;
  upstreamChannel: string | null;
  trustTier: string | null;
  supportState: ReleaseSupportState;
  structurallyValid?: boolean;
  visible: boolean;
  // Decided at registration and never patchable directly. A custom/T0 fork
  // starts import-only and becomes runnable only when an admin promotes it
  // through the same fidelity guard as an official release.
  runnable: boolean;
  // Whether the release authors the construction autonomy protocol, so an
  // intent pinned to it may be created with an autonomous grant.
  constructionAutonomy?: boolean;
  notes?: string | null;
  registeredAt?: string | null;
  registeredBy?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  // Omitted (not null) by releaseToSelectionApi when the record was never
  // certified, so the key itself is optional.
  certifiedAt?: string | null;
  certifiedBy?: string | null;
  // Admin-only. True when the record points at a closure an OLDER importer
  // revision produced: it still resolves for pinned intents, but new intents
  // miss every field later mappers learned until the closure is upgraded.
  importerStale?: boolean;
  importerHistory?: ReleaseImporterUpgrade[];
  // Analyzer evidence captured from the immutable closure at registration.
  // The runtime-specific subset is null on older records and is recomputed
  // before any promotion or channel move.
  fidelityGaps?: ReleaseFidelityGap[] | null;
  unhonouredValues?: ReleaseFidelityGap[] | null;
  // True when `fidelityGaps` is a verdict an EARLIER build stored: a listing
  // recomputes only what it can afford per call. Such a list may name behavior
  // this build now honours, so it must not be shown as a promotion blocker —
  // the server re-verifies the closure before it decides.
  fidelityEvidenceStale?: boolean;
  revision?: number;
}

export interface ReleaseFidelityGap {
  blockType: string;
  field: string;
  value: string;
}

// One closure pointer a release record has held (release-registry.js
// `closurePointer`).
export interface ReleaseClosurePointer {
  importerRevision: number;
  closureDigest: string;
  manifestKey: string;
  catalogKey: string;
}

// One audited closure upgrade: the pointer before and after, and who moved it.
export interface ReleaseImporterUpgrade {
  from: ReleaseClosurePointer;
  to: ReleaseClosurePointer;
  upgradedAt: string;
  upgradedBy: string | null;
}

// A channel pointer (stable/candidate/preview → one selectable release).
export interface ReleaseChannelPointer {
  channel: ReleaseChannelName;
  releaseId: string;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

// GET /aidlc-release-channels returns the pointer map directly (null = pointer
// unset). `pinningEnabled` mirrors the platform's AIDLC_RELEASE_PINNING flag;
// a backend predating it omits the key — treat absence as unknown, not as off.
export interface ReleaseChannels {
  stable: ReleaseChannelPointer | null;
  candidate: ReleaseChannelPointer | null;
  preview: ReleaseChannelPointer | null;
  pinningEnabled?: boolean;
}

// An allowlisted compatibility profile an admin may register, annotated with
// its publish/registration state (GET /aidlc-release-profiles).
export interface RegistrableProfile {
  profileId: string;
  releaseId: string;
  label: string | null;
  upstreamVersion: string | null;
  upstreamChannel: string | null;
  upstreamRef: string;
  trustTier: string | null;
  currentPlatformBaseline: boolean;
  runnable: boolean;
  published: boolean;
  importerRevision: number;
  registered: boolean;
  // Optional so a backend predating closure upgrades still types cleanly.
  registeredImporterRevision?: number | null;
  importerStale?: boolean;
  supportState: ReleaseSupportState | null;
  revision: number | null;
}

// The three things a custom fork registration needs. `baseProfile` is the
// official profile whose frontmatter dialect the fork is parsed with — it grants
// no trust, and the resulting record is T0 and import-only until promoted.
export interface RegisterCustomReleaseInput {
  repository: string;
  sha: string;
  baseProfile: string;
}

export interface RegisterReleaseResult {
  status: 'registered' | 'already-registered';
  release: AidlcRelease;
}

export interface UpdateReleaseInput {
  // CAS token — the record's current `revision`; a stale value 409s.
  expectedRevision: number;
  supportState?: ReleaseSupportState;
  visible?: boolean;
  notes?: string | null;
}

export interface UpgradeReleaseClosureInput {
  // CAS token — the record's current `revision`; a stale value 409s.
  expectedRevision: number;
  // The importer revision whose published closure the record should point at.
  importerRevision: number;
}

export interface UpgradeReleaseClosureResult {
  status: 'upgraded' | 'already-current';
  release: AidlcRelease;
}

/**
 * True when the release may be offered to a NEW intent. A custom fork is
 * runnable only once an admin has promoted it through the same fidelity guard
 * as an official release, so `runnable` decides for both.
 */
export const isReleaseSelectable = (release: AidlcRelease): boolean =>
  release.runnable && release.visible && SELECTABLE_SUPPORT_STATES.includes(release.supportState);

// The intent pages only need the channels read to learn the pinning flag and
// the stable default, so they share one short-lived lookup instead of calling
// GET /aidlc-release-channels on every mount. Failures are never cached, and a
// channel move or clear drops the cached value.
export const SHARED_CHANNELS_TTL_MS = 30_000;

let sharedChannelsEntry: { request: Promise<ReleaseChannels>; expiresAt: number } | null = null;

const invalidateSharedChannels = () => {
  sharedChannelsEntry = null;
};

const sharedChannels = (): Promise<ReleaseChannels> => {
  if (sharedChannelsEntry && sharedChannelsEntry.expiresAt > Date.now()) {
    return sharedChannelsEntry.request;
  }
  const entry = {
    request: api.get<ReleaseChannels>('/aidlc-release-channels'),
    expiresAt: Date.now() + SHARED_CHANNELS_TTL_MS,
  };
  entry.request.catch(() => {
    if (sharedChannelsEntry === entry) sharedChannelsEntry = null;
  });
  sharedChannelsEntry = entry;
  return entry.request;
};

// ── Release contents (issue #607) ──
//
// A release's closure, read-only: the blocks and the workflow a pinned intent
// resolves. Blocks come back in the GET /blocks/{type} shape, labelled with
// where they came from, so the authoring UI can render them beside the
// mutable library.
export interface ReleaseBlock extends Block {
  source: 'release';
  releaseId: string;
}

export interface ReleaseWorkflowPlacement {
  stageId: string;
  phasePath: string | null;
  order: number;
  scopeMembership: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface ReleaseWorkflow {
  id: string;
  workflowId: string;
  name: string;
  objective: string;
  workflowVersion: number;
  readOnly: true;
  phases: { phaseId: string; path: string | null; name?: string }[];
  placements: ReleaseWorkflowPlacement[];
  scopeRefs: { scopeId: string }[];
  ruleRefs: { ruleId: string; layer: string }[];
  source: 'release';
  releaseId: string;
}

export interface ReleaseContents {
  // The selection projection, for admins and non-admins alike.
  release: AidlcRelease;
  workflow: ReleaseWorkflow | null;
  // Keyed by the lowercase block type; only the requested types are present.
  blocks: Partial<Record<BlockType, ReleaseBlock[]>>;
}

export interface ReleaseBlockDetail {
  block: ReleaseBlock;
  body: string;
  script: string;
}

const releasePath = (releaseId: string) => `/aidlc-releases/${encodeURIComponent(releaseId)}`;

const fetchReleaseContents = (releaseId: string, types?: readonly BlockType[]) => {
  const qs = types?.length ? `?type=${types.map(encodeURIComponent).join(',')}` : '';
  return api.get<ReleaseContents>(`${releasePath(releaseId)}/blocks${qs}`);
};

// A closure never changes under a release id, so the contents only go stale
// when the record's closure is upgraded. A short TTL keeps every picker and
// library tab on one read without pinning an upgraded closure for long.
export const RELEASE_CONTENTS_TTL_MS = 60_000;

const releaseContentsCache = new Map<
  string,
  { request: Promise<ReleaseContents>; expiresAt: number }
>();

const cachedReleaseContents = (releaseId: string, types?: readonly BlockType[]) => {
  const key = `${releaseId}|${types?.toSorted().join(',') ?? '*'}`;
  const cached = releaseContentsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.request;
  const entry = {
    request: fetchReleaseContents(releaseId, types),
    expiresAt: Date.now() + RELEASE_CONTENTS_TTL_MS,
  };
  entry.request.catch(() => {
    if (releaseContentsCache.get(key) === entry) releaseContentsCache.delete(key);
  });
  releaseContentsCache.set(key, entry);
  return entry.request;
};

const invalidateReleaseContents = () => releaseContentsCache.clear();

// The release new intents pin by default, with the requested slice of its
// catalog. Null when pinning is off or no stable release is set, which is
// exactly when the mutable library is what runs, and when the contents can't
// be read: the release is an addition to the authoring UI, never a blocker.
export interface StableReleaseCatalog {
  releaseId: string;
  release: AidlcRelease;
  contents: ReleaseContents;
}

const stableReleaseCatalog = async (
  types?: readonly BlockType[],
): Promise<StableReleaseCatalog | null> => {
  try {
    const channels = await sharedChannels();
    const releaseId = channels.pinningEnabled === true ? channels.stable?.releaseId : null;
    if (!releaseId) return null;
    const contents = await cachedReleaseContents(releaseId, types);
    return { releaseId, release: contents.release, contents };
  } catch {
    return null;
  }
};

// A short human label: the upstream version when the record has one.
export const releaseDisplayLabel = (
  release: Pick<AidlcRelease, 'releaseId' | 'upstreamVersion'>,
) => (release.upstreamVersion ? `AI-DLC ${release.upstreamVersion}` : release.releaseId);

export const aidlcReleasesService = {
  // Non-admins only receive visible + selectable/certified records.
  // `currentImporterRevision` is returned to platform admins only.
  list: () =>
    api.get<{ releases: AidlcRelease[]; currentImporterRevision?: number }>('/aidlc-releases'),
  // Register a PUBLISHED profile (platform-admin). Idempotent per closure.
  register: (profileId: string) =>
    api.post<RegisterReleaseResult>('/aidlc-releases', { profileId }),
  // Register a PUBLISHED custom fork closure (platform-admin). The resulting
  // record is import-only until an admin promotes it through the fidelity guard.
  registerCustom: (input: RegisterCustomReleaseInput) =>
    api.post<RegisterReleaseResult>('/aidlc-releases', { custom: input }),
  // Support-state decision (platform-admin, CAS on expectedRevision).
  update: (releaseId: string, input: UpdateReleaseInput) =>
    api.patch<{ release: AidlcRelease }>(`/aidlc-releases/${encodeURIComponent(releaseId)}`, input),
  // Move the record onto the closure a newer importer revision published for the
  // same source SHA (platform-admin, CAS). Existing intents keep their closure.
  upgradeClosure: (releaseId: string, input: UpgradeReleaseClosureInput) =>
    api
      .patch<UpgradeReleaseClosureResult>(`/aidlc-releases/${encodeURIComponent(releaseId)}`, input)
      .finally(invalidateReleaseContents),
  channels: () => api.get<ReleaseChannels>('/aidlc-release-channels'),
  // Cached channels read for the intent pages (see sharedChannels above).
  sharedChannels,
  invalidateSharedChannels,
  // Move a channel pointer (platform-admin, CAS). `expectedRevision: null` is
  // the explicit "the pointer does not exist yet" assertion.
  setChannel: (channel: ReleaseChannelName, releaseId: string, expectedRevision: number | null) =>
    api
      .put<{ channel: ReleaseChannelPointer }>(
        `/aidlc-release-channels/${encodeURIComponent(channel)}`,
        {
          releaseId,
          expectedRevision,
        },
      )
      .finally(invalidateSharedChannels),
  // Clear a channel pointer entirely (platform-admin, CAS on the pointer's
  // current revision; a stale value 409s).
  clearChannel: (channel: ReleaseChannelName, expectedRevision: number) =>
    api
      .delete(`/aidlc-release-channels/${encodeURIComponent(channel)}`, { expectedRevision })
      .finally(invalidateSharedChannels),
  profiles: () => api.get<{ profiles: RegistrableProfile[] }>('/aidlc-release-profiles'),
  // A release's catalog (read-only). `types` narrows the listing; omitted,
  // every block type is returned. Admins may read any registered release,
  // everybody else only a selectable one.
  contents: (releaseId: string, types?: readonly BlockType[]) =>
    cachedReleaseContents(releaseId, types),
  invalidateContents: invalidateReleaseContents,
  // One catalog block with its digest-verified body and script.
  block: (releaseId: string, type: BlockType, blockId: string) =>
    api.get<ReleaseBlockDetail>(
      `${releasePath(releaseId)}/blocks/${encodeURIComponent(type)}/${encodeURIComponent(blockId)}`,
    ),
  // The stable channel's release and catalog, or null (see above).
  stableCatalog: stableReleaseCatalog,
};
