// The release registry and channel pointers.
//
// The property under test: registration records evidence and nothing more, and
// every state transition that could widen selection is refused unless the
// release is provably runnable and structurally valid. Concurrency is a
// first-class case — two admins racing must not silently clobber one another.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { customProfile, filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  publishReleaseBundle,
} from '../aidlc-release.js';
import { AIDLC_COMPATIBILITY_PROFILES } from '../aidlc-compatibility-profiles.js';
import {
  __test,
  RELEASE_CHANNELS,
  SUPPORT_STATES,
  clearChannel,
  getChannel,
  getChannels,
  getRelease,
  listRegistrableProfiles,
  listReleases,
  registerCustomRelease,
  registerRelease,
  releasePinFromRecord,
  resolveSelectableRelease,
  setChannel,
  updateRelease,
} from '../release-registry.js';

const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
// current-stable is the platform baseline (it may hold `stable` while merely
// selectable); v2.9.0 is an ordinary candidate that must be certified first.
const BASELINE_PROFILE = 'current-stable';
const CANDIDATE_PROFILE = 'v2.9.0';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const objects = new Map();
const rows = new Map();

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const preconditionFailed = () => {
  const error = new Error('At least one of the pre-conditions you specified did not hold');
  error.name = 'PreconditionFailed';
  error.$metadata = { httpStatusCode: 412 };
  return error;
};

const conditionalCheckFailed = () => {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  error.$metadata = { httpStatusCode: 400 };
  return error;
};

const bundleFor = (profileId) =>
  buildReleaseBundle({
    profileId,
    files: filesFromCompatibilityFixture({
      profileId,
      fixture: JSON.parse(
        readFileSync(
          new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
          'utf8',
        ),
      ),
    }),
  });

const baselineBundle = bundleFor(BASELINE_PROFILE);
const candidateBundle = bundleFor(CANDIDATE_PROFILE);
const BASELINE_RELEASE_ID = baselineBundle.manifest.releaseId;
const CANDIDATE_RELEASE_ID = candidateBundle.manifest.releaseId;

const keyOf = (pk, sk) => `${pk}|${sk}`;

// The DynamoDB condition expressions the registry relies on. Modelling them
// faithfully is the point of this fake: an optimistic-concurrency bug would
// otherwise pass silently against a store that ignores conditions.
const conditionHolds = (input, existing) => {
  const condition = input.ConditionExpression;
  if (!condition) return true;
  if (condition === 'attribute_not_exists(pk)') return existing === undefined;
  if (condition === 'revision = :expected') {
    return (
      existing !== undefined && existing.revision === input.ExpressionAttributeValues[':expected']
    );
  }
  if (condition === 'revision = :releaseRevision') {
    return (
      existing !== undefined &&
      existing.revision === input.ExpressionAttributeValues[':releaseRevision']
    );
  }
  if (condition === 'attribute_not_exists(pk) OR releaseId <> :releaseId') {
    return (
      existing === undefined || existing.releaseId !== input.ExpressionAttributeValues[':releaseId']
    );
  }
  throw new Error(`unmodelled ConditionExpression: ${condition}`);
};

const transactionCanceled = (reasons) => {
  const error = new Error('Transaction cancelled, please refer cancellation reasons for details');
  error.name = 'TransactionCanceledException';
  error.$metadata = { httpStatusCode: 400 };
  error.CancellationReasons = reasons;
  return error;
};

const installFakes = () => {
  s3Mock.reset();
  ddbMock.reset();
  objects.clear();
  rows.clear();

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw preconditionFailed();
    objects.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!objects.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => objects.get(input.Key) } };
  });

  ddbMock.on(GetCommand).callsFake((input) => {
    const item = rows.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: item ? { ...item } : undefined };
  });
  ddbMock.on(PutCommand).callsFake((input) => {
    const key = keyOf(input.Item.pk, input.Item.sk);
    if (!conditionHolds(input, rows.get(key))) throw conditionalCheckFailed();
    rows.set(key, { ...input.Item });
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues?.[':pk'];
    const items = [...rows.values()].filter((row) =>
      input.IndexName === 'GSI1' ? row.GSI1PK === pk : row.pk === pk,
    );
    return { Items: items.map((row) => ({ ...row })) };
  });
  ddbMock.on(DeleteCommand).callsFake((input) => {
    const key = keyOf(input.Key.pk, input.Key.sk);
    if (!conditionHolds(input, rows.get(key))) throw conditionalCheckFailed();
    rows.delete(key);
    return {};
  });
  // All-or-nothing, with per-item CancellationReasons: the registry maps a
  // failure at index 0 (the write's own CAS) to a revision conflict and a
  // failure at a later index (a channel/release guard) to a different code, so
  // the fake has to report WHICH item failed, not just that one did.
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const reasons = input.TransactItems.map((entry) => {
      const operation = entry.Put ?? entry.ConditionCheck ?? entry.Delete;
      const target = entry.Put ? entry.Put.Item : operation.Key;
      const existing = rows.get(keyOf(target.pk, target.sk));
      return conditionHolds(operation, existing)
        ? { Code: 'None' }
        : { Code: 'ConditionalCheckFailed' };
    });
    if (reasons.some((reason) => reason.Code !== 'None')) throw transactionCanceled(reasons);
    for (const entry of input.TransactItems) {
      if (entry.Put) rows.set(keyOf(entry.Put.Item.pk, entry.Put.Item.sk), { ...entry.Put.Item });
      if (entry.Delete) rows.delete(keyOf(entry.Delete.Key.pk, entry.Delete.Key.sk));
    }
    return {};
  });
};

const registryArgs = () => ({ ddb: ddbMock, tableName: TABLE });
const registerArgs = (profileId) => ({
  ...registryArgs(),
  s3,
  bucket: BUCKET,
  profileId,
  actor: 'admin-1',
});

// Promote a registered release all the way to a channel-eligible state, which
// always takes two explicit decisions: a support state and a visibility flip.
const promote = async (releaseId, supportState) => {
  const registered = await getRelease({ ...registryArgs(), releaseId });
  const stated = await updateRelease({
    ...registryArgs(),
    releaseId,
    expectedRevision: registered.revision,
    patch: { supportState },
    actor: 'admin-1',
  });
  return updateRelease({
    ...registryArgs(),
    releaseId,
    expectedRevision: stated.revision,
    patch: { visible: true },
    actor: 'admin-1',
  });
};

beforeEach(async () => {
  installFakes();
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle: baselineBundle });
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle: candidateBundle });
});

describe('registerRelease', () => {
  it('records the published manifest as evidence only, invisible and unselectable', async () => {
    const result = await registerRelease(registerArgs(BASELINE_PROFILE));

    expect(result.status).toBe('registered');
    expect(result.release).toMatchObject({
      releaseId: BASELINE_RELEASE_ID,
      sourceSha: baselineBundle.manifest.sourceSha,
      closureDigest: baselineBundle.manifest.closureDigest,
      profileId: BASELINE_PROFILE,
      supportState: 'structurally-valid',
      structurallyValid: true,
      visible: false,
      runnable: true,
      fidelityGaps: [],
      unhonouredValues: [],
      revision: 1,
    });
    expect(result.release.manifestKey).toBe(
      `aidlc-releases/v1/${baselineBundle.manifest.sourceSha}/i${AIDLC_RELEASE_IMPORTER_REVISION}/manifest.json`,
    );
    expect(result.release.catalogKey).toBe(baselineBundle.manifest.catalog.key);
  });

  it('is idempotent for the same closure', async () => {
    const first = await registerRelease(registerArgs(BASELINE_PROFILE));
    const second = await registerRelease(registerArgs(BASELINE_PROFILE));

    expect(second.status).toBe('already-registered');
    expect(second.release.revision).toBe(first.release.revision);
    expect(second.release.registeredAt).toBe(first.release.registeredAt);
  });

  it('does not overwrite a record that holds a different closure', async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    const stored = rows.get(keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META'));
    rows.set(keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META'), {
      ...stored,
      closureDigest: 'f'.repeat(64),
    });

    await expect(registerRelease(registerArgs(BASELINE_PROFILE))).rejects.toMatchObject({
      code: 'release_conflict',
    });
  });

  it('refuses a release whose bytes were never published', async () => {
    objects.clear();

    await expect(registerRelease(registerArgs(BASELINE_PROFILE))).rejects.toMatchObject({
      code: 'release_not_published',
    });
  });

  it('maps unreadable closure capability evidence to a registry conflict', async () => {
    objects.delete(baselineBundle.manifest.catalog.key);

    await expect(registerRelease(registerArgs(BASELINE_PROFILE))).rejects.toMatchObject({
      code: 'release_conflict',
    });
    expect(rows.has(keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META'))).toBe(false);
  });

  it('refuses a profile that is not on the allowlist', async () => {
    await expect(registerRelease(registerArgs('v9.9.9-custom'))).rejects.toMatchObject({
      code: 'release_profile_unknown',
    });
  });
});

describe('updateRelease', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
  });

  it('increments the revision and records the certifier', async () => {
    const updated = await updateRelease({
      ...registryArgs(),
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: 1,
      patch: { supportState: 'certified', notes: 'reviewed' },
      actor: 'reviewer-7',
    });

    expect(updated.revision).toBe(2);
    expect(updated.supportState).toBe('certified');
    expect(updated.notes).toBe('reviewed');
    expect(updated.certifiedBy).toBe('reviewer-7');
    expect(updated.certifiedAt).toEqual(expect.any(String));
  });

  it('rejects a stale expectedRevision instead of clobbering the winner', async () => {
    await updateRelease({
      ...registryArgs(),
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: 1,
      patch: { visible: true },
      actor: 'admin-1',
    });

    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: 1,
        patch: { supportState: 'existing-only' },
        actor: 'admin-2',
      }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });
    expect(rows.get(keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META'))).toMatchObject({
      visible: true,
      supportState: 'structurally-valid',
      revision: 2,
    });
  });

  it.each(['selectable', 'certified'])(
    'refuses "%s" for a release that is not runnable',
    async (supportState) => {
      const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
      rows.set(key, { ...rows.get(key), runnable: false });

      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: BASELINE_RELEASE_ID,
          expectedRevision: 1,
          patch: { supportState },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_not_selectable' });
    },
  );

  it.each(['selectable', 'certified'])(
    'refuses "%s" for a release that is not structurally valid',
    async (supportState) => {
      const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
      rows.set(key, { ...rows.get(key), structurallyValid: false, supportState: 'importable' });

      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: BASELINE_RELEASE_ID,
          expectedRevision: 1,
          patch: { supportState },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_not_selectable' });
    },
  );

  it.each(['selectable', 'certified'])(
    'refuses "%s" when the current build cannot honour authored behavior',
    async (supportState) => {
      const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
      const fidelityGaps = [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }];
      rows.set(key, { ...rows.get(key), fidelityGaps });

      await expect(
        updateRelease({
          ...registryArgs(),
          s3,
          bucket: BUCKET,
          releaseId: BASELINE_RELEASE_ID,
          expectedRevision: 1,
          patch: { supportState },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({
        code: 'release_capability_unhandled',
        details: { gaps: fidelityGaps },
      });
    },
  );

  it('allows promotion when no authored behavior is unsupported', async () => {
    await expect(promote(BASELINE_RELEASE_ID, 'selectable')).resolves.toMatchObject({
      supportState: 'selectable',
      fidelityGaps: [],
    });
  });

  it('re-evaluates the immutable closure for a legacy row without gap evidence', async () => {
    const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
    const legacy = { ...rows.get(key) };
    delete legacy.fidelityGaps;
    rows.set(key, legacy);

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: 1,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', fidelityGaps: [] });
  });

  it('refuses visibility-only activation when it would expose unsupported behavior', async () => {
    const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
    rows.set(key, {
      ...rows.get(key),
      supportState: 'selectable',
      visible: false,
      fidelityGaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
    });

    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: 1,
        patch: { visible: true },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }] },
    });
  });

  it('refuses a legacy row when its pinned closure does not match the published evidence', async () => {
    const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
    const legacy = { ...rows.get(key), closureDigest: 'f'.repeat(64) };
    delete legacy.fidelityGaps;
    rows.set(key, legacy);

    await expect(
      updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: 1,
        patch: { supportState: 'selectable' },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({
      code: 'release_conflict',
      details: { fields: expect.arrayContaining(['closureDigest']) },
    });
  });

  it('accepts every non-widening support state', async () => {
    let revision = 1;
    for (const supportState of SUPPORT_STATES.filter(
      (state) => !['selectable', 'certified'].includes(state),
    )) {
      const updated = await updateRelease({
        ...registryArgs(),
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: revision,
        patch: { supportState },
        actor: 'admin-1',
      });
      expect(updated.supportState).toBe(supportState);
      revision = updated.revision;
    }
  });

  it('rejects an unknown support state and a non-boolean visible', async () => {
    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: 1,
        patch: { supportState: 'runnable-ish' },
      }),
    ).rejects.toMatchObject({ code: 'release_state_invalid' });
    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: 1,
        patch: { visible: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'release_state_invalid' });
  });

  it('refuses to patch a release that was never registered', async () => {
    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: 'aidlc:not-registered',
        expectedRevision: 1,
        patch: { visible: true },
      }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
  });
});

describe('setChannel', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('creates a pointer with a null expectedRevision and then requires the current one', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');

    const created = await setChannel({
      ...registryArgs(),
      channel: 'candidate',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });
    expect(created).toMatchObject({
      channel: 'candidate',
      releaseId: CANDIDATE_RELEASE_ID,
      revision: 1,
    });

    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'candidate',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: null,
        actor: 'admin-2',
      }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });

    const moved = await setChannel({
      ...registryArgs(),
      channel: 'candidate',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: 1,
      actor: 'admin-1',
    });
    expect(moved.revision).toBe(2);
  });

  it('rejects a stale pointer revision', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await setChannel({
      ...registryArgs(),
      channel: 'preview',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
    });
    await setChannel({
      ...registryArgs(),
      channel: 'preview',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: 1,
    });

    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'preview',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });
  });

  it('refuses a release that is merely structurally valid', async () => {
    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'candidate',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });
  });

  it('refuses a selectable release that is still hidden', async () => {
    await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: 1,
      patch: { supportState: 'selectable' },
    });

    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'candidate',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });
  });

  it('requires certification for stable unless the release is the platform baseline', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await promote(BASELINE_RELEASE_ID, 'selectable');

    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'stable',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });

    const stable = await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: null,
    });
    expect(stable.releaseId).toBe(BASELINE_RELEASE_ID);
  });

  it('accepts a certified non-baseline release on stable', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'certified');

    const stable = await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
    });
    expect(stable.releaseId).toBe(CANDIDATE_RELEASE_ID);
  });

  it('refuses a channel pointer to an unsupported release', async () => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    rows.set(key, {
      ...rows.get(key),
      supportState: 'selectable',
      visible: true,
      fidelityGaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
    });

    await expect(
      setChannel({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        channel: 'candidate',
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }] },
    });
  });

  it('keeps the stable channel available for the current platform baseline', async () => {
    const key = keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META');
    rows.set(key, {
      ...rows.get(key),
      supportState: 'selectable',
      visible: true,
      fidelityGaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
    });

    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'stable',
        releaseId: BASELINE_RELEASE_ID,
        expectedRevision: null,
      }),
    ).resolves.toMatchObject({ releaseId: BASELINE_RELEASE_ID });
  });

  it('rejects an unknown channel and an unregistered release', async () => {
    await expect(
      setChannel({ ...registryArgs(), channel: 'nightly', releaseId: BASELINE_RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_channel_invalid' });
    await expect(
      setChannel({ ...registryArgs(), channel: 'preview', releaseId: 'aidlc:nope' }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
  });
});

describe('listReleases and getChannels', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('orders records by padded upstream version', async () => {
    const releases = await listReleases(registryArgs());

    expect(releases.map((release) => release.upstreamVersion)).toEqual(['2.3.3', '2.9.0']);
  });

  it('hides everything a caller could not select from the visible-only projection', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    // Visible but existing-only: preserved for identity, never offered again.
    const baseline = await promote(BASELINE_RELEASE_ID, 'existing-only');
    expect(baseline.visible).toBe(true);

    const visible = await listReleases({ ...registryArgs(), visibleOnly: true });

    expect(visible.map((release) => release.releaseId)).toEqual([CANDIDATE_RELEASE_ID]);
    expect((await listReleases(registryArgs())).length).toBe(2);
  });

  it('reports every channel, unset ones as null', async () => {
    await promote(BASELINE_RELEASE_ID, 'selectable');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: null,
    });

    const channels = await getChannels(registryArgs());

    expect(Object.keys(channels)).toEqual([...RELEASE_CHANNELS]);
    expect(channels.stable.releaseId).toBe(BASELINE_RELEASE_ID);
    expect(channels.candidate).toBeNull();
    expect(channels.preview).toBeNull();
  });
});

describe('resolveSelectableRelease', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('returns null when no stable channel is set, so the caller keeps its old behaviour', async () => {
    await expect(resolveSelectableRelease(registryArgs())).resolves.toBeNull();
  });

  it('resolves the stable channel when no id is requested', async () => {
    await promote(BASELINE_RELEASE_ID, 'selectable');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: null,
    });

    const resolved = await resolveSelectableRelease(registryArgs());

    expect(resolved.releaseId).toBe(BASELINE_RELEASE_ID);
    expect(releasePinFromRecord(resolved)).toEqual({
      releaseId: BASELINE_RELEASE_ID,
      sourceSha: baselineBundle.manifest.sourceSha,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      closureDigest: baselineBundle.manifest.closureDigest,
      catalogKey: baselineBundle.manifest.catalog.key,
      manifestKey: `aidlc-releases/v1/${baselineBundle.manifest.sourceSha}/i${AIDLC_RELEASE_IMPORTER_REVISION}/manifest.json`,
    });
  });

  it('resolves an explicitly requested selectable release', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'certified');

    const resolved = await resolveSelectableRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
    });

    expect(resolved.releaseId).toBe(CANDIDATE_RELEASE_ID);
  });

  it('rejects an unknown id rather than substituting the stable release', async () => {
    await promote(BASELINE_RELEASE_ID, 'selectable');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: BASELINE_RELEASE_ID,
      expectedRevision: null,
    });

    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: 'aidlc:unknown' }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
  });

  it.each([
    ['structurally-valid but never promoted', {}],
    ['hidden', { supportState: 'selectable', visible: false }],
    ['existing-only', { supportState: 'existing-only', visible: true }],
    ['non-runnable', { supportState: 'certified', visible: true, runnable: false }],
  ])('refuses a %s release', async (_label, override) => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    rows.set(key, { ...rows.get(key), ...override });

    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: CANDIDATE_RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });
  });

  it('keeps a demoted release resolvable for existing intents through getRelease', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'existing-only');

    const record = await getRelease({ ...registryArgs(), releaseId: CANDIDATE_RELEASE_ID });

    expect(record.closureDigest).toBe(candidateBundle.manifest.closureDigest);
    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: CANDIDATE_RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });
  });
});

describe('listRegistrableProfiles', () => {
  it('annotates each allowlisted profile with publication and registration state', async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));

    const profiles = await listRegistrableProfiles({ ...registryArgs(), s3, bucket: BUCKET });

    const byId = Object.fromEntries(profiles.map((profile) => [profile.profileId, profile]));
    expect(byId[CANDIDATE_PROFILE]).toMatchObject({
      published: true,
      registered: true,
      supportState: 'structurally-valid',
      revision: 1,
      runnable: true,
    });
    expect(byId[BASELINE_PROFILE]).toMatchObject({
      published: true,
      registered: false,
      supportState: null,
      currentPlatformBaseline: true,
    });
    // A profile whose bytes were never published is visibly unpublished rather
    // than absent, so an admin can tell "import it first" from "not allowlisted".
    expect(byId['v2.7.0']).toMatchObject({ published: false, registered: false });
  });
});

describe('padded version ordering', () => {
  it('orders a double-digit minor after a single-digit one', () => {
    expect(__test.paddedUpstreamVersion('2.9.0') < __test.paddedUpstreamVersion('2.10.0')).toBe(
      true,
    );
  });
});

// Custom fork records (issue #482 follow-up). The property under test: a fork is
// recorded as evidence only, and NO sequence of registry calls can make it
// offerable to a new intent.
describe('registerCustomRelease', () => {
  const FORK_SHA = '0123456789abcdef0123456789abcdef01234567';
  const FORK_REPOSITORY = 'acme/aidlc-fork';
  const forkProfile = customProfile({
    repository: FORK_REPOSITORY,
    sha: FORK_SHA,
    baseProfileId: BASELINE_PROFILE,
  });
  const forkBundle = buildReleaseBundle({
    profile: forkProfile,
    files: filesFromCompatibilityFixture({
      profileId: BASELINE_PROFILE,
      fixture: JSON.parse(
        readFileSync(
          new URL(`./fixtures/aidlc-compatibility/${BASELINE_PROFILE}.json`, import.meta.url),
          'utf8',
        ),
      ),
    }),
  });
  const FORK_RELEASE_ID = forkBundle.manifest.releaseId;
  const customArgs = (over = {}) => ({
    ...registryArgs(),
    s3,
    bucket: BUCKET,
    repository: FORK_REPOSITORY,
    sha: FORK_SHA,
    baseProfileId: BASELINE_PROFILE,
    actor: 'admin-1',
    ...over,
  });

  const registerFork = async () => {
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle: forkBundle });
    return registerCustomRelease(customArgs());
  };

  it('records the fork as non-runnable T0 evidence, invisible by default', async () => {
    const { status, release } = await registerFork();

    expect(status).toBe('registered');
    expect(release).toMatchObject({
      releaseId: FORK_RELEASE_ID,
      sourceSha: FORK_SHA,
      sourceRepository: FORK_REPOSITORY,
      custom: true,
      trustTier: 'T0',
      runnable: false,
      visible: false,
      structurallyValid: true,
      supportState: 'structurally-valid',
      revision: 1,
    });
    expect(release.manifestKey).toContain(`/custom/${FORK_REPOSITORY}/`);
    expect(release.catalogKey).toContain(`/custom/${FORK_REPOSITORY}/`);
  });

  it('is idempotent per closure and conflicts on a different one', async () => {
    await registerFork();
    await expect(registerCustomRelease(customArgs())).resolves.toMatchObject({
      status: 'already-registered',
    });

    rows.set(keyOf(`AIDLC_RELEASE#${FORK_RELEASE_ID}`, 'META'), {
      ...rows.get(keyOf(`AIDLC_RELEASE#${FORK_RELEASE_ID}`, 'META')),
      closureDigest: 'f'.repeat(64),
    });
    await expect(registerCustomRelease(customArgs())).rejects.toMatchObject({
      code: 'release_conflict',
    });
  });

  it('refuses an unpublished fork rather than inventing a record', async () => {
    await expect(registerCustomRelease(customArgs())).rejects.toMatchObject({
      code: 'release_not_published',
    });
    expect(rows.has(keyOf(`AIDLC_RELEASE#${FORK_RELEASE_ID}`, 'META'))).toBe(false);
  });

  it('refuses an invalid source, the official repository, and a mutable ref', async () => {
    await expect(
      registerCustomRelease(customArgs({ repository: 'awslabs/aidlc-workflows' })),
    ).rejects.toMatchObject({ code: 'custom_repository_official' });
    await expect(registerCustomRelease(customArgs({ sha: 'main' }))).rejects.toMatchObject({
      code: 'custom_sha_invalid',
    });
    await expect(
      registerCustomRelease(customArgs({ baseProfileId: 'nope' })),
    ).rejects.toMatchObject({ code: 'custom_base_profile_unknown' });
    await expect(
      registerCustomRelease(customArgs({ repository: 'acme/..' })),
    ).rejects.toMatchObject({ code: 'custom_source_repo_invalid' });
  });

  it('refuses a manifest at the custom prefix that describes something else', async () => {
    // Somebody drops an OFFICIAL manifest onto the fork's custom manifest key.
    objects.set(
      forkBundle.manifest.catalog.key.replace('catalog.json', 'manifest.json'),
      `${JSON.stringify(baselineBundle.manifest, null, 2)}\n`,
    );
    // Caught by readReleaseManifest's provenance assertion (the key's SHA and
    // repository must match the bytes) before the registry's own conflict check
    // ever sees it, so the swap cannot be registered under any code path.
    await expect(registerCustomRelease(customArgs())).rejects.toMatchObject({
      code: 'release_manifest_invalid',
    });
    expect(rows.has(keyOf(`AIDLC_RELEASE#${FORK_RELEASE_ID}`, 'META'))).toBe(false);
  });

  it('requires an S3 client and bucket', async () => {
    await expect(registerCustomRelease(customArgs({ bucket: null }))).rejects.toMatchObject({
      code: 'release_registry_misconfigured',
    });
  });

  it('cannot be promoted to selectable or certified', async () => {
    const { release } = await registerFork();

    for (const supportState of ['selectable', 'certified']) {
      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: FORK_RELEASE_ID,
          expectedRevision: release.revision,
          patch: { supportState },
        }),
      ).rejects.toMatchObject({ code: 'release_not_selectable' });
    }
    // The support states that do not widen selection remain patchable.
    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: FORK_RELEASE_ID,
        expectedRevision: release.revision,
        patch: { supportState: 'existing-only', visible: true },
      }),
    ).resolves.toMatchObject({ supportState: 'existing-only', runnable: false, custom: true });
  });

  it('cannot hold a channel pointer, even when visible', async () => {
    const { release } = await registerFork();
    await updateRelease({
      ...registryArgs(),
      releaseId: FORK_RELEASE_ID,
      expectedRevision: release.revision,
      patch: { visible: true },
    });

    for (const channel of RELEASE_CHANNELS) {
      await expect(
        setChannel({ ...registryArgs(), channel, releaseId: FORK_RELEASE_ID }),
      ).rejects.toMatchObject({ code: 'release_not_selectable' });
    }
  });

  it('is never offered as selectable and never listed to a non-admin', async () => {
    await registerFork();
    await updateRelease({
      ...registryArgs(),
      releaseId: FORK_RELEASE_ID,
      expectedRevision: 1,
      patch: { visible: true },
    });

    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: FORK_RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });

    const visibleOnly = await listReleases({ ...registryArgs(), visibleOnly: true });
    expect(visibleOnly.map((r) => r.releaseId)).not.toContain(FORK_RELEASE_ID);
    const all = await listReleases({ ...registryArgs(), visibleOnly: false });
    expect(all.map((r) => r.releaseId)).toContain(FORK_RELEASE_ID);
  });

  it('never appears among the allowlisted registrable profiles', async () => {
    await registerFork();
    const profiles = await listRegistrableProfiles({ ...registryArgs(), s3, bucket: BUCKET });

    expect(profiles.map((p) => p.profileId)).toEqual(
      Object.keys(AIDLC_COMPATIBILITY_PROFILES).toSorted((left, right) =>
        __test
          .releaseGsi1Sk(AIDLC_COMPATIBILITY_PROFILES[left])
          .localeCompare(__test.releaseGsi1Sk(AIDLC_COMPATIBILITY_PROFILES[right])),
      ),
    );
    expect(profiles.some((p) => p.profileId === forkProfile.id)).toBe(false);
  });
});

// ── Channel transitions, release registration, and projections ──
//
// These cover the ways the registry could previously publish a state the rest of
// the platform cannot work with: a channel stranded on a demoted release, no way
// to undo a pointer, a masked S3 403 read as a hard failure, a manifest whose
// identity does not match the profile that asked for it, and an over-broad
// non-admin projection.

describe('channel-pinned transitions', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  const currentRevision = async (releaseId) =>
    (await getRelease({ ...registryArgs(), releaseId })).revision;

  const pointCandidateAt = async (channel) => {
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');
    await setChannel({
      ...registryArgs(),
      channel,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });
    return promoted;
  };

  it.each(['stable', 'candidate', 'preview'])(
    'refuses to demote the release the %s channel points at',
    async (channel) => {
      await pointCandidateAt(channel);

      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: CANDIDATE_RELEASE_ID,
          expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
          patch: { supportState: 'existing-only' },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_channel_pinned', details: { channels: [channel] } });
    },
  );

  it('refuses to hide the release a channel points at', async () => {
    await pointCandidateAt('candidate');

    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
        patch: { visible: false },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_channel_pinned' });
  });

  it('re-checks stable eligibility: a certified stable target may not drop to selectable', async () => {
    await pointCandidateAt('stable');

    // `selectable` keeps the release offerable, so the generic guard passes — but
    // stable additionally requires certification (and v2.9.0 is not the platform
    // baseline), so the demotion must still be refused.
    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
        patch: { supportState: 'selectable' },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_channel_pinned', details: { channels: ['stable'] } });
  });

  it('allows the same demotion once the pointer is cleared (demote-then-create)', async () => {
    await pointCandidateAt('stable');
    const pointer = await getChannel({ ...registryArgs(), channel: 'stable' });

    await clearChannel({
      ...registryArgs(),
      channel: 'stable',
      expectedRevision: pointer.revision,
      actor: 'admin-1',
    });
    const demoted = await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
      patch: { supportState: 'existing-only' },
      actor: 'admin-1',
    });

    expect(demoted.supportState).toBe('existing-only');
    // Leaving `certified` drops the certification claim, so a later re-promotion
    // cannot inherit evidence from a decision that was already revoked.
    expect(demoted.certifiedAt).toBeNull();
    expect(demoted.certifiedBy).toBeNull();
  });

  it('leaves a channel-referenced release patchable when the transition keeps it valid', async () => {
    await pointCandidateAt('stable');

    const noted = await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
      patch: { notes: 'still certified' },
      actor: 'admin-1',
    });

    expect(noted.notes).toBe('still certified');
    expect(noted.supportState).toBe('certified');
  });

  it('refuses the demotion when a channel is pointed at the release concurrently', async () => {
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');
    // The read-based pre-check sees no pointer; the pointer appears before the
    // write lands. Only the in-transaction ConditionCheck can catch this.
    let raced = false;
    const realSend = ddbMock.send.bind(ddbMock);
    ddbMock.send = async (command) => {
      if (!raced && command instanceof TransactWriteCommand) {
        raced = true;
        rows.set(keyOf(`AIDLC_RELEASE_CHANNEL#stable`, 'META'), {
          pk: 'AIDLC_RELEASE_CHANNEL#stable',
          sk: 'META',
          channel: 'stable',
          releaseId: CANDIDATE_RELEASE_ID,
          revision: 1,
        });
      }
      return realSend(command);
    };
    try {
      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: CANDIDATE_RELEASE_ID,
          expectedRevision: promoted.revision,
          patch: { supportState: 'existing-only' },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_channel_pinned' });
    } finally {
      ddbMock.send = realSend;
    }
  });
});

describe('setChannel cross-row compare-and-swap', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('refuses the pointer when the target is demoted between the read and the write', async () => {
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');
    // The target was selectable when read. A concurrent admin bumps its revision
    // before the channel write, so the ConditionCheck on the release row fails
    // and no pointer is published.
    let raced = false;
    const realSend = ddbMock.send.bind(ddbMock);
    ddbMock.send = async (command) => {
      if (!raced && command instanceof TransactWriteCommand) {
        raced = true;
        const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
        rows.set(key, {
          ...rows.get(key),
          supportState: 'existing-only',
          revision: promoted.revision + 1,
        });
      }
      return realSend(command);
    };
    try {
      await expect(
        setChannel({
          ...registryArgs(),
          channel: 'stable',
          releaseId: CANDIDATE_RELEASE_ID,
          expectedRevision: null,
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_revision_conflict' });
    } finally {
      ddbMock.send = realSend;
    }
    expect(await getChannel({ ...registryArgs(), channel: 'stable' })).toBeNull();
  });
});

describe('clearChannel', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await setChannel({
      ...registryArgs(),
      channel: 'preview',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });
  });

  it('removes the pointer under a matching revision', async () => {
    const result = await clearChannel({
      ...registryArgs(),
      channel: 'preview',
      expectedRevision: 1,
      actor: 'admin-1',
    });

    expect(result).toEqual({ cleared: true, channel: 'preview' });
    expect(await getChannel({ ...registryArgs(), channel: 'preview' })).toBeNull();
  });

  it('refuses a stale revision and leaves the pointer in place', async () => {
    await expect(
      clearChannel({ ...registryArgs(), channel: 'preview', expectedRevision: 99 }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });
    expect((await getChannel({ ...registryArgs(), channel: 'preview' })).releaseId).toBe(
      CANDIDATE_RELEASE_ID,
    );
  });

  it('refuses an unset channel and an invalid channel name', async () => {
    await expect(
      clearChannel({ ...registryArgs(), channel: 'candidate', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });
    await expect(
      clearChannel({ ...registryArgs(), channel: 'nightly', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'release_channel_invalid' });
  });
});

describe('resolveSelectableRelease degrades a stranded stable pointer', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  // Hand-written rows: updateRelease now refuses to CREATE these states, so the
  // only way in is a restored backup or a direct table edit. Intent creation must
  // survive both.
  const strandStableAt = (patch) => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    rows.set(key, { ...rows.get(key), ...patch });
    rows.set(keyOf('AIDLC_RELEASE_CHANNEL#stable', 'META'), {
      pk: 'AIDLC_RELEASE_CHANNEL#stable',
      sk: 'META',
      channel: 'stable',
      releaseId: CANDIDATE_RELEASE_ID,
      revision: 1,
    });
  };

  it.each([
    ['a hidden target', { supportState: 'certified', visible: false, runnable: true }],
    ['a demoted target', { supportState: 'existing-only', visible: true, runnable: true }],
    ['a non-runnable target', { supportState: 'certified', visible: true, runnable: false }],
  ])('returns null for %s instead of blocking every new intent', async (_label, patch) => {
    strandStableAt(patch);

    await expect(resolveSelectableRelease({ ...registryArgs() })).resolves.toBeNull();
  });

  it('returns null when the stable target is not registered at all', async () => {
    rows.set(keyOf('AIDLC_RELEASE_CHANNEL#stable', 'META'), {
      pk: 'AIDLC_RELEASE_CHANNEL#stable',
      sk: 'META',
      channel: 'stable',
      releaseId: 'aidlc:deadbeef',
      revision: 1,
    });

    await expect(resolveSelectableRelease({ ...registryArgs() })).resolves.toBeNull();
  });

  it('still REJECTS an explicitly requested non-selectable release', async () => {
    strandStableAt({ supportState: 'existing-only', visible: true, runnable: true });

    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: CANDIDATE_RELEASE_ID }),
    ).rejects.toMatchObject({ code: 'release_not_selectable' });
  });
});

describe('listRegistrableProfiles tolerates a masked 403', () => {
  const accessDenied = () => {
    const error = new Error('Access Denied');
    error.name = 'AccessDenied';
    error.$metadata = { httpStatusCode: 403 };
    return error;
  };

  it('reports published:false instead of failing the whole listing', async () => {
    // Without s3:ListBucket, S3 answers a GET for an ABSENT key with 403 rather
    // than 404, which would make GET /aidlc-release-profiles fail unexpectedly.
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!objects.has(input.Key)) throw accessDenied();
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });
    objects.delete(baselineBundle.manifest.catalog.key.replace('catalog.json', 'manifest.json'));

    const profiles = await listRegistrableProfiles({ ...registryArgs(), s3, bucket: BUCKET });

    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.find((p) => p.profileId === BASELINE_PROFILE).published).toBe(false);
    expect(profiles.find((p) => p.profileId === CANDIDATE_PROFILE).published).toBe(true);
  });

  it('does NOT swallow a 403 on the registration path', async () => {
    // Registration is an execution path: "cannot read" must never be downgraded
    // to "not published", or a permissions regression would look like a missing
    // release instead of the misconfiguration it is.
    s3Mock.on(GetObjectCommand).callsFake(() => {
      throw accessDenied();
    });

    await expect(registerRelease(registerArgs(BASELINE_PROFILE))).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });
});

describe('registration asserts manifest identity', () => {
  it('refuses a manifest whose releaseId is not the profile it was asked for', async () => {
    // The bytes at the baseline profile's key describe a DIFFERENT release id,
    // which would splice one release's identity onto another's provenance.
    const manifestKey = baselineBundle.manifest.catalog.key.replace(
      'catalog.json',
      'manifest.json',
    );
    const stored = JSON.parse(objects.get(manifestKey));
    objects.set(
      manifestKey,
      `${JSON.stringify({ ...stored, releaseId: 'aidlc:someone-elses-release' }, null, 2)}\n`,
    );

    await expect(registerRelease(registerArgs(BASELINE_PROFILE))).rejects.toMatchObject({
      code: 'release_manifest_invalid',
    });
    expect(rows.has(keyOf(`AIDLC_RELEASE#${BASELINE_RELEASE_ID}`, 'META'))).toBe(false);
  });
});

describe('non-admin projection', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });
  });

  it('exposes only selection fields — no keys, digests, SHAs, or actor subs', async () => {
    const [release] = await listReleases({ ...registryArgs(), visibleOnly: true });

    expect(Object.keys(release).toSorted()).toEqual(
      [
        'certifiedAt',
        'profileId',
        'releaseId',
        'runnable',
        'supportState',
        'trustTier',
        'upstreamChannel',
        'upstreamVersion',
        'visible',
      ].toSorted(),
    );
  });

  it('keeps every operator field for an admin', async () => {
    const [release] = await listReleases({ ...registryArgs(), visibleOnly: false });

    expect(release).toMatchObject({
      sourceSha: candidateBundle.manifest.sourceSha,
      closureDigest: candidateBundle.manifest.closureDigest,
      manifestKey: expect.any(String),
      registeredBy: 'admin-1',
      certifiedBy: 'admin-1',
    });
  });

  it('withholds channel timestamps and actors from a non-admin', async () => {
    const asUser = await getChannels({ ...registryArgs(), selectionOnly: true });
    const asAdmin = await getChannels({ ...registryArgs() });

    expect(Object.keys(asUser.stable).toSorted()).toEqual(['channel', 'releaseId', 'revision']);
    expect(asAdmin.stable.updatedBy).toBe('admin-1');
  });
});

// ── Channel transitions reject changes that weaken release selection ──
//
// Patches to a channel-pinned release are rejected only when the next state would
// make that channel ineligible. An existing ineligible pointer can still be
// corrected or annotated when the patch does not make its state worse.

describe('updateRelease only refuses transitions that worsen a channel', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  const currentRevision = async (releaseId) =>
    (await getRelease({ ...registryArgs(), releaseId })).revision;

  const releaseKey = (releaseId) => keyOf(`AIDLC_RELEASE#${releaseId}`, 'META');

  // Force the stuck state directly: a channel pointing at a record that is not
  // runnable. setChannel refuses to create this, so it can only arrive by a
  // restored backup or a hand-edited row — which is exactly the case that must
  // remain correctable.
  const strandPointerOnNonRunnable = async () => {
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });
    const key = releaseKey(CANDIDATE_RELEASE_ID);
    rows.set(key, { ...rows.get(key), runnable: false });
  };

  it('accepts a notes patch on an already-stranded, non-runnable channel target', async () => {
    await strandPointerOnNonRunnable();

    const noted = await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
      patch: { notes: 'import evidence was revoked — see INC-1234' },
      actor: 'admin-2',
    });

    expect(noted.notes).toBe('import evidence was revoked — see INC-1234');
    expect(noted.runnable).toBe(false);
    // The pointer is untouched: correcting the record is not the same as fixing
    // the channel, which still has to be moved or cleared.
    expect((await getChannel({ ...registryArgs(), channel: 'stable' })).releaseId).toBe(
      CANDIDATE_RELEASE_ID,
    );
  });

  it('accepts a CORRECTIVE demotion of an already-stranded channel target', async () => {
    await strandPointerOnNonRunnable();

    const demoted = await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
      patch: { supportState: 'existing-only', visible: false },
      actor: 'admin-2',
    });

    expect(demoted.supportState).toBe('existing-only');
    expect(demoted.visible).toBe(false);
  });

  it('still refuses a demotion that takes a HEALTHY channel target from valid to invalid', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });

    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: await currentRevision(CANDIDATE_RELEASE_ID),
        patch: { supportState: 'existing-only' },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_channel_pinned', details: { channels: ['stable'] } });
  });

  it('exposes the worsening rule directly through channelsBrokenBy', async () => {
    const certified = { releaseId: 'r', runnable: true, visible: true, supportState: 'certified' };
    const hidden = { ...certified, visible: false };
    const channels = { stable: { releaseId: 'r' }, candidate: { releaseId: 'r' } };

    // certified -> hidden worsens both channels.
    expect(__test.channelsBrokenBy(hidden, channels, certified).toSorted()).toEqual([
      'candidate',
      'stable',
    ]);
    // hidden -> hidden worsens nothing, even though neither channel is satisfied.
    expect(__test.channelsBrokenBy(hidden, channels, hidden)).toEqual([]);
    // Without a `current`, the check remains absolute, which is
    // what setChannel's own target assertion needs.
    expect(__test.channelsBrokenBy(hidden, channels).toSorted()).toEqual(['candidate', 'stable']);
  });
});

describe('a cancelled transaction reports the channel guard over the revision check', () => {
  beforeEach(async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('reports release_channel_pinned when index 0 ALSO failed', async () => {
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');
    // Both conditions fail in the same transaction: another admin bumped the
    // revision AND pointed stable at this release. The actionable cause is the
    // pointer — a bare revision conflict would send the caller into a retry loop
    // that can never succeed.
    const realSend = ddbMock.send.bind(ddbMock);
    let raced = false;
    ddbMock.send = async (command) => {
      if (!raced && command instanceof TransactWriteCommand) {
        raced = true;
        const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
        rows.set(key, { ...rows.get(key), revision: promoted.revision + 5 });
        rows.set(keyOf('AIDLC_RELEASE_CHANNEL#stable', 'META'), {
          pk: 'AIDLC_RELEASE_CHANNEL#stable',
          sk: 'META',
          channel: 'stable',
          releaseId: CANDIDATE_RELEASE_ID,
          revision: 1,
        });
      }
      return realSend(command);
    };
    try {
      await expect(
        updateRelease({
          ...registryArgs(),
          releaseId: CANDIDATE_RELEASE_ID,
          expectedRevision: promoted.revision,
          patch: { supportState: 'existing-only' },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({
        code: 'release_channel_pinned',
        details: { channels: ['stable'] },
      });
    } finally {
      ddbMock.send = realSend;
    }
  });

  it('still reports a revision conflict when ONLY index 0 failed', async () => {
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');

    await expect(
      updateRelease({
        ...registryArgs(),
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: promoted.revision + 9,
        patch: { supportState: 'existing-only' },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_revision_conflict' });
  });
});
