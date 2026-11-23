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
import { previewStageResponsibilities } from '../shared/stage-responsibilities.js';

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

export const getStageResponsibilities = async ({ event, g, ddb, store, resolveRoles }) => {
  const { projectId } = event.pathParameters;
  const params = event.queryStringParameters || {};
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
  // Closures imported before importer revision 5 carry no responsibilities and
  // stay immutable; publishing a workflow version cannot change this intent.
  if (meta.methodologyRelease && !workflow.cedarPolicies)
    throw Object.assign(
      new Error(
        "This intent's AI-DLC version predates stage responsibilities, so none are defined for it.",
      ),
      { statusCode: 422 },
    );
  // `order` is a placement's position within its phase, as in the composer.
  let stages = workflow.placements.toSorted(
    (a, b) => (a.phasePath ?? '').localeCompare(b.phasePath ?? '') || a.order - b.order,
  );
  if (params.intentId) {
    const loader = createIntentMethodologyLoader({
      ddb,
      tableName: process.env.BLOCKS_TABLE,
      s3,
      bucket: process.env.ARTIFACTS_BUCKET,
    });
    const plan = await loader.loadPlan(meta);
    if (!plan.valid) throw new Error('Pinned intent plan could not be loaded');
    const [instances, gates, unitPlan] = await Promise.all([
      queryExecutionRows(ddb, params.intentId, 'STAGE#'),
      queryExecutionRows(ddb, params.intentId, 'HUMAN#'),
      ddb.send(
        new GetCommand({
          TableName: process.env.V2_EXECUTIONS_TABLE,
          Key: unitPlanKey(params.intentId),
          ConsistentRead: true,
        }),
      ),
    ]);
    const namespace = plan.plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
    stages = plan.plan.stages.flatMap((stage) => {
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
    stages = stages.map((stage) => ({
      ...stage,
      gateIds: gates
        .filter((gate) => gate.stageInstanceId === stage.stageInstanceId)
        .map((gate) => gate.humanTaskId),
    }));
  } else if (params.scope) {
    if (!stages.some((stage) => Object.hasOwn(stage.scopeMembership, params.scope)))
      throw invalid('Unknown workflow scope');
    stages = stages.filter((stage) => stage.scopeMembership[params.scope] === 'EXECUTE');
  }
  if (params.stageInstanceId) {
    stages = stages.filter((stage) => stage.stageInstanceId === params.stageInstanceId);
    if (!stages.length) throw invalid('Stage instance is not selected by this intent');
  }
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
  return previewStageResponsibilities({ workflow, members, stages });
};
