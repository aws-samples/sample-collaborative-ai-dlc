import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSupportedReleases } from '../prepare-aidlc-releases.mjs';
import { AIDLC_COMPATIBILITY_PROFILES } from '../../lambda/shared/aidlc-compatibility-profiles.js';
import { AIDLC_RELEASE_IMPORTER_REVISION } from '../../lambda/shared/aidlc-release-importer.js';

const profiles = Object.values(AIDLC_COMPATIBILITY_PROFILES);
const responseFor = (profile, overrides = {}) => ({
  StatusCode: 200,
  Payload: Buffer.from(
    JSON.stringify({
      mode: 'prepareRelease',
      profile: profile.id,
      releaseId: profile.releaseId,
      sourceSha: profile.upstreamRef,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      registration: 'registered',
      ...overrides,
    }),
  ),
});

test('prepares every allowlisted version without requesting approval or channel changes', async () => {
  const calls = [];
  const result = await prepareSupportedReleases({
    invoke: async (event) => {
      calls.push(event);
      return responseFor(AIDLC_COMPATIBILITY_PROFILES[event.profile]);
    },
  });
  assert.equal(result.length, 8);
  assert.deepEqual(
    calls,
    profiles.map((profile) => ({
      prepareRelease: true,
      profile: profile.id,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
    })),
  );
});

test('stops deployment on a failed import instead of leaving success with missing versions', async () => {
  let calls = 0;
  await assert.rejects(
    prepareSupportedReleases({
      invoke: async () => {
        calls += 1;
        return calls === 1
          ? responseFor(profiles[0])
          : { StatusCode: 200, FunctionError: 'Unhandled' };
      },
    }),
    /preparation failed/,
  );
  assert.equal(calls, 2);
});

test('rejects an older seed Lambda that ignores the preparation mode', async () => {
  await assert.rejects(
    prepareSupportedReleases({
      invoke: async () => ({ StatusCode: 200, Payload: Buffer.from('{"seeded":[]}') }),
    }),
    /not prepared by the deployed importer/,
  );
});

test('rejects the wrong source commit or importer revision', async () => {
  for (const overrides of [
    { sourceSha: 'wrong' },
    { importerRevision: 0 },
    { registration: 'failed' },
  ]) {
    await assert.rejects(
      prepareSupportedReleases({
        invoke: async () => responseFor(profiles[0], overrides),
      }),
      /not prepared by the deployed importer/,
    );
  }
});

test('does not swallow network failures or accept asynchronous invocation acknowledgement', async () => {
  await assert.rejects(
    prepareSupportedReleases({
      invoke: async () => {
        throw new Error('network unavailable');
      },
    }),
    /network unavailable/,
  );
  await assert.rejects(
    prepareSupportedReleases({
      invoke: async () => ({ StatusCode: 202 }),
    }),
    /preparation failed/,
  );
});

test('reports a version kept on its older closure and still prepares the others', async () => {
  const kept = profiles[0];
  const prepared = [];
  const keptOnOlder = [];
  const result = await prepareSupportedReleases({
    invoke: async (event) =>
      responseFor(
        AIDLC_COMPATIBILITY_PROFILES[event.profile],
        event.profile === kept.id
          ? {
              registration: 'upgrade-refused',
              upgradeRefusal: 'release_channel_pinned',
              registeredImporterRevision: 1,
            }
          : { registration: 'upgraded' },
      ),
    onPrepared: (profile) => prepared.push(profile.id),
    onKept: (profile, response) => keptOnOlder.push([profile.id, response.upgradeRefusal]),
  });
  assert.equal(result.length, 8);
  assert.deepEqual(keptOnOlder, [[kept.id, 'release_channel_pinned']]);
  assert.equal(prepared.length, 7);
  assert.ok(!prepared.includes(kept.id));
});
