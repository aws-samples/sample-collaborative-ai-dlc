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
  let completion;
  if (meta.completionPolicyVersion >= 1 || receipt?.version >= 1) {
    // #534 committed this run's completion decision together with SUCCEEDED.
    // Trust it while it still describes the current run, plan and sections;
    // claim and creation fence META and the unit plan it names.
    if (
      receipt?.runId !== meta.orchestratorRunId ||
      !['complete', 'partial'].includes(receipt?.state) ||
      receipt?.unitPlanIdentity !== unitPlanIdentity(records.unitPlan) ||
      canonicalJson(receipt?.expectedSections) !== canonicalJson(sections)
    )
      throw fail(
        'delivery_completion_changed',
        'The plan or completion decision changed. Review completion diagnostics before delivery.',
      );
    completion = receipt;
  } else {
    // Older runs have no receipt: assess their recorded evidence once, before
    // the claim. `null` is a legacy serial run without unit work (no unit plan
    // or unit rows, and no parallel section in the plan, checked above); its
    // serial stage rows below decide.
    completion = (await assessExecutionCompletion({
      records: { ...records, meta },
      loadPlan: async () => ({ valid: true, plan }),
    })) ?? { ...unverifiedCompletion(null), state: 'complete' };
    if (!['complete', 'partial'].includes(completion.state))
      throw fail(
        completion.state === 'unknown' ? 'delivery_unverified' : 'delivery_incomplete',
        completionMessage(completion),
      );
  }
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
      // Only this run's own create request makes a closed or merged PR current.
      createdAfter: repo.createRequestedAt ?? null,
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
          reason: `This run's pull request is ${pr.state === 'merged' ? 'merged' : 'closed'}. Review it in the provider; retry will not recreate closed work.`,
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
    // The claim records which unit plan this completion check covered.
    unitPlanIdentity: unitPlanIdentity(records.unitPlan),
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

// A cancelled pre-create fence means ownership or the unit plan changed; a
// retry of this run would be refused, so the reason must not offer one.
const withheldReason = (error) =>
  ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)
    ? 'Execution ownership or the unit plan changed before the pull request was created. Review completion diagnostics; publication was withheld.'
    : null;

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
  // One consistent read serves the completion check, the claim fence and the
  // PR body. Only captured methodology coordinates are re-resolved; this never
  // runs stages or reads a mutable graph DAG.
  const readRecords = () =>
    store.getExecutionRecords(meta.executionId, { includeOutputs: false, consistentRead: true });
  let delivery = claimed;
  let records = null;
  if (!delivery) {
    const latest = await store.getExecution(meta.executionId, { consistentRead: true });
    if (latest?.orchestratorRunId !== meta.orchestratorRunId || latest?.status !== 'SUCCEEDED')
      return [];
    const previous = await store.getDelivery(meta.executionId, meta.orchestratorRunId);
    if (previous && ['succeeded', 'no_change'].includes(previous.status))
      return resultsFor(previous);
    records = await readRecords();
    if (
      records.meta?.orchestratorRunId !== meta.orchestratorRunId ||
      records.meta?.projectId !== meta.projectId
    )
      throw fail('delivery_owner_changed', 'Execution ownership changed before delivery.');
    const resolved = await loadPlan(records.meta);
    if (!resolved?.valid || !Array.isArray(resolved.plan?.stages))
      throw fail('delivery_unverified', 'The pinned workflow cannot be verified for delivery.');
    // The only completion check of initial publication. Retry performs it in
    // its preview; the claim fences the META revision and unit plan it read.
    await assertDeliveryComplete(
      { ...records.meta, completionPolicyVersion: meta.completionPolicyVersion },
      records,
      resolved.plan,
    );
    delivery = await store.claimDelivery({
      meta: records.meta,
      delivery: {
        ...(previous ?? { repositories: targets(meta) }),
        unitPlanIdentity: unitPlanIdentity(records.unitPlan),
      },
      attemptId: randomUUID(),
      ifUnitPlan: records.unitPlan,
    });
  }
  // Safe to repeat after a interrupted step: load saved repository results. A
  // different/expired attempt loses before any provider mutation.
  const expectedAttemptId = delivery.attemptId;
  delivery = await store.getDelivery(meta.executionId, meta.orchestratorRunId);
  if (delivery?.attemptId !== expectedAttemptId) return [];
  if (delivery.status !== 'in_progress') return resultsFor(delivery);
  await store.saveDelivery({ delivery });
  const withhold = async (reason, retryable = false) => {
    delivery.repositories = delivery.repositories.map((repo) =>
      done(repo) ? repo : { ...repo, status: 'failed', retryable, reason },
    );
    delivery.status = deliveryStatus(delivery.repositories);
    await store.saveDelivery({ delivery, finished: true });
    return [{ eventType: 'v2.pr.failed', summary: `Final publication withheld: ${reason}` }];
  };
  if (!records) {
    try {
      records = await readRecords();
    } catch {
      return withhold(
        'Execution records could not be read. Retry delivery; existing pull requests will be checked first.',
        true,
      );
    }
    if (unitPlanIdentity(records.unitPlan) !== delivery.unitPlanIdentity)
      return withhold(
        'The unit plan changed after delivery was checked. Review completion diagnostics before delivery.',
      );
  }
  for (let i = 0; i < delivery.repositories.length; i++) {
    let repo = delivery.repositories[i];
    if (done(repo)) continue;
    repo = await inspect(meta, repo, operation);
    delivery.repositories[i] = repo;
    await store.saveDelivery({ delivery }); // pin branch and remote identity BEFORE create
    if (repo.status !== 'pending') continue;
    let withheld = null;
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
            // Record the create request and fence ownership and the unit plan
            // atomically with it, immediately before the provider mutation. A
            // later check accepts a closed or merged PR only after this marker.
            const requested = {
              ...repo,
              createRequestedAt: repo.createRequestedAt ?? new Date().toISOString(),
            };
            delivery.repositories[i] = requested;
            try {
              await store.saveDelivery({ delivery, ifUnitPlan: records.unitPlan });
            } catch (error) {
              delivery.repositories[i] = repo;
              withheld = withheldReason(error);
              return withheld
                ? { failed: true, reason: 'withheld', error: withheld }
                : {
                    failed: true,
                    reason: 'delivery_record_unavailable',
                    error:
                      'The delivery record could not be saved. Retry delivery; existing pull requests will be checked first.',
                  };
            }
            repo = requested;
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
        if (withheld) {
          delivery.repositories[i] = repo;
          return withhold(withheld);
        }
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
      repo = { ...repo, status: 'failed', retryable: true, reason: safeError(error) };
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
