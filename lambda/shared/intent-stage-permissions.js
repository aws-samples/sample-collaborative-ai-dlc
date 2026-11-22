import { membershipStore } from './space-membership.js';
import { intentMethodologyOptions } from './intent-methodology.js';
import { createSsoRoleResolver, resolveSpaceMemberRoles } from './member-role-resolver.js';
import {
  permitsEveryStage,
  predatesStagePermissions,
  resolveStageResponsibilities,
} from './stage-responsibilities.js';
import { loadWorkflowComposition } from './v2-workflow-plan.js';

// The caller resolves the stage IDs from execution records or the pinned plan.
// Membership, SSO mappings and fallback are resolved anew for each action.
export const mayActOnStages = async ({
  ddb,
  s3,
  meta,
  stageIds,
  userId,
  action,
  membershipRole,
}) => {
  if (!userId) return false;
  // Gate and document handlers have already read the actor's role for this request.
  const role =
    membershipRole ?? (await membershipStore.get(meta.projectId, userId))?.membershipRole;
  if (!['owner', 'member'].includes(role)) return false;
  const workflow = await loadWorkflowComposition({
    ddb,
    tableName: process.env.BLOCKS_TABLE,
    workflowId: meta.workflowId,
    workflowVersion: meta.workflowVersion,
    ...intentMethodologyOptions(meta, { s3, bucket: process.env.ARTIFACTS_BUCKET }),
  });
  // A pre-responsibilities version has no role restrictions, including on
  // historical documents and gates that predate stage attribution.
  if (predatesStagePermissions(workflow)) return true;
  if (!stageIds.length) return false;
  const stages = [...new Set(stageIds)].map((id) =>
    workflow.placements.find((p) => p.stageId === id),
  );
  if (stages.some((stage) => !stage)) return false;
  const mapped = stages.filter((stage) => stage.permissions != null);
  if (!mapped.length) return true;
  const members = await resolveSpaceMemberRoles({
    spaceId: meta.projectId,
    resolveRoles: createSsoRoleResolver(),
  });
  const result = resolveStageResponsibilities({ workflow, members, stages: mapped });
  return permitsEveryStage(result.stages, userId, role, action);
};
