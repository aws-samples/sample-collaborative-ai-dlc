import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { supportsCompatibilityVersion } from './runtime-compatibility.js';

const environmentKey = (environmentId) => ({ pk: `ENV#${environmentId}`, sk: 'META' });
const revisionKey = (environmentId, revisionId) => ({
  pk: `ENV#${environmentId}`,
  sk: `REV#${revisionId}`,
});
const PUBLISHED_REVISION_STATUSES = new Set(['PUBLISHED', 'SUPERSEDED']);
const ENVIRONMENT_RESOLUTION_CODES = new Set([
  'ENVIRONMENT_NOT_PUBLISHED',
  'ENVIRONMENT_REVISION_INCOMPLETE',
  'ENVIRONMENT_REVISION_UNVERIFIED',
  'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED',
]);

const environmentError = (message, code) => Object.assign(new Error(message), { code });

const fallbackSnapshot = (fallback = {}) => ({
  environmentId: 'standard',
  name: 'Standard Node/Python',
  revisionId: fallback.revisionId ?? 'legacy',
  imageDigest: fallback.imageDigest ?? null,
  runtimeVersion: fallback.runtimeVersion ?? null,
  runtimeArn: fallback.runtimeArn ?? null,
  runtimeEndpoint: fallback.runtimeEndpoint ?? null,
  compatibilityVersion: fallback.compatibilityVersion ?? '1',
  verification: fallback.verification ?? { status: 'PASSED', source: 'legacy-runtime' },
  tools: fallback.tools ?? [],
});

const fallbackEnvironment = (fallback = {}) => ({
  environmentId: 'standard',
  name: 'Standard Node/Python',
  status: 'PUBLISHED',
  publishedRevisionId: fallback.revisionId ?? 'legacy',
});

const fallbackResolution = (fallback) => ({
  environment: fallbackEnvironment(fallback),
  revision: null,
  snapshot: fallbackSnapshot(fallback),
});

export const isEnvironmentResolutionError = (error) =>
  ENVIRONMENT_RESOLUTION_CODES.has(error?.code);

export const resolvePublishedEnvironment = async ({
  ddb,
  tableName,
  environmentId = 'standard',
  fallback = {},
}) => {
  if (!ddb || !tableName) {
    if (environmentId && environmentId !== 'standard') {
      throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
    }
    return fallbackResolution(fallback);
  }
  const { Item: environment } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: environmentKey(environmentId || 'standard'),
      ConsistentRead: true,
    }),
  );
  if (!environment?.publishedRevisionId || environment.status === 'RETIRED') {
    if (environmentId && environmentId !== 'standard') {
      throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
    }
    return fallbackResolution(fallback);
  }
  const { Item: revision } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: revisionKey(environment.environmentId, environment.publishedRevisionId),
      ConsistentRead: true,
    }),
  );
  if (!revision || !PUBLISHED_REVISION_STATUSES.has(revision.status)) {
    throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
  }
  if (!revision?.runtimeArn || !revision?.imageDigest) {
    throw environmentError(
      'Published environment revision is incomplete',
      'ENVIRONMENT_REVISION_INCOMPLETE',
    );
  }
  if (revision.verification?.status !== 'PASSED') {
    throw environmentError(
      'Published environment revision is not verified',
      'ENVIRONMENT_REVISION_UNVERIFIED',
    );
  }
  const compatibilityVersion = revision.runtimeCompatibilityVersion ?? '1';
  const currentCompatibilityVersion =
    process.env.RUNTIME_COMPATIBILITY_VERSION ?? fallback.compatibilityVersion ?? '1';
  if (!supportsCompatibilityVersion(compatibilityVersion, currentCompatibilityVersion)) {
    throw environmentError(
      'Published environment compatibility version is unsupported',
      'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED',
    );
  }
  const snapshot = {
    environmentId: environment.environmentId,
    name: environment.name,
    revisionId: revision.revisionId,
    imageDigest: revision.imageDigest,
    runtimeVersion: revision.runtimeVersion ?? null,
    runtimeArn: revision.runtimeArn,
    runtimeEndpoint: revision.runtimeEndpoint ?? null,
    compatibilityVersion,
    verification: revision.verification ?? null,
    tools: revision.flattenedRecipe?.resolvedTools ?? [],
  };
  return { environment, revision, snapshot };
};

export const resolveEnvironmentSnapshot = async (options) =>
  (await resolvePublishedEnvironment(options)).snapshot;

export { fallbackSnapshot, supportsCompatibilityVersion };
export default {
  resolvePublishedEnvironment,
  resolveEnvironmentSnapshot,
  isEnvironmentResolutionError,
  fallbackSnapshot,
  supportsCompatibilityVersion,
};
