import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_KEY_ID,
  KEY_BYTES,
  buildSecretValue,
  hasCurrentVersion,
  parseArgs,
  seedSecret,
} from '../seed-notifications-secret.mjs';

const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:111122223333:secret:aidlc-dev-hmac-AbCdEf';
const KNOWN_KEY = Buffer.alloc(KEY_BYTES, 7);
const KNOWN_KEY_TEXT = KNOWN_KEY.toString('base64url');

const awsError = (name, status = 400) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

const fakeSecrets = ({ versions = {}, putFailures = [] } = {}) => {
  const puts = [];
  return {
    puts,
    describeSecret: async () => ({ ARN: SECRET_ARN, VersionIdsToStages: versions }),
    putSecretValue: async (input) => {
      puts.push(input);
      const failure = putFailures[puts.length - 1];
      if (failure) throw failure;
      return { VersionId: 'v1' };
    },
  };
};

const seed = (client) => {
  const lines = [];
  const push = (...parts) => lines.push(parts.join(' '));
  return seedSecret({
    secretArn: SECRET_ARN,
    client,
    log: { log: push, warn: push, error: push },
    sleep: async () => {},
    random: () => 0,
    generateKey: () => KNOWN_KEY,
    requestToken: '00000000-0000-4000-8000-000000000001',
  }).then((result) => ({ ...result, text: lines.join('\n') }));
};

test('T9: an existing AWSCURRENT version is left unchanged', async () => {
  const client = fakeSecrets({ versions: { v1: ['AWSCURRENT'] } });
  const result = await seed(client);
  assert.deepEqual([result.outcome, result.exitCode], ['already-seeded', 0]);
  assert.equal(client.puts.length, 0);
});

test('T9: a secret with no version is seeded once with the k1 shape', async () => {
  const client = fakeSecrets();
  const result = await seed(client);
  assert.deepEqual([result.outcome, result.exitCode], ['seeded', 0]);
  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0].SecretId, SECRET_ARN);
  assert.deepEqual(JSON.parse(client.puts[0].SecretString), {
    current: { kid: INITIAL_KEY_ID, key: KNOWN_KEY_TEXT },
    previous: null,
  });
  assert.doesNotMatch(result.text, new RegExp(KNOWN_KEY_TEXT));
});

test('T9: a transient put failure is retried with the same request token', async () => {
  const client = fakeSecrets({ putFailures: [awsError('InternalServiceError', 500)] });
  const result = await seed(client);
  assert.equal(result.outcome, 'seeded');
  assert.equal(client.puts.length, 2);
  assert.equal(client.puts[0].ClientRequestToken, client.puts[1].ClientRequestToken);
  assert.equal(client.puts[0].SecretString, client.puts[1].SecretString);
});

test('T9: a persistent put failure exits 1 without printing the key', async () => {
  const failure = awsError('InternalServiceError', 500);
  const client = fakeSecrets({ putFailures: [failure, failure, failure, failure] });
  const result = await seed(client);
  assert.deepEqual([result.outcome, result.exitCode], ['failed', 1]);
  assert.equal(client.puts.length, 4);
  assert.match(result.text, /re-run deploy \(idempotent\)/);
  assert.doesNotMatch(result.text, new RegExp(KNOWN_KEY_TEXT));
});

test('T9: AccessDenied is not retried', async () => {
  const client = fakeSecrets({ putFailures: [awsError('AccessDeniedException')] });
  const result = await seed(client);
  assert.equal(result.exitCode, 1);
  assert.equal(client.puts.length, 1);
});

test('only AWSCURRENT counts as seeded', () => {
  assert.equal(hasCurrentVersion({ VersionIdsToStages: { v1: ['AWSPENDING'] } }), false);
  assert.equal(hasCurrentVersion({}), false);
  assert.equal(
    hasCurrentVersion({ VersionIdsToStages: { v1: ['AWSPREVIOUS'], v2: ['AWSCURRENT'] } }),
    true,
  );
});

test('generated keys are 32 random bytes in base64url', () => {
  const first = JSON.parse(buildSecretValue()).current.key;
  const second = JSON.parse(buildSecretValue()).current.key;
  assert.equal(Buffer.from(first, 'base64url').length, KEY_BYTES);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});

test('argument parsing requires the secret ARN and region', () => {
  assert.deepEqual(parseArgs(['--secret-arn', SECRET_ARN, '--region', 'eu-west-1']), {
    secretArn: SECRET_ARN,
    region: 'eu-west-1',
  });
  assert.equal(parseArgs(['--secret-arn', '', '--region', 'eu-west-1']), undefined);
  assert.equal(parseArgs(['--region', 'eu-west-1']), undefined);
});
