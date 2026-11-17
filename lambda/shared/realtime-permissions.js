import { fetchSpacePermissions } from './space-permissions.js';
import { fetchProjectIdForSprint } from './legacy-authz.js';

// Internal Lambda invocation only. Yjs supplies the Cognito-verified subject and
// the required scope derived from the document name, never a browser-supplied role.
export const realtimePermissions = async (g, store, { sub, scope }) => {
  const denied = { read: false, write: false, manage: false };
  if (!sub || typeof scope !== 'string') return denied;
  const [kind, id, extra] = scope.split(':');
  if (!id || extra) return denied;
  let spaceId;
  if (kind === 'project') spaceId = id;
  else if (kind === 'sprint') spaceId = await fetchProjectIdForSprint(g, id);
  else if (kind === 'intent') {
    const intent = await store.getExecution(id, { consistentRead: true });
    if (!intent) return denied;
    spaceId = intent.projectId;
  }
  if (!spaceId) return denied;
  const { permissions } = await fetchSpacePermissions(g, spaceId, sub);
  return permissions.read ? { ...permissions, spaceId } : denied;
};
