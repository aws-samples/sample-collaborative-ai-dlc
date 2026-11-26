import gremlin from 'gremlin';
import { WorkflowSourceError } from './workflow-source-bindings.js';

const __ = gremlin.process.statics;
const T = gremlin.process.t;
const roles = new Set(['owner', 'admin', 'member']);
const safeIdentity = (value, max = 512) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const field = (row, key) =>
  row instanceof Map ? row.get(key) : Object.hasOwn(row ?? {}, key) ? row[key] : undefined;
const invalid = () => {
  throw new WorkflowSourceError(
    'WORKFLOW_SOURCE_FORBIDDEN',
    'Project membership could not be verified',
  );
};

// D18 uses the existing Neptune membership graph. Actual edge/vertex IDs detect
// observed removal and recreation; they do not isolate authority from graph
// writers or make a graph read atomic with a later binding write.
export const fetchWorkflowSourceMembership = async (g, projectId, userId) => {
  if (!safeIdentity(projectId, 256) || !safeIdentity(userId, 256)) invalid();
  let rows;
  try {
    rows = await g
      .V()
      .has('Project', 'id', projectId)
      .limit(2)
      .project('projectIdentity', 'memberships')
      .by(T.id)
      .by(
        __.outE('HAS_MEMBER')
          .where(__.inV().has('User', 'id', userId))
          .limit(2)
          .project('membershipId', 'roles')
          .by(T.id)
          .by(__.values('role').fold())
          .fold(),
      )
      .toList();
  } catch {
    throw new WorkflowSourceError(
      'WORKFLOW_SOURCE_UNAVAILABLE',
      'Project membership lookup is unavailable',
    );
  }
  if (!Array.isArray(rows)) invalid();
  if (rows.length === 0) return null;
  if (rows.length !== 1) invalid();
  const projectIdentity = field(rows[0], 'projectIdentity');
  const memberships = field(rows[0], 'memberships');
  if (!safeIdentity(projectIdentity) || !Array.isArray(memberships)) invalid();
  if (memberships.length === 0) return null;
  if (memberships.length !== 1) invalid();
  const membershipId = field(memberships[0], 'membershipId');
  const edgeRoles = field(memberships[0], 'roles');
  if (
    !safeIdentity(membershipId) ||
    !Array.isArray(edgeRoles) ||
    edgeRoles.length !== 1 ||
    !roles.has(edgeRoles[0])
  ) {
    invalid();
  }
  return Object.freeze({ role: edgeRoles[0], membershipId, projectIdentity });
};
