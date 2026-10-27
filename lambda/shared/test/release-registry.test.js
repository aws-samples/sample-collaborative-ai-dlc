// The release registry and channel pointers.
//
// The property under test: registration records evidence and nothing more, and
// every state transition that could widen selection is refused unless the
// release is provably runnable and structurally valid. Concurrency is a
// first-class case — two admins racing must not silently clobber one another.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { UNMAPPED_FIELD_GAP_VALUE } from '../aidlc-capabilities.js';
import { customProfile, filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  publishReleaseBundle,
} from '../aidlc-release.js';
import { AIDLC_COMPATIBILITY_PROFILES } from '../aidlc-compatibility-profiles.js';
import {
  __test as releaseResolverTest,
  loadReleaseClosure,
  resolveMethodologyLibrary,
} from '../release-resolver.js';
import { loadExecutionPlan, loadWorkflowScopes } from '../v2-workflow-plan.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { INVOKE_DIALECT_ANNEX, buildStagePrompt } from '../../agentcore/stage-materializer.js';
import { composePersonaPrompt } from '../../agentcore/persona-dispatch.js';
import {
  __test,
  RELEASE_CHANNELS,
  SUPPORT_STATES,
  clearChannel,
  getChannel,
  getChannels,
  getRelease,
  isAccessDenied,
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
// Neither fixture authors `agent-team`, and the current build cannot honour it,
// so a stale list holding it can only reach a caller that TRUSTED that list. It
// is what makes a "no gap" result evidence of recomputation rather than a value
// the recomputation would have produced anyway.
const UNPRODUCIBLE_GAP = Object.freeze({
  blockType: 'STAGE',
  field: 'mode',
  value: 'agent-team',
});

const {
  FIDELITY_EVIDENCE_REVISION,
  RELEASE_LIST_EVIDENCE_BUDGET,
  RELEASE_LIST_EVIDENCE_BUDGET_MS,
} = __test;

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
  // The listing's attempt marker is the only UpdateCommand: one SET of one field.
  ddbMock.on(UpdateCommand).callsFake((input) => {
    const key = keyOf(input.Key.pk, input.Key.sk);
    const existing = rows.get(key);
    if (!conditionHolds(input, existing)) throw conditionalCheckFailed();
    const field = input.ExpressionAttributeNames['#attempt'];
    rows.set(key, { ...existing, [field]: input.ExpressionAttributeValues[':now'] });
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

const markCandidateHandledForTransitionTest = () => {
  const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
  const registered = rows.get(key);
  // Most channel tests exercise registry transitions independently of the
  // fidelity guard. Model a candidate whose authored values are all handled;
  // dedicated promotion tests below retain the real 2.9.0 gaps.
  rows.set(key, { ...registered, fidelityGaps: [] });
};

// Promote a registered release all the way to a channel-eligible state, which
// always takes two explicit decisions: a support state and a visibility flip.
const promote = async (releaseId, supportState) => {
  if (releaseId === CANDIDATE_RELEASE_ID) markCandidateHandledForTransitionTest();
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
    markCandidateHandledForTransitionTest();
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

// Custom fork records. The property under test: a fork is recorded as evidence
// only, and the one way to make it offerable is the explicit admin promotion,
// through the same fidelity guard an official release passes.
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

  it('is made runnable only by an explicit promotion through the fidelity guard', async () => {
    const { release } = await registerFork();
    expect(release).toMatchObject({ runnable: false, unhonouredValues: [] });

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: FORK_RELEASE_ID,
      expectedRevision: release.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });
    const visible = await updateRelease({
      ...registryArgs(),
      releaseId: FORK_RELEASE_ID,
      expectedRevision: promoted.revision,
      patch: { visible: true },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', runnable: true, custom: true });
    expect(visible.visible).toBe(true);
    await expect(
      resolveSelectableRelease({ ...registryArgs(), releaseId: FORK_RELEASE_ID }),
    ).resolves.toMatchObject({ releaseId: FORK_RELEASE_ID, custom: true, runnable: true });
    await expect(
      setChannel({
        ...registryArgs(),
        channel: 'candidate',
        releaseId: FORK_RELEASE_ID,
        actor: 'admin-1',
      }),
    ).resolves.toMatchObject({ releaseId: FORK_RELEASE_ID });
  });

  it('pins a promoted fork to its own custom closure', async () => {
    await registerFork();
    await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: FORK_RELEASE_ID,
      expectedRevision: 1,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    const pin = releasePinFromRecord(
      await getRelease({ ...registryArgs(), releaseId: FORK_RELEASE_ID }),
    );

    expect(pin).toMatchObject({
      releaseId: FORK_RELEASE_ID,
      custom: true,
      sourceRepository: FORK_REPOSITORY,
      manifestKey: expect.stringContaining(`/custom/${FORK_REPOSITORY}/`),
    });
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

  it('takes only an S3 AccessDenied for a masked read, not another 403', () => {
    expect(isAccessDenied(accessDenied())).toBe(true);
    expect(isAccessDenied({ Code: 'AccessDenied' })).toBe(true);
    expect(
      isAccessDenied({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }),
    ).toBe(false);
    expect(isAccessDenied({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } })).toBe(false);
  });
});

// A customer's own fork that keeps 2.9.0's foundations but not its content: a
// new scope, a new blocking sensor with its script, and a new stage that runs in
// that scope. Promotion asks the same question as for an official release:
// does this build have a handler for everything the fork authors?
describe('a custom fork of 2.9.0 with its own stages, scopes and sensors', () => {
  const FORK_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
  const FORK_REPOSITORY = 'acme/aidlc-own';
  // `invokeLines: false` leaves out the engine commands the real 2.9.0 bodies carry.
  const forkFiles = ({ invokeLines = true } = {}) => {
    const files = filesWithInvokeLines(CANDIDATE_PROFILE, invokeLines ? CANDIDATE_PROFILE : null);
    const lines = (...parts) => `${parts.join('\n')}\n`;
    files.set(
      'core/scopes/acme-hotfix.md',
      lines(
        '---',
        'name: hotfix',
        'depth: Minimal',
        'keywords: []',
        'description: Ship one urgent fix behind a security review',
        'skeleton: off',
        'runner: true',
        'change_control: relaxed',
        '---',
        'Hotfix scope.',
      ),
    );
    files.set(
      'core/sensors/acme-secrets.md',
      lines(
        '---',
        'id: secrets',
        'kind: deterministic',
        'command: {{INVOKE}} engine sensor-secrets',
        'default_severity: blocking',
        'description: Refuses committed credentials',
        'category: security',
        'matches: "**/*.{ts,js}"',
        'input_schema:',
        '  file_path: string',
        'output_schema:',
        '  pass: boolean',
        'timeout_seconds: 30',
        '---',
        'Secrets sensor.',
      ),
    );
    files.set('core/tools/aidlc-sensor-secrets.ts', 'export const secrets = true;\n');
    files.set(
      'core/aidlc-common/stages/construction/acme-security-review.md',
      lines(
        '---',
        'slug: acme-security-review',
        'name: Security Review',
        'phase: construction',
        'execution: ALWAYS',
        'condition: Always',
        'lead_agent: aidlc-devsecops-agent',
        'support_agents: []',
        'mode: inline',
        'produces:',
        '  - security-review',
        'consumes: []',
        'sensors:',
        '  - secrets',
        'scopes:',
        '  - hotfix',
        '  - feature',
        'inputs: the working tree',
        'outputs: security-review.md',
        '---',
        'Review the change for security issues.',
      ),
    );
    return files;
  };
  const publishFork = async (files) => {
    const profile = customProfile({
      repository: FORK_REPOSITORY,
      sha: FORK_SHA,
      baseProfileId: CANDIDATE_PROFILE,
    });
    const bundle = buildReleaseBundle({ profile, files });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const { release } = await registerCustomRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      repository: FORK_REPOSITORY,
      sha: FORK_SHA,
      baseProfileId: CANDIDATE_PROFILE,
      actor: 'admin-1',
    });
    return release;
  };
  const promoteFork = (release) =>
    updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: release.releaseId,
      expectedRevision: release.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

  it("is promoted and its pinned plan runs the fork's own stage and sensor", async () => {
    const registered = await publishFork(forkFiles());
    const promoted = await promoteFork(registered);
    await updateRelease({
      ...registryArgs(),
      releaseId: registered.releaseId,
      expectedRevision: promoted.revision,
      patch: { visible: true },
      actor: 'admin-1',
    });
    const selected = await resolveSelectableRelease({
      ...registryArgs(),
      releaseId: registered.releaseId,
    });

    const resolved = await expectPinnedPlansResolve(selected);
    const { plan } = buildExecutionPlan({
      workflow: resolved.workflow,
      scope: 'hotfix',
      library: resolved.library,
    });

    expect(registered).toMatchObject({ runnable: false, unhonouredValues: [] });
    expect(promoted).toMatchObject({ supportState: 'selectable', runnable: true });
    const review = plan.stages.find((stage) => stage.stageId === 'acme-security-review');
    expect(review.sensors.map((sensor) => sensor.sensorId)).toEqual(['secrets']);
  });

  // Production reaches a closure through the plan and scope loaders, which must
  // hand the resolver the registry: without it every fork pin is refused.
  it('resolves its pin through the plan and scope loaders intents and the orchestrator use', async () => {
    const registered = await publishFork(forkFiles());
    await promoteFork(registered);
    const methodologyRelease = releasePinFromRecord(
      await getRelease({ ...registryArgs(), releaseId: registered.releaseId }),
    );
    const { catalog } = await loadReleaseClosure({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      methodologyRelease,
      cache: new Map(),
    });
    const args = {
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      methodologyRelease,
      workflowId: catalog.workflow.id,
      workflowVersion: catalog.workflow.workflowVersion,
    };

    releaseResolverTest.releaseClosureCache.clear();
    expect(await loadWorkflowScopes(args)).toContain('hotfix');
    releaseResolverTest.releaseClosureCache.clear();
    const { valid, errors } = await loadExecutionPlan({ ...args, scope: 'hotfix' });
    expect({ valid, errors }).toEqual({ valid: true, errors: [] });
  });

  it('stays import-only, and the admin sees why, when it authors behavior this build cannot honour', async () => {
    const files = forkFiles();
    const path = 'core/aidlc-common/stages/construction/acme-security-review.md';
    files.set(path, files.get(path).replace('mode: inline', 'mode: agent-team'));
    const registered = await publishFork(files);
    const gap = { blockType: 'STAGE', field: 'mode', value: 'agent-team' };

    expect(registered.unhonouredValues).toEqual([gap]);
    await expect(promoteFork(registered)).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [gap] },
    });
    expect(await getRelease({ ...registryArgs(), releaseId: registered.releaseId })).toMatchObject({
      runnable: false,
      supportState: 'structurally-valid',
    });
  });

  // The annex is appended to a prompt only when a part the release authors to
  // INSTRUCT carries the token — the stage body, the conductor, a persona or the
  // reference knowledge — and this fork's carry none. A rule body is rendered
  // into the stage's steering doc but is not a part any builder gates on, so an
  // engine command invoked there reaches a session with no answer.
  it('refuses an answered engine command that only a body no prompt annexes invokes', async () => {
    const files = forkFiles({ invokeLines: false });
    const rule = 'core/memory/org.md';
    expect(files.has(rule)).toBe(true);
    files.set(
      rule,
      `${files.get(rule)}\nRecord it: {{INVOKE}} engine state practices-event --type override\n`,
    );
    const registered = await publishFork(files);
    const gap = { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine state' };

    expect(registered.unhonouredValues).toEqual([gap]);
    await expect(promoteFork(registered)).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [gap] },
    });
  });

  // Bodies are content-addressed, so a stage and a rule authored with the SAME
  // text share one object. Coverage belongs to each consuming block: the rule's
  // session still receives the command, so the verdict must be the one the
  // distinct-body case gets. Deduplication is a storage detail and may not
  // decide compatibility.
  it.each([
    ['share one body', false],
    ['carry their own', true],
  ])('refuses it when the stage and the rule %s', async (_label, distinct) => {
    const files = forkFiles({ invokeLines: false });
    const stage = 'core/aidlc-common/stages/construction/acme-security-review.md';
    const rule = 'core/memory/org.md';
    const command = 'Record it: {{INVOKE}} engine state practices-event --type override.';
    files.set(stage, `${files.get(stage)}\n${command}\n`);
    files.set(rule, `${command}${distinct ? ' Org layer.' : ''}\n`);
    const registered = await publishFork(files);
    const gap = { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine state' };

    expect(registered.unhonouredValues).toEqual([gap]);
    await expect(promoteFork(registered)).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [gap] },
    });
  });

  // An APPROXIMATED family is no gap only where the annex that names the
  // platform's substitute arrives: the agent learns from it that the platform
  // owns the worktree and that the branch is readable from git. Invoked from a
  // body no builder annexes, the session has the authored step and no
  // substitute, so membership in the approximated list cannot clear it.
  it('refuses an approximated command whose answer does not reach its prompt', async () => {
    const files = forkFiles({ invokeLines: false });
    const rule = 'core/memory/org.md';
    files.set(
      rule,
      `${files.get(rule)}\nObtain the branch: {{INVOKE}} engine worktree info --slug current\n`,
    );
    const registered = await publishFork(files);
    const gap = { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine worktree' };

    expect(registered.unhonouredValues).toEqual([gap]);
    await expect(promoteFork(registered)).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps: [gap] },
    });
  });

  it.each([
    'core/aidlc-common/stages/construction/acme-security-review.md',
    'core/agents/aidlc-devsecops-agent.md',
    'core/knowledge/aidlc-shared/state-template.md',
  ])('honours an approximated command invoked from %s', async (path) => {
    const files = forkFiles({ invokeLines: false });
    expect(files.has(path), path).toBe(true);
    files.set(
      path,
      `${files.get(path)}\nObtain the branch: {{INVOKE}} engine worktree info --slug current\n`,
    );
    const registered = await publishFork(files);

    expect(registered.fidelityGaps.filter((gap) => gap.blockType === 'BODY')).toEqual([]);
    expect(registered.unhonouredValues).toEqual([]);
    await expect(promoteFork(registered)).resolves.toMatchObject({ runnable: true });
  });

  it('honours the same command in a stage body, and graph ars in the composer persona', async () => {
    const files = forkFiles({ invokeLines: false });
    const stage = 'core/aidlc-common/stages/construction/acme-security-review.md';
    const composer = 'core/agents/aidlc-composer-agent.md';
    expect(files.has(composer)).toBe(true);
    files.set(
      stage,
      `${files.get(stage)}\nRecord it: {{INVOKE}} engine state practices-event --type override\n`,
    );
    files.set(composer, `${files.get(composer)}\n{{INVOKE}} engine graph ars --iae <s>\n`);
    const registered = await publishFork(files);

    expect(registered.fidelityGaps.filter((gap) => gap.blockType === 'BODY')).toEqual([
      { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine graph ars', annexed: true },
      { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine state', annexed: true },
    ]);
    await expect(promoteFork(registered)).resolves.toMatchObject({ runnable: true });
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
        'constructionAutonomy',
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

describe('construction autonomy on the release listing', () => {
  // Selectable as registered, so each record keeps the evidence its own closure
  // produced instead of the emptied list the transition tests use.
  const offer = (releaseId, over = {}) => {
    const key = keyOf(`AIDLC_RELEASE#${releaseId}`, 'META');
    rows.set(key, { ...rows.get(key), supportState: 'selectable', visible: true, ...over });
  };
  const listed = async (releaseId, visibleOnly = true) =>
    (await listReleases({ ...registryArgs(), visibleOnly })).find(
      (release) => release.releaseId === releaseId,
    );

  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('is true for a release that ships the construction protocol, for users and admins', async () => {
    offer(CANDIDATE_RELEASE_ID);
    expect((await listed(CANDIDATE_RELEASE_ID)).constructionAutonomy).toBe(true);
    expect((await listed(CANDIDATE_RELEASE_ID, false)).constructionAutonomy).toBe(true);
  });

  it('is false for a release without the construction protocol', async () => {
    offer(BASELINE_RELEASE_ID);
    expect((await listed(BASELINE_RELEASE_ID)).constructionAutonomy).toBe(false);
  });

  it('reads evidence stored before the capability was registered', async () => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const fidelityGaps = rows
      .get(key)
      .fidelityGaps.filter((gap) => gap.field !== 'construction-autonomy');
    expect(fidelityGaps).toContainEqual({
      blockType: 'PROTOCOL',
      field: 'build-and-test-loopback',
      value: 'present',
    });
    offer(CANDIDATE_RELEASE_ID, { fidelityGaps });
    expect((await listed(CANDIDATE_RELEASE_ID)).constructionAutonomy).toBe(true);
  });

  it('is false when the record carries no evidence', async () => {
    offer(CANDIDATE_RELEASE_ID, { fidelityGaps: null });
    expect((await listed(CANDIDATE_RELEASE_ID)).constructionAutonomy).toBe(false);
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

// Acceptance: a deployment of this build, starting from an empty registry, can
// promote and run 2.8.2 and 2.9.0. The compatibility fixtures omit every body,
// so each is rebuilt with every `{{INVOKE}} engine` line its real release
// carries, verbatim, in every file (prompts, skills, templates, the engine's
// hooks, protocols and tools).
const INVOKE_LINES = JSON.parse(
  readFileSync(new URL('./fixtures/aidlc-release-invoke-lines.json', import.meta.url), 'utf8'),
);

const filesWithInvokeLines = (profileId, linesFrom = profileId) => {
  const files = filesFromCompatibilityFixture({
    profileId,
    fixture: JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });
  for (const [path, lines] of Object.entries(INVOKE_LINES[linesFrom]?.files ?? {})) {
    expect(files.has(path), path).toBe(true);
    files.set(path, `${files.get(path)}\n${lines.join('\n')}\n`);
  }
  return files;
};

// The plan of every scope the release offers resolves from the pinned closure.
const expectPinnedPlansResolve = async (release) => {
  const closure = await loadReleaseClosure({
    s3,
    bucket: BUCKET,
    methodologyRelease: releasePinFromRecord(release),
    ...registryArgs(),
    cache: new Map(),
  });
  const resolved = await resolveMethodologyLibrary({
    closure,
    ddb: ddbMock,
    tableName: TABLE,
    workflowId: closure.catalog.workflow.id,
    workflowVersion: closure.catalog.workflow.workflowVersion,
  });
  const scopes = Object.keys(resolved.library.scopesById);
  expect(scopes.length).toBeGreaterThan(0);
  for (const scope of scopes) {
    const { valid, errors } = buildExecutionPlan({
      workflow: resolved.workflow,
      scope,
      library: resolved.library,
    });
    expect({ scope, valid, errors }).toEqual({ scope, valid: true, errors: [] });
  }
  return resolved;
};

describe.each(['v2.8.2', 'v2.9.0'])('a deployment promoting the real %s', (profileId) => {
  const bundle = buildReleaseBundle({ profileId, files: filesWithInvokeLines(profileId) });
  const { releaseId } = bundle.manifest;
  const engineCommand = (value) => ({
    blockType: 'BODY',
    field: '{{INVOKE}}',
    value,
    annexed: true,
  });

  beforeEach(async () => {
    installFakes();
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
  });

  it('registers it with only the engine commands its prompts invoke, and none unhonoured', async () => {
    const { release } = await registerRelease(registerArgs(profileId));

    expect(release.fidelityGaps.filter((gap) => gap.blockType === 'BODY')).toEqual(
      ['engine graph ars', 'engine orchestrate', 'engine recompose', 'engine state'].map(
        engineCommand,
      ),
    );
    expect(release.unhonouredValues).toEqual([]);
  });

  it('promotes it to selectable, offers it, and resolves every pinned plan', async () => {
    await registerRelease(registerArgs(profileId));
    const stated = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId,
      expectedRevision: 1,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });
    await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId,
      expectedRevision: stated.revision,
      patch: { visible: true },
      actor: 'admin-1',
    });

    const selected = await resolveSelectableRelease({ ...registryArgs(), releaseId });

    expect(selected).toMatchObject({ supportState: 'selectable', visible: true, runnable: true });
    await expectPinnedPlansResolve(selected);
  });
});

// The guard's verdict is only honest if the prompt the session actually gets
// carries the annex, so the two shapes an upstream release really uses are
// walked end to end: registration, promotion, plan resolution, and the prompt
// that receives the body. 2.9.0 with its own `{{INVOKE}}` lines left out, so the
// only engine command in the closure is the one each case authors.
describe('a 2.9.0 whose developer persona carries the engine command', () => {
  const STAGE_PATH = 'core/aidlc-common/stages/construction/code-generation.md';
  const PERSONA_PATH = 'core/agents/aidlc-developer-agent.md';
  // The receiving stage: `aidlc-developer-agent` leads it, its own body carries
  // no token, and it runs in the `feature` scope. The annex can therefore only
  // arrive through the persona.
  const RECEIVING_STAGE = 'reverse-engineering';
  const SCOPE = 'feature';

  // Bodies are content-addressed, so two blocks given the same body text are ONE
  // object. Replacing the body rather than appending to it is what makes the
  // stage and the persona share it.
  const withBody = (content, body) =>
    `${content.slice(0, content.indexOf('\n---\n') + 5)}${body}\n`;

  const publishPromoteAndResolve = async (files) => {
    installFakes();
    const bundle = buildReleaseBundle({ profileId: CANDIDATE_PROFILE, files });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const { release } = await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const stated = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: release.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });
    await updateRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: stated.revision,
      patch: { visible: true },
      actor: 'admin-1',
    });
    const selected = await resolveSelectableRelease({
      ...registryArgs(),
      releaseId: CANDIDATE_RELEASE_ID,
    });
    return {
      bundle,
      registered: release,
      promoted: stated,
      resolved: await expectPinnedPlansResolve(selected),
    };
  };

  // The bytes the runtime renders for a block: its body is a content-addressed
  // object, read from the closure through `loadBlockBody`.
  const bodyOf = (block) => {
    const key = block?.bodyRef?.s3Key;
    expect(objects.has(key), key).toBe(true);
    return objects.get(key);
  };

  const receivingStage = (resolved) => {
    const { plan } = buildExecutionPlan({
      workflow: resolved.workflow,
      scope: SCOPE,
      library: resolved.library,
    });
    const stage = plan.stages.find((entry) => entry.stageId === RECEIVING_STAGE);
    expect(stage, RECEIVING_STAGE).toBeDefined();
    const stageBody = bodyOf(resolved.library.stagesById[stage.stageId]);
    const persona = bodyOf(resolved.library.agentsById[stage.agentRef]);
    expect(stage.agentRef).toBe('aidlc-developer-agent');
    expect(stageBody).not.toContain('{{INVOKE}}');
    return { stage, stageBody, persona };
  };

  const bodyKeysOf = (bundle, blockIds) => {
    const byId = new Map(
      Object.values(bundle.catalog.blocks)
        .flat()
        .map((block) => [block.blockId, block.bodyRef?.s3Key]),
    );
    return blockIds.map((blockId) => {
      expect(byId.has(blockId), blockId).toBe(true);
      return byId.get(blockId);
    });
  };

  it('promotes a body the code-generation stage and that persona share, and annexes the prompt that receives it', async () => {
    const files = filesWithInvokeLines(CANDIDATE_PROFILE, null);
    const body = 'Record it: {{INVOKE}} engine state practices-event --type override';
    for (const path of [STAGE_PATH, PERSONA_PATH]) {
      expect(files.has(path), path).toBe(true);
      files.set(path, withBody(files.get(path), body));
    }

    const { bundle, registered, promoted, resolved } = await publishPromoteAndResolve(files);
    const { stage, stageBody, persona } = receivingStage(resolved);

    expect(new Set(bodyKeysOf(bundle, ['code-generation', 'aidlc-developer-agent'])).size).toBe(1);
    expect(registered.fidelityGaps.filter((gap) => gap.blockType === 'BODY')).toEqual([
      { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine state', annexed: true },
    ]);
    expect(registered.unhonouredValues).toEqual([]);
    expect(promoted).toMatchObject({ supportState: 'selectable', runnable: true });
    expect(persona).toContain('{{INVOKE}} engine state practices-event');
    expect(buildStagePrompt({ stage, stageBody, agentPersona: persona })).toContain(
      INVOKE_DIALECT_ANNEX,
    );
  });

  it('promotes an approximated command that persona invokes, and annexes its prompt and reviewer brief', async () => {
    const files = filesWithInvokeLines(CANDIDATE_PROFILE, null);
    expect(files.has(PERSONA_PATH)).toBe(true);
    files.set(
      PERSONA_PATH,
      `${files.get(PERSONA_PATH)}\nObtain the branch: {{INVOKE}} engine worktree info --slug current\n`,
    );

    const { registered, promoted, resolved } = await publishPromoteAndResolve(files);
    const { stage, stageBody, persona } = receivingStage(resolved);

    expect(registered.fidelityGaps.filter((gap) => gap.blockType === 'BODY')).toEqual([]);
    expect(registered.unhonouredValues).toEqual([]);
    expect(promoted).toMatchObject({ supportState: 'selectable', runnable: true });
    expect(buildStagePrompt({ stage, stageBody, agentPersona: persona })).toContain(
      INVOKE_DIALECT_ANNEX,
    );
    // The same persona is rendered into the reviewer brief of that stage, which
    // is a session the guard counted as answered too.
    expect(
      composePersonaPrompt({ brief: 'Review it.', persona, knowledge: '', role: 'reviewer' }),
    ).toContain(INVOKE_DIALECT_ANNEX);
  });
});

// An execution-relevant authored field no adapter consumes is how a future
// release would silently lose a setting: the closure already records its name,
// so promotion must name it as a blocker rather than leave it to certification.
// AI-DLC 2.11.0 and 2.11.1, end to end on the real releases: the exact upstream commit's
// frontmatter (the pinned compatibility fixture, every blob verified against the
// upstream git tree when it was generated) plus every `{{INVOKE}} engine` line
// those files really carry. Publication, registration, promotion and every
// offered scope's pinned plan all run against that closure.
//
// It promotes with nothing unhonoured, and it promotes the whole way an
// administrator may take it: `selectable`, then `certified`, then the `stable`
// channel.
// 2.11.1 answers one command 2.11.0 never invokes: build-and-test's cross-unit
// coverage gate asks for a sensor run on request.
const REAL_211_RELEASES = Object.freeze([
  {
    PROFILE: 'v2.11.0',
    SHA: '6a378b53c0a4fe0641ed7d8de8dfff94264d5b6a',
    VERSION: '2.11.0',
    ADDED: [],
  },
  {
    PROFILE: 'v2.11.1',
    SHA: '895a35d86d20336d9b7bc4aedc9440e4a12c83ab',
    VERSION: '2.11.1',
    ADDED: ['engine sensor-<id> --stage'],
  },
]);
for (const { PROFILE, SHA, VERSION, ADDED } of REAL_211_RELEASES) {
  describe(`a deployment admitting the real AI-DLC ${VERSION}`, () => {
    // The eleven engine commands 2.11 invokes that this runtime refuses, each
    // answered by name in the dialect annex, plus the four families 2.9.0 already
    // answered. Listed verbatim: a command that stopped being answered, or a new
    // one that started being honoured without an answer, must fail here.
    const ANSWERED_ENGINE_COMMANDS = Object.freeze(
      [
        'engine config set',
        'engine graph ars',
        'engine log answer',
        'engine log decision',
        'engine orchestrate',
        'engine orchestrate next',
        'engine recompose',
        'engine state',
        'engine state set-construction-execution',
        'engine state set-construction-verification-command',
        'engine testing-posture restore',
        'engine worktree discard',
        'engine worktree list',
        'engine worktree purge',
        'engine worktree restore',
        ...ADDED,
      ].toSorted(),
    );
    const bundle = buildReleaseBundle({ profileId: PROFILE, files: filesWithInvokeLines(PROFILE) });
    const { releaseId } = bundle.manifest;

    beforeEach(async () => {
      installFakes();
      await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    });

    const promote = async (supportState) => {
      const { release } = await registerRelease(registerArgs(PROFILE));
      return updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId,
        expectedRevision: release.revision,
        patch: { supportState },
        actor: 'admin-1',
      });
    };

    it('imports the exact upstream commit under the current importer revision', async () => {
      const { release } = await registerRelease(registerArgs(PROFILE));

      expect(release).toMatchObject({
        profileId: PROFILE,
        sourceSha: SHA,
        upstreamVersion: VERSION,
        importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
        trustTier: 'T1',
        structurallyValid: true,
        custom: false,
      });
    });

    it('records only engine commands the annex answers, and nothing unhonoured', async () => {
      const { release } = await registerRelease(registerArgs(PROFILE));

      expect(
        release.fidelityGaps
          .filter((gap) => gap.blockType === 'BODY')
          .map((gap) => ({ value: gap.value, annexed: gap.annexed })),
      ).toEqual(ANSWERED_ENGINE_COMMANDS.map((value) => ({ value, annexed: true })));
      // The four settings 2.11 renames or adds are MAPPED, so none is reported as
      // an unmapped execution-relevant field either.
      expect(release.unhonouredValues).toEqual([]);
    });

    it('promotes to selectable, offers it, and resolves all eleven scope plans', async () => {
      const stated = await promote('selectable');
      await updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId,
        expectedRevision: stated.revision,
        patch: { visible: true },
        actor: 'admin-1',
      });

      const selected = await resolveSelectableRelease({ ...registryArgs(), releaseId });
      expect(selected).toMatchObject({ supportState: 'selectable', visible: true, runnable: true });

      const resolved = await expectPinnedPlansResolve(selected);
      expect(Object.keys(resolved.library.scopesById)).toHaveLength(11);
    });

    // 2.11 is in the same answered-not-reproduced situation as 2.8.2 and 2.9.0,
    // which stay certifiable: whether the published handled/approximated/refused
    // table justifies the claim is the administrator's decision, not the
    // registry's, so `certified` and the `stable` channel it unlocks must both be
    // reachable.
    it('promotes to certified, like 2.9.0', async () => {
      const certified = await promote('certified');

      expect(certified.supportState).toBe('certified');
      expect(certified.certifiedBy).toBe('admin-1');
      expect(certified.certifiedAt).toEqual(expect.any(String));
    });

    it('may be pointed at by the stable channel once certified', async () => {
      const certified = await promote('certified');
      await updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId,
        expectedRevision: certified.revision,
        patch: { visible: true },
        actor: 'admin-1',
      });

      const stable = await setChannel({
        ...registryArgs(),
        channel: 'stable',
        releaseId,
        expectedRevision: null,
      });
      expect(stable.releaseId).toBe(releaseId);
    });

    it('still refuses an intermediate release nobody onboarded', async () => {
      await expect(registerRelease(registerArgs('v2.10.0'))).rejects.toMatchObject({
        code: 'release_profile_unknown',
      });
    });

    // A fork of a 2.11-shaped body goes through the SAME guard, borrowing only the
    // parsing dialect: it stays T0, it is `custom`, and it is never admitted under
    // the official repository slug.
    describe('a fork whose body is 2.11-shaped', () => {
      const FORK_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
      const FORK_REPOSITORY = 'acme/aidlc-211-fork';
      const forkProfile = customProfile({
        repository: FORK_REPOSITORY,
        sha: FORK_SHA,
        baseProfileId: PROFILE,
      });
      const forkBundle = buildReleaseBundle({
        profile: forkProfile,
        files: filesWithInvokeLines(PROFILE),
      });

      const registerFork = async () => {
        await publishReleaseBundle({ s3, bucket: BUCKET, bundle: forkBundle });
        return registerCustomRelease({
          ...registryArgs(),
          s3,
          bucket: BUCKET,
          repository: FORK_REPOSITORY,
          sha: FORK_SHA,
          baseProfileId: PROFILE,
          actor: 'admin-1',
        });
      };

      it('promotes through the same guard, stays T0, and is marked custom', async () => {
        const { release } = await registerFork();

        expect(release).toMatchObject({
          custom: true,
          trustTier: 'T0',
          sourceRepository: FORK_REPOSITORY,
          runnable: false,
        });
        // The fork borrows the 2.11 PARSING dialect and nothing else: not the
        // trust tier, not the support state.
        expect(forkProfile).toMatchObject({
          baseProfileId: PROFILE,
          frontmatterDialect: AIDLC_COMPATIBILITY_PROFILES[PROFILE].frontmatterDialect,
          trustTier: 'T0',
        });
        expect(release.unhonouredValues).toEqual([]);

        const promoted = await updateRelease({
          ...registryArgs(),
          s3,
          bucket: BUCKET,
          releaseId: release.releaseId,
          expectedRevision: release.revision,
          patch: { supportState: 'selectable' },
          actor: 'admin-1',
        });

        expect(promoted).toMatchObject({ supportState: 'selectable', runnable: true });
        expect(promoted.trustTier).toBe('T0');
        // The fork resolves only through a pin that names it as a fork; the
        // official 2.11 identity is a different release id entirely.
        expect(promoted.releaseId).not.toBe(releaseId);
      });

      // The three approximated families are not gaps because the ANNEX answers
      // them, and that answer only arrives where a prompt carries the annex. A
      // SCOPE body is rendered into the compose grounding, which no builder gates
      // on (`shared/annex-reach.js`), so a fork that moves such an invocation into
      // a scope has a consuming session instructed to run a command it has no
      // answer for — the exact invariant `annexed` is supposed to make checkable.
      // Membership in the approximated list is not evidence of reach, so promotion
      // must refuse it.
      describe('a fork that invokes an approximated command from a scope body', () => {
        const SCOPE_FORK_SHA = '0f0e0d0c0b0a09080706050403020100ffeeddcc';
        const SCOPE_REPOSITORY = 'acme/aidlc-211-scope-fork';

        const scopeForkFiles = () => {
          const files = filesWithInvokeLines(PROFILE);
          const scopePath = [...files.keys()].find((path) => path.startsWith('core/scopes/'));
          expect(scopePath, 'a scope body').toBeTruthy();
          files.set(
            scopePath,
            `${files.get(scopePath)}\n\nRecord the time with {{INVOKE}} engine now.\n`,
          );
          return files;
        };

        it('names the command as unhonoured and refuses promotion', async () => {
          const bundle = buildReleaseBundle({
            profile: customProfile({
              repository: SCOPE_REPOSITORY,
              sha: SCOPE_FORK_SHA,
              baseProfileId: PROFILE,
            }),
            files: scopeForkFiles(),
          });
          await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

          const { release } = await registerCustomRelease({
            ...registryArgs(),
            s3,
            bucket: BUCKET,
            repository: SCOPE_REPOSITORY,
            sha: SCOPE_FORK_SHA,
            baseProfileId: PROFILE,
            actor: 'admin-1',
          });

          expect(release.unhonouredValues).toContainEqual({
            blockType: 'BODY',
            field: '{{INVOKE}}',
            value: 'engine now',
          });
          await expect(
            updateRelease({
              ...registryArgs(),
              s3,
              bucket: BUCKET,
              releaseId: release.releaseId,
              expectedRevision: release.revision,
              patch: { supportState: 'selectable' },
              actor: 'admin-1',
            }),
          ).rejects.toMatchObject({ code: 'release_capability_unhandled' });
        });

        // The same command in a body every consuming prompt DOES annex — the
        // knowledge of an agent that only ever reviews — is answered: the shared
        // persona tail appends the annex whenever that knowledge instructs, so the
        // reviewer receives the answer with its recording channel redirected to
        // the tool it has.
        it('still honours it in a body whose prompts all carry the annex', async () => {
          const KNOWLEDGE_SHA = '1f1e1d1c1b1a19181716151413121110ffeeddcc';
          const REPOSITORY = 'acme/aidlc-211-knowledge-fork';
          const files = filesWithInvokeLines(PROFILE);
          const knowledgePath = [...files.keys()].find((path) =>
            path.startsWith('core/knowledge/aidlc-architecture-reviewer-agent/'),
          );
          expect(knowledgePath, 'a reviewer knowledge body').toBeTruthy();
          files.set(
            knowledgePath,
            `${files.get(knowledgePath)}\n\nStamp it with {{INVOKE}} engine now.\n`,
          );
          const bundle = buildReleaseBundle({
            profile: customProfile({
              repository: REPOSITORY,
              sha: KNOWLEDGE_SHA,
              baseProfileId: PROFILE,
            }),
            files,
          });
          await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

          const { release } = await registerCustomRelease({
            ...registryArgs(),
            s3,
            bucket: BUCKET,
            repository: REPOSITORY,
            sha: KNOWLEDGE_SHA,
            baseProfileId: PROFILE,
            actor: 'admin-1',
          });

          expect(release.unhonouredValues).toEqual([]);
        });
      });

      it('is never admitted under the official repository slug', () => {
        expect(() =>
          customProfile({
            repository: 'awslabs/aidlc-workflows',
            sha: SHA,
            baseProfileId: PROFILE,
          }),
        ).toThrow(expect.objectContaining({ code: 'custom_repository_official' }));
      });
    });
  });
}

// An execution-relevant authored field no adapter consumes is how a future
// release would silently lose a setting: the closure already records its name,
// so promotion must name it as a blocker rather than leave it to certification.

describe('a release authoring an execution-relevant field no adapter consumes', () => {
  const SCOPE_PATH = 'core/scopes/aidlc-bugfix.md';
  const FUTURE_FIELD = { blockType: 'SCOPE', field: 'future_switch', value: 'unmapped' };

  const withFutureField = (files) => {
    expect(files.has(SCOPE_PATH), SCOPE_PATH).toBe(true);
    files.set(SCOPE_PATH, files.get(SCOPE_PATH).replace('---\n', '---\nfuture_switch: later\n'));
    return files;
  };

  it.each(['selectable', 'certified'])(
    'refuses %s promotion and names the field',
    async (state) => {
      installFakes();
      const bundle = buildReleaseBundle({
        profileId: CANDIDATE_PROFILE,
        files: withFutureField(filesWithInvokeLines(CANDIDATE_PROFILE)),
      });
      await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
      const { release } = await registerRelease(registerArgs(CANDIDATE_PROFILE));

      expect(release.unhonouredValues).toContainEqual(FUTURE_FIELD);
      await expect(
        updateRelease({
          ...registryArgs(),
          s3,
          bucket: BUCKET,
          releaseId: release.releaseId,
          expectedRevision: release.revision,
          patch: { supportState: state },
          actor: 'admin-1',
        }),
      ).rejects.toMatchObject({ code: 'release_capability_unhandled' });
    },
  );

  // Fork promotion goes through the same guard, so a fork that authors an
  // unknown field is held exactly as an official release would be.
  it('holds a fork authoring the same field', async () => {
    installFakes();
    const FORK_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    const profile = customProfile({
      repository: 'acme/aidlc-own',
      sha: FORK_SHA,
      baseProfileId: CANDIDATE_PROFILE,
    });
    const bundle = buildReleaseBundle({
      profile,
      files: withFutureField(filesWithInvokeLines(CANDIDATE_PROFILE)),
    });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const { release } = await registerCustomRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      repository: 'acme/aidlc-own',
      sha: FORK_SHA,
      baseProfileId: CANDIDATE_PROFILE,
      actor: 'admin-1',
    });

    expect(release.unhonouredValues).toContainEqual(FUTURE_FIELD);
    await expect(
      updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId: release.releaseId,
        expectedRevision: release.revision,
        patch: { supportState: 'selectable' },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_capability_unhandled' });
  });
  // The regression guard for the blocker itself: every release this build
  // already promotes authors no such field, so none of them becomes blocked.
  it.each(Object.keys(AIDLC_COMPATIBILITY_PROFILES))(
    'leaves the allowlisted %s with no unmapped-field blocker',
    async (profileId) => {
      installFakes();
      const bundle = buildReleaseBundle({ profileId, files: filesWithInvokeLines(profileId) });
      await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

      const { release } = await registerRelease(registerArgs(profileId));

      expect(bundle.manifest.compatibility.executionRelevantUnmappedFields).toEqual([]);
      expect(
        release.unhonouredValues.filter((gap) => gap.value === UNMAPPED_FIELD_GAP_VALUE),
      ).toEqual([]);
    },
  );
});

describe('promotion of a record registered before protocol evidence existed', () => {
  // A record imported by an earlier build stored only its frontmatter gaps; the
  // build-and-test loop-back is a protocol the closure ships, not an authored
  // value, so that list says nothing about it.
  const registeredEarlier = async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const row = {
      ...rows.get(key),
      fidelityGaps: [
        { blockType: 'STAGE', field: 'mode', value: 'mob' },
        { blockType: 'STAGE', field: 'mode', value: 'pipeline' },
      ],
    };
    delete row.fidelityEvidenceRevision;
    rows.set(key, row);
    return row;
  };

  it('re-evaluates the closure, and promotes it once the loop-back is handled', async () => {
    const row = await registeredEarlier();

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: row.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', unhonouredValues: [] });
    expect(rows.get(keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META'))).toMatchObject({
      fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION,
    });
  });

  it('marks a record registered by this build as carrying complete evidence', async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));

    expect(rows.get(keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META'))).toMatchObject({
      fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION,
    });
  });

  // Pointing a channel at a release is a promotion gate too, so it must hold the
  // same evidence bar. Were it to trust a pre-protocol list, the decision would
  // depend on whether an admin listing had refreshed that record first.
  it('points a channel at a record whose stored evidence predates the protocol, once the loop-back is handled', async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const promoted = await promote(CANDIDATE_RELEASE_ID, 'certified');
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const row = { ...rows.get(key), fidelityGaps: [UNPRODUCIBLE_GAP] };
    delete row.fidelityEvidenceRevision;
    rows.set(key, row);

    await expect(
      setChannel({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        channel: 'candidate',
        releaseId: CANDIDATE_RELEASE_ID,
        actor: 'admin-1',
      }),
    ).resolves.toMatchObject({ releaseId: CANDIDATE_RELEASE_ID });
    expect(promoted.supportState).toBe('certified');
  });
});

describe('promotion of a record whose evidence read the engine sources', () => {
  // An earlier build stored, at evidence revision 2, the engine commands the
  // engine CLI's own sources quote. The closure's prompts author none of them, so
  // trusting that list would keep refusing the release for behavior it never
  // asks an agent for.
  it('re-evaluates the closure instead of trusting that list', async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const row = {
      ...rows.get(key),
      fidelityGaps: [{ blockType: 'BODY', field: '{{INVOKE}}', value: 'engine swarm prepare' }],
      fidelityEvidenceRevision: 2,
    };
    rows.set(key, row);

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: row.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', unhonouredValues: [] });
    expect(rows.get(key).fidelityGaps).not.toContainEqual(row.fidelityGaps[0]);
  });
});

// An `unmapped` gap says the importer of that closure stored NO value for the
// field. Adding a runtime handler later cannot recover what was dropped, so the
// blocker must survive a build that can handle the field — only a re-import
// under the newer revision may clear it.
describe('promotion of a closure whose importer never stored the field', () => {
  const UNMAPPED_GAPS = Object.freeze([
    { blockType: 'SCOPE', field: 'guard_policy', value: UNMAPPED_FIELD_GAP_VALUE },
    { blockType: 'SCOPE', field: 'plan_approval', value: UNMAPPED_FIELD_GAP_VALUE },
  ]);

  // The row an earlier importer revision left behind: its catalog has no value
  // for either field, and its gap list is current evidence for THAT closure.
  const atTheOlderImporterRevision = async () => {
    installFakes();
    const bundle = buildReleaseBundle({
      profileId: CANDIDATE_PROFILE,
      files: filesWithInvokeLines(CANDIDATE_PROFILE),
    });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    // The evidence revision stays the one this build just wrote, so the stored
    // list is current evidence and the guard reads it rather than recomputing:
    // the question under test is what the registry does with an `unmapped`
    // value it now has an entry for.
    const row = {
      ...rows.get(key),
      importerRevision: 2,
      fidelityGaps: [...UNMAPPED_GAPS],
    };
    rows.set(key, row);
    return row;
  };

  it.each(['selectable', 'certified'])('refuses %s promotion', async (state) => {
    const row = await atTheOlderImporterRevision();

    await expect(
      updateRelease({
        ...registryArgs(),
        s3,
        bucket: BUCKET,
        releaseId: CANDIDATE_RELEASE_ID,
        expectedRevision: row.revision,
        patch: { supportState: state },
        actor: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'release_capability_unhandled' });
  });

  it('keeps naming both fields when an admin lists it', async () => {
    await atTheOlderImporterRevision();

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const listed = releases.find((release) => release.releaseId === CANDIDATE_RELEASE_ID);
    for (const gap of UNMAPPED_GAPS) {
      expect(listed.unhonouredValues).toContainEqual(gap);
    }
    expect(listed.importerRevision).toBe(2);
  });
});

// Mapping a new authored field removes its `unmapped` blocker, and nothing else
// makes the setting work, so each of the four carries a classification from the
// moment it becomes mapped and holds promotion until its handler ships. This PR
// resolves the last of them, so the whole set promotes — and an illegal value is
// still refused, which is what keeps these promotions a statement about the
// VALUES rather than about the field names.
describe('fork promotion of a release authoring the 2.11 scope settings', () => {
  const SCOPE_PATH = 'core/scopes/aidlc-classic.md';
  const SETTINGS = [
    'guard_policy: strict',
    'plan_approval: off',
    'collaborators: off',
    'existing_code: true',
  ];
  const FORK_REPOSITORY = 'acme/aidlc-settings';
  const FORK_SHA = 'bcdef0123456789abcdef0123456789abcdef012';

  const withSettings = (files, lines) => {
    expect(files.has(SCOPE_PATH), SCOPE_PATH).toBe(true);
    files.set(SCOPE_PATH, files.get(SCOPE_PATH).replace('---\n', `---\n${lines.join('\n')}\n`));
    return files;
  };

  const forkBundle = (lines) =>
    buildReleaseBundle({
      profile: customProfile({
        repository: FORK_REPOSITORY,
        sha: FORK_SHA,
        baseProfileId: CANDIDATE_PROFILE,
      }),
      files: withSettings(filesWithInvokeLines(CANDIDATE_PROFILE), lines),
    });

  const registerFork = async (lines) => {
    installFakes();
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle: forkBundle(lines) });
    return registerCustomRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      repository: FORK_REPOSITORY,
      sha: FORK_SHA,
      baseProfileId: CANDIDATE_PROFILE,
      actor: 'admin-1',
    });
  };

  const promoteFork = (release, state) =>
    updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: release.releaseId,
      expectedRevision: release.revision,
      patch: { supportState: state },
      actor: 'admin-1',
    });

  it.each(SETTINGS)('promotes a fork authoring %s alone', async (line) => {
    const { release } = await registerFork([line]);

    // The field is mapped, so its `unmapped` blocker is gone — and it is
    // handled, which is why nothing replaced it.
    expect(release.unhonouredValues).toEqual([]);
    await expect(promoteFork(release, 'selectable')).resolves.toMatchObject({
      supportState: 'selectable',
    });
  });

  it.each(['selectable', 'certified'])(
    'promotes a fork authoring all of them to %s',
    async (state) => {
      const { release } = await registerFork(SETTINGS);

      expect(release.unhonouredValues).toEqual([]);
      await expect(promoteFork(release, state)).resolves.toMatchObject({ supportState: state });
    },
  );

  it.each(['guard_policy: paranoid', 'plan_approval: maybe', 'existing_code: "true"'])(
    'refuses to import a fork authoring %s',
    (line) => {
      installFakes();

      expect(() => forkBundle([line])).toThrow(
        expect.objectContaining({ code: 'release_import_rejected' }),
      );
    },
  );
});

// A stored list carrying a NUMERIC revision this build has moved past is the
// other stale shape, and the one an upgrade actually produces: the previous
// build wrote `fidelityEvidenceRevision: 4` with evidence that never judged an
// unmapped execution-relevant field, so the row looks complete while holding a
// verdict this build would not reach. The revision — not the presence of a list
// — is what has to decide whether the closure is re-read.
describe('promotion of a record whose evidence predates the unmapped-field blocker', () => {
  const STALE_GAP = Object.freeze({
    blockType: 'BODY',
    field: '{{INVOKE}}',
    value: 'engine state practices-event',
    annexed: false,
  });

  const registeredAtTheOlderRevision = async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const row = { ...rows.get(key), fidelityGaps: [STALE_GAP], fidelityEvidenceRevision: 4 };
    rows.set(key, row);
    return { key, row };
  };

  it('re-evaluates the closure instead of trusting that list', async () => {
    const { key, row } = await registeredAtTheOlderRevision();

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: row.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', unhonouredValues: [] });
    expect(rows.get(key).fidelityGaps).not.toContainEqual(STALE_GAP);
    expect(rows.get(key)).toMatchObject({ fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION });
  });

  it('reports the recomputed answer when an admin lists it', async () => {
    const { key } = await registeredAtTheOlderRevision();

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const listed = releases.find((release) => release.releaseId === CANDIDATE_RELEASE_ID);
    expect(listed.unhonouredValues).toEqual([]);
    expect(listed.fidelityGaps).not.toContainEqual(STALE_GAP);
    expect(rows.get(key)).toMatchObject({ fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION });
  });
});

// The classification itself changed twice on top of revision 5:
// `feat/release-scope-policy` judges a scope policy value by its authored type
// and activates one only from a field a consumer reads, and the fourteen 2.11
// engine-command families are each classified in their own right. A fork
// registered while the PREVIOUS build was running holds a current-looking
// revision-5 list with the old blockers, so promoting that same stored closure
// after the upgrade has to recollect the evidence rather than trust it.
describe('promotion of a record whose evidence predates the 2.11 command classification', () => {
  const registeredAtThePreviousClassification = async () => {
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const row = {
      ...rows.get(key),
      fidelityGaps: [
        {
          kind: 'engine-command',
          blockType: 'BODY',
          field: '{{INVOKE}}',
          value: 'engine state practices-event',
          annexed: false,
        },
      ],
      fidelityEvidenceRevision: 5,
    };
    rows.set(key, row);
    return { key, row };
  };

  it('recollects the evidence and stores the current revision', async () => {
    const { key, row } = await registeredAtThePreviousClassification();

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: CANDIDATE_RELEASE_ID,
      expectedRevision: row.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', unhonouredValues: [] });
    expect(rows.get(key).fidelityGaps).not.toContainEqual(row.fidelityGaps[0]);
    expect(rows.get(key)).toMatchObject({ fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION });
  });
});

// A 2.11.1 record registered before `sensor-<id> --stage` was classified: that
// build stored the bare command as an unknown, unannexed family, at revision 6.
// Its list looked current, so promotion trusted it and refused the release
// forever — the bug the revision bump fixes.
describe('promotion of a 2.11.1 record whose evidence predates the sensor-on-request classification', () => {
  const PROFILE = 'v2.11.1';
  const STALE_GAP = Object.freeze({
    blockType: 'BODY',
    field: '{{INVOKE}}',
    value: 'engine sensor-traceability --stage',
  });
  const bundle211 = buildReleaseBundle({
    profileId: PROFILE,
    files: filesWithInvokeLines(PROFILE),
  });
  const releaseId211 = bundle211.manifest.releaseId;

  const registeredByThePreviousBuild = async () => {
    installFakes();
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle: bundle211 });
    await registerRelease(registerArgs(PROFILE));
    const key = keyOf(`AIDLC_RELEASE#${releaseId211}`, 'META');
    const row = {
      ...rows.get(key),
      fidelityGaps: [
        ...rows.get(key).fidelityGaps.filter((gap) => gap.value !== 'engine sensor-<id> --stage'),
        STALE_GAP,
      ],
      fidelityEvidenceRevision: 6,
    };
    rows.set(key, row);
    return { key, row };
  };

  it('is stale, so neither the listing nor promotion trusts that list', async () => {
    const { key } = await registeredByThePreviousBuild();

    expect(FIDELITY_EVIDENCE_REVISION).toBeGreaterThan(6);
    const listed = (await listReleases({ ...registryArgs(), s3, bucket: BUCKET })).find(
      (release) => release.releaseId === releaseId211,
    );
    expect(listed.unhonouredValues).toEqual([]);
    expect(rows.get(key)).toMatchObject({ fidelityEvidenceRevision: FIDELITY_EVIDENCE_REVISION });
  });

  it('promotes once the closure is re-evaluated', async () => {
    const { key, row } = await registeredByThePreviousBuild();

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: releaseId211,
      expectedRevision: row.revision,
      patch: { supportState: 'certified' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'certified', unhonouredValues: [] });
    expect(rows.get(key).fidelityGaps.map((gap) => gap.value)).not.toContain(STALE_GAP.value);
  });
});

describe('admin listing of a record registered before protocol evidence existed', () => {
  // Drop the protocol evidence from a registered row, the shape an earlier build
  // left behind: a stored gap list with no `fidelityEvidenceRevision`. The stored
  // list holds a value this closure does not author, so every assertion below
  // distinguishes a recomputed answer from a trusted one.
  const makeLegacy = (releaseId) => {
    const key = keyOf(`AIDLC_RELEASE#${releaseId}`, 'META');
    const row = { ...rows.get(key), fidelityGaps: [UNPRODUCIBLE_GAP] };
    delete row.fidelityEvidenceRevision;
    rows.set(key, row);
    return key;
  };

  // The listing Lambda has 128 MB, so the closure reads it issues must stay
  // bounded however many legacy records the page carries.
  const trackedReads = () => {
    const state = { inFlight: 0, peakInFlight: 0, reads: 0 };
    s3Mock.on(GetObjectCommand).callsFake(async (input) => {
      if (!objects.has(input.Key)) throw noSuchKey();
      state.inFlight += 1;
      state.reads += 1;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      await Promise.resolve();
      state.inFlight -= 1;
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });
    return state;
  };

  beforeEach(async () => {
    await registerRelease(registerArgs(BASELINE_PROFILE));
    await registerRelease(registerArgs(CANDIDATE_PROFILE));
  });

  it('reports what promotion decides once the loop-back is handled', async () => {
    const key = makeLegacy(CANDIDATE_RELEASE_ID);

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const listed = releases.find((release) => release.releaseId === CANDIDATE_RELEASE_ID);
    expect(listed.unhonouredValues).toEqual([]);
    expect(listed.fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
    expect(rows.get(key).fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
  });

  // One closure's worth of reads: its manifest, its catalog, and its objects.
  const perClosureReads = () =>
    Math.max(baselineBundle.manifest.objects.length, candidateBundle.manifest.objects.length) + 2;

  it('verifies at most the budgeted record however many are stale, and says so', async () => {
    makeLegacy(BASELINE_RELEASE_ID);
    makeLegacy(CANDIDATE_RELEASE_ID);
    const reads = trackedReads();

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    // A deploy that bumps the evidence revision makes EVERY row stale at once.
    // The listing may not pay for all of them: it recomputes up to the budget
    // and reports the rest with the evidence it has, marked stale.
    expect(releases.filter((release) => release.fidelityEvidenceStale === false).length).toBe(
      RELEASE_LIST_EVIDENCE_BUDGET,
    );
    expect(releases.filter((release) => release.fidelityEvidenceStale === true).length).toBe(
      releases.length - RELEASE_LIST_EVIDENCE_BUDGET,
    );
    expect(reads.reads).toBeLessThanOrEqual(perClosureReads() * RELEASE_LIST_EVIDENCE_BUDGET);
    // Two closures verified in parallel would peak at both evidence pools at
    // once; one closure at a time cannot exceed a single pool.
    expect(reads.peakInFlight).toBeLessThanOrEqual(4);
  });

  it('reports the stored evidence for a row it did not recompute', async () => {
    makeLegacy(BASELINE_RELEASE_ID);
    makeLegacy(CANDIDATE_RELEASE_ID);

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const deferred = releases.find((release) => release.fidelityEvidenceStale === true);
    expect(deferred.fidelityGaps).toContainEqual(UNPRODUCIBLE_GAP);
    // The row is left untouched, so the next listing can still recompute it.
    expect(rows.get(keyOf(`AIDLC_RELEASE#${deferred.releaseId}`, 'META'))).not.toHaveProperty(
      'fidelityEvidenceRevision',
    );
  });

  it('works the backlog down one budget at a time across listings', async () => {
    makeLegacy(BASELINE_RELEASE_ID);
    makeLegacy(CANDIDATE_RELEASE_ID);

    await listReleases({ ...registryArgs(), s3, bucket: BUCKET });
    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    expect(releases.every((release) => release.fidelityEvidenceStale === false)).toBe(true);
    for (const release of releases)
      expect(release.fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
  });

  it('leaves a page of current records untouched and reads no closure', async () => {
    const reads = trackedReads();

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    expect(releases.length).toBe(2);
    expect(releases.every((release) => release.fidelityEvidenceStale === false)).toBe(true);
    expect(reads.reads).toBe(0);
  });

  it('still recomputes before a promotion decides on a row the listing deferred', async () => {
    makeLegacy(BASELINE_RELEASE_ID);
    makeLegacy(CANDIDATE_RELEASE_ID);
    const listed = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });
    const deferred = listed.find((release) => release.fidelityEvidenceStale === true);
    const deferredKey = keyOf(`AIDLC_RELEASE#${deferred.releaseId}`, 'META');
    expect(rows.get(deferredKey).fidelityGaps).toContainEqual(UNPRODUCIBLE_GAP);

    const promoted = await updateRelease({
      ...registryArgs(),
      s3,
      bucket: BUCKET,
      releaseId: deferred.releaseId,
      expectedRevision: deferred.revision,
      patch: { supportState: 'selectable' },
      actor: 'admin-1',
    });

    expect(promoted).toMatchObject({ supportState: 'selectable', unhonouredValues: [] });
    expect(promoted.fidelityEvidenceStale).toBe(false);
    expect(rows.get(deferredKey).fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
  });

  it('caches the recomputed evidence so the next listing reads no closure', async () => {
    const key = makeLegacy(CANDIDATE_RELEASE_ID);
    const legacy = rows.get(key);

    const first = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });
    const cached = rows.get(key);
    const reads = trackedReads();
    const second = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const listed = first.find((release) => release.releaseId === CANDIDATE_RELEASE_ID);
    expect(cached.fidelityEvidenceRevision).toBe(FIDELITY_EVIDENCE_REVISION);
    expect(cached.fidelityGaps).toEqual(listed.fidelityGaps);
    expect(cached.fidelityGaps).not.toEqual(legacy.fidelityGaps);
    // Evidence is derived from an immutable closure, never a decision, so the
    // cache write must leave the record's revision and audit trail alone.
    expect(cached.revision).toBe(legacy.revision);
    expect(cached.updatedAt).toBe(legacy.updatedAt);
    expect(cached.updatedBy).toBe(legacy.updatedBy);
    expect(reads.reads).toBe(0);
    expect(second).toEqual(first);
  });

  // Filling the cache is opportunistic; the listing is a GET that must answer with
  // the evidence it just computed whatever the write does, so EVERY failure mode
  // is swallowed — a lost CAS race and a hard store failure alike.
  it.each([
    ['the cache write loses a race', conditionalCheckFailed],
    [
      'the store rejects the cache write outright',
      () => new Error('ProvisionedThroughputExceeded'),
    ],
  ])('still reports the recomputed gaps when %s', async (_case, failure) => {
    const key = makeLegacy(CANDIDATE_RELEASE_ID);
    const stale = rows.get(key);
    ddbMock.on(PutCommand).callsFake((input) => {
      const putKey = keyOf(input.Item.pk, input.Item.sk);
      if (putKey === key) throw failure();
      rows.set(putKey, { ...input.Item });
      return {};
    });

    const releases = await listReleases({ ...registryArgs(), s3, bucket: BUCKET });

    const listed = releases.find((release) => release.releaseId === CANDIDATE_RELEASE_ID);
    expect(listed.unhonouredValues).toEqual([]);
    expect(listed.fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
    // No evidence was stored: the row is what it was, plus the attempt marker the
    // listing claimed its turn with before reading the closure.
    const { fidelityEvidenceAttemptedAt, ...unchanged } = rows.get(key);
    expect(typeof fidelityEvidenceAttemptedAt).toBe('string');
    expect(unchanged).toEqual(stale);
  });
});

// A stale row whose closure cannot be read is not a hypothetical: an object
// lifecycle rule, a half-finished publish or a bucket policy change produces
// one, and no later listing can ever verify it. The page order is deterministic
// (`releaseGsi1Sk`), so such a row holds its place in front of the others on
// every call. If a failed verification spent the per-call budget, the rows
// behind it would stay at their stored evidence for good — the backlog would
// never converge. Only a verification that produced evidence may spend the
// budget, and the wall clock is what bounds a page of failures.
describe('admin listing with a stale row whose closure cannot be verified', () => {
  // Five registered releases, the page size the defect was reported on.
  // `current-stable` is 2.3.3, so it sorts FIRST and is the row every other row
  // sits behind.
  const PAGE_PROFILES = ['current-stable', 'v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0'];
  const BROKEN_PROFILE = 'current-stable';
  const MIGRATING_PROFILES = PAGE_PROFILES.filter((profileId) => profileId !== BROKEN_PROFILE);
  const bundles = new Map(PAGE_PROFILES.map((profileId) => [profileId, bundleFor(profileId)]));

  const rowKeyOf = (profileId) =>
    keyOf(`AIDLC_RELEASE#${AIDLC_COMPATIBILITY_PROFILES[profileId].releaseId}`, 'META');

  // The shape a revision bump leaves behind: a stored gap list, no evidence
  // revision. The list holds a value no fixture authors, so a row still holding
  // it was never recomputed.
  const makeStale = (profileId) => {
    const key = rowKeyOf(profileId);
    const row = { ...rows.get(key), fidelityGaps: [UNPRODUCIBLE_GAP] };
    delete row.fidelityEvidenceRevision;
    rows.set(key, row);
  };

  const breakClosure = (profileId) => {
    const key = bundles.get(profileId).manifest.catalog.key;
    expect(objects.has(key), key).toBe(true);
    objects.delete(key);
  };

  const migrated = () =>
    PAGE_PROFILES.filter(
      (profileId) =>
        rows.get(rowKeyOf(profileId)).fidelityEvidenceRevision === FIDELITY_EVIDENCE_REVISION,
    );

  const list = () => listReleases({ ...registryArgs(), s3, bucket: BUCKET });

  beforeEach(async () => {
    installFakes();
    for (const bundle of bundles.values())
      await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    for (const profileId of PAGE_PROFILES) await registerRelease(registerArgs(profileId));
    for (const profileId of PAGE_PROFILES) makeStale(profileId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates every other stale row across calls, one budget at a time', async () => {
    breakClosure(BROKEN_PROFILE);

    // One VERIFIED row per call, in page order: the failure in front of them
    // costs its own reads but no budget.
    for (const [index, profileId] of MIGRATING_PROFILES.entries()) {
      await list();
      expect(migrated(), `after ${index + 1} listing(s)`).toEqual(
        MIGRATING_PROFILES.slice(0, index + 1),
      );
      expect(rows.get(rowKeyOf(profileId)).fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
    }

    // The broken row is reported, left untouched and re-attempted, never cached.
    const releases = await list();
    const broken = releases.find(
      (release) => release.releaseId === AIDLC_COMPATIBILITY_PROFILES[BROKEN_PROFILE].releaseId,
    );
    expect(broken.fidelityGaps).toBeNull();
    expect(rows.get(rowKeyOf(BROKEN_PROFILE))).not.toHaveProperty('fidelityEvidenceRevision');
    expect(rows.get(rowKeyOf(BROKEN_PROFILE)).fidelityGaps).toContainEqual(UNPRODUCIBLE_GAP);
  });

  it('stops starting verifications once the wall-clock budget is spent', async () => {
    for (const profileId of PAGE_PROFILES) breakClosure(profileId);
    // The budget is a wall clock, so the clock is stubbed rather than waited
    // out: a test that really spent it would be a six-second test. One failing
    // verification is charged more than half the budget, so the third must not
    // be started however many rows are left.
    const step = Math.ceil(RELEASE_LIST_EVIDENCE_BUDGET_MS / 2) + 1;
    let clock = 0;
    let attempts = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!objects.has(input.Key)) throw noSuchKey();
      if (input.Key.endsWith('manifest.json')) {
        attempts += 1;
        clock += step;
      }
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });

    const releases = await list();

    expect(attempts).toBe(2);
    expect(migrated()).toEqual([]);
    // Everything the clock stopped is answered with the evidence it has.
    expect(releases.filter((release) => release.fidelityEvidenceStale === true).length).toBe(
      PAGE_PROFILES.length - attempts,
    );
  });

  // The failure in front of the page can also be SLOW: a read that spends the
  // whole wall-clock budget before failing. Nothing behind it is then even
  // attempted, so a listing that restarts at the same first stale row on every
  // call would park every later row at its stored evidence for good — one call's
  // bounds would become the permanent end of the backlog.
  it('gives a later stale row its turn when the first row fails on the full clock', async () => {
    breakClosure(BROKEN_PROFILE);
    const brokenCatalogKey = bundles.get(BROKEN_PROFILE).manifest.catalog.key;
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!objects.has(input.Key)) {
        if (input.Key === brokenCatalogKey) clock += RELEASE_LIST_EVIDENCE_BUDGET_MS;
        throw noSuchKey();
      }
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });

    // Each listing is its own request, so each one starts with a full budget.
    let listed = [];
    for (let call = 0; call < 3; call += 1) {
      clock = 0;
      listed = await list();
    }

    // A healthy row behind the failure has current evidence by now.
    const healthy = migrated();
    expect(healthy.length).toBeGreaterThan(0);
    for (const profileId of healthy) {
      expect(rows.get(rowKeyOf(profileId)).fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
      const release = listed.find(
        (candidate) => candidate.releaseId === AIDLC_COMPATIBILITY_PROFILES[profileId].releaseId,
      );
      expect(release.fidelityEvidenceStale).toBe(false);
      expect(release.fidelityGaps).not.toContainEqual(UNPRODUCIBLE_GAP);
    }

    // The row that could not be read is never recorded as verified.
    expect(healthy).not.toContain(BROKEN_PROFILE);
    expect(rows.get(rowKeyOf(BROKEN_PROFILE))).not.toHaveProperty('fidelityEvidenceRevision');
    expect(rows.get(rowKeyOf(BROKEN_PROFILE)).fidelityGaps).toContainEqual(UNPRODUCIBLE_GAP);
  });

  it('spends the budget, not the clock, when every closure can be verified', async () => {
    const step = RELEASE_LIST_EVIDENCE_BUDGET_MS;
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!objects.has(input.Key)) throw noSuchKey();
      if (input.Key.endsWith('manifest.json')) clock += step;
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });

    await list();

    expect(migrated().length).toBe(RELEASE_LIST_EVIDENCE_BUDGET);
  });

  // A read that never returns (a stalled request, a Lambda killed at its
  // timeout) records nothing after it. The turn is therefore claimed before the
  // read, so the next listing starts on another row.
  it('claims a row before reading it, so a read that never returns does not hold the next listing', async () => {
    const catalogOf = (profileId) => bundles.get(profileId).manifest.catalog.key;
    const firstReads = [];
    let reads = [];
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      const profileId = PAGE_PROFILES.find((candidate) => catalogOf(candidate) === input.Key);
      if (profileId) reads.push(profileId);
      if (profileId === BROKEN_PROFILE) return new Promise(() => {});
      if (!objects.has(input.Key)) throw noSuchKey();
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });

    for (let call = 0; call < 3; call += 1) {
      reads = [];
      void list();
      await new Promise((resolve) => setTimeout(resolve, 30));
      firstReads.push(reads[0]);
    }

    expect(firstReads[0]).toBe(BROKEN_PROFILE);
    expect(firstReads.slice(1)).not.toContain(BROKEN_PROFILE);
  });

  // Two admins listing at once: one listing caches evidence for a row while the
  // other fails to read the same row. The attempt marker is a one-field update,
  // so the failure cannot overwrite the evidence the first listing stored.
  it('never lets a failed attempt overwrite evidence a concurrent listing cached', async () => {
    const catalogKey = bundles.get(BROKEN_PROFILE).manifest.catalog.key;
    let catalogReads = 0;
    s3Mock.on(GetObjectCommand).callsFake(async (input) => {
      if (input.Key === catalogKey) {
        catalogReads += 1;
        if (catalogReads === 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw noSuchKey();
        }
      }
      if (!objects.has(input.Key)) throw noSuchKey();
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });

    await Promise.all([list(), list()]);

    expect(catalogReads).toBe(2);
    expect(rows.get(rowKeyOf(BROKEN_PROFILE)).fidelityEvidenceRevision).toBe(
      FIDELITY_EVIDENCE_REVISION,
    );
  });
});
