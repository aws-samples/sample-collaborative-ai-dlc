// Central store for user git-provider connection rows.
//
// Background: connections used to live in a single-key table (hash userId), so
// a user could hold exactly ONE git connection. That was fine when GitHub was
// the only provider, but GitLab (added in this branch) needs a second
// connection per user — and the single key meant connecting GitLab would
// overwrite the user's GitHub connection. Connections now live in a
// composite-key table (hash userId + range providerInstance) so a user can hold
// a GitHub AND a GitLab connection at once. For github/gitlab the stored row
// references an SSM token (parameterName) that backs BOTH repo and issue
// operations — one row, one token, both concerns.
//
// providerInstance: the range key is '<provider>#<instance>', mirroring the
// tracker-connections table (e.g. 'jira-cloud#cloud'). Only the SaaS 'public'
// instance exists today, so callers pass just a provider and the store pins
// '#public' at the DynamoDB boundary (the same way jira-cloud.js pins
// 'jira-cloud#cloud'). Storing the composite value now means future self-hosted
// / enterprise instances ('gitlab#self-hosted', …) need NO data migration —
// only a code change to vary the instance.
//
// Lazy migrate-on-read: pre-existing connections live in the legacy table
// keyed by userId alone. On main these are all GitHub rows (GitLab post-dates
// the single-key table); a dev environment that test-connected GitLab on the
// old code may also have a legacy GitLab row. Either way the logic is the same:
// readers try the new table first; on a miss they fall back to the legacy row,
// and — if its provider matches the requested one — MOVE it into the new table
// (write new, then delete legacy). The SSM token itself never moves; only the
// DynamoDB row does. Over time the legacy table drains and can be retired.
//
// Env vars (all wired in terraform/modules/api/lambda):
//   GIT_PROVIDER_CONNECTIONS_TABLE — composite-key table (authoritative)
//   GIT_CONNECTIONS_TABLE          — legacy single-key table (read-fallback)

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// The only git-connection instance today is the SaaS one. Pinned here so the
// stored data already carries the composite key shape; callers never see it.
const DEFAULT_INSTANCE = 'public';

// Range-key value for a provider: '<provider>#<instance>'. Mirrors
// tracker-connections' providerInstance.
const instanceKey = (provider, instance = DEFAULT_INSTANCE) => `${provider}#${instance}`;

// Legacy rows predate the `provider` attribute and are always GitHub (GitLab
// post-dates the single-key table), so default a missing provider to github.
const rowProvider = (item) => item?.provider || 'github';

const newTable = () => process.env.GIT_PROVIDER_CONNECTIONS_TABLE;
const legacyTable = () => process.env.GIT_CONNECTIONS_TABLE;

// Resolve a user's connection for a specific provider.
//
// Returns the connection row (with userId + providerInstance + provider +
// parameterName + …) or null when the user has no connection for that provider.
// Performs the lazy migrate-on-read: a legacy row matching `provider` is moved
// into the new table before being returned.
//
// `ddb` is a DynamoDBDocumentClient.
const getGitConnection = async (ddb, userId, provider) => {
  if (!userId || !provider) return null;
  const providerInstance = instanceKey(provider);

  // 1. Authoritative read on the composite-key table.
  if (newTable()) {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: newTable(), Key: { userId, providerInstance } }),
    );
    if (Item) return Item;
  }

  // 2. Fallback to the legacy single-key row.
  if (!legacyTable()) return null;
  const { Item: legacy } = await ddb.send(
    new GetCommand({ TableName: legacyTable(), Key: { userId } }),
  );
  if (!legacy) return null;

  // The legacy table holds one pre-cutover row per user (in practice a GitHub
  // connection). Only satisfy this request when that row's provider matches the
  // one being asked for — otherwise this provider simply isn't connected.
  if (rowProvider(legacy) !== provider) return null;

  // 3. Migrate-on-read: move the row into the new table (best-effort), stamping
  // the composite key + an explicit provider (legacy rows may lack it).
  const migrated = { ...legacy, userId, providerInstance, provider };
  if (newTable()) {
    try {
      await ddb.send(new PutCommand({ TableName: newTable(), Item: migrated }));
      // Delete the legacy row only AFTER the new-table write succeeds, so a
      // failure between the two never loses the connection.
      await ddb.send(new DeleteCommand({ TableName: legacyTable(), Key: { userId } }));
    } catch (err) {
      // Migration is opportunistic; the read still succeeds on the legacy data.
      console.error('git connection migrate-on-read failed:', err.message);
    }
  }
  return migrated;
};

// Persist (create/update) a connection row. Always writes the authoritative
// composite-key table — never the legacy table — so the legacy table only ever
// drains, never grows. The caller passes a plain `provider`; the store stamps
// the composite `providerInstance` key.
const putGitConnection = async (ddb, item) => {
  if (!item?.userId || !item?.provider) {
    throw new Error('putGitConnection requires userId and provider');
  }
  const row = { ...item, providerInstance: instanceKey(item.provider) };
  await ddb.send(new PutCommand({ TableName: newTable(), Item: row }));
};

// Remove a user's connection for a provider from BOTH tables. Deleting the
// legacy row too prevents a stale legacy row from "resurrecting" a disconnected
// connection via migrate-on-read on the next read — but ONLY when that legacy
// row actually belongs to the provider being disconnected. The legacy table is
// keyed by userId alone (one row per user, in practice GitHub), so deleting it
// unconditionally would wipe an unmigrated GitHub connection when the user
// disconnects a DIFFERENT provider (e.g. GitLab). Guard on the row's provider.
const deleteGitConnection = async (ddb, userId, provider) => {
  if (!userId || !provider) return;
  const ops = [];
  if (newTable()) {
    ops.push(
      ddb.send(
        new DeleteCommand({
          TableName: newTable(),
          Key: { userId, providerInstance: instanceKey(provider) },
        }),
      ),
    );
  }
  if (legacyTable()) {
    // Only delete the legacy single-key row if it belongs to THIS provider.
    const { Item: legacy } = await ddb.send(
      new GetCommand({ TableName: legacyTable(), Key: { userId } }),
    );
    if (legacy && rowProvider(legacy) === provider) {
      ops.push(ddb.send(new DeleteCommand({ TableName: legacyTable(), Key: { userId } })));
    }
  }
  await Promise.all(ops);
};

export { getGitConnection, putGitConnection, deleteGitConnection, rowProvider, instanceKey };
export default {
  getGitConnection,
  putGitConnection,
  deleteGitConnection,
  rowProvider,
  instanceKey,
};
