import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { supportsCompatibilityVersion } from './runtime-compatibility.js';

const environmentKey = (environmentId) => ({ pk: `ENV#${environmentId}`, sk: 'META' });
const revisionKey = (environmentId, revisionId) => ({
  pk: `ENV#${environmentId}`,
  sk: `REV#${revisionId}`,
});

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

export const resolveEnvironmentSnapshot = async ({
  ddb,
  tableName,
  environmentId = 'standard',
  fallback = {},
}) => {
  if (!ddb || !tableName) return fallbackSnapshot(fallback);
  const { Item: environment } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: environmentKey(environmentId || 'standard'),
      ConsistentRead: true,
    }),
  );
  if (!environment?.publishedRevisionId || environment.status === 'RETIRED') {
    if (environmentId && environmentId !== 'standard') {
      throw Object.assign(new Error('Assigned environment is not published'), {
        code: 'ENVIRONMENT_NOT_PUBLISHED',
      });
    }
    return fallbackSnapshot(fallback);
  }
  const { Item: revision } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: revisionKey(environment.environmentId, environment.publishedRevisionId),
      ConsistentRead: true,
    }),
  );
  if (!revision?.runtimeArn || !revision?.imageDigest) {
    throw Object.assign(new Error('Published environment revision is incomplete'), {
      code: 'ENVIRONMENT_REVISION_INCOMPLETE',
    });
  }
  if (revision.verification?.status !== 'PASSED') {
    throw Object.assign(new Error('Published environment revision is not verified'), {
      code: 'ENVIRONMENT_REVISION_UNVERIFIED',
    });
  }
  const compatibilityVersion = revision.runtimeCompatibilityVersion ?? '1';
  const currentCompatibilityVersion =
    process.env.RUNTIME_COMPATIBILITY_VERSION ?? fallback.compatibilityVersion ?? '1';
  if (!supportsCompatibilityVersion(compatibilityVersion, currentCompatibilityVersion)) {
    throw Object.assign(new Error('Published environment compatibility version is unsupported'), {
      code: 'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED',
    });
  }
  return {
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
};

export { fallbackSnapshot, supportsCompatibilityVersion };
export default { resolveEnvironmentSnapshot, fallbackSnapshot, supportsCompatibilityVersion };
