import type { Member } from '@/services/projects';
import type { StageResponsibilities } from '@/services/stageResponsibilities';

// Temporary display after a member edit, until the backend evaluates the saved
// policy. Never used for access checks or to replace a completed backend result.
// Keep fallback rules in sync with resolveStageResponsibilities in lambda/shared/stage-responsibilities.js.
export function previewMemberResponsibilities(
  responsibilities: StageResponsibilities,
  members: Member[],
): StageResponsibilities {
  const profiles = new Map(
    responsibilities.stages
      .flatMap((stage) => [...stage.decisionMakers, ...stage.contributors])
      .map((person) => [person.userId, person]),
  );
  const eligible = members
    .filter((member) => member.role === 'owner' || member.role === 'member')
    .map((member) => ({
      userId: member.userId,
      name: profiles.get(member.userId)?.name,
      email: member.email ?? profiles.get(member.userId)?.email,
      roles: member.effectiveRoles ?? member.localRoles ?? [],
      membershipRole: member.role,
    }));
  const people = (selected: typeof eligible) =>
    selected.map(({ membershipRole: _membershipRole, ...person }) => person);
  return {
    ...responsibilities,
    stages: responsibilities.stages.map((stage) => {
      if (!stage.permissions || stage.reason === 'automatic') return stage;
      const { decisionMakerRoles, contributorRoles } = stage.permissions;
      const decisionMakers = eligible.filter((person) =>
        person.roles.some((role) => decisionMakerRoles.includes(role)),
      );
      const contributors = eligible.filter((person) =>
        person.roles.some((role) => contributorRoles.includes(role)),
      );
      const reason = decisionMakers.length
        ? 'decision-makers'
        : contributors.length
          ? 'contributors'
          : 'owners';
      const unassigned = (roles: string[]) =>
        roles.filter((role) => !eligible.some((person) => person.roles.includes(role)));
      return {
        ...stage,
        reason,
        decisionMakers: people(
          reason === 'decision-makers'
            ? decisionMakers
            : reason === 'contributors'
              ? contributors
              : eligible.filter((person) => person.membershipRole === 'owner'),
        ),
        contributors: people(contributors),
        missingDecisionMakerRoles: unassigned(decisionMakerRoles),
        missingContributorRoles: unassigned(contributorRoles),
      };
    }),
  };
}
