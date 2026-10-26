// Default environment for new spaces: one platform setting in the environment
// registry, managed by platform admins (environments API, Admin -> Environments).
// No setting, or `standard`, keeps every new space on Standard.
//
// Space creation never fails on this setting: an environment that is no longer
// published, or a registry read error, falls back to Standard. A space can still
// be moved to another environment afterwards.
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { resolvePublishedEnvironment } from './environment-snapshot.js';

export const STANDARD_ENVIRONMENT_ID = 'standard';

// Outside the ENV# key space and without GSI attributes, so environment listings
// never see it.
export const DEFAULT_ENVIRONMENT_KEY = Object.freeze({
  pk: 'SETTINGS#ENVIRONMENTS',
  sk: 'DEFAULT',
});

/** The stored setting, or null when unset (Standard). */
export const readDefaultEnvironment = async ({ ddb, tableName }) => {
  if (!ddb || !tableName) return null;
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: DEFAULT_ENVIRONMENT_KEY, ConsistentRead: true }),
  );
  return Item?.environmentId ? Item : null;
};

/** Store the default; `standard` clears the setting. */
export const writeDefaultEnvironment = async ({ ddb, tableName, environmentId, actor, now }) => {
  if (environmentId === STANDARD_ENVIRONMENT_ID) {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: DEFAULT_ENVIRONMENT_KEY }));
    return null;
  }
  const item = {
    ...DEFAULT_ENVIRONMENT_KEY,
    environmentId,
    updatedAt: now,
    updatedBy: actor ?? null,
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
  return item;
};

/**
 * The environment id a new space gets: the configured default when it resolves
 * as published (the same check intent creation applies), else Standard.
 * `onFallback(reason, environmentId)` reports a configured default that was not used.
 */
export const resolveDefaultEnvironmentId = async ({
  ddb,
  tableName,
  fallback = {},
  onFallback = () => {},
}) => {
  let environmentId = null;
  try {
    environmentId = (await readDefaultEnvironment({ ddb, tableName }))?.environmentId ?? null;
    if (!environmentId || environmentId === STANDARD_ENVIRONMENT_ID) {
      return STANDARD_ENVIRONMENT_ID;
    }
    await resolvePublishedEnvironment({ ddb, tableName, environmentId, fallback });
    return environmentId;
  } catch (error) {
    onFallback(error, environmentId);
    return STANDARD_ENVIRONMENT_ID;
  }
};

export default {
  STANDARD_ENVIRONMENT_ID,
  DEFAULT_ENVIRONMENT_KEY,
  readDefaultEnvironment,
  writeDefaultEnvironment,
  resolveDefaultEnvironmentId,
};
