import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowPackageImportContext,
  WorkflowPackageImportRequest,
  WorkflowPackageJob,
  WorkflowSource,
  WorkflowSourceSelection,
} from './workflowSources';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('./api', () => ({ api: mocks }));

import {
  isNativePackageJobsDisabled,
  isWorkflowPackageRelease,
  isWorkflowSourceApiDisabled,
  workflowPackageImportRecovery,
  workflowSourcesService,
} from './workflowSources';

const source: WorkflowSource = {
  sourceId: 'source-id',
  provider: 'github',
  repository: 'team/workflows',
  revision: 'observed-revision',
  status: 'active',
  authType: 'public',
  access: 'read',
};

describe('workflow source HTTP contract', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads the direct list response and encodes the project path', async () => {
    mocks.get.mockResolvedValue([source]);

    await expect(workflowSourcesService.list('space/one')).resolves.toEqual([source]);
    expect(mocks.get).toHaveBeenCalledWith('/projects/space%2Fone/workflow-sources');
  });

  it('keeps array-only callers compatible with the capability envelope', async () => {
    mocks.get.mockResolvedValue({
      sources: [source],
      capabilities: { packageImportsEnabled: true },
    });
    await expect(workflowSourcesService.list('space')).resolves.toEqual([source]);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/projects/space/workflow-sources');
  });

  it('reads sources and explicit package enablement in a single request', async () => {
    mocks.get.mockResolvedValue({
      sources: [source],
      capabilities: { packageImportsEnabled: true, privateConfiguration: 'discard' },
      internalData: 'discard',
    });
    await expect(workflowSourcesService.listWithCapabilities('space/one')).resolves.toEqual({
      sources: [source],
      capabilities: { packageImportsEnabled: true },
    });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/projects/space%2Fone/workflow-sources');
  });

  it.each([
    ['legacy array', [source]],
    ['missing capabilities', { sources: [source] }],
    ['null capabilities', { sources: [source], capabilities: null }],
    ['invalid capabilities', { sources: [source], capabilities: 'enabled' }],
    ['unknown capability', { sources: [source], capabilities: { otherCapability: true } }],
    ['disabled', { sources: [source], capabilities: { packageImportsEnabled: false } }],
    ['string true', { sources: [source], capabilities: { packageImportsEnabled: 'true' } }],
    ['number true', { sources: [source], capabilities: { packageImportsEnabled: 1 } }],
  ])('keeps sources usable with imports closed for %s', async (_name, response) => {
    mocks.get.mockResolvedValue(response);
    await expect(workflowSourcesService.listWithCapabilities('space')).resolves.toEqual({
      sources: [source],
      capabilities: { packageImportsEnabled: false },
    });
  });

  it.each([
    null,
    {},
    { sources: null },
    { sources: {}, capabilities: { packageImportsEnabled: true } },
  ])('rejects an unreadable source list: %j', async (response) => {
    mocks.get.mockResolvedValue(response);
    await expect(workflowSourcesService.listWithCapabilities('space')).rejects.toThrow(
      'Could not read workflow sources.',
    );
  });

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'preserves the selected %s source and explicit create revision without sending credentials',
    async (provider) => {
      mocks.post.mockResolvedValue(source);
      // Values from a wider form must not escape the HTTP allowlist.
      const selection = {
        provider,
        repository: 'team/workflows',
        authType: `${provider}-oauth`,
        confirmDelegation: true,
        expectedRevision: null,
        actorId: 'forged-user',
        credentialRef: { token: 'must-stay-local' },
      } as WorkflowSourceSelection;

      await expect(workflowSourcesService.configure('space', selection)).resolves.toEqual(source);
      expect(mocks.post).toHaveBeenCalledWith('/projects/space/workflow-sources', {
        provider,
        repository: 'team/workflows',
        authType: `${provider}-oauth`,
        confirmDelegation: true,
        expectedRevision: null,
      });
    },
  );

  it('reverifies exactly the revision the user saw', async () => {
    await workflowSourcesService.configure('space', {
      provider: source.provider,
      repository: source.repository,
      authType: source.authType,
      expectedRevision: source.revision,
    });
    expect(mocks.post).toHaveBeenCalledWith('/projects/space/workflow-sources', {
      provider: 'github',
      repository: 'team/workflows',
      authType: 'public',
      expectedRevision: 'observed-revision',
    });
  });

  it('deletes with an encoded source path and a conditional revision body', async () => {
    await workflowSourcesService.remove('space', { sourceId: 'a/b', revision: source.revision });
    expect(mocks.delete).toHaveBeenCalledWith('/projects/space/workflow-sources/a%2Fb', {
      expectedRevision: 'observed-revision',
    });
  });

  it('does not retry a concurrent update with a newer revision', async () => {
    const conflict = Object.assign(new Error('Source changed; reload.'), { status: 409 });
    mocks.post.mockRejectedValue(conflict);
    await expect(
      workflowSourcesService.configure('space', {
        provider: 'github',
        repository: 'team/workflows',
        authType: 'public',
        expectedRevision: 'stale',
      }),
    ).rejects.toBe(conflict);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('hides configuration only for the explicit disabled-service response', () => {
    expect(
      isWorkflowSourceApiDisabled({
        status: 503,
        body: { code: 'WORKFLOW_SOURCE_API_DISABLED' },
      }),
    ).toBe(true);
    for (const error of [
      null,
      'offline',
      new Error('offline'),
      { status: 503 },
      { status: 503, body: { code: 'UPSTREAM_UNAVAILABLE' } },
      { status: 403, body: { code: 'WORKFLOW_SOURCE_API_DISABLED' } },
    ]) {
      expect(isWorkflowSourceApiDisabled(error)).toBe(false);
    }
  });
});

describe('workflow package import session recovery', () => {
  const context: WorkflowPackageImportContext = {
    userId: 'member-one',
    projectId: 'project-one',
    sourceId: 'a'.repeat(64),
    revision: '11111111-1111-4111-8111-111111111111',
  };
  const request = {
    jobId: '22222222-2222-4222-8222-222222222222',
    expectedRevision: context.revision,
    requestedRelease: 'latest',
  };
  let entries: Map<string, string>;
  beforeEach(() => {
    entries = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => entries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => entries.set(key, value)),
      removeItem: vi.fn((key: string) => entries.delete(key)),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retains only the immutable nonsecret request and validated user/source context', () => {
    const widerContext = { ...context, token: 'private-token' };
    const widerRequest = {
      ...request,
      credentialRef: 'private-token',
      package: { localPath: '/tmp/private' },
    };
    expect(workflowPackageImportRecovery.save(widerContext, widerRequest)).toBe(true);
    expect(entries.size).toBe(1);
    expect([...entries.values()][0]).not.toMatch(/private-token|\/tmp\/private/);
    expect(workflowPackageImportRecovery.read(context)).toEqual(request);
  });

  it.each([
    { userId: 'other-member' },
    { projectId: 'other-project' },
    { sourceId: 'b'.repeat(64) },
    { revision: '33333333-3333-4333-8333-333333333333' },
  ])('does not restore a request for a changed scope: %j', (change) => {
    workflowPackageImportRecovery.save(context, request);
    expect(workflowPackageImportRecovery.read({ ...context, ...change })).toBeNull();
    expect(workflowPackageImportRecovery.read(context)).toEqual(request);
  });

  it.each([
    { userId: 'other-member' },
    { projectId: 'other-project' },
    { sourceId: 'b'.repeat(64) },
    { revision: '33333333-3333-4333-8333-333333333333' },
  ])('validates the stored scope as well as its storage key: %j', (change) => {
    workflowPackageImportRecovery.save(context, request);
    const key = [...entries.keys()][0]!;
    entries.set(
      key,
      JSON.stringify({ schemaVersion: 1, context: { ...context, ...change }, request }),
    );
    expect(workflowPackageImportRecovery.read(context)).toBeNull();
  });

  it.each([
    { jobId: 'not-a-uuid' },
    { expectedRevision: '33333333-3333-4333-8333-333333333333' },
    { requestedRelease: '/tmp/private-token' },
    { requestedRelease: 'latest\n' },
  ])('rejects invalid persisted requests and refuses to save them: %j', (change) => {
    workflowPackageImportRecovery.save(context, request);
    const key = [...entries.keys()][0]!;
    entries.set(
      key,
      JSON.stringify({ schemaVersion: 1, context, request: { ...request, ...change } }),
    );
    expect(workflowPackageImportRecovery.read(context)).toBeNull();
    expect(workflowPackageImportRecovery.save(context, { ...request, ...change })).toBe(false);
  });

  it.each(['{', 'null', '[]', JSON.stringify({ schemaVersion: 2 }), 'x'.repeat(2049)])(
    'ignores malformed or unsupported session data',
    (raw) => {
      workflowPackageImportRecovery.save(context, request);
      entries.set([...entries.keys()][0]!, raw);
      expect(workflowPackageImportRecovery.read(context)).toBeNull();
    },
  );

  it('clears only the exact scope when the user deliberately chooses a new import', () => {
    const otherContext = { ...context, userId: 'other-member' };
    workflowPackageImportRecovery.save(context, request);
    workflowPackageImportRecovery.save(otherContext, request);
    expect(workflowPackageImportRecovery.clear(context)).toBe(true);
    expect(workflowPackageImportRecovery.read(context)).toBeNull();
    expect(workflowPackageImportRecovery.read(otherContext)).toEqual(request);
  });

  it('does not expose storage errors or claim that an unretained request is safe to submit', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('private-token');
      },
      setItem: () => {
        throw new Error('private-token');
      },
      removeItem: () => {
        throw new Error('private-token');
      },
    });
    expect(workflowPackageImportRecovery.read(context)).toBeNull();
    expect(workflowPackageImportRecovery.save(context, request)).toBe(false);
    expect(workflowPackageImportRecovery.clear(context)).toBe(false);
  });

  it('refuses storage with invalid authenticated context', () => {
    for (const change of [
      { userId: '' },
      { projectId: '../private' },
      { sourceId: 'unknown-source' },
      { revision: 'unknown-revision' },
    ]) {
      const invalidContext = { ...context, ...change };
      expect(workflowPackageImportRecovery.read(invalidContext)).toBeNull();
      expect(workflowPackageImportRecovery.save(invalidContext, request)).toBe(false);
      expect(workflowPackageImportRecovery.clear(invalidContext)).toBe(false);
    }
    expect(entries.size).toBe(0);
  });
});

const importRequest: WorkflowPackageImportRequest = {
  jobId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: '11111111-1111-4111-8111-111111111111',
  requestedRelease: 'latest',
};
const queued: WorkflowPackageJob = {
  jobId: importRequest.jobId,
  sourceId: source.sourceId,
  requestedRelease: 'latest',
  createdAt: 10,
  updatedAt: 20,
  state: 'QUEUED',
};
const succeeded: WorkflowPackageJob = {
  ...queued,
  state: 'SUCCEEDED',
  package: {
    packageId: `sha256:${'a'.repeat(64)}`,
    materializationId: `sha256:${'b'.repeat(64)}`,
    version: '2.9.0',
    release: 'v2.9.0',
    commit: 'c'.repeat(40),
    harnesses: ['claude', 'codex', 'kiro', 'opencode'],
    integrity: 'verified',
    signature: 'not_checked',
    execution: 'not_qualified',
  },
};

describe('workflow package import HTTP contract', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['latest', 'v2.9.0', 'v2.10.0-preview.20260918.1'])(
    'submits exactly the caller’s immutable request for %s',
    async (requestedRelease) => {
      const request = {
        ...importRequest,
        requestedRelease,
        actorId: 'forged',
        credentialRef: 'private-token',
        package: { localPath: '/tmp/private-package' },
      };
      mocks.post.mockResolvedValue({ ...queued, sourceId: 'source/one', requestedRelease });

      await expect(
        workflowSourcesService.createPackageImport('space/one', 'source/one', request),
      ).resolves.toEqual({ ...queued, sourceId: 'source/one', requestedRelease });
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
        '/projects/space%2Fone/workflow-sources/source%2Fone/packages',
        { ...importRequest, requestedRelease },
      );
    },
  );

  it('encodes the GET job path and never sends a new release or request body', async () => {
    mocks.get.mockResolvedValue({ ...queued, sourceId: 's/1', jobId: 'job/one' });
    await expect(workflowSourcesService.getPackageImport('p/1', 's/1', 'job/one')).resolves.toEqual(
      { ...queued, sourceId: 's/1', jobId: 'job/one' },
    );
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      '/projects/p%2F1/workflow-sources/s%2F1/packages/job%2Fone',
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('keeps the same UUID and body after a lost response without resolving latest again', async () => {
    mocks.post.mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(queued);
    await expect(
      workflowSourcesService.createPackageImport('p1', source.sourceId, importRequest),
    ).rejects.toThrow('Response lost');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
    await workflowSourcesService.createPackageImport('p1', source.sourceId, importRequest);
    expect(mocks.post.mock.calls[0]).toEqual(mocks.post.mock.calls[1]);
  });

  it.each(['QUEUED', 'RUNNING', 'FAILED'] as const)(
    'projects only safe status fields for %s',
    async (state) => {
      mocks.get.mockResolvedValue({
        ...queued,
        state,
        error: '/tmp/private-path token=private-token',
        credentialRef: 'private-token',
        actorId: 'private-user',
        package: { inventory: 'private contents' },
      });
      await expect(
        workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
      ).resolves.toEqual({ ...queued, state });
    },
  );

  it('returns the safe preview for all four harnesses without internal data', async () => {
    mocks.get.mockResolvedValue({
      ...succeeded,
      error: 'private-token',
      candidate: { inventory: 'private files' },
      archiveReceipt: 'private-storage',
      package: { ...succeeded.package, localPath: '/tmp/private', signatureDetails: 'private' },
    });
    await expect(
      workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
    ).resolves.toEqual(succeeded);
  });

  it('accepts an explicitly requested preview without broadening latest to previews', async () => {
    const version = '2.10.0-preview.20260918.1';
    const result = {
      ...succeeded,
      requestedRelease: `v${version}`,
      package: { ...succeeded.package, version, release: `v${version}` },
    };
    mocks.get
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ ...result, requestedRelease: 'latest' });
    await expect(
      workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
    ).resolves.toEqual(result);
    await expect(
      workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
    ).rejects.toThrow('Could not read package import status.');
  });

  it.each([
    { jobId: 'different-job' },
    { sourceId: 'different-source' },
    { requestedRelease: '/tmp/private-token' },
    { state: 'PRIVATE_DIAGNOSTIC' },
    { createdAt: 'private-token' },
    { updatedAt: 5 },
    { state: 'SUCCEEDED' },
  ])('rejects a malformed or mismatched status: %j', async (change) => {
    mocks.get.mockResolvedValue({ ...queued, ...change });
    await expect(
      workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
    ).rejects.toThrow('Could not read package import status.');
  });

  it.each([
    { version: '/tmp/private-token' },
    { release: 'v2.8.0' },
    { commit: '/tmp/private-token' },
    { packageId: '/tmp/private-token' },
    { materializationId: '/tmp/private-token' },
    { harnesses: ['private-token'] },
    { harnesses: ['codex', 'codex', 'codex', 'codex'] },
    { integrity: 'not_verified' },
    { signature: 'verified' },
    { execution: 'qualified' },
  ])('rejects unsafe or overstated package preview values: %j', async (change) => {
    mocks.get.mockResolvedValue({
      ...succeeded,
      package: { ...succeeded.package, ...change },
    });
    await expect(
      workflowSourcesService.getPackageImport('p1', source.sourceId, importRequest.jobId),
    ).rejects.toThrow('Could not read package import status.');
  });

  it('rejects a submission response for another selection and does not retry it', async () => {
    mocks.post.mockResolvedValue({ ...queued, requestedRelease: 'v2.9.0' });
    await expect(
      workflowSourcesService.createPackageImport('p1', source.sourceId, importRequest),
    ).rejects.toThrow('Could not read package import status.');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('leaves revision conflicts intact for the UI without rereading or resubmitting', async () => {
    const conflict = { status: 409, body: { code: 'WORKFLOW_SOURCE_CONFLICT' } };
    mocks.post.mockRejectedValue(conflict);
    await expect(
      workflowSourcesService.createPackageImport('p1', source.sourceId, importRequest),
    ).rejects.toBe(conflict);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('recognizes the independent imports-disabled flag without disabling source administration', () => {
    const disabled = { status: 503, body: { code: 'NATIVE_PACKAGE_JOBS_DISABLED' } };
    expect(isNativePackageJobsDisabled(disabled)).toBe(true);
    expect(isWorkflowSourceApiDisabled(disabled)).toBe(false);
    for (const error of [
      null,
      new Error('NATIVE_PACKAGE_JOBS_DISABLED'),
      { status: 503 },
      { status: 503, body: { code: 'WORKFLOW_SOURCE_API_DISABLED' } },
      { status: 503, body: { code: 'UPSTREAM_UNAVAILABLE' } },
      { status: 403, body: { code: 'NATIVE_PACKAGE_JOBS_DISABLED' } },
    ]) {
      expect(isNativePackageJobsDisabled(error)).toBe(false);
    }
  });

  it.each(['latest', 'v0.0.0', 'v2.9.0', 'v2.10.0-preview.20260918.1'])(
    'accepts supported release input %s',
    (value) => expect(isWorkflowPackageRelease(value)).toBe(true),
  );

  it.each([
    null,
    '',
    'main',
    '2.9.0',
    'v01.2.3',
    'latest\n',
    'v2.9.0\n',
    'v2.9.0-beta.1',
    'v2.9.0-preview.20260918.0',
    `v${'9'.repeat(256)}.0.0`,
  ])('rejects unsupported release input %j', (value) => {
    expect(isWorkflowPackageRelease(value)).toBe(false);
  });
});
