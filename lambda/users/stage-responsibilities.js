import { readSpaceStageRoleEnforcement } from '../shared/stage-role-enforcement.js';
import { BUSINESS_ROLES } from '../shared/business-roles.js';
import { spacePermissions } from '../shared/space-permissions.js';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { getVal } from '../shared/trackers.js';
import { resolveSpaceMemberRoles } from '../shared/member-role-resolver.js';
import { workflowPk } from '../shared/workflows.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from '../shared/tenant.js';
import { loadWorkflowComposition } from '../shared/v2-workflow-plan.js';
import {
  createIntentMethodologyLoader,
  intentMethodologyOptions,
} from '../shared/intent-methodology.js';
import { executionMetaKey, executionPk, unitPlanKey } from '../shared/v2-process-keys.js';
import { stageInstanceId } from '../shared/v2-execution-plan.js';
import { unitStageSkipReason } from '../shared/unit-kind-pruning.js';
import {
  responsiblePeople,
  actorStageAccess,
  isSectionGate,
  sectionGateStageIds,
  sectionGateRoleAccess,
  permitsEveryStage,
  predatesStagePermissions,
  previewStageResponsibilities,
} from '../shared/stage-responsibilities.js';

const s3 = new S3Client({});
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const queryExecutionRows = async (ddb, executionId, prefix) => {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: process.env.V2_EXECUTIONS_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': executionPk(executionId),
          ':prefix': prefix,
        },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
};

const loadResponsibilityMeta = async ({ projectId, params, g, ddb }) => {
  let meta;
  if (params.intentId) {
    const result = await ddb.send(
      new GetCommand({
        TableName: process.env.V2_EXECUTIONS_TABLE,
        Key: executionMetaKey(params.intentId),
        ConsistentRead: true,
      }),
    );
    meta = result.Item;
    if (!meta || meta.projectId !== projectId)
      throw Object.assign(new Error('Intent not found in this space'), {
        statusCode: 404,
      });
  } else {
    const project = await g.V().has('Project', 'id', projectId).valueMap().next();
    const configuredWorkflow = getVal(project.value, 'workflow_id') || 'aidlc-v2';
    const workflowId = params.workflowId || configuredWorkflow;
    let workflowVersion =
      params.version ||
      (workflowId === configuredWorkflow ? getVal(project.value, 'workflow_version') : null);
    if (!workflowVersion) {
      for (const tenant of [DEFAULT_TENANT, SYSTEM_TENANT]) {
        const result = await ddb.send(
          new GetCommand({
            TableName: process.env.BLOCKS_TABLE,
            Key: { pk: workflowPk(tenant, workflowId), sk: 'META' },
            ConsistentRead: true,
          }),
        );
        if (result.Item) {
          workflowVersion = result.Item.version;
          break;
        }
      }
    }
    if (!Number.isSafeInteger(Number(workflowVersion)) || Number(workflowVersion) < 1)
      throw invalid('A saved workflow version is required');
    meta = { workflowId, workflowVersion: Number(workflowVersion) };
  }
  return meta;
};

const loadResponsibilityContext = async ({ meta, ddb, params }) => {
  const options = {
    ddb,
    tableName: process.env.BLOCKS_TABLE,
    workflowId: meta.workflowId,
    workflowVersion: meta.workflowVersion,
    ...intentMethodologyOptions(meta, {
      s3,
      bucket: process.env.ARTIFACTS_BUCKET,
    }),
  };
  const workflow = await loadWorkflowComposition(options);
  return { meta, workflow, ddb, params };
};

const scopedPlacements = (workflow, scope) => {
  // `order` is a placement's position within its phase, as in the composer.
  const stages = workflow.placements.toSorted(
    (a, b) => (a.phasePath ?? '').localeCompare(b.phasePath ?? '') || a.order - b.order,
  );
  if (!scope) return stages;
  if (!stages.some((stage) => Object.hasOwn(stage.scopeMembership, scope)))
    throw invalid('Unknown workflow scope');
  return stages.filter((stage) => stage.scopeMembership[scope] === 'EXECUTE');
};

const withGateIds = (stage, gates) => ({
  ...stage,
  gateIds: gates
    .filter((gate) => gate.stageInstanceId === stage.stageInstanceId)
    .map((gate) => gate.humanTaskId),
});

const loadExecutionStages = async ({ ddb, meta, params: { intentId } }) => {
  const loader = createIntentMethodologyLoader({
    ddb,
    tableName: process.env.BLOCKS_TABLE,
    s3,
    bucket: process.env.ARTIFACTS_BUCKET,
  });
  const plan = await loader.loadPlan(meta);
  if (!plan.valid) throw new Error('Pinned intent plan could not be loaded');
  const [instances, gates, unitPlan] = await Promise.all([
    queryExecutionRows(ddb, intentId, 'STAGE#'),
    queryExecutionRows(ddb, intentId, 'HUMAN#'),
    ddb.send(
      new GetCommand({
        TableName: process.env.V2_EXECUTIONS_TABLE,
        Key: unitPlanKey(intentId),
        ConsistentRead: true,
      }),
    ),
  ]);
  const namespace = plan.plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
  const stages = plan.plan.stages.flatMap((stage) => {
    // UNITPLAN contains selected lanes, including ones that have not started.
    // Stage rows describe execution progress; they are not the selected plan.
    if (stage.parallelSection != null && unitPlan.Item) {
      return (
        (unitPlan.Item.units ?? [])
          // Same rule the orchestrator uses to record SKIPPED instances.
          .filter((unit) => !unitStageSkipReason(stage, unit, unitPlan.Item.skipMatrix))
          .map((unit) => {
            const plannedId = stageInstanceId(
              namespace,
              stage.stageId,
              unit.slug,
              stage.parallelSection,
            );
            const instance =
              instances.find((row) => row.sk === `STAGE#${plannedId}`) ??
              instances.find(
                (row) =>
                  row.stageId === stage.stageId &&
                  row.unitSlug === unit.slug &&
                  row.sectionIndex == null,
              );
            return {
              ...stage,
              stageInstanceId: instance?.sk.slice('STAGE#'.length) ?? plannedId,
            };
          })
      );
    }
    const instance = instances.find((row) => row.stageId === stage.stageId && !row.unitSlug);
    return [
      {
        ...stage,
        stageInstanceId: instance?.sk.slice('STAGE#'.length) ?? stage.stageInstanceId,
      },
    ];
  });
  return { stages, instances, gates, planStages: plan.plan.stages, unitPlan: unitPlan.Item };
};

const loadPreviewStages = async (context) => {
  const { params, meta, workflow } = context;
  // Closures imported before importer revision 5 carry no responsibilities and
  // stay immutable; publishing a workflow version cannot change this intent.
  if (meta.methodologyRelease && !workflow.cedarPolicies)
    throw Object.assign(
      new Error(
        "This intent's AI-DLC version predates stage responsibilities, so none are defined for it.",
      ),
      { statusCode: 422 },
    );
  if (!params.intentId) return scopedPlacements(workflow, params.scope);
  const { stages, gates } = await loadExecutionStages(context);
  return stages.map((stage) => withGateIds(stage, gates));
};

const loadActorStages = async (context) => {
  const { params, meta, workflow } = context;
  let stages;
  let sectionGates = [];
  if (params.intentId && meta.status !== 'DRAFT') {
    const execution = await loadExecutionStages(context);
    const { instances, gates, planStages, unitPlan } = execution;
    stages = execution.stages;
    // Answer history still refers to its original instance after a reshape.
    const selected = new Set(stages.map((stage) => stage.stageInstanceId));
    for (const row of instances) {
      const id = row.sk.slice('STAGE#'.length);
      if (selected.has(id)) continue;
      const placement = workflow.placements.find((p) => p.stageId === row.stageId);
      if (placement) stages.push({ ...placement, stageInstanceId: id });
    }
    stages = stages.map((stage) => withGateIds(stage, gates));
    sectionGates = gates.filter(isSectionGate).map((gate) => ({
      gate,
      stageIds: sectionGateStageIds(gate, planStages, unitPlan),
    }));
  } else {
    stages = scopedPlacements(workflow, params.scope);
  }
  // A reshape may select a previously skipped stage. Keep its pinned permissions
  // available to execution controls even before it has an instance.
  const selected = new Set(stages.map((stage) => stage.stageId));
  stages.push(...workflow.placements.filter((stage) => !selected.has(stage.stageId)));
  return { stages, sectionGates };
};

const loadMembers = async ({ projectId, store, resolveRoles, g }) => {
  const resolvedMembers = await resolveSpaceMemberRoles({
    spaceId: projectId,
    store,
    resolveRoles,
  });
  const members = [];
  for (let offset = 0; offset < resolvedMembers.length; offset += 5) {
    members.push(
      ...(await Promise.all(
        resolvedMembers.slice(offset, offset + 5).map(async (member) => {
          const person = await g
            .V()
            .has('User', 'id', member.userId)
            .valueMap('name', 'email')
            .next();
          return {
            ...member,
            name: getVal(person.value, 'name'),
            email: getVal(person.value, 'email'),
          };
        }),
      )),
    );
  }
  return members;
};

const withActorAccess = ({ result, workflow, members, userId, sectionGates }) => {
  const actor = members.find((member) => member.userId === userId);
  const legacy = predatesStagePermissions(workflow);
  if (legacy)
    result.unattributedAccess = actorStageAccess(
      { reason: 'unmapped', decisionMakers: [], contributors: [] },
      userId,
      actor?.membershipRole,
    );
  for (const stage of result.stages)
    stage.access = actorStageAccess(stage, userId, actor?.membershipRole);
  result.sectionGates = Object.fromEntries(
    sectionGates.map(({ gate, stageIds }) => {
      const affected = stageIds.map((id) => result.stages.find((stage) => stage.stageId === id));
      const permitted = (member, action) => {
        const roleAccess = sectionGateRoleAccess(member?.membershipRole);
        if (roleAccess !== undefined) return roleAccess;
        if (!affected.length) return legacy;
        return permitsEveryStage(affected, member.userId, member.membershipRole, action);
      };
      return [
        gate.humanTaskId,
        {
          reason: 'section',
          decisionMakers: responsiblePeople(members.filter((m) => permitted(m, 'decide'))),
          contributors: responsiblePeople(
            members.filter((m) => permitted(m, 'edit') && !permitted(m, 'decide')),
          ),
          access: { edit: permitted(actor, 'edit'), decide: permitted(actor, 'decide') },
        },
      ];
    }),
  );
  return result;
};

export const getStageResponsibilities = async ({
  event,
  g,
  ddb,
  store,
  resolveRoles,
  actorRole,
}) => {
  const { projectId } = event.pathParameters;
  const params = event.queryStringParameters || {};
  const actorAccess = params.actorAccess === 'true';
  const meta = await loadResponsibilityMeta({ projectId, params, g, ddb });
  const { enforceStageRoles } = await readSpaceStageRoleEnforcement(ddb, projectId);
  if (actorAccess && !enforceStageRoles) {
    const { write } = spacePermissions(actorRole);
    return {
      workflowId: meta.workflowId,
      workflowVersion: meta.workflowVersion,
      previewOnly: true,
      enforceStageRoles,
      roles: BUSINESS_ROLES,
      stages: [],
      unattributedAccess: { edit: write, decide: write },
    };
  }
  const context = await loadResponsibilityContext({ meta, ddb, params });
  const { workflow } = context;
  let { stages, sectionGates } = actorAccess
    ? await loadActorStages(context)
    : { stages: await loadPreviewStages(context) };
  if (params.stageInstanceId) {
    stages = stages.filter((stage) => stage.stageInstanceId === params.stageInstanceId);
    if (!stages.length) throw invalid('Stage instance is not selected by this intent');
  }
  const members = await loadMembers({ projectId, store, resolveRoles, g });
  const result = previewStageResponsibilities({
    workflow,
    members,
    stages,
    allowLegacy: actorAccess,
  });
  result.enforceStageRoles = enforceStageRoles;
  if (!actorAccess) return result;
  return withActorAccess({
    result,
    workflow,
    members,
    userId: event.requestContext.authorizer.claims.sub,
    sectionGates,
  });
};
