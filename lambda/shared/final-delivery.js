import { createHash, randomUUID } from 'node:crypto';
import { repoProvider } from './repo-provider.js';
import {
  completionMessage,
  completionSections,
  unitPlanIdentity,
  assessExecutionCompletion,
  unverifiedCompletion,
} from './unit-completion.js';
import { openIntentPrs } from './intent-pr.js';
import { canonicalJson } from './workflow-checkpoint.js';

const done = (repo) => ['succeeded', 'no_change'].includes(repo.status);
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });
const safeError = (error) => {
  const code = error?.code;
  return [
    'UNBOUND',
    'BINDING_INVALID',
    'BINDING_REQUIRED',
    'CAPABILITY_REQUIRED',
    'PROVIDER_UNAUTHORIZED',
    'SOURCE_CONTROL_NOT_READY',
    'REPOSITORY_NOT_ON_PROJECT',
    'MISSING_SCOPES',
  ].includes(code)
    ? 'Source control access needs attention in project settings. Check the repository binding, then retry.'
    : 'The provider could not be verified. Check source control access and availability, then retry; existing pull requests will be checked first.';
};
export const deliveryStatus = (repositories) => {
  if (!repositories.length || repositories.every((r) => r.status === 'no_change'))
    return 'no_change';
  if (repositories.every(done)) return 'succeeded';
  if (repositories.some(done)) return 'partial';
  return 'failed';
};
export const deliveryView = (meta, delivery) => {
  if (!delivery)
    return {
      status: 'unknown',
      repositories: [],
      message:
        'Delivery has not been assessed for this run. Check delivery to inspect the recorded branches and existing pull requests.',
    };
  const expired =
    delivery.status === 'in_progress' && Date.parse(delivery.leaseUntil) <= Date.now();
  return {
    status: expired ? 'unknown' : delivery.status,
    message: expired
      ? 'The previous delivery attempt stopped responding. Check delivery before retrying.'
      : null,
    leaseUntil: delivery.leaseUntil,
    repositories: (delivery.repositories ?? []).map(
      ({ repoId, provider, branch, baseBranch, status, reason, retryable, pr }) => ({
        repoId,
        provider,
        branch,
        baseBranch,
        status,
        reason,
        retryable,
        pr,
      }),
    ),
    updatedAt: delivery.updatedAt,
  };
};
export const currentDelivery = (records) =>
  (records.deliveries ?? []).find((d) => d.orchestratorRunId === records.meta?.orchestratorRunId) ??
  null;

// Resolve the pinned workflow before offering publication of old terminal rows.
// A missing row is unfinished, including when an entire parallel section is absent.
export const assertDeliveryComplete = async (meta, records, plan) => {
  if (meta.status !== 'SUCCEEDED' || !meta.orchestratorRunId)
    throw fail(
      'delivery_not_complete',
      'Delivery retry requires a completed run with a recorded owner. Recover unfinished execution first.',
    );
  if (
    (records.humanTasks ?? []).some(
      (gate) =>
        gate.status === 'pending' &&
        (!gate.orchestratorRunId || gate.orchestratorRunId === meta.orchestratorRunId),
    )
  )
    throw fail(
      'delivery_gate_pending',
      'A human gate still needs an answer. Review execution recovery before delivery.',
    );
  const sections = completionSections(plan);
  if (sections.length && !records.unitPlan?.units?.length)
    throw fail(
      'delivery_missing_plan',
      'The current unit plan is missing. Review execution recovery before delivery.',
    );
  const receipt = meta.completionValidation;
  if (
    (meta.completionPolicyVersion >= 1 || receipt?.version >= 1) &&
    (receipt?.runId !== meta.orchestratorRunId ||
      !['complete', 'partial'].includes(receipt?.state) ||
      receipt?.unitPlanIdentity !== unitPlanIdentity(records.unitPlan) ||
      canonicalJson(receipt?.expectedSections) !== canonicalJson(sections))
  )
    throw fail(
      'delivery_completion_changed',
      'The plan or completion decision changed. Review completion diagnostics before delivery.',
    );
  // No unit diagnostic on a legacy serial execution is not evidence of its
  // historical workflow definition. Publication still requires verified scope.
  const completion =
    (await assessExecutionCompletion({
      records: { ...records, meta },
      loadPlan: async () => ({ valid: true, plan }),
    })) ?? unverifiedCompletion('legacy_workflow_unpinned');
  if (!['complete', 'partial'].includes(completion.state))
    throw fail(
      completion.state === 'unknown' ? 'delivery_unverified' : 'delivery_incomplete',
      completionMessage(completion),
    );
  for (const stage of plan.stages.filter((s) => s.parallelSection == null)) {
    const row = records.stages.find((r) => r.stageId === stage.stageId && !r.unitSlug);
    if (!row || !['SUCCEEDED', 'SKIPPED'].includes(row.state))
      throw fail(
        'delivery_stage_incomplete',
        'A workflow stage is unfinished or unverified. Review execution recovery before delivery.',
      );
  }
  return completion;
};

const targets = (meta) => {
  if (!Array.isArray(meta.repos))
    throw fail(
      'delivery_repositories_unknown',
      'The captured repositories are unknown. Review the execution before delivery.',
    );
  return meta.repos.map((repo) => {
    const repoId = typeof repo === 'string' ? repo : repo.url;
    return {
      repoId,
      provider: repoProvider(repoId, meta.gitProvider, meta.repoProviders),
      branch: meta.branch,
      baseBranch: meta.baseBranches?.[repoId] ?? meta.baseBranch ?? null,
      status: 'pending',
    };
  });
};
const callFor = (operation, meta, repo, name, args) =>
  operation({
    projectId: meta.projectId,
    provider: repo.provider,
    repo: repo.repoId,
    operation: name,
    args,
  });

const inspect = async (meta, repo, operation) => {
  if (done(repo)) return repo; // Publication is complete; merge lifecycle is out of scope.
  try {
    if (!repo.branch)
      return {
        ...repo,
        status: 'failed',
        retryable: false,
        reason: 'The captured intent branch is missing. Review the execution before publishing.',
      };
    const snapshot = await callFor(operation, meta, repo, 'delivery-inspect', {
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      number: repo.pr?.prNumber,
    });
    const next = {
      ...repo,
      baseBranch: repo.baseBranch ?? snapshot.baseBranch,
      headSha: repo.headSha ?? snapshot.headSha,
    };
    const pr = snapshot.pr;
    if (pr) {
      const identity = {
        repoId: repo.repoId,
        provider: repo.provider,
        prUrl: pr.url,
        prNumber: pr.number,
        branch: pr.sourceBranch,
        baseBranch: pr.targetBranch,
      };
      if (
        !pr.url ||
        pr.number == null ||
        pr.sourceBranch !== repo.branch ||
        pr.targetBranch !== next.baseBranch
      )
        return {
          ...next,
          status: 'failed',
          retryable: false,
          reason:
            'The existing pull request has a different branch or target. Review it with the repository owner; retry will not retarget it.',
        };
      if (pr.state !== 'open')
        return {
          ...next,
          pr: identity,
          status: 'failed',
          retryable: false,
          reason: `The existing pull request is ${pr.state === 'merged' ? 'merged' : 'closed'}. Review it in the provider; retry will not recreate closed work.`,
        };
      if (
        !snapshot.headSha ||
        pr.headSha !== snapshot.headSha ||
        (repo.headSha && snapshot.headSha !== repo.headSha)
      )
        return {
          ...next,
          pr: identity,
          status: 'failed',
          retryable: false,
          reason:
            'The intent branch changed after the delivery attempt. Review the new commits before starting a new execution.',
        };
      return {
        ...next,
        pr: identity,
        status: 'succeeded',
        retryable: false,
        reason: 'Existing open pull request reconciled.',
      };
    }
    if (!snapshot.headSha || !snapshot.baseSha)
      return {
        ...next,
        status: 'failed',
        retryable: false,
        reason: `The ${!snapshot.headSha ? 'intent' : 'base'} branch does not exist. Restore the captured branch before checking delivery again.`,
      };
    if (repo.headSha && snapshot.headSha !== repo.headSha)
      return {
        ...next,
        status: 'failed',
        retryable: false,
        reason:
          'The intent branch changed after the delivery attempt. Review the new commits before starting a new execution.',
      };
    return {
      ...next,
      status: 'pending',
      retryable: true,
      reason: 'Ready to publish the captured intent branch. Existing integrated code is preserved.',
    };
  } catch (error) {
    return { ...repo, status: 'failed', retryable: true, reason: safeError(error) };
  }
};

export const previewDelivery = async ({ meta, records, plan, operation }) => {
  await assertDeliveryComplete(meta, records, plan);
  if (meta.deliveryLeaseUntil && Date.parse(meta.deliveryLeaseUntil) > Date.now())
    throw fail(
      'delivery_in_progress',
      'Delivery is already in progress. Refresh its status; an abandoned attempt can be checked after its lease expires.',
    );
  const previous = currentDelivery(records);
  const repositories = [];
  for (const repo of previous?.repositories ?? targets(meta))
    repositories.push(await inspect(meta, repo, operation));
  const delivery = {
    ...previous,
    repositories,
    status: repositories.some((r) => r.status === 'pending')
      ? 'pending'
      : deliveryStatus(repositories),
  };
  const previewToken = createHash('sha256')
    .update(
      canonicalJson({
        meta,
        stages: records.stages,
        unitPlan: records.unitPlan,
        units: records.units,
        unitPrs: records.unitPrs,
        humanTasks: records.humanTasks,
        previous,
        repositories,
      }),
    )
    .digest('hex');
  return {
    delivery,
    previewToken,
    historical: !previous,
    retryable: repositories.some((r) => r.retryable),
    canRecord: !previous || canonicalJson(previous.repositories) !== canonicalJson(repositories),
  };
};

// Called by the orchestrator in one versioned durable step. Retry uses the same
// code with an already claimed attempt. No runtime/model/Git integration calls.
export const publishFinalDelivery = async ({
  store,
  meta,
  operation,
  applicationUrl,
  claimed = null,
  loadPlan,
}) => {
  // Re-resolve only captured methodology coordinates; this never runs stages or
  // reads a mutable graph DAG. Both initial publication and retry enter here.
  const verifyCompletion = async () => {
    try {
      const records = await store.getCompletionRecords(meta.executionId, { includeStages: true });
      const latest = records.meta;
      if (
        latest?.orchestratorRunId !== meta.orchestratorRunId ||
        latest?.projectId !== meta.projectId
      )
        throw fail('delivery_owner_changed', 'Execution ownership changed before delivery.');
      const resolved = await loadPlan(latest);
      if (!resolved?.valid || !Array.isArray(resolved.plan?.stages))
        throw fail('delivery_unverified', 'The pinned workflow cannot be verified for delivery.');
      await assertDeliveryComplete(
        { ...latest, completionPolicyVersion: meta.completionPolicyVersion },
        records,
        resolved.plan,
      );
      return records;
    } catch (error) {
      if (error.statusCode === 409) throw error;
      throw fail(
        'delivery_unverified',
        'Completion evidence could not be read. Review completion diagnostics before delivery.',
      );
    }
  };
  let delivery = claimed;
  if (!delivery) {
    const latest = await store.getExecution(meta.executionId, { consistentRead: true });
    if (latest?.orchestratorRunId !== meta.orchestratorRunId || latest?.status !== 'SUCCEEDED')
      return [];
    const previous = await store.getDelivery(meta.executionId, meta.orchestratorRunId);
    if (previous && ['succeeded', 'no_change'].includes(previous.status))
      return resultsFor(previous);
    const completionRecords = await verifyCompletion();
    delivery = await store.claimDelivery({
      meta: completionRecords.meta,
      delivery: previous ?? { repositories: targets(meta) },
      attemptId: randomUUID(),
      ifUnitPlan: completionRecords.unitPlan,
    });
  }
  // Safe to repeat after a interrupted step: load saved repository results. A
  // different/expired attempt loses before any provider mutation.
  const expectedAttemptId = delivery.attemptId;
  delivery = await store.getDelivery(meta.executionId, meta.orchestratorRunId);
  if (delivery?.attemptId !== expectedAttemptId) return [];
  if (delivery.status !== 'in_progress') return resultsFor(delivery);
  await store.saveDelivery({ delivery });
  let completionRecords;
  try {
    completionRecords = await verifyCompletion();
  } catch (error) {
    const reason =
      error.statusCode === 409
        ? error.message
        : 'Completion evidence could not be read. Review completion diagnostics before delivery.';
    delivery.repositories = delivery.repositories.map((repo) =>
      done(repo) ? repo : { ...repo, status: 'failed', retryable: false, reason },
    );
    delivery.status = deliveryStatus(delivery.repositories);
    await store.saveDelivery({ delivery, finished: true });
    return [{ eventType: 'v2.pr.failed', summary: `Final publication withheld: ${reason}` }];
  }
  const records = await store.getExecutionRecords(meta.executionId, {
    includeOutputs: false,
    consistentRead: true,
  });
  for (let i = 0; i < delivery.repositories.length; i++) {
    let repo = delivery.repositories[i];
    if (done(repo)) continue;
    repo = await inspect(meta, repo, operation);
    delivery.repositories[i] = repo;
    await store.saveDelivery({ delivery }); // pin branch and remote identity BEFORE create
    if (repo.status !== 'pending') continue;
    try {
      const cmp = await callFor(operation, meta, repo, 'compare', {
        base: repo.baseBranch,
        head: repo.branch,
      });
      if (!['ahead', 'diverged', 'identical', 'behind'].includes(cmp?.status)) {
        repo = {
          ...repo,
          status: 'failed',
          retryable: true,
          reason:
            'The branch comparison could not be verified. Check the captured branches and retry.',
        };
      } else {
        const [result] = await openIntentPrs({
          store: {
            listEvents: async () => records.events,
            listUnits: async () => records.units,
            getUnitPlan: async () => records.unitPlan,
          },
          meta: {
            ...meta,
            repos: [repo.repoId],
            branch: repo.branch,
            baseBranches: { [repo.repoId]: repo.baseBranch },
          },
          executionId: meta.executionId,
          runId: meta.orchestratorRunId,
          applicationUrl,
          comparePrBranches: async () => cmp,
          openPr: async ({ branch, baseBranch, title, body, attemptKey }) => {
            // Provider inspection may take time. Recheck completion and atomically
            // fence its plan with the active attempt immediately before creation.
            completionRecords = await verifyCompletion();
            await store.saveDelivery({ delivery, ifUnitPlan: completionRecords.unitPlan });
            let providerResult;
            try {
              providerResult = await callFor(operation, meta, repo, 'create-pr', {
                branch,
                baseBranch,
                title,
                body,
                attemptKey,
                expectedHeadSha: repo.headSha,
                allowRetarget: false,
              });
            } catch (error) {
              return { failed: true, reason: 'provider_unavailable', error: safeError(error) };
            }
            if (providerResult?.prUrl && providerResult.prNumber != null) return providerResult;
            if (providerResult?.skipped) return { skipped: true, reason: 'no_changes' };
            return {
              failed: true,
              reason: providerResult?.conflict
                ? 'unmerged_branches'
                : ['branch_changed', 'missing_base'].includes(providerResult?.reason)
                  ? providerResult.reason
                  : 'provider_rejected',
              error:
                'Review repository access, branch protection and unintegrated task branches, then retry.',
            };
          },
        });
        repo = {
          ...repo,
          status: result.pr
            ? 'succeeded'
            : result.eventType === 'v2.pr.skipped'
              ? 'no_change'
              : 'failed',
          ...(result.pr ? { pr: result.pr } : {}),
          retryable: result.eventType === 'v2.pr.failed',
          reason: result.summary,
        };
      }
    } catch (error) {
      const completionFailure = error.code?.startsWith('delivery_');
      repo = {
        ...repo,
        status: 'failed',
        retryable: !completionFailure,
        reason: completionFailure ? error.message : safeError(error),
      };
    }
    delivery.repositories[i] = repo;
    await store.saveDelivery({ delivery });
  }
  delivery.status = deliveryStatus(delivery.repositories);
  await store.saveDelivery({ delivery, finished: true });
  return resultsFor(delivery);
};
const resultsFor = (delivery) =>
  delivery.repositories.length === 0
    ? [{ eventType: 'v2.pr.skipped', summary: 'No repositories on this intent — no PR to open' }]
    : delivery.repositories.map((repo) => ({
        eventType:
          repo.status === 'succeeded'
            ? 'v2.pr.opened'
            : repo.status === 'no_change'
              ? 'v2.pr.skipped'
              : 'v2.pr.failed',
        summary: `${repo.repoId}: ${repo.reason ?? repo.status}`,
        ...(repo.pr && repo.status === 'succeeded' ? { pr: repo.pr } : {}),
      }));
