import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';

const { store, membership, closeConnection } = vi.hoisted(() => ({
  store: {
    getExecution: vi.fn(),
    listProjectExecutions: vi.fn(),
    getHumanTask: vi.fn(),
    updateExecution: vi.fn(),
    answerHumanTask: vi.fn(),
    clearUnitPrWait: vi.fn(),
  },
  membership: vi.fn(),
  closeConnection: vi.fn(),
}));

vi.mock('../../shared/v2-process-store.js', () => ({ createProcessStore: () => store }));
vi.mock('../../shared/trackers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchMembershipRole: membership,
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({
    accessKeyId: 'test',
    secretAccessKey: 'test',
  }),
}));
vi.mock('gremlin', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      driver: {
        ...actual.default.driver,
        DriverRemoteConnection: class {
          close = closeConnection;
        },
      },
    },
  };
});

import { handler } from '../index.js';

const sendS3 = vi.spyOn(S3Client.prototype, 'send');
const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'SUCCEEDED',
  executionBackend: 'native',
};
const request = (method, suffix = '', body = {}, params = {}) => ({
  httpMethod: method,
  path: `/projects/p1/intents/i1${suffix}`,
  pathParameters: { projectId: 'p1', intentId: 'i1', ...params },
  body: JSON.stringify(body),
  requestContext: { authorizer: { claims: { sub: 'u1' } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  sendS3.mockRejectedValue(new Error('Unexpected S3 request'));
  membership.mockResolvedValue('member');
  store.getExecution.mockResolvedValue(META);
  store.listProjectExecutions.mockResolvedValue([META]);
});

describe('execution backend HTTP boundary', () => {
  it.each(['native', 'unknown', null])(
    'keeps attachment reads free of cleanup mutations for %s',
    async (executionBackend) => {
      const attachments = [{ attachmentId: 'kept', filename: 'notes.md' }];
      store.getExecution.mockResolvedValue({
        ...META,
        executionBackend,
        attachments,
        attachmentRevision: 2,
        pendingAttachmentDeletions: [{ attachmentId: 'old', s3Key: 'old.md' }],
      });
      const result = await handler(request('GET', '/attachments'));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ attachments, attachmentRevision: 2 });
      expect(sendS3).not.toHaveBeenCalled();
      expect(store.updateExecution).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['PUT', '/artifacts/a1/content', { artifactId: 'a1' }, 'artifactEdit'],
    ['POST', '/artifacts/a1/verify', { artifactId: 'a1' }, 'artifactVerify'],
    ['POST', '/artifacts/a1/quorum-edit', { artifactId: 'a1' }, 'quorumEdit'],
    ['POST', '/quorum-edits/e1/decision', { editId: 'e1' }, 'quorumEdit'],
    ['POST', '/gates/g1/revise', { humanTaskId: 'g1' }, 'answerRevision'],
    ['POST', '/rewind', {}, 'workflowRewind'],
    ['POST', '/recompose', {}, 'workflowRecompose'],
    ['POST', '/compose', {}, 'workflowCompose'],
    ['POST', '/compose-report-upload', {}, 'workflowCompose'],
    ['POST', '/repair', {}, 'parallelUnits'],
    ['POST', '/export', {}, 'nativeExport'],
    ['POST', '/derive', {}, 'derive'],
    ['GET', '/units/0/u1/feedback', { sectionIndex: '0', unitSlug: 'u1' }, 'unitPullRequests'],
    ['POST', '/units/0/u1/feedback', { sectionIndex: '0', unitSlug: 'u1' }, 'unitPullRequests'],
  ])(
    'blocks native %s %s before platform side effects',
    async (method, suffix, params, capability) => {
      const result = await handler(request(method, suffix, {}, params));
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({
        code: 'unsupported_execution_capability',
        executionBackend: 'native',
        capability,
      });
      expect(store.getExecution).toHaveBeenCalledExactlyOnceWith('i1', { consistentRead: true });
      expect(store.updateExecution).not.toHaveBeenCalled();
      expect(closeConnection).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['POST', '/start'],
    ['POST', '/cancel'],
    ['POST', '/gates/g1/answer'],
    ['PATCH', ''],
    ['DELETE', ''],
    ['POST', '/attachments/upload'],
    ['POST', '/future-mutation'],
  ])('rejects unimplemented native %s %s without fallback', async (method, suffix) => {
    const result = await handler(request(method, suffix, {}, { humanTaskId: 'g1' }));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).code).toBe('execution_backend_unavailable');
    expect(store.getHumanTask).not.toHaveBeenCalled();
    expect(store.answerHumanTask).not.toHaveBeenCalled();
    expect(store.updateExecution).not.toHaveBeenCalled();
  });

  it.each([null, '', 'other', false])('rejects invalid stored backend %j', async (backend) => {
    store.getExecution.mockResolvedValue({ ...META, executionBackend: backend });
    const result = await handler(request('POST', '/start'));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).code).toBe('invalid_execution_backend');
  });

  it.each([undefined, 'platform'])(
    'preserves legacy/platform route validation (%s)',
    async (backend) => {
      store.getExecution.mockResolvedValue({ ...META, executionBackend: backend });
      const result = await handler(request('POST', '/start'));
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).error).toContain('SUCCEEDED');
      expect(JSON.parse(result.body)).not.toHaveProperty('code');
    },
  );

  it('rejects native creation before loading a platform workflow', async () => {
    const result = await handler(
      request('POST', '', { title: 'Native', executionBackend: 'native' }, { intentId: undefined }),
    );
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).code).toBe('execution_backend_unavailable');
    expect(store.getExecution).not.toHaveBeenCalled();
  });

  it.each([null, '', 'other', false])('rejects explicit invalid selection %j', async (backend) => {
    const result = await handler(
      request('POST', '', { title: 'Native', executionBackend: backend }, { intentId: undefined }),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).code).toBe('invalid_execution_backend');
  });

  it.each(['DRAFT', 'FAILED', 'CREATED', 'SUCCEEDED'])(
    'does not silently ignore backend switching on %s records',
    async (status) => {
      store.getExecution.mockResolvedValue({ ...META, status, executionBackend: 'platform' });
      const result = await handler(request('PATCH', '', { executionBackend: 'native' }));
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).code).toBe('execution_backend_immutable');
    },
  );

  it('checks membership before revealing backend state', async () => {
    membership.mockResolvedValue(null);
    const result = await handler(request('POST', '/start'));
    expect(result.statusCode).toBe(403);
    expect(store.getExecution).not.toHaveBeenCalled();
  });

  it('checks project ownership before revealing backend state', async () => {
    store.getExecution.mockResolvedValue({ ...META, projectId: 'another-project' });
    const result = await handler(request('POST', '/start'));
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Intent not found' });
  });

  it('returns conservative capabilities for native and explicit platform identity for legacy rows', async () => {
    store.listProjectExecutions.mockResolvedValue([
      META,
      { ...META, intentId: 'legacy', executionBackend: undefined },
      { ...META, intentId: 'unknown', executionBackend: 'unknown' },
    ]);
    const result = await handler(request('GET', '', {}, { intentId: undefined }));
    expect(result.statusCode).toBe(200);
    const rows = JSON.parse(result.body);
    expect(rows[0].executionBackend).toBe('native');
    expect(Object.values(rows[0].executionCapabilities).every((value) => value === false)).toBe(
      true,
    );
    expect(rows[1].executionBackend).toBe('platform');
    expect(rows[1].executionCapabilities.artifactEdit).toBe(true);
    expect(rows[2].executionCapabilities.unitPullRequests).toBe(false);
  });
});

describe('platform maintenance boundary', () => {
  it.each(['native', 'unknown', null])(
    'does not promote a pending attachment upload for %s',
    async (executionBackend) => {
      const key = 'intent-attachments/staging/i1/a1.md';
      store.getExecution.mockResolvedValue({
        ...META,
        executionBackend,
        status: 'DRAFT',
        pendingAttachmentUploads: [
          {
            attachmentId: 'a1',
            filename: 'notes.md',
            mimeType: 'text/markdown',
            size: 10,
            s3Key: key,
          },
        ],
      });
      expect(
        await handler({
          source: 'aws.s3',
          detail: { object: { key, 'version-id': 'v1' } },
        }),
      ).toEqual({ ok: true });
      expect(store.getExecution).toHaveBeenCalledWith('i1', { consistentRead: true });
      expect(sendS3).not.toHaveBeenCalled();
      expect(store.updateExecution).not.toHaveBeenCalled();
    },
  );

  it('leaves native and unknown execution supervision to their backend', async () => {
    const result = await handler({
      action: 'repair-durable-executions',
      candidates: [META, { ...META, executionBackend: 'unknown' }],
    });
    expect(result).toEqual({ checked: 2, repaired: 0, skipped: 2, errors: [] });
    expect(store.updateExecution).not.toHaveBeenCalled();
  });

  it('does not clear or wake a native PR callback through platform maintenance', async () => {
    const result = await handler({
      action: 'reconcile-provider-state',
      candidates: [],
      waits: [{ executionId: 'i1', slug: 'u1', sectionIndex: 0 }],
    });
    expect(result.prWaits).toMatchObject({ checked: 1, unchanged: 1, woken: 0, errors: [] });
    expect(store.clearUnitPrWait).not.toHaveBeenCalled();
  });
});
