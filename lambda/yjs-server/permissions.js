import { createMembershipStore } from '../shared/space-membership.js';
import { parseStageDocument } from '../shared/realtime-token.js';
import { spacePermissions } from '../shared/space-permissions.js';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const STAGE_PERMISSION_TTL_MS = 30_000;

// Reuse this socket's stage decision from the start of the lookup, including room load time.
export const createConnectionPermissionCheck = (lookup, target, permissions, checkedAt) => {
  if (!parseStageDocument(target.docName)) return () => lookup(target);
  let expiresAt = checkedAt + STAGE_PERMISSION_TTL_MS;
  return async () => {
    const now = Date.now();
    if (!permissions || now >= expiresAt) {
      permissions = await lookup(target);
      expiresAt = now + STAGE_PERMISSION_TTL_MS;
    }
    return permissions;
  };
};

export const createPermissionLookup = ({
  client = new LambdaClient({}),
  functionName = process.env.SPACE_PERMISSIONS_FUNCTION,
  stageFunction = process.env.STAGE_PERMISSIONS_FUNCTION,
} = {}) => {
  if (!functionName) throw new Error('SPACE_PERMISSIONS_FUNCTION is required');
  return async ({ sub, scope, docName }) => {
    const stageDocument = parseStageDocument(docName);
    if (stageDocument && !stageFunction) throw new Error('STAGE_PERMISSIONS_FUNCTION is required');
    const result = await client.send(
      new InvokeCommand({
        FunctionName: stageDocument ? stageFunction : functionName,
        Payload: Buffer.from(
          JSON.stringify({
            action: 'realtime-permissions',
            sub,
            scope,
            ...(stageDocument && { docName }),
          }),
        ),
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    if (result.FunctionError) throw new Error('Space permission lookup failed');
    const permissions = JSON.parse(Buffer.from(result.Payload).toString('utf8'));
    if (
      typeof permissions.read !== 'boolean' ||
      typeof permissions.write !== 'boolean' ||
      (permissions.read && typeof permissions.spaceId !== 'string')
    ) {
      throw new Error('Invalid space permission response');
    }
    return permissions;
  };
};

// Non-stage documents need only the consistent membership read after upgrade.
export const createMembershipLookup = ({
  accessTable = process.env.ACCESS_TABLE,
  store = createMembershipStore({ accessTable }),
} = {}) => {
  if (!accessTable) throw new Error('ACCESS_TABLE is required');
  return async ({ sub, spaceId }) => {
    if (!sub || !spaceId) return spacePermissions(null);
    const member = await store.get(spaceId, sub);
    return spacePermissions(member?.membershipRole);
  };
};
