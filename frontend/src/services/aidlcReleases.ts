import { api } from './api';

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
// visible, runnable, certifiedAt). Everything else is therefore optional —
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
  // Provenance property decided at registration, never patchable: custom/T0
  // content is import-only and can never be offered to a new intent.
  runnable: boolean;
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
// no trust, and the resulting record is always T0 / import-only.
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
 * True when the release may be offered to a NEW intent. `custom` is checked
 * independently of `runnable` so a future backend that forgot to clear one flag
 * still cannot get a fork into a selector.
 */
export const isReleaseSelectable = (release: AidlcRelease): boolean =>
  release.runnable &&
  !release.custom &&
  release.visible &&
  SELECTABLE_SUPPORT_STATES.includes(release.supportState);

export const aidlcReleasesService = {
  // Non-admins only receive visible + selectable/certified records.
  // `currentImporterRevision` is returned to platform admins only.
  list: () =>
    api.get<{ releases: AidlcRelease[]; currentImporterRevision?: number }>('/aidlc-releases'),
  // Register a PUBLISHED profile (platform-admin). Idempotent per closure.
  register: (profileId: string) =>
    api.post<RegisterReleaseResult>('/aidlc-releases', { profileId }),
  // Register a PUBLISHED custom fork closure (platform-admin). The resulting
  // record is import-only: it can never be made selectable or hold a channel.
  registerCustom: (input: RegisterCustomReleaseInput) =>
    api.post<RegisterReleaseResult>('/aidlc-releases', { custom: input }),
  // Support-state decision (platform-admin, CAS on expectedRevision).
  update: (releaseId: string, input: UpdateReleaseInput) =>
    api.patch<{ release: AidlcRelease }>(`/aidlc-releases/${encodeURIComponent(releaseId)}`, input),
  // Move the record onto the closure a newer importer revision published for the
  // same source SHA (platform-admin, CAS). Existing intents keep their closure.
  upgradeClosure: (releaseId: string, input: UpgradeReleaseClosureInput) =>
    api.patch<UpgradeReleaseClosureResult>(
      `/aidlc-releases/${encodeURIComponent(releaseId)}`,
      input,
    ),
  channels: () => api.get<ReleaseChannels>('/aidlc-release-channels'),
  // Move a channel pointer (platform-admin, CAS). `expectedRevision: null` is
  // the explicit "the pointer does not exist yet" assertion.
  setChannel: (channel: ReleaseChannelName, releaseId: string, expectedRevision: number | null) =>
    api.put<{ channel: ReleaseChannelPointer }>(
      `/aidlc-release-channels/${encodeURIComponent(channel)}`,
      {
        releaseId,
        expectedRevision,
      },
    ),
  // Clear a channel pointer entirely (platform-admin, CAS on the pointer's
  // current revision; a stale value 409s).
  clearChannel: (channel: ReleaseChannelName, expectedRevision: number) =>
    api.delete(`/aidlc-release-channels/${encodeURIComponent(channel)}`, { expectedRevision }),
  profiles: () => api.get<{ profiles: RegistrableProfile[] }>('/aidlc-release-profiles'),
};
