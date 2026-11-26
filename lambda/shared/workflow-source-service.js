// Domain service for the forthcoming dedicated workflow-source API. The host
// must authenticate actorId; never expose this via an agent-callable Lambda that
// also accepts synthetic API Gateway claims. Production hosts must supply
// getMembershipSnapshot backed by existing Neptune membership. D18 retains
// that graph's writer risk: these lifecycle checks are not an independently
// protected roster or an atomic graph/DynamoDB authorization transaction.
import {
  WorkflowSourceError,
  deleteWorkflowSourceBinding,
  getWorkflowSourceBinding,
  listWorkflowSourceBindings,
  requireWorkflowSourceRevision,
  saveWorkflowSourceBinding,
  workflowSourceIdentity,
  workflowSourceView,
} from './workflow-source-bindings.js';
import { verifyReadOnlySourceCredential } from './source-control-credentials.js';

const denied = () => {
  throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied');
};
const members = new Set(['owner', 'admin', 'member']);
const graphIdentity = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const reverify = () => {
  throw new WorkflowSourceError(
    'WORKFLOW_SOURCE_INVALID',
    'Workflow source membership changed; administrator reverification is required',
  );
};

export const createWorkflowSourceService = ({
  ddb,
  ssm,
  secrets,
  getMembershipSnapshot,
  getMembershipRole,
  verifyCredential = verifyReadOnlySourceCredential,
}) => {
  const withIdentity = getMembershipSnapshot !== undefined;
  if (
    (withIdentity && typeof getMembershipSnapshot !== 'function') ||
    (!withIdentity && typeof getMembershipRole !== 'function')
  ) {
    throw new TypeError('An authenticated membership lookup is required');
  }
  const requireRole = async (projectId, actorId, { admin = false } = {}) => {
    if (!projectId || !actorId) denied();
    if (withIdentity) {
      const snapshot = await getMembershipSnapshot(projectId, actorId);
      if (
        !snapshot ||
        Object.getPrototypeOf(snapshot) !== Object.prototype ||
        Reflect.ownKeys(snapshot).length !== 3 ||
        !Object.hasOwn(snapshot, 'role') ||
        !Object.hasOwn(snapshot, 'membershipId') ||
        !Object.hasOwn(snapshot, 'projectIdentity') ||
        !members.has(snapshot.role) ||
        (admin && snapshot.role !== 'owner' && snapshot.role !== 'admin') ||
        !graphIdentity(snapshot.membershipId) ||
        !graphIdentity(snapshot.projectIdentity)
      ) {
        denied();
      }
      // Copy before awaiting provider work, even if a lookup reuses its object.
      return Object.freeze({
        role: snapshot.role,
        membershipId: snapshot.membershipId,
        projectIdentity: snapshot.projectIdentity,
      });
    }
    // Unprotected role-only compatibility port for offline domain tests. Never
    // invent graph identities here or configure a production API with this port.
    const role = await getMembershipRole(projectId, actorId);
    if (!members.has(role) || (admin && role !== 'owner' && role !== 'admin')) denied();
    return { role };
  };

  return Object.freeze({
    async list({ projectId, actorId }) {
      const authorization = await requireRole(projectId, actorId);
      const sources = await listWorkflowSourceBindings(ddb, projectId);
      return sources
        .filter((source) => source.status !== 'deleted')
        .map((source) =>
          workflowSourceView(
            withIdentity &&
              (source.projectIdentity !== authorization.projectIdentity ||
                (source.authType?.endsWith('-oauth') &&
                  !graphIdentity(source.delegatorMembershipIdentity)))
              ? { ...source, status: 'invalid' }
              : source,
          ),
        );
    },

    async configure({ projectId, actorId, selection, expectedRevision }) {
      const before = await requireRole(projectId, actorId, { admin: true });
      const identity = workflowSourceIdentity(selection?.provider, selection?.repository);
      // Reject stale updates before provider work, and condition the eventual
      // write too: the slow network verification must not overwrite a newer
      // configuration or recreate a concurrently removed source.
      const previous = await getWorkflowSourceBinding(ddb, projectId, identity.sourceId);
      let writeRevision = expectedRevision;
      if (expectedRevision === null) {
        if (previous && previous.status !== 'deleted') {
          throw new WorkflowSourceError(
            'WORKFLOW_SOURCE_CONFLICT',
            'Workflow source already exists; reload before retrying',
          );
        }
        writeRevision = previous?.revision ?? null;
      } else {
        // Invalidated sources can be reverified explicitly by an administrator.
        if (!previous || previous.revision !== expectedRevision) {
          throw new WorkflowSourceError(
            'WORKFLOW_SOURCE_CONFLICT',
            'Workflow source changed; reload before retrying',
          );
        }
      }
      const verified = await verifyCredential({
        ddb,
        ssm,
        secrets,
        provider: identity.provider,
        repo: identity.repository,
        authType: selection.authType,
        userId: actorId,
        confirmDelegation: selection.confirmDelegation === true,
      });
      // Readding the same administrator or recreating the logical project must
      // not let a pending verification publish under its previous delegation.
      const after = await requireRole(projectId, actorId, { admin: true });
      if (
        withIdentity &&
        (before.membershipId !== after.membershipId ||
          before.projectIdentity !== after.projectIdentity)
      ) {
        reverify();
      }
      const saved = await saveWorkflowSourceBinding(
        ddb,
        {
          projectId,
          provider: identity.provider,
          repository: identity.repository,
          actorId,
          verified,
          ...(withIdentity ? { authorization: after } : {}),
        },
        { expectedRevision: writeRevision },
      );
      return workflowSourceView(saved);
    },

    async remove({ projectId, actorId, sourceId, expectedRevision }) {
      await requireRole(projectId, actorId, { admin: true });
      await deleteWorkflowSourceBinding(ddb, projectId, sourceId, { expectedRevision, actorId });
    },

    // Internal package-intake authorization only. Its return value contains
    // credential references and MUST NOT be returned by an HTTP endpoint.
    // The package broker must resolve with the read-only credential helper,
    // apply a closed provider-operation allowlist and recheck this revision
    // before publishing downloaded bytes. This function never yields a token.
    async getAuthorizedBinding({ projectId, actorId, sourceId, expectedRevision }) {
      const authorization = await requireRole(projectId, actorId);
      const binding = await getWorkflowSourceBinding(ddb, projectId, sourceId);
      requireWorkflowSourceRevision(binding, expectedRevision);
      const identity = workflowSourceIdentity(binding.provider, binding.repository);
      if (
        binding.projectId !== projectId ||
        binding.sourceId !== sourceId ||
        identity.sourceId !== sourceId ||
        binding.repo !== identity.repository
      ) {
        throw new WorkflowSourceError('WORKFLOW_SOURCE_INVALID', 'Invalid workflow source');
      }
      if (withIdentity && binding.projectIdentity !== authorization.projectIdentity) {
        reverify();
      }
      if (binding.authType?.endsWith('-oauth')) {
        const delegator = await requireRole(projectId, binding.connectionUserId);
        if (
          withIdentity &&
          (delegator.projectIdentity !== binding.projectIdentity ||
            delegator.membershipId !== binding.delegatorMembershipIdentity)
        ) {
          reverify();
        }
      }
      return binding;
    },
  });
};
