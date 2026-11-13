import gremlin from 'gremlin';
import { getVal } from '../shared/trackers.js';
import { normalizeMembershipRole } from '../shared/space-membership.js';

const __ = gremlin.process.statics;
const field = (row, key) => (row instanceof Map ? row.get(key) : row[key]);
const defaultWarn = (message, details) => console.warn(message, details);

const sourceSpaces = async (g) => {
  const projects = await g
    .V()
    .hasLabel('Project')
    .coalesce(__.values('id'), __.constant(''))
    .toList();
  if (
    projects.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(projects).size !== projects.length
  ) {
    throw new Error('Invalid or duplicate space ID in membership source');
  }
  return projects;
};

const sourceMemberships = async (g, spaceId, warn) => {
  // One query per space: concurrent deletes cannot shift a later offset page
  // past an unchanged member. Source changes after this read remain a rollout risk.
  const rows = await g
    .V()
    .has('Project', 'id', spaceId)
    .outE('HAS_MEMBER')
    .as('edge')
    .inV()
    .as('user')
    .project('edge', 'user', 'userLabel')
    .by(__.select('edge').valueMap())
    .by(__.select('user').valueMap())
    .by(__.select('user').label())
    .toList();
  const members = new Map();
  for (const row of rows) {
    const userId = getVal(field(row, 'user'), 'id');
    const oldRole = getVal(field(row, 'edge'), 'role') || 'member';
    const role = normalizeMembershipRole(oldRole);
    if (
      typeof userId !== 'string' ||
      !userId.trim() ||
      field(row, 'userLabel') !== 'User' ||
      !['owner', 'member'].includes(role)
    ) {
      throw new Error(`Invalid membership in space ${spaceId}: ${userId || 'missing user ID'}`);
    }
    const previous = members.get(userId);
    if (previous) {
      if (previous.role !== role) {
        warn('Duplicate membership roles; preserving the strongest grant', { spaceId, userId });
      }
      if (previous.role === 'owner' || role === 'member') continue;
    }
    members.set(userId, { role, oldRole });
  }
  return members;
};

// History is retained after revocation/deletion. Its migration baseline prevents
// a retry from restoring a membership removed after the application switched.
export const migrateMemberships = async (
  g,
  store,
  { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), warn = defaultWarn } = {},
) => {
  const projects = await sourceSpaces(g);
  let copied = 0;
  let preserved = 0;
  let skipped = 0;
  let ownerless = 0;
  for (const spaceId of projects) {
    const baselines = new Map();
    let token;
    do {
      const page = await store.listHistory(spaceId, { token });
      for (const item of page.items) {
        if (item.action === 'membership-migrated') baselines.set(item.targetUserId, item);
      }
      token = page.nextToken;
    } while (token);
    const seen = await sourceMemberships(g, spaceId, warn);
    if (!seen.size) {
      warn('Space has no source memberships; skipping copy', { spaceId });
      skipped++;
      continue;
    }
    // Resolve duplicate source edges before writing any baselines. This avoids
    // committing a weaker role merely because its edge was encountered first.
    for (const [userId, { role, oldRole }] of seen) {
      if (baselines.has(userId)) {
        preserved++;
        continue;
      }
      const current = await store.get(spaceId, userId);
      if (current) {
        // An application write is newer authority. Never replace it with an old edge.
        preserved++;
        continue;
      }
      await store.change({
        spaceId,
        userId,
        actorId: 'system:membership-migration',
        role,
        before: { membershipRole: oldRole },
        action: 'membership-migrated',
        migration: true,
      });
      copied++;
    }
    if (!(await store.hasOtherOwner(spaceId, ''))) {
      warn('Space has no Owner; preserving existing member access', { spaceId });
      ownerless++;
    }

    // Re-read durable baselines, then verify the GSI against current base items.
    const verified = new Set();
    token = undefined;
    do {
      const page = await store.listHistory(spaceId, { token });
      for (const entry of page.items) {
        if (
          entry.action === 'membership-migrated' &&
          entry.after?.userId === entry.targetUserId &&
          normalizeMembershipRole(entry.before?.membershipRole) === entry.after?.membershipRole
        ) {
          verified.add(entry.targetUserId);
        }
      }
      token = page.nextToken;
    } while (token);
    for (const userId of seen.keys()) {
      const current = await store.get(spaceId, userId);
      if (!verified.has(userId) && !current)
        throw new Error(`Missing migration baseline: ${spaceId}/${userId}`);
      if (!current) continue; // revoked after a previous copy
      let indexed = false;
      for (let attempt = 0; attempt < 10 && !indexed; attempt++) {
        token = undefined;
        do {
          const page = await store.listUserSpaces(userId, token);
          indexed = page.items.some(
            (m) =>
              m.pk === current.pk &&
              m.membershipRole === current.membershipRole &&
              m.revision === current.revision,
          );
          token = page.nextToken;
        } while (token && !indexed);
        if (!indexed) await wait(1000);
      }
      if (!indexed) throw new Error(`Membership index has not propagated: ${spaceId}/${userId}`);
    }
  }
  return { verified: true, spaces: projects.length, copied, preserved, skipped, ownerless };
};

export const reportMembershipDifferences = async (g, store, { warn = defaultWarn } = {}) => {
  const projects = await sourceSpaces(g);
  let missingDestination = 0;
  let missingSource = 0;
  let roleMismatches = 0;
  for (const spaceId of projects) {
    const source = await sourceMemberships(g, spaceId, warn);
    const destination = new Map();
    let token;
    do {
      const page = await store.listMembers(spaceId, token);
      for (const item of page.items) destination.set(item.userId, item.membershipRole);
      token = page.nextToken;
    } while (token);
    for (const [userId, { role }] of source) {
      const destinationRole = destination.get(userId);
      if (!destinationRole) {
        warn('Graph membership has no DynamoDB grant', { spaceId, userId, sourceRole: role });
        missingDestination++;
      } else if (destinationRole !== role) {
        warn('Graph and DynamoDB membership roles differ', {
          spaceId,
          userId,
          sourceRole: role,
          destinationRole,
        });
        roleMismatches++;
      }
    }
    for (const [userId, role] of destination) {
      if (!source.has(userId)) {
        warn('DynamoDB membership has no graph grant', { spaceId, userId, destinationRole: role });
        missingSource++;
      }
    }
  }
  return {
    reported: true,
    spaces: projects.length,
    missingDestination,
    missingSource,
    roleMismatches,
  };
};
