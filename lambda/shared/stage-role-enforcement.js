import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const platformKey = { pk: 'SETTINGS#STAGE_ROLES', sk: 'CURRENT' };
const spaceKey = (spaceId) => ({ pk: `SPACE#${spaceId}`, sk: 'SETTINGS#STAGE_ROLES' });

// Only an explicitly stored false relaxes stage authorization. Read failures propagate.
const readSetting = async (ddb, key) => {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: process.env.ACCESS_TABLE, Key: key, ConsistentRead: true }),
  );
  return Item ? Item.enabled !== false : null;
};

export const readStageRoleEnforcement = async (ddb) =>
  (await readSetting(ddb, platformKey)) ?? true;

export const writeStageRoleEnforcement = (ddb, enabled) =>
  ddb.send(
    new PutCommand({ TableName: process.env.ACCESS_TABLE, Item: { ...platformKey, enabled } }),
  );

export const readSpaceStageRoleEnforcement = async (ddb, spaceId) => {
  const [platformDefault, override] = await Promise.all([
    readStageRoleEnforcement(ddb),
    readSetting(ddb, spaceKey(spaceId)),
  ]);
  return { platformDefault, override, enforceStageRoles: override ?? platformDefault };
};

export const writeSpaceStageRoleOverride = (ddb, spaceId, override) => {
  const TableName = process.env.ACCESS_TABLE;
  const Key = spaceKey(spaceId);
  return ddb.send(
    override === null
      ? new DeleteCommand({ TableName, Key })
      : new PutCommand({ TableName, Item: { ...Key, enabled: override } }),
  );
};
