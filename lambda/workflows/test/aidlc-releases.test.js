// The release-registry HTTP surface on the workflows
// lambda.
//
// The properties under test: mutations are platform-admin only, a non-admin list
// sees nothing it could not actually select, a colon-bearing release id
// round-trips through a percent-encoded path parameter, and every registry
// failure maps to a stable {error, code} with the right status.

import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { customProfile, filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle } from '../../shared/aidlc-release.js';
import {
  __test as releaseResolverTest,
  methodologyReleasePinFromManifest,
} from '../../shared/release-resolver.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';
const BASELINE_PROFILE = 'current-stable';
const CANDIDATE_PROFILE = 'v2.9.0';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const s3 = new S3Client({});
const objects = new Map();
const rows = new Map();
const keyOf = (pk, sk) => `${pk}|${sk}`;

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const preconditionFailed = () => {
  const error = new Error('precondition failed');
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

const bundleFor = (profileId) =>
  buildReleaseBundle({
    profileId,
    files: filesFromCompatibilityFixture({
      profileId,
      fixture: JSON.parse(
        readFileSync(
          new URL(
            `../../shared/test/fixtures/aidlc-compatibility/${profileId}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    }),
  });

const baselineBundle = bundleFor(BASELINE_PROFILE);
const candidateBundle = bundleFor(CANDIDATE_PROFILE);
const BASELINE_RELEASE_ID = baselineBundle.manifest.releaseId;
const CANDIDATE_RELEASE_ID = candidateBundle.manifest.releaseId;

const installFakes = () => {
  s3Mock.reset();
  ddbMock.reset();
  lambdaMock.reset();
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
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const reasons = input.TransactItems.map((entry) => {
      const operation = entry.Put ?? entry.ConditionCheck ?? entry.Delete;
      const target = entry.Put ? entry.Put.Item : operation.Key;
      return conditionHolds(operation, rows.get(keyOf(target.pk, target.sk)))
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

const adminClaims = {
  sub: 'admin-1',
  email: 'admin@example.com',
  'cognito:groups': 'platform-admin',
};
const memberClaims = { sub: 'user-2', email: 'user2@example.com' };

// API Gateway hands over `event.resource` including the /api stage prefix.
const releaseEvent = ({ method, resource, pathParameters = {}, body, claims = adminClaims }) => ({
  httpMethod: method,
  resource: `/api${resource}`,
  path: `/api${resource}`,
  pathParameters,
  body: body === undefined ? null : JSON.stringify(body),
  queryStringParameters: {},
  requestContext: { authorizer: { claims } },
  headers: {},
});

let handler;
const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  process.env.INTENTS_FUNCTION = 'intents-test';
  ({ handler } = await import('../index.js'));
});

beforeEach(async () => {
  installFakes();
  // Closures are immutable, so the resolver's cache is never invalidated in
  // production. Each test must still start cold or a tampered-bytes case would
  // be served from an earlier test's verified closure.
  releaseResolverTest.releaseClosureCache.clear();
  await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle: baselineBundle });
  await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle: candidateBundle });
});

const register = async (profileId, claims = adminClaims) =>
  parse(
    await handler(
      releaseEvent({ method: 'POST', resource: '/aidlc-releases', body: { profileId }, claims }),
    ),
  );

const patchRelease = (releaseId, body, claims = adminClaims) =>
  handler(
    releaseEvent({
      method: 'PATCH',
      resource: '/aidlc-releases/{releaseId}',
      pathParameters: { releaseId: encodeURIComponent(releaseId) },
      body,
      claims,
    }),
  );

const putChannel = (channel, body, claims = adminClaims) =>
  handler(
    releaseEvent({
      method: 'PUT',
      resource: '/aidlc-release-channels/{channel}',
      pathParameters: { channel },
      body,
      claims,
    }),
  );

const listReleases = (claims = adminClaims) =>
  handler(releaseEvent({ method: 'GET', resource: '/aidlc-releases', claims }));

// Two decisions, because support state and visibility are deliberately separate.
const promote = async (releaseId, supportState) => {
  if (releaseId === CANDIDATE_RELEASE_ID) {
    const key = keyOf(`AIDLC_RELEASE#${releaseId}`, 'META');
    const registered = rows.get(key);
    // These cases exercise channel transitions independently of the fidelity
    // guard. Model an otherwise-identical candidate whose values are handled;
    // the dedicated guard test keeps the actual unsupported evidence.
    rows.set(key, { ...registered, fidelityGaps: [] });
  }
  const registered = parse(await listReleases()).body.releases.find(
    (release) => release.releaseId === releaseId,
  );
  const stated = parse(
    await patchRelease(releaseId, { expectedRevision: registered.revision, supportState }),
  );
  return parse(
    await patchRelease(releaseId, {
      expectedRevision: stated.body.release.revision,
      visible: true,
    }),
  );
};

describe('POST /aidlc-releases', () => {
  it('registers a published release as invisible evidence', async () => {
    const res = await register(CANDIDATE_PROFILE);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'registered',
      release: {
        releaseId: CANDIDATE_RELEASE_ID,
        supportState: 'structurally-valid',
        visible: false,
        runnable: true,
        revision: 1,
      },
    });
  });

  it('is idempotent and reports 200 for an already-registered closure', async () => {
    await register(CANDIDATE_PROFILE);
    const again = await register(CANDIDATE_PROFILE);

    expect(again.status).toBe(200);
    expect(again.body.status).toBe('already-registered');
  });

  it('400s a profile whose bytes were never published', async () => {
    objects.clear();
    const res = await register(CANDIDATE_PROFILE);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_not_published');
  });

  it('400s an unknown profile and a missing profileId', async () => {
    expect((await register('nope')).body.code).toBe('release_profile_unknown');
    const missing = parse(
      await handler(releaseEvent({ method: 'POST', resource: '/aidlc-releases', body: {} })),
    );
    expect(missing.status).toBe(400);
  });

  it('403s a non-admin', async () => {
    const res = await register(CANDIDATE_PROFILE, memberClaims);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLATFORM_ADMIN_REQUIRED');
    expect(rows.size).toBe(0);
  });
});

describe('GET /aidlc-releases', () => {
  beforeEach(async () => {
    await register(BASELINE_PROFILE);
    await register(CANDIDATE_PROFILE);
  });

  it('shows an admin every record, oldest upstream version first', async () => {
    const res = parse(await listReleases());

    expect(res.status).toBe(200);
    expect(res.body.releases.map((release) => release.upstreamVersion)).toEqual(['2.3.3', '2.9.0']);
  });

  it('shows a non-admin only visible, selectable records', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await promote(BASELINE_RELEASE_ID, 'existing-only');

    const res = parse(await listReleases(memberClaims));

    expect(res.status).toBe(200);
    expect(res.body.releases.map((release) => release.releaseId)).toEqual([CANDIDATE_RELEASE_ID]);
  });
});

describe('PATCH /aidlc-releases/{releaseId}', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
  });

  it('round-trips a percent-encoded, colon-bearing release id', async () => {
    const res = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1, notes: 'reviewed' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.release.releaseId).toBe(CANDIDATE_RELEASE_ID);
    expect(res.body.release.notes).toBe('reviewed');
    expect(res.body.release.revision).toBe(2);
  });

  it('409s a stale expectedRevision', async () => {
    await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1, visible: true });

    const res = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1, visible: false }),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_revision_conflict');
  });

  it('404s an unregistered release', async () => {
    const res = parse(await patchRelease('aidlc:missing', { expectedRevision: 1, visible: true }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('release_not_found');
  });

  it('400s a non-runnable promotion, a bad state, a missing revision and an empty patch', async () => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    rows.set(key, { ...rows.get(key), runnable: false });
    expect(
      parse(
        await patchRelease(CANDIDATE_RELEASE_ID, {
          expectedRevision: 1,
          supportState: 'selectable',
        }),
      ).body.code,
    ).toBe('release_not_selectable');

    rows.set(key, { ...rows.get(key), runnable: true });
    expect(
      parse(await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1, supportState: 'nope' }))
        .body.code,
    ).toBe('release_state_invalid');
    expect(parse(await patchRelease(CANDIDATE_RELEASE_ID, { visible: true })).body.code).toBe(
      'release_revision_invalid',
    );
    expect(parse(await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1 })).body.code).toBe(
      'release_state_invalid',
    );
  });

  it('returns release_capability_unhandled and the authored values that block promotion', async () => {
    const key = keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META');
    const gaps = [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }];
    rows.set(key, { ...rows.get(key), fidelityGaps: gaps });

    const res = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, {
        expectedRevision: 1,
        supportState: 'selectable',
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'release_capability_unhandled',
      details: { gaps },
    });

    rows.set(key, {
      ...rows.get(key),
      supportState: 'selectable',
      visible: false,
      fidelityGaps: gaps,
    });
    const visibility = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, { expectedRevision: 1, visible: true }),
    );
    expect(visibility).toMatchObject({
      status: 400,
      body: { code: 'release_capability_unhandled', details: { gaps } },
    });
  });

  it('403s a non-admin', async () => {
    const res = parse(
      await patchRelease(
        CANDIDATE_RELEASE_ID,
        { expectedRevision: 1, visible: true },
        memberClaims,
      ),
    );

    expect(res.status).toBe(403);
    expect(rows.get(keyOf(`AIDLC_RELEASE#${CANDIDATE_RELEASE_ID}`, 'META')).visible).toBe(false);
  });
});

describe('release channels', () => {
  beforeEach(async () => {
    await register(BASELINE_PROFILE);
    await register(CANDIDATE_PROFILE);
  });

  it('reports unset channels as null and then the pointer that was set', async () => {
    const empty = parse(
      await handler(releaseEvent({ method: 'GET', resource: '/aidlc-release-channels' })),
    );
    // `pinningEnabled` reports the intents Lambda's AIDLC_RELEASE_PINNING flag
    // so the admin UI can say whether these pointers are consulted at all.
    expect(empty.body).toEqual({
      stable: null,
      candidate: null,
      preview: null,
      pinningEnabled: false,
    });

    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    const set = parse(
      await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }),
    );
    expect(set.status).toBe(200);
    expect(set.body.channel).toMatchObject({
      channel: 'candidate',
      releaseId: CANDIDATE_RELEASE_ID,
      revision: 1,
    });

    const after = parse(
      await handler(releaseEvent({ method: 'GET', resource: '/aidlc-release-channels' })),
    );
    expect(after.body.candidate.releaseId).toBe(CANDIDATE_RELEASE_ID);
  });

  it('409s a channel CAS conflict', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null });

    const res = parse(
      await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_revision_conflict');
  });

  it('400s an unselectable target and an unknown channel', async () => {
    expect(
      parse(
        await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }),
      ).body.code,
    ).toBe('release_not_selectable');
    expect(
      parse(
        await putChannel('nightly', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }),
      ).body.code,
    ).toBe('release_channel_invalid');
  });

  it('holds stable to certification unless the release is the platform baseline', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await promote(BASELINE_RELEASE_ID, 'selectable');

    expect(
      parse(await putChannel('stable', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }))
        .body.code,
    ).toBe('release_not_selectable');
    expect(
      parse(await putChannel('stable', { releaseId: BASELINE_RELEASE_ID, expectedRevision: null }))
        .status,
    ).toBe(200);
  });

  it('403s a non-admin channel move', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'selectable');

    const res = parse(
      await putChannel(
        'candidate',
        { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null },
        memberClaims,
      ),
    );

    expect(res.status).toBe(403);
    expect(rows.has(keyOf('AIDLC_RELEASE_CHANNEL#candidate', 'META'))).toBe(false);
  });
});

describe('GET /aidlc-release-profiles', () => {
  it('lists allowlisted profiles with publication and registration state', async () => {
    await register(CANDIDATE_PROFILE);

    const res = parse(
      await handler(releaseEvent({ method: 'GET', resource: '/aidlc-release-profiles' })),
    );

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.profiles.map((p) => [p.profileId, p]));
    expect(byId[CANDIDATE_PROFILE]).toMatchObject({ published: true, registered: true });
    expect(byId['v2.7.0']).toMatchObject({ published: false, registered: false });
  });

  it('403s a non-admin', async () => {
    const res = parse(
      await handler(
        releaseEvent({
          method: 'GET',
          resource: '/aidlc-release-profiles',
          claims: memberClaims,
        }),
      ),
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLATFORM_ADMIN_REQUIRED');
  });
});

describe('method routing', () => {
  it('405s an unsupported verb on a registry resource', async () => {
    const res = parse(
      await handler(
        releaseEvent({
          method: 'DELETE',
          resource: '/aidlc-releases/{releaseId}',
          pathParameters: { releaseId: encodeURIComponent(CANDIDATE_RELEASE_ID) },
        }),
      ),
    );

    expect(res.status).toBe(405);
  });

  it('keeps the workflow routes reachable alongside the registry', async () => {
    const res = parse(await handler(releaseEvent({ method: 'GET', resource: '/workflows' })));

    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual([]);
  });
});

// Custom fork registration over HTTP (issue #482 follow-up). The properties
// under test: the route is platform-admin only, the two sources are mutually
// exclusive, and the resulting record is import-only on every projection.
describe('POST /aidlc-releases with a custom fork', () => {
  const FORK_SHA = '0123456789abcdef0123456789abcdef01234567';
  const FORK_REPOSITORY = 'acme/aidlc-fork';
  const forkBundle = buildReleaseBundle({
    profile: customProfile({
      repository: FORK_REPOSITORY,
      sha: FORK_SHA,
      baseProfileId: BASELINE_PROFILE,
    }),
    files: filesFromCompatibilityFixture({
      profileId: BASELINE_PROFILE,
      fixture: JSON.parse(
        readFileSync(
          new URL(
            `../../shared/test/fixtures/aidlc-compatibility/${BASELINE_PROFILE}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    }),
  });
  const FORK_RELEASE_ID = forkBundle.manifest.releaseId;

  const registerCustom = async (custom, claims = adminClaims) =>
    parse(
      await handler(
        releaseEvent({ method: 'POST', resource: '/aidlc-releases', body: { custom }, claims }),
      ),
    );
  const validCustom = (over = {}) => ({
    repository: FORK_REPOSITORY,
    sha: FORK_SHA,
    baseProfile: BASELINE_PROFILE,
    ...over,
  });

  beforeEach(async () => {
    await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle: forkBundle });
  });

  it('registers a published fork as an import-only T0 record', async () => {
    const res = await registerCustom(validCustom());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'registered',
      release: expect.objectContaining({
        releaseId: FORK_RELEASE_ID,
        sourceRepository: FORK_REPOSITORY,
        custom: true,
        trustTier: 'T0',
        runnable: false,
        visible: false,
      }),
    });
  });

  it('is platform-admin only', async () => {
    const res = await registerCustom(validCustom(), memberClaims);
    expect(res.status).toBe(403);
    expect(rows.has(keyOf(`AIDLC_RELEASE#${FORK_RELEASE_ID}`, 'META'))).toBe(false);
  });

  it('refuses profileId and custom together', async () => {
    const res = parse(
      await handler(
        releaseEvent({
          method: 'POST',
          resource: '/aidlc-releases',
          body: { profileId: BASELINE_PROFILE, custom: validCustom() },
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_state_invalid');
  });

  it('refuses a non-object custom payload and an empty body', async () => {
    for (const custom of ['acme/fork', [], 42]) {
      const res = await registerCustom(custom);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('release_custom_source_invalid');
    }
    const empty = parse(
      await handler(releaseEvent({ method: 'POST', resource: '/aidlc-releases', body: {} })),
    );
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('release_profile_unknown');
  });

  it('maps every custom-source rejection to a stable 400 code', async () => {
    const cases = [
      [validCustom({ repository: 'awslabs/aidlc-workflows' }), 'custom_repository_official'],
      [validCustom({ sha: 'main' }), 'custom_sha_invalid'],
      [validCustom({ baseProfile: 'nope' }), 'custom_base_profile_unknown'],
      [validCustom({ repository: 'acme/..' }), 'custom_source_repo_invalid'],
      [validCustom({ repository: 'acme' }), 'custom_source_repository_invalid'],
    ];
    for (const [custom, code] of cases) {
      const res = await registerCustom(custom);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
  });

  it('404s a fork whose closure is not published', async () => {
    objects.delete(forkBundle.manifest.catalog.key.replace('catalog.json', 'manifest.json'));
    const res = await registerCustom(validCustom());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_not_published');
  });

  it('is idempotent and never becomes selectable or channel-eligible', async () => {
    await registerCustom(validCustom());
    expect((await registerCustom(validCustom())).status).toBe(200);

    const registered = parse(await listReleases()).body.releases.find(
      (release) => release.releaseId === FORK_RELEASE_ID,
    );
    const promoted = parse(
      await patchRelease(FORK_RELEASE_ID, {
        expectedRevision: registered.revision,
        supportState: 'selectable',
      }),
    );
    expect(promoted.status).toBe(400);
    expect(promoted.body.code).toBe('release_not_selectable');

    const visible = parse(
      await patchRelease(FORK_RELEASE_ID, {
        expectedRevision: registered.revision,
        visible: true,
      }),
    );
    expect(visible.status).toBe(200);
    const channel = parse(
      await putChannel('preview', { releaseId: FORK_RELEASE_ID, expectedRevision: null }),
    );
    expect(channel.status).toBe(400);
    expect(channel.body.code).toBe('release_not_selectable');

    // A non-admin never sees it, however visible the flag is.
    const memberList = parse(await listReleases(memberClaims));
    expect(memberList.body.releases.map((release) => release.releaseId)).not.toContain(
      FORK_RELEASE_ID,
    );
  });
});

// ── Channel transitions and non-admin projections at the HTTP boundary ──

const deleteChannel = (channel, body, claims = adminClaims) =>
  handler(
    releaseEvent({
      method: 'DELETE',
      resource: '/aidlc-release-channels/{channel}',
      pathParameters: { channel },
      body,
      claims,
    }),
  );

const listChannels = (claims = adminClaims) =>
  handler(releaseEvent({ method: 'GET', resource: '/aidlc-release-channels', claims }));

describe('DELETE /aidlc-release-channels/{channel}', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await putChannel('preview', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null });
  });

  it('clears the pointer under a matching revision', async () => {
    const res = parse(await deleteChannel('preview', { expectedRevision: 1 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, channel: 'preview' });
    expect(parse(await listChannels()).body.preview).toBeNull();
  });

  it('409s a stale revision', async () => {
    const res = parse(await deleteChannel('preview', { expectedRevision: 99 }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_revision_conflict');
    expect(parse(await listChannels()).body.preview.releaseId).toBe(CANDIDATE_RELEASE_ID);
  });

  it('400s an absent or non-integer expectedRevision', async () => {
    expect(parse(await deleteChannel('preview', {})).status).toBe(400);
    expect(parse(await deleteChannel('preview', { expectedRevision: '1' })).status).toBe(400);
  });

  it('is platform-admin only', async () => {
    const res = parse(await deleteChannel('preview', { expectedRevision: 1 }, memberClaims));

    expect(res.status).toBe(403);
    expect(parse(await listChannels()).body.preview.releaseId).toBe(CANDIDATE_RELEASE_ID);
  });
});

describe('PATCH refuses to strand a channel pointer', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    await promote(CANDIDATE_RELEASE_ID, 'certified');
    await putChannel('stable', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null });
  });

  const revisionOf = async (releaseId) =>
    parse(await listReleases()).body.releases.find((release) => release.releaseId === releaseId)
      .revision;

  it('409s the demotion of the stable target', async () => {
    const res = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, {
        expectedRevision: await revisionOf(CANDIDATE_RELEASE_ID),
        supportState: 'existing-only',
      }),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_channel_pinned');
  });

  it('succeeds after the pointer is cleared — the demote-then-create sequence', async () => {
    expect(parse(await deleteChannel('stable', { expectedRevision: 1 })).status).toBe(200);

    const res = parse(
      await patchRelease(CANDIDATE_RELEASE_ID, {
        expectedRevision: await revisionOf(CANDIDATE_RELEASE_ID),
        supportState: 'existing-only',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.release.supportState).toBe('existing-only');
  });
});

describe('PUT /aidlc-release-channels requires expectedRevision', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    await promote(CANDIDATE_RELEASE_ID, 'certified');
  });

  it('400s an absent expectedRevision rather than treating it as a create', async () => {
    const res = parse(await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_revision_invalid');
    expect(parse(await listChannels()).body.candidate).toBeNull();
  });

  it('accepts an explicit null as the does-not-exist-yet assertion', async () => {
    const res = parse(
      await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null }),
    );

    expect(res.status).toBe(200);
  });
});

describe('non-admin projections over HTTP', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    await promote(CANDIDATE_RELEASE_ID, 'selectable');
    await putChannel('candidate', { releaseId: CANDIDATE_RELEASE_ID, expectedRevision: null });
  });

  it('withholds keys, digests, SHAs, and actor subs from a non-admin release list', async () => {
    const [release] = parse(await listReleases(memberClaims)).body.releases;

    for (const field of [
      'sourceSha',
      'closureDigest',
      'manifestKey',
      'catalogKey',
      'registeredBy',
      'updatedBy',
      'certifiedBy',
      'importerRevision',
      'revision',
    ]) {
      expect(release).not.toHaveProperty(field);
    }
    expect(release).toMatchObject({ releaseId: CANDIDATE_RELEASE_ID, upstreamVersion: '2.9.0' });
  });

  it('withholds channel actors and timestamps from a non-admin', async () => {
    const asUser = parse(await listChannels(memberClaims)).body;
    const asAdmin = parse(await listChannels()).body;

    expect(asUser.candidate).toEqual({
      channel: 'candidate',
      releaseId: CANDIDATE_RELEASE_ID,
      revision: 1,
    });
    expect(asAdmin.candidate.updatedBy).toBe('admin-1');
  });

  it('reports pinningEnabled from the flag the intents Lambda gates on', async () => {
    expect(parse(await listChannels()).body.pinningEnabled).toBe(false);

    process.env.AIDLC_RELEASE_PINNING = 'on';
    try {
      expect(parse(await listChannels()).body.pinningEnabled).toBe(true);
    } finally {
      delete process.env.AIDLC_RELEASE_PINNING;
    }
  });
});

// ── Compiled reads use the selected release ──

// The release branch asserts the caller can see the workflow before it touches
// the closure, so every release-path test needs the META row the
// non-release path would have read.
const seedWorkflowMeta = (tenant = 'SYSTEM', workflowId = 'aidlc-v2') => {
  rows.set(keyOf(`WF#${tenant}#${workflowId}`, 'META'), {
    pk: `WF#${tenant}#${workflowId}`,
    sk: 'META',
    workflowId,
    tenantId: tenant,
    name: 'AI-DLC v2',
    version: 1,
  });
};

const compiledFor = (workflowId, query = {}, claims = adminClaims) =>
  handler({
    ...releaseEvent({ method: 'GET', resource: '/workflows/{workflowId}/compiled', claims }),
    pathParameters: { workflowId },
    queryStringParameters: query,
  });

describe('GET /workflows/{id}/compiled?release', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    seedWorkflowMeta();
  });

  it('compiles the closure, not the live SYSTEM rows', async () => {
    // The WF#SYSTEM partition holds ONLY the META row this route now asserts on —
    // no placements, scope refs, or stage blocks — so a non-empty scope grid and
    // graph can only have come from the release closure.
    const res = parse(await compiledFor('aidlc-v2', { release: CANDIDATE_RELEASE_ID }));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.scopeGrid).length).toBeGreaterThan(0);
    expect(res.body.graph.nodes.length).toBeGreaterThan(0);
    // The closure's own phase tree rides along, so a pinned compose page needs
    // no second request against the live workflow.
    expect(res.body.phases.length).toBeGreaterThan(0);
  });

  it('accepts a percent-encoded release id', async () => {
    const res = parse(
      await compiledFor('aidlc-v2', { release: encodeURIComponent(CANDIDATE_RELEASE_ID) }),
    );

    expect(res.status).toBe(200);
  });

  it('404s an unregistered release rather than falling back to the live rows', async () => {
    const res = parse(await compiledFor('aidlc-v2', { release: 'aidlc:not-registered' }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('release_not_found');
  });

  it('409s a tampered closure rather than serving the live rows', async () => {
    objects.delete(candidateBundle.manifest.catalog.key);

    const res = parse(await compiledFor('aidlc-v2', { release: CANDIDATE_RELEASE_ID }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_closure_mismatch');
  });

  it('serves a release that is registered but no longer selectable', async () => {
    // An existing intent stays pinned to a demoted release, so its compose page
    // must keep resolving. Selection is a separate gate.
    await promote(CANDIDATE_RELEASE_ID, 'existing-only');

    const res = parse(await compiledFor('aidlc-v2', { release: CANDIDATE_RELEASE_ID }));

    expect(res.status).toBe(200);
  });

  it('leaves the unpinned path on the live rows', async () => {
    // Same workflow, no `release` parameter: the live partition holds only META,
    // so an EMPTY grid is the proof the closure was never consulted.
    const res = parse(await compiledFor('aidlc-v2', {}));

    expect(res.status).toBe(200);
    expect(res.body.scopeGrid).toEqual({});
    expect(res.body.graph.nodes).toEqual([]);
    expect(res.body.phases).toBeUndefined();
  });

  it('404s with the plain non-release body when the workflow is not visible', async () => {
    // The release must not become a way to read a workflow the caller could not
    // otherwise see, and the 404 must be indistinguishable from the ordinary one.
    rows.delete(keyOf('WF#SYSTEM#aidlc-v2', 'META'));

    const res = parse(await compiledFor('unknown-workflow', { release: CANDIDATE_RELEASE_ID }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

// ── `?release=` is gated on selectability ──
//
// A non-admin may only resolve a release it could actually select. Unknown and
// non-selectable must be INDISTINGUISHABLE, or the parameter becomes a registry
// oracle for any authenticated user.

const previewFor = (workflowId, query = {}, claims = adminClaims) =>
  handler({
    ...releaseEvent({
      method: 'GET',
      resource: '/workflows/{workflowId}/execution-preview',
      claims,
    }),
    pathParameters: { workflowId },
    queryStringParameters: query,
  });

const validateGridFor = (workflowId, query = {}, claims = adminClaims) =>
  handler({
    ...releaseEvent({
      method: 'POST',
      resource: '/workflows/{workflowId}/validate-grid',
      body: { composedGrid: { 'requirements-elaboration': 'EXECUTE' } },
      claims,
    }),
    pathParameters: { workflowId },
    queryStringParameters: query,
  });

const releaseRoutes = [
  ['GET /compiled', (query, claims) => compiledFor('aidlc-v2', query, claims)],
  [
    'GET /execution-preview',
    (query, claims) => previewFor('aidlc-v2', { scope: 'mvp', ...query }, claims),
  ],
  ['POST /validate-grid', (query, claims) => validateGridFor('aidlc-v2', query, claims)],
];

describe('`?release=` selectability gate for non-admins', () => {
  beforeEach(async () => {
    await register(CANDIDATE_PROFILE);
    seedWorkflowMeta();
  });

  for (const [label, call] of releaseRoutes) {
    it(`${label}: a non-admin may resolve a SELECTABLE release`, async () => {
      await promote(CANDIDATE_RELEASE_ID, 'selectable');

      const res = parse(await call({ release: CANDIDATE_RELEASE_ID }, memberClaims));

      expect(res.status).toBe(200);
    });

    it(`${label}: a non-admin gets the unknown-release 404 for a registered-but-hidden release`, async () => {
      // Registered, runnable, structurally valid — but never made visible.
      const unknown = parse(await call({ release: 'aidlc:not-registered' }, memberClaims));
      const hidden = parse(await call({ release: CANDIDATE_RELEASE_ID }, memberClaims));

      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe('release_not_found');
      expect(hidden.status).toBe(unknown.status);
      expect(hidden.body.code).toBe(unknown.body.code);
    });

    it(`${label}: a non-admin gets the same 404 for a DEMOTED release`, async () => {
      await promote(CANDIDATE_RELEASE_ID, 'existing-only');

      const res = parse(await call({ release: CANDIDATE_RELEASE_ID }, memberClaims));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('release_not_found');
    });

    it(`${label}: a project member may resolve their existing intent's demoted pin`, async () => {
      await promote(CANDIDATE_RELEASE_ID, 'existing-only');
      const methodologyRelease = methodologyReleasePinFromManifest(candidateBundle.manifest);
      const agentPk = 'BLOCK#default#AGENT#aidlc-architect-agent';
      const methodologyPins = {
        AGENT: { 'aidlc-architect-agent': { tenantId: 'default', version: 7 } },
      };
      rows.set(keyOf(agentPk, 'V#7'), {
        pk: agentPk,
        sk: 'V#7',
        id: 'aidlc-architect-agent',
        blockId: 'aidlc-architect-agent',
        tenantId: 'default',
        version: 7,
      });
      lambdaMock.on(InvokeCommand).callsFake((input) => {
        expect(input.FunctionName).toBe('intents-test');
        const request = JSON.parse(Buffer.from(input.Payload).toString());
        expect(request).toMatchObject({
          httpMethod: 'GET',
          pathParameters: { projectId: 'project-1', intentId: 'intent-1' },
          queryStringParameters: { view: 'workflow-preview' },
          requestContext: { authorizer: { claims: { sub: memberClaims.sub } } },
        });
        return {
          Payload: Buffer.from(
            JSON.stringify({
              statusCode: 200,
              body: JSON.stringify({
                workflowIntent: {
                  id: 'intent-1',
                  projectId: 'project-1',
                  workflowId: 'aidlc-v2',
                  workflowVersion: 1,
                  methodologyRelease,
                  methodologyPins,
                },
              }),
            }),
          ),
        };
      });

      const res = parse(
        await call(
          {
            release: CANDIDATE_RELEASE_ID,
            projectId: 'project-1',
            intentId: 'intent-1',
          },
          memberClaims,
        ),
      );

      expect(res.status).toBe(200);
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });

    it(`${label}: an admin may still resolve a demoted release`, async () => {
      await promote(CANDIDATE_RELEASE_ID, 'existing-only');

      const res = parse(await call({ release: CANDIDATE_RELEASE_ID }, adminClaims));

      expect(res.status).toBe(200);
    });

    it(`${label}: an unpinned non-admin read is unaffected`, async () => {
      const res = parse(await call({}, memberClaims));

      expect(res.status).toBe(200);
    });
  }

  it('does not expose a demoted pin when the intent lookup is unauthorized or mismatched', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'existing-only');
    const unauthorized = {
      statusCode: 404,
      body: JSON.stringify({ error: 'Intent not found' }),
    };
    lambdaMock.on(InvokeCommand).resolves({ Payload: Buffer.from(JSON.stringify(unauthorized)) });

    const denied = parse(
      await compiledFor(
        'aidlc-v2',
        {
          release: CANDIDATE_RELEASE_ID,
          projectId: 'project-1',
          intentId: 'intent-1',
        },
        memberClaims,
      ),
    );
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('release_not_found');

    lambdaMock.reset();
    const methodologyRelease = methodologyReleasePinFromManifest(candidateBundle.manifest);
    lambdaMock.on(InvokeCommand).resolves({
      Payload: Buffer.from(
        JSON.stringify({
          statusCode: 200,
          body: JSON.stringify({
            workflowIntent: {
              id: 'intent-1',
              projectId: 'another-project',
              workflowId: 'aidlc-v2',
              workflowVersion: 1,
              methodologyRelease,
            },
          }),
        }),
      ),
    });

    const mismatched = parse(
      await compiledFor(
        'aidlc-v2',
        {
          release: CANDIDATE_RELEASE_ID,
          projectId: 'project-1',
          intentId: 'intent-1',
        },
        memberClaims,
      ),
    );
    expect(mismatched.status).toBe(404);
    expect(mismatched.body.code).toBe('release_not_found');
  });

  it('maps intent lookup outages to a dependency error without exposing hidden pins', async () => {
    await promote(CANDIDATE_RELEASE_ID, 'existing-only');
    const query = {
      release: CANDIDATE_RELEASE_ID,
      projectId: 'project-1',
      intentId: 'intent-1',
    };
    lambdaMock.on(InvokeCommand).resolves({
      Payload: Buffer.from(JSON.stringify({ statusCode: 503, body: '{"error":"unavailable"}' })),
    });

    const unavailable = parse(await compiledFor('aidlc-v2', query, memberClaims));

    expect(unavailable.status).toBe(502);
    expect(unavailable.body.code).toBe('intent_lookup_failed');

    lambdaMock.reset();
    lambdaMock.on(InvokeCommand).resolves({
      Payload: Buffer.from(JSON.stringify({ statusCode: 403, body: '{"error":"Forbidden"}' })),
    });

    const forbidden = parse(await compiledFor('aidlc-v2', query, memberClaims));

    expect(forbidden.status).toBe(404);
    expect(forbidden.body.code).toBe('release_not_found');
  });
});
