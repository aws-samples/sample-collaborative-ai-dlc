import { createMembershipStore } from '../shared/space-membership.js';
import { spacePermissions } from '../shared/space-permissions.js';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

export const createPermissionLookup = ({
  client = new LambdaClient({}),
  functionName = process.env.SPACE_PERMISSIONS_FUNCTION,
} = {}) => {
  if (!functionName) throw new Error('SPACE_PERMISSIONS_FUNCTION is required');
  return async ({ sub, scope }) => {
    const result = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify({ action: 'realtime-permissions', sub, scope })),
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

// Resource existence and the immutable document-to-space binding were verified
// at upgrade. Open documents need only the canonical, consistent membership read.
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
