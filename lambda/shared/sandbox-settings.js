// Platform policy and its immutable applied versions live in the existing
// process table. There are no project overrides or secrets in these records.
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export const DEFAULT_SANDBOX_CONFIG = Object.freeze({
  enabled: false,
  settings: {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowAllUnixSockets: true,
    },
    filesystem: {
      disabled: false,
      allowWrite: ['/'],
      denyRead: [
        '/home/node/.aws',
        '/home/node/.ssh',
        '/home/node/.git-credentials',
        '/home/node/.netrc',
      ],
      denyWrite: [
        '/home/node/.aws',
        '/home/node/.ssh',
        '/home/node/.git-credentials',
        '/home/node/.netrc',
      ],
    },
  },
});

const key = { pk: 'SETTINGS#SANDBOX', sk: 'CURRENT' };
export const sandboxSettingsError = (code, message) => Object.assign(new Error(message), { code });

export const readSandboxSettings = async ({ ddb, tableName }) => {
  if (!tableName) throw new Error('Sandbox settings require the process table');
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  return Item ?? { ...key, revision: 0, enabled: false, applied: null, draft: null };
};

export const sandboxSettingsView = (record) => ({
  revision: record.revision,
  enabled: record.enabled,
  applied: record.applied,
  draft: record.draft,
  defaultSettings: DEFAULT_SANDBOX_CONFIG.settings,
});

export const captureSandboxSettings = (record) => {
  if (typeof record.enabled !== 'boolean' || (record.enabled && !record.applied?.settings)) {
    throw new Error('Invalid saved sandbox configuration');
  }
  return structuredClone({
    enabled: record.enabled,
    version: record.applied?.version ?? null,
    settings: record.applied?.settings ?? DEFAULT_SANDBOX_CONFIG.settings,
  });
};

// The API validates config before this write. All operations compare the same
// revision, so autosave, toggle and Apply cannot overwrite another admin.
export const writeSandboxSettings = async ({
  ddb,
  tableName,
  expectedRevision,
  action,
  config,
  enabled,
  actor,
  now = new Date().toISOString(),
}) => {
  const current = await readSandboxSettings({ ddb, tableName });
  if (current.revision !== expectedRevision) {
    throw sandboxSettingsError(
      'sandbox_conflict',
      'Sandbox settings changed. Reload before saving.',
    );
  }
  const next = { ...current, revision: current.revision + 1, updatedAt: now, updatedBy: actor };
  let appliedConfig;
  if (action === 'draft') next.draft = config;
  else if (action === 'apply') appliedConfig = config;
  else if (action === 'toggle') {
    if (typeof enabled !== 'boolean') {
      throw sandboxSettingsError('sandbox_invalid', 'enabled must be a boolean');
    }
    if (enabled && !current.applied) {
      appliedConfig = structuredClone(DEFAULT_SANDBOX_CONFIG.settings);
    }
    next.enabled = enabled;
  } else {
    throw sandboxSettingsError('sandbox_invalid', 'Unknown sandbox settings action');
  }
  if (appliedConfig) {
    next.applied = {
      version: next.revision,
      settings: appliedConfig,
      appliedAt: now,
      appliedBy: actor,
    };
    // First enable uses the starter, never an unapplied draft.
    if (action === 'apply' || !next.draft) next.draft = appliedConfig;
  }
  const writes = [
    {
      Put: {
        TableName: tableName,
        Item: next,
        ConditionExpression:
          expectedRevision === 0 ? 'attribute_not_exists(pk)' : '#revision = :revision',
        ...(expectedRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': expectedRevision },
            }),
      },
    },
  ];
  if (appliedConfig) {
    writes.push({
      Put: {
        TableName: tableName,
        Item: { pk: key.pk, sk: `V#${next.applied.version}`, ...next.applied },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (
      error.name === 'TransactionCanceledException' &&
      error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
    ) {
      throw sandboxSettingsError(
        'sandbox_conflict',
        'Sandbox settings changed. Reload before saving.',
      );
    }
    throw error;
  }
  return sandboxSettingsView(next);
};
