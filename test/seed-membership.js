import { membershipStore, normalizeMembershipRole } from '../lambda/shared/space-membership.js';

export const seedMembership = async (spaceId, userId, role = 'owner') => {
  const before = await membershipStore.get(spaceId, userId);
  return membershipStore.change({
    spaceId,
    userId,
    role: normalizeMembershipRole(role),
    actorId: userId,
    before,
    action: 'space-created',
  });
};

export const removeMembership = async (spaceId, userId) => {
  const before = await membershipStore.get(spaceId, userId);
  if (before) {
    let actorId = userId;
    if (before.membershipRole !== 'owner') {
      let token;
      do {
        const page = await membershipStore.listMembers(spaceId, token);
        const owner = page.items.find((member) => member.membershipRole === 'owner');
        if (owner) {
          actorId = owner.userId;
          break;
        }
        token = page.nextToken;
      } while (token);
    }
    await membershipStore.change({
      spaceId,
      userId,
      actorId,
      before,
      role: null,
      action: 'member-removed',
    });
  }
};
