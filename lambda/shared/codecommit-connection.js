// A user's CodeCommit connection: the platform-issued external ID that user's
// tenant roles trust.
//
// CodeCommit has no OAuth grant, but the external ID plays the same part as an
// OAuth connection: it identifies WHO the platform is acting for when it
// assumes a tenant role (the IAM confused-deputy guard,
// https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html). It is
// therefore minted server-side, persisted against its owner, and resolved from
// that record — never accepted from a request. A caller who learns another
// user's role ARN and external ID still cannot make the platform present that
// external ID: discovery and binding only ever use the caller's own record (or,
// when re-verifying, the one already stored on a binding of the same project).
//
// One connection per user, stored in the git-provider connections table under
// the same composite key shape as the OAuth providers ('codecommit#public').
// Every role a user connects trusts the same external ID, so reopening the
// connect form always renders the trust policy the user already pasted.
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { instanceKey } from './git-connection-store.js';
import { isCodeCommitExternalId, newCodeCommitExternalId } from './codecommit-role.js';

const PROVIDER = 'codecommit';
const table = () => process.env.GIT_PROVIDER_CONNECTIONS_TABLE;
const key = (userId) => ({ userId, providerInstance: instanceKey(PROVIDER) });

const unavailable = () =>
  Object.assign(new Error('CodeCommit connection storage is not configured'), {
    code: 'CODECOMMIT_NOT_CONFIGURED',
    status: 503,
  });

// The caller's connection, or null when they never opened the connect flow.
export const getCodeCommitConnection = async (ddb, userId) => {
  if (!userId) return null;
  if (!table()) throw unavailable();
  const { Item } = await ddb.send(new GetCommand({ TableName: table(), Key: key(userId) }));
  return Item && isCodeCommitExternalId(Item.externalId) ? Item : null;
};

// Get-or-create. Concurrent first calls race on a conditional put; the loser
// re-reads the winner's row, so a user never ends up with two external IDs.
export const ensureCodeCommitConnection = async (ddb, userId, { now = () => new Date() } = {}) => {
  const existing = await getCodeCommitConnection(ddb, userId);
  if (existing) return existing;
  const item = {
    ...key(userId),
    provider: PROVIDER,
    externalId: newCodeCommitExternalId(),
    createdAt: now().toISOString(),
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    );
    return item;
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    const winner = await getCodeCommitConnection(ddb, userId);
    if (!winner) throw error;
    return winner;
  }
};

// The external ID the platform may present for `roleArn` on behalf of
// `userId`. Project authorization first: when the project already holds a
// CodeCommit binding for this role (the caller is a privileged member, checked
// by the route), re-verification keeps the external ID that role already
// trusts, whoever connected it. Otherwise the caller's own connection. A
// request-supplied external ID is only tolerated when it equals the resolved
// one; anything else is refused before STS is called.
export const resolveCodeCommitExternalId = async ({
  ddb,
  userId,
  roleArn,
  requested = null,
  projectBindings = [],
}) => {
  const bound = projectBindings.find(
    (binding) =>
      binding?.authType === 'codecommit-role' &&
      binding.roleArn === roleArn &&
      isCodeCommitExternalId(binding.externalId),
  );
  const externalId = bound?.externalId ?? (await getCodeCommitConnection(ddb, userId))?.externalId;
  if (!externalId) {
    throw Object.assign(new Error('Open the CodeCommit connect flow first'), {
      code: 'CONNECTION_REQUIRED',
      status: 409,
    });
  }
  const asked = String(requested ?? '').trim();
  if (asked && asked !== externalId) {
    throw Object.assign(new Error('This external ID does not belong to your connection'), {
      code: 'EXTERNAL_ID_NOT_OWNED',
      status: 403,
    });
  }
  return externalId;
};

export default {
  getCodeCommitConnection,
  ensureCodeCommitConnection,
  resolveCodeCommitExternalId,
};
