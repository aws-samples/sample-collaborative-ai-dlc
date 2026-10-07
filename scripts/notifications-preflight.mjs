#!/usr/bin/env node
// Notifications pre-flight, run by deploy-terraform.sh before `terraform plan`
// and again before `terraform apply`.
//
// The attention-notifications release evolves the existing, previously unused
// `notifications` table in place (TTL plus the SourceIndex and DigestIndex
// GSIs). Rows written before that release have no eventKey or expiresAt, so
// they would never expire and every consumer ignores them. The check halts the
// upgrade when it finds such rows, unless the operator explicitly acknowledges
// them. It fails closed: when emptiness cannot be verified, the deploy stops.
//
// Output never contains item attributes or keys, because a legacy row could
// hold personal data.
//
// Usage:
//   notifications-preflight.mjs --table <name> --region <region>
//   notifications-preflight.mjs --plan-json <terraform-show-json>
// Exit codes: 0 pass, 1 halt, 2 usage error.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OVERRIDE_ENV = 'AIDLC_NOTIFICATIONS_PREFLIGHT';
export const OVERRIDE_VALUE = 'acknowledge-legacy';
export const UPGRADE_MARKER_INDEX = 'SourceIndex';
export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 200;
export const MAX_SCAN_PAGES = 20;

const PREFIX = 'notifications-preflight:';
const NOTIFICATIONS_ADDRESS = 'module.dynamodb.aws_dynamodb_table.notifications';
const RELEASE_NOTES = 'CHANGELOG.md, "Upgrade notes — Attention Notifications data plane"';

const PASSING = { fresh: true, 'already-upgraded': true, empty: true, 'legacy-acknowledged': true };

const THROTTLING_ERRORS = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'LimitExceededException',
  'TooManyRequestsException',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
]);

export class PreflightUsageError extends Error {}

const isNotFound = (error) => error?.name === 'ResourceNotFoundException';

export const isAccessDenied = (error) =>
  error?.name === 'AccessDeniedException' ||
  error?.name === 'AccessDenied' ||
  error?.$metadata?.httpStatusCode === 403;

// Only throttling, 5xx and network failures are worth retrying. Everything
// else (credentials, validation, access) is reported as unverifiable at once.
export const isRetryable = (error) => {
  if (!error || isAccessDenied(error)) return false;
  if (THROTTLING_ERRORS.has(error.name)) return true;
  if (error.$retryable) return true;
  const status = error.$metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500) return true;
  if (error.name === 'TimeoutError') return true;
  return NETWORK_ERROR_CODES.has(error.code);
};

const describeError = (error) => error?.name || error?.code || 'unknown error';

/** Run `operation`, retrying retryable failures with full-jitter exponential backoff. */
export const withRetries = async (operation, { sleep, random }) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryable(error)) throw error;
      await sleep(Math.round(random() * BASE_DELAY_MS * 2 ** attempt));
    }
  }
};

const hasMarkerIndex = (table) =>
  (table?.GlobalSecondaryIndexes || []).some((index) => index.IndexName === UPGRADE_MARKER_INDEX);

// Returns true when a row exists, false when the table is verifiably empty,
// and null when the page budget ran out (callers treat that as non-empty).
const findAnyItem = async (client, tableName, retry) => {
  let exclusiveStartKey;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const result = await retry(() => client.scanOne(tableName, exclusiveStartKey));
    if ((result.Count ?? result.Items?.length ?? 0) > 0) return true;
    if (!result.LastEvaluatedKey) return false;
    exclusiveStartKey = result.LastEvaluatedKey;
  }
  return null;
};

const haltGuidance = (tableName, log) => {
  log.error(
    `${PREFIX} HALT — table ${tableName} holds at least one row written before this release`,
  );
  log.error(`${PREFIX} (or could not be confirmed empty within ${MAX_SCAN_PAGES} scan pages).`);
  log.error(
    `${PREFIX} Legacy rows have no eventKey or expiresAt: they never expire and are never listed.`,
  );
  log.error(`${PREFIX} Choose one, then re-run the deploy:`);
  log.error(
    `${PREFIX}   A) Back up the table (point-in-time recovery or an export), delete the rows.`,
  );
  log.error(`${PREFIX}   B) Leave them in place: export ${OVERRIDE_ENV}=${OVERRIDE_VALUE}`);
  log.error(`${PREFIX} See ${RELEASE_NOTES}.`);
};

const readOverride = (env, log) => {
  const value = env[OVERRIDE_ENV];
  if (value === undefined || value === '') return false;
  if (value === OVERRIDE_VALUE) return true;
  log.error(`${PREFIX} ignoring ${OVERRIDE_ENV}: the only accepted value is "${OVERRIDE_VALUE}"`);
  return false;
};

/**
 * Decide whether the notifications table may be upgraded in place.
 *
 * @param {object} options
 * @param {string} options.tableName
 * @param {{describeTable(name: string): Promise<object>, scanOne(name: string, startKey?: object): Promise<object>}} options.client
 * @returns {Promise<{outcome: string, exitCode: number}>}
 */
export const runPreflight = async ({
  tableName,
  client,
  env = process.env,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
}) => {
  const retry = (operation) => withRetries(operation, { sleep, random });
  const result = (outcome) => ({ outcome, exitCode: PASSING[outcome] ? 0 : 1 });
  const unverifiable = (error) => {
    log.error(
      `${PREFIX} HALT — cannot verify table ${tableName} (${describeError(error)}).` +
        ` Check the deploy credentials and region, then re-run. ${OVERRIDE_ENV} does not bypass this.`,
    );
    return result('unverifiable');
  };

  let table;
  try {
    table = await retry(() => client.describeTable(tableName));
  } catch (error) {
    if (isNotFound(error)) {
      log.log(`${PREFIX} PASS — ${tableName} does not exist yet (fresh install)`);
      return result('fresh');
    }
    return unverifiable(error);
  }

  if (hasMarkerIndex(table)) {
    log.log(`${PREFIX} PASS — ${tableName} already has ${UPGRADE_MARKER_INDEX} (already upgraded)`);
    return result('already-upgraded');
  }

  let found;
  try {
    found = await findAnyItem(client, tableName, retry);
  } catch (error) {
    return unverifiable(error);
  }
  if (found === false) {
    log.log(`${PREFIX} PASS — ${tableName} is empty, safe to upgrade in place`);
    return result('empty');
  }

  if (readOverride(env, log)) {
    log.warn(
      `${PREFIX} WARN — legacy rows left in ${tableName} (${OVERRIDE_ENV}=${OVERRIDE_VALUE}); they are never listed (no eventKey)`,
    );
    return result('legacy-acknowledged');
  }
  haltGuidance(tableName, log);
  return result('legacy-present');
};

/** Resolve the table name and region from `terraform show -json <plan>` output. */
export const targetFromPlan = (plan) => {
  const variable = (name) => plan?.variables?.[name]?.value;
  const change = (plan?.resource_changes || []).find(
    (candidate) => candidate.address === NOTIFICATIONS_ADDRESS,
  );
  const projectName = variable('project_name');
  const environment = variable('environment');
  const tableName =
    change?.change?.after?.name ||
    change?.change?.before?.name ||
    (projectName && environment ? `${projectName}-notifications-${environment}` : undefined);
  const region = variable('aws_region');
  if (!tableName || !region) {
    throw new PreflightUsageError(
      'the plan does not identify the notifications table name and region',
    );
  }
  return { tableName, region };
};

export const parseArgs = (argv, readFile = (path) => readFileSync(path, 'utf8')) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--table', '--region', '--plan-json'].includes(flag) || !value) {
      throw new PreflightUsageError(`unexpected argument: ${flag ?? ''}`);
    }
    options[flag.slice(2)] = value;
  }
  if (options['plan-json']) {
    return targetFromPlan(JSON.parse(readFile(options['plan-json'])));
  }
  if (!options.table || !options.region) {
    throw new PreflightUsageError('expected --table and --region, or --plan-json');
  }
  return { tableName: options.table, region: options.region };
};

/** Adapt the AWS SDK to the narrow client interface runPreflight needs. */
export const createDynamoClient = async (region) => {
  const { DynamoDBClient, DescribeTableCommand, ScanCommand } =
    await import('@aws-sdk/client-dynamodb');
  // Retries are handled by withRetries so the policy stays explicit and bounded.
  const dynamo = new DynamoDBClient({ region, maxAttempts: 1 });
  return {
    describeTable: async (tableName) =>
      (await dynamo.send(new DescribeTableCommand({ TableName: tableName }))).Table,
    scanOne: (tableName, exclusiveStartKey) =>
      dynamo.send(
        new ScanCommand({
          TableName: tableName,
          Limit: 1,
          ProjectionExpression: 'userId',
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      ),
  };
};

const main = async () => {
  let target;
  try {
    target = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    console.error(
      'Usage: notifications-preflight.mjs --table <name> --region <region> | --plan-json <path>',
    );
    return 2;
  }
  const client = await createDynamoClient(target.region);
  const { exitCode } = await runPreflight({ tableName: target.tableName, client });
  return exitCode;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`${PREFIX} HALT — unexpected failure (${describeError(error)})`);
      process.exit(1);
    },
  );
}
