// The release registry and channel pointers.
//
// The importer publishes an immutable release closure to S3; the runtime resolves
// a pin on an execution META row back into that closure. Neither answers the product
// question "which published releases MAY a new intent be created against?".
// This module owns exactly that decision and nothing else.
//
// The registry is therefore a SELECTION gate, not an execution input. The
// execution path (release-resolver.js) never reads a registry row: an existing
// intent keeps resolving its pinned closure even after its release is demoted,
// hidden, or moved to `existing-only`. Demoting a release changes what NEW
// intents may pick; it must never change what an existing intent runs.
//
// Two item shapes live in the BLOCKS table:
//
//   pk `AIDLC_RELEASE#<releaseId>`         sk `META`  the release record
//   pk `AIDLC_RELEASE_CHANNEL#<channel>`   sk `META`  a channel pointer
//
// Release records are listable through GSI1 (`AIDLC_RELEASES`), ordered by a
// zero-padded upstream version so a lexicographic index scan is also a version
// ordering. Every mutation is a compare-and-swap on an integer `revision`, so
// two concurrent admins cannot silently clobber one another's decision.
//
// Clients are injected (shared/ is a leaf foundation, see .dependency-cruiser.cjs).

import { Logger } from '@aws-lambda-powertools/logger';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  readReleaseFidelityGaps,
  readReleaseManifest,
  releaseCatalogKey,
  releaseKeyArgs,
  releaseManifestKey,
} from './aidlc-release.js';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  OFFICIAL_AIDLC_REPOSITORY,
  customProfile,
  profileFor,
} from './aidlc-compatibility-profiles.js';
import { unhonouredValues } from './aidlc-capabilities.js';

const logger = new Logger({ persistentKeys: { component: 'release-registry' } });

const META = 'META';
const RELEASE_PK_PREFIX = 'AIDLC_RELEASE#';
const CHANNEL_PK_PREFIX = 'AIDLC_RELEASE_CHANNEL#';
const RELEASES_GSI1PK = 'AIDLC_RELEASES';

const RELEASE_ITEM_TYPE = 'AidlcRelease';
const CHANNEL_ITEM_TYPE = 'AidlcReleaseChannel';

// The compatibility vocabulary (docs/concepts/aidlc-release-compatibility.md). These
// states are not a ladder the registry may infer: `certified` and `selectable`
// are explicit product decisions, and `existing-only` is the safe state for a
// release that must stay resolvable without being offered again.
const SUPPORT_STATES = Object.freeze([
  'importable',
  'structurally-valid',
  'certified',
  'selectable',
  'existing-only',
]);

// The only two states a new intent may be created against.
const SELECTABLE_SUPPORT_STATES = Object.freeze(['selectable', 'certified']);

const RELEASE_CHANNELS = Object.freeze(['stable', 'candidate', 'preview']);

const VERSION_SEGMENT_WIDTH = 6;

class ReleaseRegistryError extends Error {
  constructor(code, message, { cause, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ReleaseRegistryError';
    this.code = code;
    this.details = details;
  }
}

const isReleaseRegistryError = (error) => error instanceof ReleaseRegistryError;

const isConditionalCheckFailed = (error) => error?.name === 'ConditionalCheckFailedException';

const isTransactionCancelled = (error) => error?.name === 'TransactionCanceledException';

const releasePk = (releaseId) => `${RELEASE_PK_PREFIX}${releaseId}`;
const channelPk = (channel) => `${CHANNEL_PK_PREFIX}${channel}`;

/**
 * Zero-pads the numeric segments of an upstream version so the GSI1 sort key
 * orders `2.10.0` after `2.9.0` instead of before it. Non-numeric segments are
 * kept verbatim: they are labels, and the release id is the tiebreaker anyway.
 */
const paddedUpstreamVersion = (upstreamVersion) =>
  String(upstreamVersion ?? '')
    .split('.')
    .map((segment) =>
      /^\d+$/.test(segment) ? segment.padStart(VERSION_SEGMENT_WIDTH, '0') : segment,
    )
    .join('.');

const releaseGsi1Sk = ({ upstreamVersion, releaseId }) =>
  `${paddedUpstreamVersion(upstreamVersion)}#${releaseId}`;

const nowIso = () => new Date().toISOString();

const assertChannel = (channel) => {
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new ReleaseRegistryError(
      'release_channel_invalid',
      `release-registry: channel must be one of ${RELEASE_CHANNELS.join(', ')}`,
      { details: { channel: String(channel ?? '') } },
    );
  }
  return channel;
};

const assertSupportState = (supportState) => {
  if (!SUPPORT_STATES.includes(supportState)) {
    throw new ReleaseRegistryError(
      'release_state_invalid',
      `release-registry: supportState must be one of ${SUPPORT_STATES.join(', ')}`,
      { details: { supportState: String(supportState ?? '') } },
    );
  }
  return supportState;
};

const assertRevision = (revision, field) => {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ReleaseRegistryError(
      'release_revision_invalid',
      `release-registry: ${field} must be a positive integer`,
      { details: { [field]: revision ?? null } },
    );
  }
  return revision;
};

/**
 * Runnability is a property of provenance, decided once at registration and
 * never patchable: only an allowlisted official profile above T0 may ever be
 * offered for a new intent. Custom, preview, and T0 content stays non-runnable
 * however complete its files look.
 */
const profileIsRunnable = (profile) => Boolean(profile) && profile.trustTier !== 'T0';

const isImporterStale = (item) =>
  Number(item?.importerRevision ?? AIDLC_RELEASE_IMPORTER_REVISION) <
  AIDLC_RELEASE_IMPORTER_REVISION;

const releaseToApi = (item) =>
  item
    ? {
        releaseId: item.releaseId,
        sourceSha: item.sourceSha,
        importerRevision: item.importerRevision,
        closureDigest: item.closureDigest,
        manifestKey: item.manifestKey,
        catalogKey: item.catalogKey,
        profileId: item.profileId,
        sourceRepository: item.sourceRepository ?? null,
        custom: item.custom === true,
        upstreamVersion: item.upstreamVersion ?? null,
        upstreamChannel: item.upstreamChannel ?? null,
        trustTier: item.trustTier ?? null,
        supportState: item.supportState,
        structurallyValid: item.structurallyValid === true,
        visible: item.visible === true,
        runnable: item.runnable === true,
        notes: item.notes ?? null,
        registeredAt: item.registeredAt ?? null,
        registeredBy: item.registeredBy ?? null,
        updatedAt: item.updatedAt ?? null,
        updatedBy: item.updatedBy ?? null,
        certifiedAt: item.certifiedAt ?? null,
        certifiedBy: item.certifiedBy ?? null,
        // A closure produced by an older importer revision still resolves (its
        // pins are immutable), but new intents created against it miss every
        // field later mappers learned. Surfaced so an admin can upgrade it.
        importerStale: isImporterStale(item),
        importerHistory: item.importerHistory ?? [],
        fidelityGaps: Array.isArray(item.fidelityGaps) ? item.fidelityGaps : null,
        unhonouredValues: Array.isArray(item.fidelityGaps)
          ? unhonouredValues({ fidelityGaps: item.fidelityGaps })
          : null,
        revision: item.revision ?? 1,
      }
    : null;

/**
 * What a NON-admin is allowed to learn about a release: enough to pick one in
 * the version selector, and nothing else. Storage keys, closure digests, source
 * SHAs, and the Cognito subs of whoever registered or certified it are operator
 * data — they describe the platform's internals, not the user's choice.
 */
const releaseToSelectionApi = (item) =>
  item
    ? {
        releaseId: item.releaseId,
        upstreamVersion: item.upstreamVersion ?? null,
        upstreamChannel: item.upstreamChannel ?? null,
        profileId: item.profileId,
        supportState: item.supportState,
        trustTier: item.trustTier ?? null,
        visible: item.visible === true,
        runnable: item.runnable === true,
        ...(item.certifiedAt ? { certifiedAt: item.certifiedAt } : {}),
      }
    : null;

const channelToApi = (item) =>
  item
    ? {
        channel: item.channel,
        releaseId: item.releaseId,
        revision: item.revision ?? 1,
        updatedAt: item.updatedAt ?? null,
        updatedBy: item.updatedBy ?? null,
      }
    : null;

const channelToSelectionApi = (item) =>
  item ? { channel: item.channel, releaseId: item.releaseId, revision: item.revision ?? 1 } : null;

/**
 * The execution-level pin a selected release stamps onto an intent's META row.
 * Identical in shape to `methodologyReleasePinFromManifest` (release-resolver),
 * because the runtime re-verifies every field of it against the manifest.
 */
const releasePinFromRecord = (release) => ({
  releaseId: release.releaseId,
  sourceSha: release.sourceSha,
  importerRevision: release.importerRevision,
  closureDigest: release.closureDigest,
  catalogKey: release.catalogKey,
  manifestKey: release.manifestKey,
});

const getRelease = async ({ ddb, tableName, releaseId }) => {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk: releasePk(releaseId), sk: META } }),
  );
  return Item ?? null;
};

const getChannel = async ({ ddb, tableName, channel }) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: channelPk(assertChannel(channel)), sk: META },
    }),
  );
  return Item ?? null;
};

const getChannels = async ({ ddb, tableName, selectionOnly = false }) => {
  const items = await Promise.all(
    RELEASE_CHANNELS.map((channel) => getChannel({ ddb, tableName, channel })),
  );
  const project = selectionOnly ? channelToSelectionApi : channelToApi;
  const byChannel = {};
  for (const [index, channel] of RELEASE_CHANNELS.entries()) {
    byChannel[channel] = project(items[index]);
  }
  return byChannel;
};

/**
 * Lists every registered release, oldest upstream version first. `visibleOnly`
 * is the non-admin projection: a user may only see what they could actually
 * select, so importable/structurally-valid/existing-only or hidden records are
 * withheld rather than shown as if they were runnable — and the records that DO
 * come back carry only the selection fields (see `releaseToSelectionApi`).
 */
const listReleases = async ({ ddb, tableName, visibleOnly = false }) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': RELEASES_GSI1PK },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items
    .filter(
      (item) =>
        !visibleOnly ||
        (item.visible === true && SELECTABLE_SUPPORT_STATES.includes(item.supportState)),
    )
    .toSorted(
      (left, right) =>
        releaseGsi1Sk(left).localeCompare(releaseGsi1Sk(right)) ||
        left.releaseId.localeCompare(right.releaseId),
    )
    .map(visibleOnly ? releaseToSelectionApi : releaseToApi);
};

const assertRegistryStorage = (s3, bucket) => {
  if (!s3 || !bucket) {
    throw new ReleaseRegistryError(
      'release_registry_misconfigured',
      'release-registry: an S3 client and bucket are required to register a release',
    );
  }
};

/**
 * A release record is keyed by the release id, and the profile is what decides
 * runnability, trust tier, and version label. If the published manifest names a
 * different release id than the profile asked for, the row would carry one
 * release's identity with another's provenance.
 */
const assertManifestMatchesProfile = ({ manifest, profile }) => {
  if (manifest.releaseId !== profile.releaseId) {
    throw new ReleaseRegistryError(
      'release_conflict',
      `release-registry: the manifest published for profile ${profile.id} names release ${String(manifest.releaseId)}, not ${profile.releaseId}`,
      {
        details: {
          profileId: profile.id,
          profileReleaseId: profile.releaseId,
          manifestReleaseId: manifest.releaseId ?? null,
        },
      },
    );
  }
  return manifest;
};

const readVerifiedReleaseFidelityGaps = async ({ s3, bucket, manifest }) => {
  try {
    return await readReleaseFidelityGaps({ s3, bucket, manifest });
  } catch (error) {
    if (error?.name !== 'AidlcReleaseError') throw error;
    throw new ReleaseRegistryError(
      'release_conflict',
      `release-registry: capability evidence for ${manifest.releaseId} could not be verified`,
      {
        cause: error,
        details: { releaseId: manifest.releaseId, verificationCode: error.code },
      },
    );
  }
};

/**
 * Turns a published manifest plus its profile into the registry row and writes
 * it. Shared by the official and custom registration paths so both get the same
 * evidence-only support state, the same idempotency, and the same conflict
 * semantics — runnability is the only thing that differs, and it comes from the
 * profile's trust tier rather than from the caller.
 */
const persistReleaseRecord = async ({
  ddb,
  tableName,
  manifest,
  profile,
  s3,
  bucket,
  actor = null,
}) => {
  assertManifestMatchesProfile({ manifest, profile });
  const structurallyValid = manifest.compatibility?.structurallyValid === true;
  const fidelityGaps = await readVerifiedReleaseFidelityGaps({ s3, bucket, manifest });
  const keyArgs = releaseKeyArgs(manifest);
  const now = nowIso();
  const item = {
    pk: releasePk(manifest.releaseId),
    sk: META,
    type: RELEASE_ITEM_TYPE,
    releaseId: manifest.releaseId,
    sourceSha: manifest.sourceSha,
    importerRevision: manifest.importerRevision,
    closureDigest: manifest.closureDigest,
    manifestKey: releaseManifestKey(keyArgs),
    catalogKey: releaseCatalogKey(keyArgs),
    profileId: profile.id,
    sourceRepository: manifest.sourceRepository ?? null,
    custom: profile.custom === true,
    upstreamVersion: profile.upstreamVersion ?? null,
    upstreamChannel: profile.upstreamChannel ?? null,
    trustTier: profile.trustTier ?? null,
    // Evidence only. Structural validity is not certification, so it never
    // reaches `certified` or `selectable` on its own.
    supportState: structurallyValid ? 'structurally-valid' : 'importable',
    structurallyValid,
    fidelityGaps,
    visible: false,
    runnable: profileIsRunnable(profile),
    notes: null,
    registeredAt: now,
    registeredBy: actor,
    updatedAt: now,
    updatedBy: actor,
    certifiedAt: null,
    certifiedBy: null,
    revision: 1,
    GSI1PK: RELEASES_GSI1PK,
    GSI1SK: releaseGsi1Sk({
      upstreamVersion: profile.upstreamVersion,
      releaseId: manifest.releaseId,
    }),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { status: 'registered', release: releaseToApi(item) };
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    const existing = await getRelease({ ddb, tableName, releaseId: manifest.releaseId });
    if (existing?.closureDigest === manifest.closureDigest) {
      return { status: 'already-registered', release: releaseToApi(existing) };
    }
    const upgradeable = Number(existing?.importerRevision ?? 0) < Number(manifest.importerRevision);
    throw new ReleaseRegistryError(
      'release_conflict',
      upgradeable
        ? `release-registry: release ${manifest.releaseId} is registered at importer revision ${existing.importerRevision}; upgrade it to revision ${manifest.importerRevision} instead of re-registering`
        : `release-registry: release ${manifest.releaseId} is already registered with a different closure`,
      {
        cause: error,
        details: {
          releaseId: manifest.releaseId,
          registeredClosureDigest: existing?.closureDigest ?? null,
          publishedClosureDigest: manifest.closureDigest,
          registeredImporterRevision: existing?.importerRevision ?? null,
          publishedImporterRevision: manifest.importerRevision,
        },
      },
    );
  }
};

/**
 * Registers a PUBLISHED release. Registration records evidence; it does not
 * grant selection: the record starts invisible, and its support state is the
 * strongest thing the manifest already proves (structurally-valid at best).
 * Promoting it to certified/selectable is a separate, explicit admin decision.
 *
 * Idempotent: re-registering the same closure returns the existing record.
 * A different closure under the same release id is a conflict, never a
 * silent overwrite of another import's identity.
 */
const registerRelease = async ({ ddb, tableName, s3, bucket, profileId, actor = null }) => {
  const profile = profileFor(profileId);
  if (!profile) {
    throw new ReleaseRegistryError(
      'release_profile_unknown',
      `release-registry: unknown AI-DLC compatibility profile "${String(profileId)}"`,
      { details: { profileId: String(profileId ?? '') } },
    );
  }
  assertRegistryStorage(s3, bucket);
  const importerRevision = AIDLC_RELEASE_IMPORTER_REVISION;
  const manifest = await readReleaseManifest({
    s3,
    bucket,
    sha: profile.upstreamRef,
    importerRevision,
  });
  if (!manifest) {
    throw new ReleaseRegistryError(
      'release_not_published',
      `release-registry: no published release manifest for profile ${profile.id}`,
      { details: { profileId: profile.id, sourceSha: profile.upstreamRef, importerRevision } },
    );
  }
  return persistReleaseRecord({ ddb, tableName, manifest, profile, s3, bucket, actor });
};

/**
 * Registers a PUBLISHED custom fork closure. The record is import-only by
 * construction: the synthesized profile is T0, so `runnable` is false and both
 * `updateRelease` and `setChannel` will refuse to make it offerable. There is
 * deliberately no parameter that could override that.
 */
const registerCustomRelease = async ({
  ddb,
  tableName,
  s3,
  bucket,
  repository,
  sha,
  baseProfileId,
  actor = null,
}) => {
  let profile;
  try {
    profile = customProfile({ repository, sha, baseProfileId });
  } catch (error) {
    throw new ReleaseRegistryError(
      error?.code ?? 'release_custom_source_invalid',
      `release-registry: ${error?.message ?? 'invalid custom source'}`,
      { cause: error, details: error?.details ?? null },
    );
  }
  assertRegistryStorage(s3, bucket);
  const importerRevision = AIDLC_RELEASE_IMPORTER_REVISION;
  const manifest = await readReleaseManifest({
    s3,
    bucket,
    sha: profile.upstreamRef,
    importerRevision,
    custom: true,
    sourceRepository: profile.sourceRepository,
  });
  if (!manifest) {
    throw new ReleaseRegistryError(
      'release_not_published',
      `release-registry: no published custom release manifest for ${profile.sourceRepository}@${profile.upstreamRef}`,
      {
        details: {
          repository: profile.sourceRepository,
          sourceSha: profile.upstreamRef,
          importerRevision,
        },
      },
    );
  }
  if (manifest.custom !== true || manifest.sourceRepository !== profile.sourceRepository) {
    throw new ReleaseRegistryError(
      'release_conflict',
      `release-registry: the manifest at the custom prefix for ${profile.sourceRepository} does not describe that custom source`,
      {
        details: {
          repository: profile.sourceRepository,
          manifestRepository: manifest.sourceRepository ?? null,
          custom: manifest.custom === true,
        },
      },
    );
  }
  return persistReleaseRecord({ ddb, tableName, manifest, profile, s3, bucket, actor });
};

const fidelityGapsForRecord = async ({ release, s3, bucket }) => {
  if (Array.isArray(release.fidelityGaps)) return release.fidelityGaps;

  try {
    assertRegistryStorage(s3, bucket);
    const manifest = await readReleaseManifest({
      s3,
      bucket,
      sha: release.sourceSha,
      importerRevision: Number(release.importerRevision ?? AIDLC_RELEASE_IMPORTER_REVISION),
      custom: release.custom === true,
      sourceRepository: release.custom === true ? release.sourceRepository : null,
    });
    if (!manifest) throw new Error('The registered closure has no published manifest.');
    const mismatched = [
      ['releaseId', manifest.releaseId, release.releaseId],
      ['sourceSha', manifest.sourceSha, release.sourceSha],
      [
        'importerRevision',
        Number(manifest.importerRevision),
        Number(release.importerRevision ?? AIDLC_RELEASE_IMPORTER_REVISION),
      ],
      ['closureDigest', manifest.closureDigest, release.closureDigest],
      ['catalogKey', manifest.catalog.key, release.catalogKey],
      ['manifestKey', releaseManifestKey(releaseKeyArgs(manifest)), release.manifestKey],
    ].filter(([, published, registered]) => published !== registered);
    if (mismatched.length > 0) {
      throw new ReleaseRegistryError(
        'release_conflict',
        `release-registry: the published closure does not match the registry record for ${release.releaseId}`,
        { details: { releaseId: release.releaseId, fields: mismatched.map(([field]) => field) } },
      );
    }
    return await readVerifiedReleaseFidelityGaps({ s3, bucket, manifest });
  } catch (error) {
    if (isReleaseRegistryError(error)) throw error;
    throw new ReleaseRegistryError(
      'release_capability_unhandled',
      `release-registry: cannot verify authored behavior for ${release.releaseId}; promotion is refused`,
      { cause: error, details: { gaps: [], verificationError: true } },
    );
  }
};

const assertFidelityGapsHonoured = ({ release, fidelityGaps }) => {
  const gaps = unhonouredValues({ fidelityGaps });
  if (gaps.length > 0) {
    throw new ReleaseRegistryError(
      'release_capability_unhandled',
      `release-registry: ${release.releaseId} authors behavior this build cannot honour`,
      { details: { gaps } },
    );
  }
  return fidelityGaps;
};

const assertReleaseCapabilitiesHonoured = async ({ release, s3, bucket }) =>
  assertFidelityGapsHonoured({
    release,
    fidelityGaps: await fidelityGapsForRecord({ release, s3, bucket }),
  });

const isSelectableRecord = (release) =>
  release?.runnable === true &&
  release?.visible === true &&
  SELECTABLE_SUPPORT_STATES.includes(release?.supportState);

/**
 * `stable` is what every auto-pinned intent gets, so it is held to certification
 * — with one documented exception: the profile that is the platform's current
 * baseline (`currentPlatformBaseline`) is already what unpinned intents run, so
 * requiring fresh T3 evidence before it may be named `stable` would leave the
 * channel empty and make the default worse than the status quo.
 */
const isStableEligible = (release) =>
  release?.supportState === 'certified' ||
  profileFor(release?.profileId)?.currentPlatformBaseline === true;

const satisfiesChannel = (release, channel) =>
  isSelectableRecord(release) && (channel !== 'stable' || isStableEligible(release));

/**
 * Which channels a proposed record state would BREAK. A channel pointer is a
 * hard promise that its target is selectable: `resolveSelectableRelease` and the
 * whole intent-creation path read it. Demoting or hiding a channel target
 * therefore does not "just change what new intents may pick" — it stops every
 * new intent from being created at all, which is why this is refused rather
 * than allowed with a warning.
 *
 * `current` makes the test a WORSENING test rather than an absolute one. A record
 * that is already unselectable (an import-only `runnable: false` release a
 * channel was somehow pointed at) has already broken the channel, and refusing a
 * neutral `notes` patch on it would leave the record permanently unfixable while
 * the channel stays broken either way. Only a patch that takes a channel from
 * satisfied to unsatisfied is refused.
 */
const channelsBrokenBy = (next, channelsByName, current = null) =>
  Object.entries(channelsByName ?? {})
    .filter(([channel, pointer]) => {
      if (pointer?.releaseId !== next.releaseId) return false;
      if (current && !satisfiesChannel(current, channel)) return false;
      return !satisfiesChannel(next, channel);
    })
    .map(([channel]) => channel);

const assertSelectableRecord = (release) => {
  if (!isSelectableRecord(release)) {
    throw new ReleaseRegistryError(
      'release_not_selectable',
      `release-registry: release ${release.releaseId} is not selectable for new intents`,
      {
        details: {
          releaseId: release.releaseId,
          supportState: release.supportState,
          visible: release.visible === true,
          runnable: release.runnable === true,
        },
      },
    );
  }
  return release;
};

/**
 * Only a support decision is patchable: `supportState`, `visible`, `notes`.
 * Identity, provenance, and runnability are import evidence and are immutable.
 *
 * `selectable` and `certified` both require a runnable, structurally-valid
 * release — the registry refuses to make importable or non-allowlisted content
 * offerable no matter what the caller asks for.
 *
 * A transition that would STRAND a channel pointer — taking it from satisfied to
 * unsatisfied (non-selectable, or for `stable` non-certifiable) — is refused with
 * `release_channel_pinned`. A patch that leaves an already-stranded pointer no
 * worse off is allowed, so a record a channel is wrongly pointed at can still be
 * annotated or corrected. The channel rows are re-asserted inside the write
 * transaction, so a concurrent `setChannel` cannot slip a pointer onto the
 * release between the check and the write.
 */
const updateRelease = async ({
  ddb,
  tableName,
  s3,
  bucket,
  releaseId,
  expectedRevision,
  patch = {},
  actor = null,
}) => {
  assertRevision(expectedRevision, 'expectedRevision');
  const current = await getRelease({ ddb, tableName, releaseId });
  if (!current) {
    throw new ReleaseRegistryError(
      'release_not_found',
      `release-registry: release ${String(releaseId)} is not registered`,
      { details: { releaseId: String(releaseId ?? '') } },
    );
  }

  const next = { ...current };
  if (patch.supportState !== undefined) {
    const supportState = assertSupportState(patch.supportState);
    next.supportState = supportState;
    // `certified` is a reviewer's label, so record who claimed it and when —
    // and drop the claim on the way out, so a re-promotion cannot inherit stale
    // certification evidence from a decision that was already revoked.
    if (supportState === 'certified') {
      next.certifiedAt = nowIso();
      next.certifiedBy = actor;
    } else if (current.supportState === 'certified') {
      next.certifiedAt = null;
      next.certifiedBy = null;
    }
  }
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== 'boolean') {
      throw new ReleaseRegistryError(
        'release_state_invalid',
        'release-registry: visible must be a boolean',
      );
    }
    next.visible = patch.visible;
  }
  if (patch.notes !== undefined) {
    if (patch.notes !== null && typeof patch.notes !== 'string') {
      throw new ReleaseRegistryError(
        'release_state_invalid',
        'release-registry: notes must be a string or null',
      );
    }
    next.notes = patch.notes;
  }

  const supportStatePromotion =
    patch.supportState !== undefined && SELECTABLE_SUPPORT_STATES.includes(next.supportState);
  const visibilityPromotion =
    patch.visible === true &&
    current.visible !== true &&
    SELECTABLE_SUPPORT_STATES.includes(next.supportState);
  if (supportStatePromotion || visibilityPromotion) {
    if (next.runnable !== true || next.structurallyValid !== true) {
      throw new ReleaseRegistryError(
        'release_not_selectable',
        `release-registry: ${current.releaseId} cannot become selectable — it is not a runnable, structurally-valid release`,
        {
          details: {
            releaseId: current.releaseId,
            runnable: next.runnable === true,
            structurallyValid: next.structurallyValid === true,
          },
        },
      );
    }
    next.fidelityGaps = await assertReleaseCapabilitiesHonoured({ release: current, s3, bucket });
  }

  const channelsByName = await getChannels({ ddb, tableName });
  const broken = channelsBrokenBy(next, channelsByName, current);
  if (broken.length > 0) {
    throw new ReleaseRegistryError(
      'release_channel_pinned',
      `release-registry: ${current.releaseId} is the target of the ${broken.join(', ')} channel — clear or move the pointer first`,
      {
        details: {
          releaseId: current.releaseId,
          channels: broken,
          supportState: next.supportState,
          visible: next.visible === true,
        },
      },
    );
  }

  next.revision = Number(current.revision ?? 1) + 1;
  next.updatedAt = nowIso();
  next.updatedBy = actor;

  // Guard exactly the channels this patch WORSENS: they must still not point here
  // when the write lands. A channel the current state already fails is left
  // unguarded — no concurrent `setChannel` can have created such a pointer
  // (it asserts selectability), and guarding it would make an already-broken
  // record impossible to correct.
  const guardedChannels = RELEASE_CHANNELS.filter(
    (channel) => satisfiesChannel(current, channel) && !satisfiesChannel(next, channel),
  );
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: next,
              ConditionExpression: 'revision = :expected',
              ExpressionAttributeValues: { ':expected': expectedRevision },
            },
          },
          ...guardedChannels.map((channel) => ({
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: channelPk(channel), sk: META },
              ConditionExpression: 'attribute_not_exists(pk) OR releaseId <> :releaseId',
              ExpressionAttributeValues: { ':releaseId': current.releaseId },
            },
          })),
        ],
      }),
    );
  } catch (error) {
    if (isTransactionCancelled(error)) {
      const reasons = error.CancellationReasons ?? [];
      // A channel guard that fired is the actionable cause even when the revision
      // check at index 0 fired too: the caller must move or clear the pointer, and
      // reporting a bare revision conflict would send them into a retry loop that
      // can never succeed. Index 0 is the Put, so channel guards start at 1.
      const failedChannels = guardedChannels.filter(
        (_channel, index) => reasons[index + 1]?.Code === 'ConditionalCheckFailed',
      );
      if (failedChannels.length > 0) {
        throw new ReleaseRegistryError(
          'release_channel_pinned',
          `release-registry: the ${failedChannels.join(', ')} channel was pointed at ${current.releaseId} concurrently`,
          {
            cause: error,
            details: {
              releaseId: current.releaseId,
              channels: failedChannels,
            },
          },
        );
      }
    }
    if (!isConditionalCheckFailed(error) && !isTransactionCancelled(error)) throw error;
    throw new ReleaseRegistryError(
      'release_revision_conflict',
      `release-registry: release ${current.releaseId} was modified concurrently (expected revision ${expectedRevision})`,
      {
        cause: error,
        details: {
          releaseId: current.releaseId,
          expectedRevision,
          actualRevision: current.revision,
        },
      },
    );
  }
  return releaseToApi(next);
};

const closurePointer = (item) => ({
  importerRevision: item.importerRevision,
  closureDigest: item.closureDigest,
  manifestKey: item.manifestKey,
  catalogKey: item.catalogKey,
});

/**
 * Moves a registered release onto the closure a NEWER importer revision
 * published for the same source SHA.
 *
 * This is a pointer move, never a rewrite: both closures stay in S3 untouched,
 * and every existing intent keeps resolving the closure its META row pinned —
 * the resolver reads that pin straight from S3 and never consults this record.
 * Only intents created AFTER the move pin the new closure.
 *
 * Fail-closed checks, in order:
 *   - the revision must be strictly newer than the record's and no newer than
 *     the running importer (there is nothing to read beyond it);
 *   - a manifest must be published at that revision, and `readReleaseManifest`
 *     re-verifies its closure digest, fingerprint, sha, and provenance;
 *   - it must name the same release, profile, trust tier, and (for a fork) the
 *     same repository — an upgrade may change the bytes' importer, never whose
 *     bytes they are;
 *   - a structurally valid record cannot move to a closure that is not, and a
 *     selectable/certified one never loses the evidence its state rests on;
 *   - no channel pointing at the release may be left unsatisfied.
 *
 * The write is a CAS on `revision` AND on the importer revision it replaces, and
 * the replaced pointer is appended to `importerHistory` with who moved it.
 * Re-requesting the revision the record already points at is an idempotent
 * no-op (`already-current`), so an operator can safely retry.
 */
const upgradeReleaseClosure = async ({
  ddb,
  tableName,
  s3,
  bucket,
  releaseId,
  expectedRevision,
  importerRevision,
  actor = null,
}) => {
  assertRevision(expectedRevision, 'expectedRevision');
  if (!Number.isInteger(importerRevision) || importerRevision < 1) {
    throw new ReleaseRegistryError(
      'release_importer_revision_invalid',
      'release-registry: importerRevision must be a positive integer',
      { details: { importerRevision: importerRevision ?? null } },
    );
  }
  assertRegistryStorage(s3, bucket);
  const current = await getRelease({ ddb, tableName, releaseId });
  if (!current) {
    throw new ReleaseRegistryError(
      'release_not_found',
      `release-registry: release ${String(releaseId)} is not registered`,
      { details: { releaseId: String(releaseId ?? '') } },
    );
  }
  const fromRevision = Number(current.importerRevision);
  if (importerRevision === fromRevision) {
    return { status: 'already-current', release: releaseToApi(current) };
  }
  if (importerRevision < fromRevision || importerRevision > AIDLC_RELEASE_IMPORTER_REVISION) {
    throw new ReleaseRegistryError(
      'release_importer_revision_invalid',
      `release-registry: ${current.releaseId} can only move forward, from importer revision ${fromRevision} up to ${AIDLC_RELEASE_IMPORTER_REVISION} (asked for ${importerRevision})`,
      {
        details: {
          releaseId: current.releaseId,
          importerRevision,
          registeredImporterRevision: fromRevision,
          currentImporterRevision: AIDLC_RELEASE_IMPORTER_REVISION,
        },
      },
    );
  }

  const custom = current.custom === true;
  let manifest;
  try {
    manifest = await readReleaseManifest({
      s3,
      bucket,
      sha: current.sourceSha,
      importerRevision,
      custom,
      sourceRepository: custom ? current.sourceRepository : null,
    });
  } catch (error) {
    // Only a manifest that was READ and rejected is a conflict; an S3 failure
    // stays an infrastructure error rather than being reported as bad bytes.
    if (error?.name !== 'AidlcReleaseError') throw error;
    throw new ReleaseRegistryError(
      'release_conflict',
      `release-registry: the manifest published for ${current.releaseId} at importer revision ${importerRevision} is invalid: ${error.message}`,
      { cause: error, details: { releaseId: current.releaseId, importerRevision } },
    );
  }
  if (!manifest) {
    throw new ReleaseRegistryError(
      'release_not_published',
      `release-registry: no published manifest for ${current.releaseId} at importer revision ${importerRevision}`,
      { details: { releaseId: current.releaseId, sourceSha: current.sourceSha, importerRevision } },
    );
  }

  // Records registered before `sourceRepository` was stamped on official
  // releases carry null; for a non-custom release that can only mean the
  // official repository, so it is compared (and re-stamped below) as such.
  const registeredRepository =
    current.sourceRepository ?? (custom ? null : OFFICIAL_AIDLC_REPOSITORY);
  const mismatched = [
    ['releaseId', manifest.releaseId, current.releaseId],
    ['profileId', manifest.profileId, current.profileId],
    ['trustTier', manifest.trustTier ?? null, current.trustTier ?? null],
    [
      'sourceRepository',
      manifest.sourceRepository ?? (custom ? null : OFFICIAL_AIDLC_REPOSITORY),
      registeredRepository,
    ],
    ['custom', manifest.custom === true, custom],
  ].filter(([, published, registered]) => published !== registered);
  if (mismatched.length > 0) {
    throw new ReleaseRegistryError(
      'release_conflict',
      `release-registry: the importer revision ${importerRevision} manifest does not describe ${current.releaseId} (${mismatched.map(([field]) => field).join(', ')})`,
      {
        details: {
          releaseId: current.releaseId,
          importerRevision,
          fields: mismatched.map(([field]) => field),
        },
      },
    );
  }

  const structurallyValid = manifest.compatibility?.structurallyValid === true;
  const fidelityGaps = await readVerifiedReleaseFidelityGaps({ s3, bucket, manifest });
  if (isSelectableRecord(current)) {
    assertFidelityGapsHonoured({ release: current, fidelityGaps });
  }
  if (current.structurallyValid === true && !structurallyValid) {
    throw new ReleaseRegistryError(
      'release_not_selectable',
      `release-registry: the importer revision ${importerRevision} closure of ${current.releaseId} is not structurally valid; the registered one is`,
      { details: { releaseId: current.releaseId, importerRevision } },
    );
  }

  const keyArgs = releaseKeyArgs(manifest);
  const now = nowIso();
  const next = {
    ...current,
    sourceRepository: registeredRepository,
    importerRevision: manifest.importerRevision,
    closureDigest: manifest.closureDigest,
    manifestKey: releaseManifestKey(keyArgs),
    catalogKey: releaseCatalogKey(keyArgs),
    structurallyValid,
    fidelityGaps,
    importerHistory: [
      ...(current.importerHistory ?? []),
      {
        from: closurePointer(current),
        to: closurePointer({
          importerRevision: manifest.importerRevision,
          closureDigest: manifest.closureDigest,
          manifestKey: releaseManifestKey(keyArgs),
          catalogKey: releaseCatalogKey(keyArgs),
        }),
        upgradedAt: now,
        upgradedBy: actor,
      },
    ],
    revision: Number(current.revision ?? 1) + 1,
    updatedAt: now,
    updatedBy: actor,
  };

  const channelsByName = await getChannels({ ddb, tableName });
  const broken = channelsBrokenBy(next, channelsByName, current);
  if (broken.length > 0) {
    throw new ReleaseRegistryError(
      'release_channel_pinned',
      `release-registry: upgrading ${current.releaseId} would leave the ${broken.join(', ')} channel unsatisfied`,
      { details: { releaseId: current.releaseId, channels: broken } },
    );
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: next,
        ConditionExpression: 'revision = :expected AND importerRevision = :fromImporter',
        ExpressionAttributeValues: {
          ':expected': expectedRevision,
          ':fromImporter': fromRevision,
        },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    throw new ReleaseRegistryError(
      'release_revision_conflict',
      `release-registry: release ${current.releaseId} was modified concurrently (expected revision ${expectedRevision})`,
      {
        cause: error,
        details: {
          releaseId: current.releaseId,
          expectedRevision,
          actualRevision: current.revision,
        },
      },
    );
  }
  logger.info('AI-DLC release closure upgraded', {
    releaseId: current.releaseId,
    fromImporterRevision: fromRevision,
    toImporterRevision: next.importerRevision,
    fromClosureDigest: current.closureDigest,
    toClosureDigest: next.closureDigest,
    upgradedBy: actor,
  });
  return { status: 'upgraded', release: releaseToApi(next) };
};

/**
 * Moves a channel pointer. The target must already be selectable, so a channel
 * can never widen a release's support state — it only names one of the releases
 * an admin already approved.
 *
 * `stable` is additionally restricted to a `certified` release, with the
 * `currentPlatformBaseline` exception documented on `isStableEligible`.
 *
 * The pointer write and the target's revision are asserted in ONE transaction:
 * reading the release row and then writing the channel row separately leaves a
 * window in which a concurrent `updateRelease` demotes the target, which would
 * publish a channel pointing at a release no new intent can use.
 */
const setChannel = async ({
  ddb,
  tableName,
  s3,
  bucket,
  channel,
  releaseId,
  expectedRevision = null,
  actor = null,
}) => {
  assertChannel(channel);
  if (expectedRevision !== null) assertRevision(expectedRevision, 'expectedRevision');
  const target = await getRelease({ ddb, tableName, releaseId });
  if (!target) {
    throw new ReleaseRegistryError(
      'release_not_found',
      `release-registry: release ${String(releaseId)} is not registered`,
      { details: { releaseId: String(releaseId ?? '') } },
    );
  }
  assertSelectableRecord(target);
  if (!(channel === 'stable' && profileFor(target.profileId)?.currentPlatformBaseline === true)) {
    await assertReleaseCapabilitiesHonoured({ release: target, s3, bucket });
  }
  if (channel === 'stable' && !isStableEligible(target)) {
    throw new ReleaseRegistryError(
      'release_not_selectable',
      `release-registry: the stable channel requires a certified release (${target.releaseId} is "${target.supportState}")`,
      { details: { releaseId: target.releaseId, supportState: target.supportState } },
    );
  }

  const item = {
    pk: channelPk(channel),
    sk: META,
    type: CHANNEL_ITEM_TYPE,
    channel,
    releaseId: target.releaseId,
    revision: (expectedRevision ?? 0) + 1,
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ...(expectedRevision === null
                ? { ConditionExpression: 'attribute_not_exists(pk)' }
                : {
                    ConditionExpression: 'revision = :expected',
                    ExpressionAttributeValues: { ':expected': expectedRevision },
                  }),
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: releasePk(target.releaseId), sk: META },
              ConditionExpression: 'revision = :releaseRevision',
              ExpressionAttributeValues: { ':releaseRevision': Number(target.revision ?? 1) },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error) && !isTransactionCancelled(error)) throw error;
    throw new ReleaseRegistryError(
      'release_revision_conflict',
      `release-registry: channel ${channel} or release ${target.releaseId} was modified concurrently (expected channel revision ${expectedRevision ?? 'unset'}, release revision ${Number(target.revision ?? 1)})`,
      {
        cause: error,
        details: {
          channel,
          expectedRevision,
          releaseId: target.releaseId,
          releaseRevision: Number(target.revision ?? 1),
        },
      },
    );
  }
  return channelToApi(item);
};

/**
 * Clears a channel pointer. This is the ONLY way out of a channel that names a
 * release an admin now wants to demote: `updateRelease` refuses the demotion
 * while the pointer exists, so without this the registry has no exit.
 *
 * Clearing `stable` is not a demotion of anything — it returns the platform to
 * the pre-#482 default, where a create with no explicit release derives its pin
 * from the deployment ref instead of from a channel.
 */
const clearChannel = async ({ ddb, tableName, channel, expectedRevision, actor = null }) => {
  assertChannel(channel);
  assertRevision(expectedRevision, 'expectedRevision');
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: channelPk(channel), sk: META },
        ConditionExpression: 'revision = :expected',
        ExpressionAttributeValues: { ':expected': expectedRevision },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    throw new ReleaseRegistryError(
      'release_revision_conflict',
      `release-registry: channel ${channel} was modified or already cleared (expected revision ${expectedRevision})`,
      { cause: error, details: { channel, expectedRevision } },
    );
  }
  logger.info('AI-DLC release channel cleared', { channel, clearedBy: actor });
  return { cleared: true, channel };
};

/**
 * The selection gate for NEW intents.
 *
 * An explicit id must resolve to a registered, selectable release — an unknown
 * or demoted id is rejected rather than substituted, so a caller never gets a
 * different release than the one it asked for.
 *
 * With no id the stable channel decides. An unset stable channel returns null:
 * that is not an error, it means the platform has not opted into release-based
 * selection yet and the caller keeps its pre-existing behaviour.
 *
 * A stable pointer whose target is no longer SELECTABLE degrades to null for the
 * same reason. `updateRelease` refuses to create that state, but a restored
 * backup or a hand-edited row can, and an implicit fallback must never be able
 * to make intent creation fail platform-wide — an EXPLICIT id is still rejected,
 * so no caller silently gets a release it did not ask for.
 */
const resolveSelectableRelease = async ({ ddb, tableName, releaseId = null }) => {
  if (!releaseId) {
    const stable = await getChannel({ ddb, tableName, channel: 'stable' });
    if (!stable?.releaseId) return null;
    const target = await getRelease({ ddb, tableName, releaseId: stable.releaseId });
    // Selectability only. Stable ELIGIBILITY (certified or baseline) is enforced
    // when the pointer is written; re-deciding it here would let a policy change
    // retroactively unpin a channel an admin legitimately set.
    if (!target || !isSelectableRecord(target)) {
      logger.warn('stable AI-DLC release channel points at a non-selectable release; ignoring', {
        channel: 'stable',
        releaseId: stable.releaseId,
        registered: Boolean(target),
        supportState: target?.supportState ?? null,
        visible: target?.visible === true,
        runnable: target?.runnable === true,
      });
      return null;
    }
    return releaseToApi(target);
  }
  const record = await getRelease({ ddb, tableName, releaseId });
  if (!record) {
    throw new ReleaseRegistryError(
      'release_not_found',
      `release-registry: release ${String(releaseId)} is not registered`,
      { details: { releaseId: String(releaseId) } },
    );
  }
  assertSelectableRecord(record);
  return releaseToApi(record);
};

/**
 * Without `s3:ListBucket` on a prefix, S3 answers a GET for a key that does not
 * exist with 403 AccessDenied instead of 404 NoSuchKey — it refuses to confirm
 * or deny existence. The admin profile listing is a pure "is this published yet?"
 * probe over keys that are USUALLY absent, so a masked 403 there means "not
 * published", not "broken", and must not 500 the whole listing.
 *
 * This tolerance is deliberately scoped to the probe. Every execution path
 * (loadReleaseClosure, registerRelease, the auto-pin lookup) keeps treating an
 * unreadable manifest as a hard failure: there, "cannot read" must never be
 * downgraded to "does not exist", or a genuine permissions regression would
 * silently unpin intents.
 */
const isAccessDenied = (error) =>
  error?.name === 'AccessDenied' ||
  error?.Code === 'AccessDenied' ||
  error?.$metadata?.httpStatusCode === 403;

const probePublishedManifest = async ({ s3, bucket, profile }) => {
  try {
    return await readReleaseManifest({
      s3,
      bucket,
      sha: profile.upstreamRef,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
    });
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    logger.warn('release manifest probe was denied; treating the release as not published', {
      profileId: profile.id,
      sourceSha: profile.upstreamRef,
    });
    return null;
  }
};

/**
 * The allowlisted profiles an admin may register, annotated with whether their
 * bytes are published and whether a registry record already exists. Purely
 * informational: it never publishes or registers anything.
 */
const listRegistrableProfiles = async ({ ddb, tableName, s3, bucket }) => {
  const profiles = Object.values(AIDLC_COMPATIBILITY_PROFILES);
  const results = await Promise.all(
    profiles.map(async (profile) => {
      const manifest = s3 && bucket ? await probePublishedManifest({ s3, bucket, profile }) : null;
      const registered = await getRelease({ ddb, tableName, releaseId: profile.releaseId });
      return {
        profileId: profile.id,
        releaseId: profile.releaseId,
        label: profile.label ?? null,
        upstreamVersion: profile.upstreamVersion ?? null,
        upstreamChannel: profile.upstreamChannel ?? null,
        upstreamRef: profile.upstreamRef,
        trustTier: profile.trustTier ?? null,
        currentPlatformBaseline: profile.currentPlatformBaseline === true,
        runnable: profileIsRunnable(profile),
        published: Boolean(manifest),
        importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
        registered: Boolean(registered),
        registeredImporterRevision: registered?.importerRevision ?? null,
        importerStale: registered ? isImporterStale(registered) : false,
        supportState: registered?.supportState ?? null,
        revision: registered?.revision ?? null,
      };
    }),
  );
  return results.toSorted((left, right) => releaseGsi1Sk(left).localeCompare(releaseGsi1Sk(right)));
};

const __test = {
  paddedUpstreamVersion,
  releaseGsi1Sk,
  releasePk,
  channelPk,
  isSelectableRecord,
  isStableEligible,
  channelsBrokenBy,
};

export {
  __test,
  RELEASE_CHANNELS,
  ReleaseRegistryError,
  SELECTABLE_SUPPORT_STATES,
  SUPPORT_STATES,
  assertReleaseCapabilitiesHonoured,
  channelToApi,
  channelToSelectionApi,
  clearChannel,
  getChannel,
  getChannels,
  getRelease,
  isReleaseRegistryError,
  isSelectableRecord,
  listRegistrableProfiles,
  listReleases,
  registerCustomRelease,
  registerRelease,
  releasePinFromRecord,
  releaseToApi,
  releaseToSelectionApi,
  resolveSelectableRelease,
  setChannel,
  updateRelease,
  upgradeReleaseClosure,
};

export default {
  RELEASE_CHANNELS,
  ReleaseRegistryError,
  SELECTABLE_SUPPORT_STATES,
  SUPPORT_STATES,
  assertReleaseCapabilitiesHonoured,
  channelToApi,
  channelToSelectionApi,
  clearChannel,
  getChannel,
  getChannels,
  getRelease,
  isReleaseRegistryError,
  isSelectableRecord,
  listRegistrableProfiles,
  listReleases,
  registerCustomRelease,
  registerRelease,
  releasePinFromRecord,
  releaseToApi,
  releaseToSelectionApi,
  resolveSelectableRelease,
  setChannel,
  updateRelease,
  upgradeReleaseClosure,
};
