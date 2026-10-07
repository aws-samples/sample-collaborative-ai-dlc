#!/usr/bin/env node
// Seeds the notification unsubscribe HMAC secret once, after `terraform apply`.
//
// Terraform creates only the secret container, so the key never appears in
// Terraform state or plans. This script runs on every deploy and does nothing
// once a version is AWSCURRENT. The key value is never printed, logged or
// written to disk.
//
// Usage: seed-notifications-secret.mjs --secret-arn <arn> --region <region>
// Exit codes: 0 seeded or already seeded, 1 failure, 2 usage error.

import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withRetries } from './notifications-preflight.mjs';

const PREFIX = 'notifications-secret:';
export const KEY_BYTES = 32;
export const INITIAL_KEY_ID = 'k1';

export const hasCurrentVersion = (description) =>
  Object.values(description?.VersionIdsToStages || {}).some((stages) =>
    stages?.includes('AWSCURRENT'),
  );

export const buildSecretValue = (generateKey = () => randomBytes(KEY_BYTES)) =>
  JSON.stringify({
    current: { kid: INITIAL_KEY_ID, key: generateKey().toString('base64url') },
    previous: null,
  });

/**
 * @param {object} options
 * @param {string} options.secretArn
 * @param {{describeSecret(arn: string): Promise<object>, putSecretValue(input: object): Promise<unknown>}} options.client
 * @returns {Promise<{outcome: 'already-seeded'|'seeded'|'failed', exitCode: number}>}
 */
export const seedSecret = async ({
  secretArn,
  client,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  generateKey,
  requestToken = randomUUID(),
}) => {
  const retry = (operation) => withRetries(operation, { sleep, random });
  try {
    const description = await retry(() => client.describeSecret(secretArn));
    if (hasCurrentVersion(description)) {
      log.log(`${PREFIX} unsubscribe secret already seeded; leaving it unchanged`);
      return { outcome: 'already-seeded', exitCode: 0 };
    }
    // One token for every attempt in this run, so a retried put after a lost
    // response is deduplicated by Secrets Manager instead of adding a version.
    const secretString = buildSecretValue(generateKey);
    await retry(() =>
      client.putSecretValue({
        SecretId: secretArn,
        SecretString: secretString,
        ClientRequestToken: requestToken,
      }),
    );
    log.log(`${PREFIX} unsubscribe secret seeded (kid ${INITIAL_KEY_ID})`);
    return { outcome: 'seeded', exitCode: 0 };
  } catch (error) {
    log.error(
      `${PREFIX} unsubscribe secret not seeded (${error?.name || error?.code || 'unknown error'}) — re-run deploy (idempotent)`,
    );
    return { outcome: 'failed', exitCode: 1 };
  }
};

export const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--secret-arn', '--region'].includes(flag) || !value) return undefined;
    options[flag.slice(2)] = value;
  }
  if (!options['secret-arn'] || !options.region) return undefined;
  return { secretArn: options['secret-arn'], region: options.region };
};

export const createSecretsClient = async (region) => {
  const { SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const secrets = new SecretsManagerClient({ region, maxAttempts: 1 });
  return {
    describeSecret: (secretArn) => secrets.send(new DescribeSecretCommand({ SecretId: secretArn })),
    putSecretValue: (input) => secrets.send(new PutSecretValueCommand(input)),
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error(
      `${PREFIX} Usage: seed-notifications-secret.mjs --secret-arn <arn> --region <region>`,
    );
    return 2;
  }
  const client = await createSecretsClient(options.region);
  const { exitCode } = await seedSecret({ secretArn: options.secretArn, client });
  return exitCode;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `${PREFIX} unsubscribe secret not seeded (${error?.name || 'unknown error'}) — re-run deploy (idempotent)`,
      );
      process.exit(1);
    },
  );
}
