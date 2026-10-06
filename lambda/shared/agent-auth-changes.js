import { isMaterialAuthInventoryRow } from './agent-auth-inventory.js';
import { normalizeAuthAction } from './agent-auth-actions.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  authError,
  assertIdentifier,
  normalizeCredentialBinding,
  legacyPlatformBinding,
  credentialChangeAffects,
} from './agent-auth-catalog.js';
import { legacyConnectionId } from './agent-connection-repository.js';

export const AUTH_IMPACT_OUTCOMES = Object.freeze({
  CONTINUES: 'continues',
  NEXT_START: 'next-start',
  LOSES_ACCESS: 'loses-access',
  REPAIR: 'repair',
  UNKNOWN: 'unknown',
});
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export { credentialUpdateCandidate } from './agent-auth-key-changes.js';
export const materialAuthInventory = (rows, now = Date.now()) => {
  const executions = new Map(
    rows.filter((row) => row.type === 'Execution').map((row) => [row.executionId, row]),
  );
  const expanded = rows.flatMap((row) =>
    row.type === 'AgentInvocation' && row.credentialBindings?.length
      ? row.credentialBindings.map((binding, index) => ({
          ...row,
          credentialBinding: binding,
          inventoryBindingIndex: index,
        }))
      : [row],
  );
  return expanded
    .filter((row) => isMaterialAuthInventoryRow(row, now))
    .map((row) => {
      const parent = executions.get(row.executionId);
      const binding =
        row.credentialBinding ??
        (['Compose', 'QuorumEdit'].includes(row.type) ? parent?.credentialBinding : null);
      return {
        id: row.id ?? row.executionId ?? row.environmentId ?? row.pk,
        key: `${row.pk ?? row.type}:${row.sk ?? row.id}${row.inventoryBindingIndex === undefined ? '' : `:binding-${row.inventoryBindingIndex}`}`,
        type: row.type,
        projectId: row.projectId ?? parent?.projectId ?? null,
        status: row.status ?? row.state ?? null,
        userId: row.userId ?? null,
        source: row.source ?? null,
        agentCli: row.agentCli ?? parent?.agentCli ?? null,
        binding: binding ? normalizeCredentialBinding(binding) : null,
        revision: row.revision ?? row.revisionId ?? null,
        connectionId: row.connectionId ?? null,
        agentAuthProtocol:
          row.agentAuthProtocol ??
          row.environment?.agentAuthProtocol ??
          row.verification?.agentAuthProtocol ??
          null,
        liveness:
          row.type === 'AgentInvocation'
            ? row.heartbeatAt && Date.parse(row.heartbeatAt) >= now - 120_000
              ? 'live'
              : 'unknown'
            : null,
        credentialStatus: row.credentialStatus ?? null,
        environmentId: row.environmentId ?? null,
      };
    })
    .toSorted((a, b) => a.key.localeCompare(b.key));
};

export const classifyAuthImpact = (inventory, candidate) =>
  inventory.map((item) => {
    let outcome = AUTH_IMPACT_OUTCOMES.CONTINUES;
    let reason = 'The pinned connection and its credential access are retained.';
    let action = 'No action required.';
    const binding = item.binding ?? (item.agentCli ? legacyPlatformBinding(item.agentCli) : null);
    const connectionId =
      binding?.connectionId ??
      (binding ? legacyConnectionId({ ...binding, projectId: item.projectId }) : null);
    if (item.type === 'Execution' && !binding) {
      outcome = AUTH_IMPACT_OUTCOMES.NEXT_START;
      reason = 'This draft selects the effective connection at its next operation.';
    } else if (item.type === 'EnvironmentRevision') {
      outcome =
        item.agentAuthProtocol >= 2 ? AUTH_IMPACT_OUTCOMES.CONTINUES : AUTH_IMPACT_OUTCOMES.UNKNOWN;
      reason =
        item.agentAuthProtocol >= 2
          ? 'This published runtime supports versioned authentication bindings.'
          : 'This runtime has not reported authentication capabilities. Legacy bindings remain supported.';
      action =
        item.agentAuthProtocol >= 2
          ? 'No action required.'
          : 'Publish and verify a compatible environment before selecting a new connection.';
    } else if (item.type === 'AgentInvocation' && item.liveness !== 'live') {
      outcome = AUTH_IMPACT_OUTCOMES.UNKNOWN;
      reason = 'Invocation liveness evidence is missing or stale.';
      action = 'Inspect the runtime before relying on this inventory.';
    }
    if (credentialChangeAffects(candidate, binding, item.projectId)) {
      const change = candidate.changes.find((entry) => entry.provider === binding.provider);
      if (change?.action === 'clear') {
        outcome = AUTH_IMPACT_OUTCOMES.LOSES_ACCESS;
        reason =
          'The next invocation or renewal cannot acquire this credential. An already issued credential may continue until expiry or external revocation.';
        action =
          'Keep this credential while pinned work needs it, or repair the same connection before resuming.';
      } else if (change) {
        reason =
          'The binding stays pinned to this secret reference. The next invocation uses the rotated key; an already issued key is unchanged.';
      }
    }
    if (item.status === 'reconnect-required' || item.status === 'revoked') {
      outcome = AUTH_IMPACT_OUTCOMES.REPAIR;
      reason = 'The selected connection cannot authorize its next operation.';
      action = 'Reconnect or repair the pinned connection.';
    }
    if (['Space', 'CredentialScope'].includes(item.type)) {
      outcome = AUTH_IMPACT_OUTCOMES.NEXT_START;
      reason =
        'Future work resolves the current mode and applicable scope overrides. Pinned work is listed separately.';
      action = 'Review the effective connection before starting new work.';
    }
    if (
      item.type === 'AgentSelection' ||
      (['Compose', 'QuorumEdit'].includes(item.type) && !binding)
    ) {
      outcome = AUTH_IMPACT_OUTCOMES.UNKNOWN;
      reason =
        'Credential selection has reserved this identity, but the operation may not yet have pinned its execution record.';
      action = 'The referenced credential may still be needed by work being started.';
    }
    return { ...item, connectionId, outcome, reason, action };
  });

const scopedMaterialInventory = (rows, candidate, now) => {
  const inventory = materialAuthInventory(rows, now);
  return candidate.source === 'user'
    ? inventory.filter((item) => (item.binding?.userId ?? item.userId) === candidate.userId)
    : inventory;
};

export const createAgentAuthChangeService = ({
  repository,
  loadInventory = (candidate) => repository.loadInventory(candidate),
  now = Date.now,
  randomId = randomUUID,
}) => {
  const validateCandidate = (candidate) => normalizeAuthAction(candidate, repository);
  return {
    async preview(candidate, actorId) {
      assertIdentifier(actorId, 'actorId');
      candidate = await validateCandidate(candidate);
      const policy = await repository.getPolicy(candidate);
      if (policy.pendingReview) {
        const pending = await repository.getReview(policy.pendingReview);
        if (pending?.actorId === actorId && hash(pending.candidate) === hash(candidate)) {
          return {
            ...pending,
            items: [],
            limitations: [
              ...pending.limitations,
              'This reviewed change is pending. Apply it again to finish the interrupted write.',
            ],
          };
        }
        throw authError(
          'AGENT_AUTH_CHANGE_IN_PROGRESS',
          'Finish the pending credential change before reviewing another',
        );
      }
      const inventory = scopedMaterialInventory(await loadInventory(candidate), candidate, now());
      const latest = await repository.getPolicy(candidate);
      if (
        latest.configurationRevision !== policy.configurationRevision ||
        latest.revision !== policy.revision ||
        latest.activityRevision !== policy.activityRevision
      ) {
        throw authError(
          'AGENT_AUTH_REVIEW_STALE',
          'Work or configuration changed while preparing the preview; review again',
        );
      }
      const items = classifyAuthImpact(inventory, candidate, now());
      const review = {
        id: randomId(),
        actorId,
        candidate,
        policyRevision: policy.revision,
        ...(policy.configurationRevision !== undefined
          ? { configurationRevision: policy.configurationRevision }
          : {}),
        activityRevision: policy.activityRevision,
        inventoryHash: hash(inventory),
        createdAt: new Date(now()).toISOString(),
        expiresAt: now() + 600_000,
        complete: false,
        limitations: [
          'Older runtime sessions do not provide complete invocation accounting. External token expiry and revocation are independent of configuration changes.',
        ],
        counts: Object.fromEntries(
          Object.values(AUTH_IMPACT_OUTCOMES).map((outcome) => [
            outcome,
            items.filter((item) => item.outcome === outcome).length,
          ]),
        ),
        items,
      };
      await repository.putReview(review);
      return review;
    },
    async apply(reviewId, actorId, { candidate: expectedCandidate, writeCredentials } = {}) {
      const review = await repository.getReview(reviewId);
      if (!review || review.actorId !== actorId)
        throw authError(
          'AGENT_AUTH_REVIEW_INVALID',
          'Review does not belong to this administrator',
        );
      if (expectedCandidate && hash(expectedCandidate) !== hash(review.candidate))
        throw authError(
          'AGENT_AUTH_REVIEW_STALE',
          'Proposed credential changes differ from the reviewed changes',
        );
      if (review.appliedRevision) return { saved: true, revision: review.appliedRevision };
      const policy = await repository.getPolicy(review.candidate);
      const resuming = policy.pendingReview === review.id;
      if (
        !resuming &&
        (review.expiresAt <= now() ||
          policy.configurationRevision !== review.configurationRevision ||
          policy.revision !== review.policyRevision ||
          policy.activityRevision !== review.activityRevision ||
          hash(
            scopedMaterialInventory(await loadInventory(review.candidate), review.candidate, now()),
          ) !== review.inventoryHash)
      ) {
        throw authError(
          'AGENT_AUTH_REVIEW_STALE',
          'Work or configuration changed since review; generate and review a new preview',
        );
      }
      await validateCandidate(review.candidate);
      try {
        if (review.candidate.kind === 'credential-update') {
          if (!expectedCandidate || !writeCredentials)
            throw authError('AGENT_AUTH_INVALID', 'The reviewed credential update is required');
          if (!resuming) await repository.lockReview(review);
          await writeCredentials();
        }
        const next = await repository.applyReview({
          review,
          actorId,
          policy,
          now: new Date(now()).toISOString(),
        });
        return { saved: true, revision: next.revision };
      } catch (error) {
        if (
          ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error?.name)
        ) {
          throw authError(
            'AGENT_AUTH_REVIEW_STALE',
            'Configuration changed during activation; review again',
          );
        }
        throw error;
      }
    },
  };
};
