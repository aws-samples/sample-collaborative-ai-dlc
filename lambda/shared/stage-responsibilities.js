import { BUSINESS_ROLES, normalizeStagePermissions } from './business-roles.js';
import { validateCedarPolicies, createCedarPolicyEvaluator } from './space-permissions.js';
import { buildStagePolicies } from './stage-responsibility-defaults.js';
export { normalizeStagePermissions } from './business-roles.js';
export { DEFAULT_STAGE_PERMISSIONS } from './stage-responsibility-defaults.js';

const schema = `
entity User { membershipRole: String, roles: Set<String> };
entity Stage;
action "decision-maker", "contribute", "decide" appliesTo {
  principal: User, resource: Stage, context: { fallback: String }
};`;

export const validateStagePolicies = (cedarPolicies) =>
  validateCedarPolicies(cedarPolicies, schema);

export const generateStagePolicies = (placements) => {
  const cedarPolicies = buildStagePolicies(placements);
  validateStagePolicies(cedarPolicies);
  return cedarPolicies;
};

export const assertWorkflowItemSize = (item) => {
  // JSON includes names and structural overhead; reserve room for DynamoDB metadata.
  if (Buffer.byteLength(JSON.stringify(item)) > 350_000)
    throw Object.assign(new Error('Workflow item exceeds the safe DynamoDB item size'), {
      statusCode: 400,
    });
};

const people = (selected) =>
  selected.map(({ userId, name, email, effectiveRoles }) => ({
    userId,
    name,
    email,
    roles: effectiveRoles,
  }));

export const resolveStageResponsibilities = ({
  workflow,
  members,
  stages = workflow.placements,
}) => {
  // A missing mapping is visible, but absent/invalid stored policy is an error.
  validateStagePolicies(workflow.cedarPolicies);
  const evaluatePolicy = createCedarPolicyEvaluator(workflow.cedarPolicies);
  const evaluate = (member, stageId, action, fallback = '') =>
    evaluatePolicy({
      principal: { type: 'User', id: member.userId },
      action: { type: 'Action', id: action },
      resource: { type: 'Stage', id: stageId },
      context: { fallback },
      entities: [
        {
          uid: { type: 'User', id: member.userId },
          attrs: {
            membershipRole: member.membershipRole,
            roles: member.effectiveRoles,
          },
          parents: [],
        },
      ],
    });
  return {
    workflowId: workflow.workflowId ?? workflow.id,
    workflowVersion: workflow.workflowVersion ?? workflow.version,
    stages: stages.map((stage) => {
      const placement = workflow.placements.find((p) => p.stageId === stage.stageId);
      if (!placement) throw new Error(`Unknown stage placement ${stage.stageId}`);
      const base = {
        stageId: stage.stageId,
        stageInstanceId: stage.stageInstanceId ?? null,
        gateIds: stage.gateIds ?? [],
        name: stage.name ?? stage.stageId,
        phasePath: placement.phasePath,
        permissions: placement.permissions ?? null,
        missingDecisionMakerRoles: [],
        missingContributorRoles: [],
      };
      if (!placement.permissions)
        return {
          ...base,
          reason: 'unmapped',
          decisionMakers: [],
          contributors: [],
        };
      const permissions = normalizeStagePermissions(placement.permissions);
      if (permissions.automatic)
        return {
          ...base,
          reason: 'automatic',
          decisionMakers: [],
          contributors: [],
        };
      const decisionMakers = members.filter((m) => evaluate(m, stage.stageId, 'decision-maker'));
      const contributors = members.filter((m) => evaluate(m, stage.stageId, 'contribute'));
      const missing = (roles) =>
        roles.filter(
          (role) =>
            !members.some(
              (member) =>
                ['owner', 'member'].includes(member.membershipRole) &&
                member.effectiveRoles.includes(role),
            ),
        );
      const reason = decisionMakers.length
        ? 'decision-makers'
        : contributors.length
          ? 'contributors'
          : 'owners';
      return {
        ...base,
        reason,
        missingDecisionMakerRoles: missing(permissions.decisionMakerRoles),
        missingContributorRoles: missing(permissions.contributorRoles),
        decisionMakers: people(members.filter((m) => evaluate(m, stage.stageId, 'decide', reason))),
        contributors: people(contributors),
      };
    }),
  };
};

export const previewStageResponsibilities = (options) => ({
  previewOnly: true,
  roles: BUSINESS_ROLES,
  ...resolveStageResponsibilities(options),
});
