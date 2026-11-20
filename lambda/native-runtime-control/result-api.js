import {
  nativeResultRequest,
  nativePreparedGit,
  resultFailure,
  resultJobMatches,
  RESULT_LEASE_MS,
} from './result-store.js';
import { resultEligibleFiles, assertArchivePaths } from './result-archive.js';
import { nativeGitResultTarget } from './git-result.js';
import { nativeRevisionGitProof } from './revision-api.js';

// No execution/image/projector operation. The caller supplies current entity
// authorization before and after every read and immediately before URL delivery.
export const createNativeResultApi = ({
  read,
  revisions,
  jobs,
  storage,
  enqueue,
  completionProof,
  observeBranch,
  now = Date.now,
}) => {
  const locate = async (draft, input, recheck) => {
    const request = nativeResultRequest(input);
    const row = await read(draft, recheck);
    if (!row?.publication) throw resultFailure('INVALID');
    if (request.format === 'git') {
      const located = await revisions.source(row, request);
      const target = nativeGitResultTarget(row, located);
      const verification = await nativeRevisionGitProof({ row, ...located, completionProof });
      return {
        row,
        request,
        delivery: {
          ...target,
          sourceBaselineId: located.baseline.receipt.id,
          publicationOutcome: located.manifest.outcome,
          verification,
          changeCount: located.baseline.changes.length,
        },
      };
    }
    const located = await revisions.publication(row, request);
    const files = resultEligibleFiles(located.manifest, request);
    if (!request.fileId) assertArchivePaths(files);
    return { row, request };
  };
  const finish = async (draft, row, recheck) => {
    const current = await read(draft, recheck);
    if (
      current?.bindingId !== row.bindingId ||
      current?.attemptId !== row.attemptId ||
      current?.configurationSha256 !== row.configurationSha256
    )
      throw resultFailure('CONFLICT');
  };
  const view = async (row, job, delivery) => {
    let download;
    if (delivery && (job.preparedGit || job.status === 'ready')) {
      const git = nativePreparedGit(job.preparedGit);
      if (
        git.base !== delivery.repository.commit ||
        git.branch !== delivery.branch ||
        git.deltaSha256 !== delivery.deltaSha256
      )
        throw resultFailure('CONFLICT');
      delivery = { ...delivery, commit: git.commit, tree: git.tree };
    }
    if (job.status === 'ready') {
      try {
        download = await storage.download(job);
      } catch {
        /* Never issue an unverified URL. */
      }
    }
    return {
      projectId: row.scope.projectId,
      executionId: row.scope.executionId,
      ...job.request,
      status:
        (job.status === 'building' && job.leaseUntil <= now()) ||
        (job.status === 'ready' && !download)
          ? 'retryable'
          : job.status,
      updatedAt: new Date(job.updatedAt).toISOString(),
      retryAfterSeconds: 3,
      ...(download ? { download } : {}),
      ...(delivery ? { delivery } : {}),
    };
  };
  return {
    async requestResult(draft, input, recheck) {
      const { row, request, delivery } = await locate(draft, input, recheck);
      await finish(draft, row, recheck);
      let job = await jobs.request(row, request);
      let result = await view(row, job, delivery);
      if (
        (job.status === 'ready' && result.status === 'retryable') ||
        job.status === 'failed' ||
        (job.status === 'building' && job.leaseUntil <= now())
      ) {
        await finish(draft, row, recheck);
        job = await jobs.rebuild(job);
        result = await view(row, job, delivery);
      }
      if (job.status !== 'ready' && !(job.status === 'building' && job.leaseUntil > now()))
        await enqueue({ ...row.scope, requestId: request.requestId }, request.format);
      await finish(draft, row, recheck);
      return result;
    },
    async result(draft, input, recheck, actorId) {
      const { observe, ...named } = input;
      const { row, request, delivery } = await locate(draft, named, recheck);
      const job = await jobs.get(row.scope, request.requestId);
      if (!resultJobMatches(job, row, request)) throw resultFailure('INVALID');
      const result = await view(row, job, delivery);
      if (observe && result.delivery?.commit) {
        await finish(draft, row, recheck);
        const { commit, branch } = result.delivery;
        let observation = { status: 'unavailable' };
        try {
          const head = await observeBranch({ row, actorId, branch });
          observation =
            head === null
              ? { status: 'absent' }
              : { status: head === commit ? 'matched' : 'different', commit: head };
        } catch {
          /* Preserve the prepared result on a provider/access failure. */
        }
        result.delivery.observation = observation;
      }
      // Pending async delivery can be safely requested again after its queue age.
      if (job.status === 'pending' && now() - job.updatedAt > RESULT_LEASE_MS)
        result.status = 'retryable';
      await finish(draft, row, recheck);
      return result;
    },
  };
};
