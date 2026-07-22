import { fetchMembershipRole } from './trackers.js';

const denied = (statusCode, error) => ({ denied: true, statusCode, error });

const getCallerSub = (event) => event?.requestContext?.authorizer?.claims?.sub || null;

const fetchProjectIdForSprint = async (g, sprintId) => {
  const r = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .in_('HAS_SPRINT')
    .hasLabel('Project')
    .values('id')
    .next();
  return r.done ? null : r.value;
};

const authorizeLegacyProjectRead = async (g, event, projectId) => {
  const sub = getCallerSub(event);
  if (!sub) return denied(401, 'Unauthorized');
  const role = await fetchMembershipRole(g, projectId, sub);
  if (!role) return denied(403, 'Not a project member');
  return { denied: false, projectId, role };
};

const authorizeLegacySprintRead = async (g, event, sprintId, expectedProjectId = null) => {
  const sub = getCallerSub(event);
  if (!sub) return denied(401, 'Unauthorized');
  const projectId = await fetchProjectIdForSprint(g, sprintId);
  if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) {
    return denied(404, 'Sprint not found');
  }
  const role = await fetchMembershipRole(g, projectId, sub);
  if (!role) return denied(403, 'Not a project member');
  return { denied: false, projectId, role };
};

const fetchProjectIdForExecution = async (g, executionIds) => {
  const candidates = [...new Set(executionIds.filter(Boolean))];
  for (const executionId of candidates) {
    let r = await g
      .V()
      .has('AgentRun', 'execution_id', executionId)
      .in_('HAS_AGENT_RUN')
      .hasLabel('Sprint')
      .in_('HAS_SPRINT')
      .hasLabel('Project')
      .values('id')
      .next();
    if (!r.done) return r.value;

    for (const property of ['current_execution_id', 'current_execution_arn']) {
      r = await g
        .V()
        .has('Sprint', property, executionId)
        .in_('HAS_SPRINT')
        .hasLabel('Project')
        .values('id')
        .next();
      if (!r.done) return r.value;

      r = await g.V().has('Project', property, executionId).values('id').next();
      if (!r.done) return r.value;
    }

    for (const property of ['task_execution_id', 'task_execution_arn']) {
      r = await g
        .V()
        .has('Task', property, executionId)
        .in_('CONTAINS')
        .hasLabel('Sprint')
        .in_('HAS_SPRINT')
        .hasLabel('Project')
        .values('id')
        .next();
      if (!r.done) return r.value;
    }
  }
  return null;
};

export {
  authorizeLegacyProjectRead,
  authorizeLegacySprintRead,
  fetchProjectIdForExecution,
  fetchProjectIdForSprint,
  getCallerSub,
};
