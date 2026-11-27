// /projects/{projectId}/access-requests[/{userId}]: people who are not members
// ask to join a discoverable space, and its Owners approve or decline.
//
//   POST   /access-requests          request access (non-members, discoverable spaces only)
//   DELETE /access-requests/{userId} withdraw your own request
//   GET    /access-requests          list pending requests (Owners)
//   PUT    /access-requests/{userId} { decision: 'approve' | 'decline', role? } (Owners)
//          role is owner, member (the default) or viewer.

import {
  listOwnerContacts,
  membershipStore,
  normalizeMembershipRole,
} from '../shared/space-membership.js';
import { spacePermissions } from '../shared/space-permissions.js';
import { publishNotificationEvent } from '../shared/notification-events.js';
import { getVal } from '../shared/trackers.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'access-requests' } });

export const MAX_REQUEST_MESSAGE = 500;

const parseBody = (body) => {
  try {
    const data = JSON.parse(body || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};

const publicRequest = (request) => ({
  userId: request.requesterId,
  email: request.email || '',
  message: request.message || '',
  createdAt: request.createdAt,
});

export const handleAccessRequests = async ({
  g,
  event,
  response,
  projectId,
  actorId,
  actorRole,
}) => {
  const { httpMethod, pathParameters, body } = event;
  const targetUserId = pathParameters?.userId;
  const actorEmail = event.requestContext?.authorizer?.claims?.email || '';

  if (!targetUserId && httpMethod === 'POST') {
    if (actorRole) return response(409, { error: 'You are already a member of this space' });
    // A private space answers as if it did not exist.
    const space = await g
      .V()
      .has('Project', 'id', projectId)
      .valueMap('name', 'discoverable')
      .next();
    if (space.done || getVal(space.value, 'discoverable') !== 'true')
      return response(404, { error: 'Space not found' });
    const data = parseBody(body);
    if (!data) return response(400, { error: 'Invalid JSON body' });
    if (data.message !== undefined && typeof data.message !== 'string')
      return response(400, { error: 'message must be a string' });
    const message = (data.message || '').trim();
    if (message.length > MAX_REQUEST_MESSAGE)
      return response(400, {
        error: `message must be at most ${MAX_REQUEST_MESSAGE} characters`,
      });
    const request = await membershipStore.createRequest({
      spaceId: projectId,
      requesterId: actorId,
      email: actorEmail,
      message,
    });
    // Hidden, deleted, or joined some other way while this was written: the
    // clean-up for those may already have run, so check again and undo.
    let after;
    try {
      const [discoverable, membership] = await Promise.all([
        g.V().has('Project', 'id', projectId).values('discoverable').next(),
        membershipStore.get(projectId, actorId),
      ]);
      after = { visible: discoverable.value === 'true', member: Boolean(membership) };
    } catch (error) {
      // Undo the request, but report the check's failure even if the undo fails too.
      await membershipStore.withdrawRequest(projectId, actorId).catch((undoError) =>
        logger.error('Could not withdraw an unconfirmed access request', {
          projectId,
          error: undoError?.name,
        }),
      );
      throw new Error('Could not confirm the access request', { cause: error });
    }
    if (!after.visible || after.member) {
      await membershipStore.withdrawRequest(projectId, actorId);
      return after.member
        ? response(409, { error: 'You are already a member of this space' })
        : response(404, { error: 'Space not found' });
    }
    // The request is stored: a failed Owner lookup only thins the event.
    const owners = await listOwnerContacts(g, projectId, membershipStore).catch((error) => {
      logger.warn('Owner lookup for access request event failed', { error: error?.message });
      return null;
    });
    await publishNotificationEvent('space.access.requested', {
      eventId: `${projectId}:${actorId}:${request.createdAt}`,
      projectId,
      name: getVal(space.value, 'name') || '',
      requesterId: actorId,
      requesterEmail: actorEmail,
      message,
      owners,
      requestedAt: request.createdAt,
    });
    return response(201, { projectId, ...publicRequest(request), status: 'pending' });
  }

  if (targetUserId && httpMethod === 'DELETE') {
    if (targetUserId !== actorId)
      return response(403, { error: 'You can only withdraw your own request' });
    if (!(await membershipStore.withdrawRequest(projectId, actorId)))
      return response(404, { error: 'Request not found' });
    return response(204, null);
  }

  const ownerRoute =
    (!targetUserId && httpMethod === 'GET') || (targetUserId && httpMethod === 'PUT');
  if (!ownerRoute) return response(405, { error: 'Method not allowed' });
  if (!spacePermissions(actorRole).manage)
    return response(403, { error: 'Space Owner access required' });

  if (httpMethod === 'GET') {
    const page = await membershipStore.listRequests(
      projectId,
      event.queryStringParameters?.nextToken,
    );
    return response(200, { items: page.items.map(publicRequest), nextToken: page.nextToken });
  }

  const data = parseBody(body);
  if (!data) return response(400, { error: 'Invalid JSON body' });
  if (!['approve', 'decline'].includes(data.decision))
    return response(400, { error: 'decision must be approve or decline' });
  const role = normalizeMembershipRole(data.role || 'member');
  if (data.decision === 'approve' && !['owner', 'member', 'viewer'].includes(role))
    return response(400, { error: 'Invalid role. Must be owner, member, or viewer' });
  const request = await membershipStore.getRequest(projectId, targetUserId);
  if (!request) return response(404, { error: 'Request not found' });

  if (data.decision === 'decline') {
    await membershipStore.declineRequest({
      spaceId: projectId,
      requesterId: targetUserId,
      actorId,
      request,
    });
  } else {
    if (await membershipStore.get(projectId, targetUserId)) {
      // Added directly since asking; the request has nothing left to grant.
      await membershipStore.withdrawRequest(projectId, targetUserId);
      return response(409, { error: 'User is already a member of this space' });
    }
    if (!(await g.V().has('User', 'id', targetUserId).hasNext()))
      await g
        .addV('User')
        .property('id', targetUserId)
        .property('email', request.email || '')
        .next();
    await membershipStore.change({
      spaceId: projectId,
      userId: targetUserId,
      actorId,
      role,
      action: 'access-request-approved',
      accessRequest: 'approve',
    });
  }
  const decidedAt = new Date().toISOString();
  const decision = data.decision === 'approve' ? 'approved' : 'declined';
  // The decision is saved: a failed name read only thins the event.
  const name = await g
    .V()
    .has('Project', 'id', projectId)
    .values('name')
    .next()
    .catch(() => ({ value: '' }));
  await publishNotificationEvent('space.access.decided', {
    eventId: `decision:${projectId}:${targetUserId}:${request.createdAt}`,
    projectId,
    name: name.value || '',
    requesterId: targetUserId,
    requesterEmail: request.email || '',
    decision,
    role: decision === 'approved' ? role : null,
    decidedById: actorId,
    decidedByEmail: actorEmail,
    decidedAt,
  });
  return response(200, {
    projectId,
    userId: targetUserId,
    decision,
    ...(decision === 'approved' ? { role } : {}),
  });
};
