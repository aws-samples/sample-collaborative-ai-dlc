import { describe, expect, it, vi } from 'vitest';
import { createWorkflowSourcesHandler } from '../handler.js';
import { createWorkflowPackageJobsService, nativePackageJobView } from '../package-jobs.js';
import { NativePackageJobError } from '../../shared/native-package-jobs.js';
import { WorkflowSourceError } from '../../shared/workflow-source-bindings.js';

const projectId = 'project-one';
const actorId = 'human-sub';
const sourceId = 'a'.repeat(64);
const jobId = '22222222-2222-4222-8222-222222222222';
const bindingRevision = '11111111-1111-4111-8111-111111111111';
const secret = 'private-authority-and-error-data';
const collection = '/api/projects/{projectId}/workflow-sources/{sourceId}/packages';
const input = { projectId, actorId, sourceId, jobId, expectedRevision: bindingRevision };
const job = () => ({
  projectId,
  actorId,
  sourceId,
  jobId,
  bindingRevision,
  requestedRelease: 'latest',
  state: 'QUEUED',
  createdAt: 10,
  updatedAt: 10,
  leaseToken: secret,
  credentialRef: secret,
});
const request = (method = 'POST', overrides = {}) => ({
  resource: `${collection}${method === 'GET' ? '/{jobId}' : ''}`,
  httpMethod: method,
  path: `/api/projects/${projectId}/workflow-sources/${sourceId}/packages${method === 'GET' ? `/${jobId}` : ''}`,
  pathParameters: { projectId, sourceId, ...(method === 'GET' ? { jobId } : {}) },
  requestContext: { authorizer: { claims: { sub: actorId } } },
  ...(method === 'POST'
    ? { body: JSON.stringify({ jobId, expectedRevision: bindingRevision }) }
    : {}),
  ...overrides,
});
const setup = (options = {}) => {
  const jobs = {
    create: vi.fn(async () => job()),
    get: vi.fn(async () => job()),
  };
  const sources = {
    getAuthorizedBinding: vi.fn(async () => ({ credentialRef: secret })),
    list: vi.fn(async () => []),
    configure: vi.fn(),
    remove: vi.fn(),
  };
  const service = createWorkflowPackageJobsService({ jobs, workflowSources: sources });
  const handle = createWorkflowSourcesHandler({
    service: sources,
    packageJobs: service,
    enabled: true,
    packageJobsEnabled: true,
    ...options,
  });
  return { jobs, sources, service, handle };
};
describe('native package job HTTP authorization', () => {
  it('records only the authenticated identity and returns an allowlisted status', async () => {
    const f = setup();
    const result = await f.handle(request('POST', { actorId: 'forged', token: secret }));
    expect(result.statusCode).toBe(202);
    expect(f.jobs.create).toHaveBeenCalledExactlyOnceWith({
      projectId,
      actorId,
      sourceId,
      jobId,
      bindingRevision,
      requestedRelease: 'latest',
    });
    expect(f.sources.getAuthorizedBinding).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.body)).toEqual({
      jobId,
      sourceId,
      requestedRelease: 'latest',
      state: 'QUEUED',
      createdAt: 10,
      updatedAt: 10,
    });
    expect(result.body).not.toContain(secret);
  });
  it('does not report success after source access is revoked during enqueue', async () => {
    const f = setup();
    f.sources.getAuthorizedBinding
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', secret));
    const result = await f.handle(request());
    expect(result.statusCode).toBe(403);
    expect(f.jobs.create).toHaveBeenCalledOnce();
    expect(result.body).not.toContain(secret);
  });
  it('denies enqueue before storage when membership or revision is invalid', async () => {
    const f = setup();
    f.sources.getAuthorizedBinding.mockRejectedValue(
      new WorkflowSourceError('WORKFLOW_SOURCE_CONFLICT', secret),
    );
    expect((await f.handle(request())).statusCode).toBe(409);
    expect(f.jobs.create).not.toHaveBeenCalled();
  });
  it('allows current members to view another member’s job after current source authorization', async () => {
    const f = setup();
    f.jobs.get.mockResolvedValue({ ...job(), actorId: 'another-member' });
    expect((await f.handle(request('GET'))).statusCode).toBe(200);
    expect(f.sources.list).toHaveBeenCalledExactlyOnceWith({ projectId, actorId });
    expect(f.sources.getAuthorizedBinding).toHaveBeenCalledExactlyOnceWith({
      projectId,
      actorId,
      sourceId,
      expectedRevision: bindingRevision,
    });
  });
  it('does not read job data before membership is established', async () => {
    const f = setup();
    f.sources.list.mockRejectedValue(new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', secret));
    expect((await f.handle(request('GET'))).statusCode).toBe(403);
    expect(f.jobs.get).not.toHaveBeenCalled();
  });
  it.each([null, { ...job(), sourceId: 'b'.repeat(64) }])(
    'does not disclose jobs through another source',
    async (row) => {
      const f = setup();
      f.jobs.get.mockResolvedValue(row);
      const result = await f.handle(request('GET'));
      expect(result.statusCode).toBe(404);
      expect(f.sources.getAuthorizedBinding).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, false, 'true', 1])(
    'requires the separate boolean feature flag: %s',
    async (flag) => {
      const f = setup({ packageJobsEnabled: flag });
      const result = await f.handle(request());
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).code).toBe('NATIVE_PACKAGE_JOBS_DISABLED');
      expect(f.jobs.create).not.toHaveBeenCalled();
      expect(f.sources.getAuthorizedBinding).not.toHaveBeenCalled();
    },
  );
  it.each([
    { actorId },
    { candidate: {} },
    { archiveReceipt: {} },
    { sourceId },
    { operation: 'start' },
    { expectedRevision: null },
    { requestedRelease: 'main' },
    { requestedRelease: 'latest\n' },
    { requestedRelease: 'v01.2.3' },
    { requestedRelease: null },
    { jobId: '../escape' },
  ])('rejects authority claims and malformed selections: %j', async (change) => {
    const f = setup();
    const result = await f.handle(
      request('POST', {
        body: JSON.stringify({ jobId, expectedRevision: bindingRevision, ...change }),
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(f.jobs.create).not.toHaveBeenCalled();
  });
  it.each(['latest', 'v2.9.0', 'v2.10.0-preview.20260918.1'])(
    'accepts a source-local supported selection %s',
    async (requestedRelease) => {
      const f = setup();
      expect(
        (
          await f.handle(
            request('POST', {
              body: JSON.stringify({ jobId, expectedRevision: bindingRevision, requestedRelease }),
            }),
          )
        ).statusCode,
      ).toBe(202);
      expect(f.jobs.create).toHaveBeenCalledWith(expect.objectContaining({ requestedRelease }));
    },
  );
  it.each([
    ['native_package_job_conflict', 409],
    ['native_package_job_unavailable', 503],
    ['unrecognized', 500],
  ])('sanitizes store errors %s', async (code, status) => {
    const f = setup();
    f.jobs.create.mockRejectedValue(
      Object.assign(new NativePackageJobError(code), { code, message: secret }),
    );
    const result = await f.handle(request());
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain(secret);
  });
  it('rejects mismatched job paths and extra GET payload claims', async () => {
    const f = setup();
    for (const extra of [
      { path: '/api/projects/another/workflow-sources/other/packages/job' },
      { body: '{}' },
      { queryStringParameters: { actorId } },
      { pathParameters: { projectId, sourceId, jobId, actorId } },
      { requestContext: {} },
    ]) {
      expect((await f.handle(request('GET', extra))).statusCode).toBe(
        extra.requestContext ? 401 : 400,
      );
    }
    expect(f.jobs.get).not.toHaveBeenCalled();
  });
});

describe('package status public view', () => {
  it('never reflects internal failure text or authority records', () => {
    const view = nativePackageJobView({ ...job(), state: 'FAILED', error: secret, code: secret });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.error).toContain('Package import failed');
  });
  it('does not equate byte verification with signature or harness qualification', () => {
    const packagePin = {
      schemaVersion: 1,
      source: {
        provider: 'github',
        repository: 'example/private-workflows',
        release: 'v2.9.0',
        commit: 'f'.repeat(40),
      },
      target: 'linux-arm64',
      version: '2.9.0',
      manifestSha256: 'a'.repeat(64),
      checksumsSha256: 'b'.repeat(64),
      assets: {
        binary: { name: 'aidlc-linux-arm64', sha256: 'c'.repeat(64), bytes: 17 },
        runtime: { name: 'aidlc-runtime-2.9.0.tar.gz', sha256: 'd'.repeat(64), bytes: 55 },
      },
      harnesses: ['claude', 'codex', 'kiro', 'opencode'],
      packageId: 'sha256:5e9b57d096ffe74b040151415a94d916ee178bec727e3f6f63b4a85c62c5971a',
      verification: { harnessExecution: 'verified' },
      inventory: secret,
    };
    const view = nativePackageJobView({
      ...job(),
      state: 'SUCCEEDED',
      archiveReceipt: secret,
      candidate: { packagePin, attestation: null },
    });
    expect(view.package).toMatchObject({
      version: '2.9.0',
      integrity: 'verified',
      signature: 'not_checked',
      execution: 'not_qualified',
    });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.package).not.toHaveProperty('verification');
  });
  it('passes the same idempotency key through to the durable store on response retries', async () => {
    const f = setup();
    await f.service.create(input);
    await f.service.create(input);
    expect(f.jobs.create.mock.calls[0]).toEqual(f.jobs.create.mock.calls[1]);
  });
});
