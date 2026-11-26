// The HTTP facade returns a small status view, never the worker's authority,
// candidate inventory, storage receipt, credentials, or diagnostic messages.
import { NativePackageJobError } from '../shared/native-package-jobs.js';
import { describeNativePackagePin } from '../shared/native-package-pin.js';

export const nativePackageJobView = (job) => {
  const view = {
    jobId: job.jobId,
    sourceId: job.sourceId,
    requestedRelease: job.requestedRelease,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.state === 'FAILED') {
    view.error =
      'Package import failed. Start a new import after checking source access and release files.';
  }
  if (job.state === 'SUCCEEDED') {
    const pin = describeNativePackagePin(job.candidate.packagePin, job.candidate.attestation);
    view.package = {
      packageId: pin.packageId,
      materializationId: pin.materializationId,
      version: pin.identity.version,
      release: pin.identity.source.release,
      commit: pin.identity.source.commit,
      harnesses: pin.identity.harnesses,
      integrity: 'verified',
      signature: 'not_checked',
      execution: 'not_qualified',
    };
  }
  return view;
};

export const createWorkflowPackageJobsService = ({ jobs, workflowSources }) =>
  Object.freeze({
    async create({ projectId, actorId, sourceId, jobId, expectedRevision, requestedRelease }) {
      const scope = { projectId, actorId, sourceId, expectedRevision };
      await workflowSources.getAuthorizedBinding(scope);
      const job = await jobs.create({
        projectId,
        actorId,
        sourceId,
        jobId,
        bindingRevision: expectedRevision,
        requestedRelease: requestedRelease ?? 'latest',
      });
      // A committed job may outlive a lost HTTP response. Retrying with the
      // same jobId is safe; workers independently recheck source access.
      await workflowSources.getAuthorizedBinding(scope);
      return nativePackageJobView(job);
    },
    async get({ projectId, actorId, sourceId, jobId }) {
      // Establish current membership even for an unknown job/source pairing.
      await workflowSources.list({ projectId, actorId });
      const job = await jobs.get({ projectId, jobId });
      if (!job || job.sourceId !== sourceId) {
        throw new NativePackageJobError('native_package_job_not_found');
      }
      await workflowSources.getAuthorizedBinding({
        projectId,
        actorId,
        sourceId,
        expectedRevision: job.bindingRevision,
      });
      return nativePackageJobView(job);
    },
  });
