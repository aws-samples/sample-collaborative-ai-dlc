import { describe, expect, it, vi } from 'vitest';
import { createStatusHandler, runtimeNameFor } from '../status.js';

const environment = {
  environmentId: 'custom',
  status: 'BUILDING',
};

const revision = {
  environmentId: 'custom',
  revisionId: 'r-1',
  status: 'BUILDING',
  runtimeCompatibilityVersion: '1',
};

const mutableStore = (initialRevision = revision) => {
  let current = initialRevision;
  return {
    get current() {
      return current;
    },
    getLookup: vi.fn().mockResolvedValue({ environmentId: 'custom', revisionId: 'r-1' }),
    getEnvironment: vi.fn().mockResolvedValue(environment),
    getRevision: vi.fn().mockImplementation(async () => current),
    updateRevision: vi.fn().mockImplementation(async (_environmentId, _revisionId, patch) => {
      current = { ...current, ...patch };
      return current;
    }),
    updateEnvironment: vi.fn().mockResolvedValue(environment),
    listRevisionsByStatus: vi
      .fn()
      .mockImplementation(async (status) => (current.status === status ? [current] : [])),
  };
};

const buildEvent = {
  source: 'aws.codebuild',
  detail: {
    'build-id': 'build-1',
    'build-status': 'SUCCEEDED',
  },
};

const imageClient = (severityCounts, findings = [], nextToken = undefined) => ({
  send: vi
    .fn()
    .mockResolvedValueOnce({
      imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}` }],
    })
    .mockResolvedValueOnce({
      imageScanStatus: { status: 'COMPLETE' },
      imageScanFindings: { findingSeverityCounts: severityCounts, findings },
      nextToken,
    }),
});

describe('managed environment status handler', () => {
  it('keeps runtime names bounded and unique when environment IDs are long', () => {
    const environmentId = `environment-${'x'.repeat(52)}`;
    const first = runtimeNameFor(environmentId, 'r-first');
    const second = runtimeNameFor(environmentId, 'r-second');

    expect(first).toMatch(/^[A-Za-z][A-Za-z0-9_]+$/);
    expect(first.length).toBeLessThanOrEqual(48);
    expect(second).not.toBe(first);
  });

  it('requires acceptance for Critical findings and records issue details', async () => {
    const store = mutableStore();
    const handler = createStatusHandler({
      store,
      ecrClient: imageClient(
        { CRITICAL: 1 },
        [
          {
            name: 'CVE-2026-42010',
            severity: 'CRITICAL',
            uri: 'https://example.test/CVE-2026-42010',
            attributes: [
              { key: 'package_name', value: 'gnutls28' },
              { key: 'package_version', value: '3.7.9-2+deb12u6' },
            ],
          },
        ],
        'more-findings',
      ),
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });
    const result = await handler(buildEvent);
    expect(result.revision).toMatchObject({
      status: 'SECURITY_REVIEW',
      failure: null,
      scanFindings: {
        findingsTruncated: true,
        findings: [
          {
            id: 'CVE-2026-42010',
            severity: 'CRITICAL',
            packageName: 'gnutls28',
            packageVersion: '3.7.9-2+deb12u6',
          },
        ],
      },
    });
  });

  it('requires acknowledgement for High findings', async () => {
    const store = mutableStore();
    const handler = createStatusHandler({
      store,
      ecrClient: imageClient({ HIGH: 2 }),
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });
    const result = await handler(buildEvent);
    expect(result.revision.status).toBe('SECURITY_REVIEW');
    expect(result.revision.scanFindings.severityCounts.HIGH).toBe(2);
  });

  it('creates a runtime with the protected protocol and a stable token', async () => {
    const store = mutableStore();
    const controlClient = {
      send: vi.fn().mockResolvedValueOnce({
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/custom',
        agentRuntimeId: 'runtime-1',
        agentRuntimeVersion: '3',
      }),
    };
    const handler = createStatusHandler({
      store,
      ecrClient: imageClient({}),
      controlClient,
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler(buildEvent);

    expect(result.revision).toMatchObject({
      status: 'VERIFYING',
      runtimeId: 'runtime-1',
      runtimeVersion: '3',
      runtimeEndpoint: 'revision_r_1',
      runtimeEndpointArn: null,
    });
    const runtimeInput = controlClient.send.mock.calls[0][0].input;
    expect(runtimeInput.protocolConfiguration).toEqual({
      serverProtocol: 'HTTP',
    });
    expect(runtimeInput.tags).toMatchObject({
      ManagedEnvironment: 'custom',
      ManagedEnvironmentRevision: 'r-1',
    });
    expect(runtimeInput.clientToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('waits for runtime readiness before creating the endpoint', async () => {
    const verifying = {
      ...revision,
      status: 'VERIFYING',
      runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/custom',
      runtimeId: 'runtime-1',
      runtimeVersion: '3',
      runtimeEndpoint: 'revision_r_1',
      runtimeEndpointArn: null,
    };
    const store = mutableStore(verifying);
    const creatingControl = {
      send: vi.fn().mockResolvedValue({ status: 'CREATING' }),
    };
    const creatingHandler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: creatingControl,
      runtimeClient: { send: vi.fn() },
    });

    const pending = await creatingHandler({ action: 'poll' });

    expect(pending.results[0]).toMatchObject({
      pending: true,
      revision: { runtimeEndpointArn: null },
    });
    expect(creatingControl.send).toHaveBeenCalledTimes(1);
    expect(creatingControl.send.mock.calls[0][0].constructor.name).toBe('GetAgentRuntimeCommand');

    const readyControl = {
      send: vi.fn().mockResolvedValueOnce({ status: 'READY' }).mockResolvedValueOnce({
        endpointName: 'revision_r_1',
        agentRuntimeEndpointArn:
          'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime-endpoint/custom',
      }),
    };
    const readyHandler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: readyControl,
      runtimeClient: { send: vi.fn() },
    });

    const provisioned = await readyHandler({ action: 'poll' });

    expect(provisioned.results[0].revision.runtimeEndpointArn).toContain('runtime-endpoint/custom');
    const endpointInput = readyControl.send.mock.calls[1][0].input;
    expect(endpointInput.tags).toMatchObject({
      ManagedEnvironment: 'custom',
      ManagedEnvironmentRevision: 'r-1',
    });
    expect(endpointInput.clientToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps a revision pending while ECR metadata propagates', async () => {
    const store = mutableStore();
    const notFound = Object.assign(new Error('image not visible yet'), {
      name: 'ImageNotFoundException',
    });
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn().mockRejectedValue(notFound) },
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler(buildEvent);

    expect(result).toMatchObject({
      pending: true,
      revision: { status: 'BUILDING' },
    });
    expect(store.updateRevision).not.toHaveBeenCalled();
  });

  it('retries runtime creation after security findings are accepted', async () => {
    const acknowledged = {
      ...revision,
      status: 'SECURITY_REVIEW',
      securityFindingsAcceptedAt: '2026-08-10T12:00:00.000Z',
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/environments',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    };
    const store = mutableStore(acknowledged);
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/custom',
        agentRuntimeId: 'runtime-1',
        agentRuntimeVersion: '3',
      }),
    };
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient,
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler({ action: 'poll' });

    expect(result.results).toContainEqual(
      expect.objectContaining({
        revision: expect.objectContaining({
          status: 'VERIFYING',
          runtimeId: 'runtime-1',
        }),
      }),
    );
    expect(controlClient.send.mock.calls[0][0].constructor.name).toBe('CreateAgentRuntimeCommand');
  });

  it('reopens legacy Critical scan failures without rebuilding the image', async () => {
    const failed = {
      ...revision,
      status: 'FAILED',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      failure: {
        reason: 'critical_vulnerability_findings',
        detail: '5 Critical finding(s)',
      },
    };
    const store = mutableStore(failed);
    const handler = createStatusHandler({
      store,
      ecrClient: imageClient({ CRITICAL: 5 }),
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler({ action: 'poll' });

    expect(result.results).toContainEqual(
      expect.objectContaining({
        revision: expect.objectContaining({
          status: 'SECURITY_REVIEW',
          imageDigest: failed.imageDigest,
          failure: null,
        }),
      }),
    );
  });

  it('records image build failures without changing the built image reference', async () => {
    const imageDigest = `sha256:${'c'.repeat(64)}`;
    const store = mutableStore({ ...revision, imageDigest });
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });
    const result = await handler({
      ...buildEvent,
      detail: {
        ...buildEvent.detail,
        'build-status': 'FAILED',
      },
    });
    expect(result.revision).toMatchObject({
      status: 'FAILED',
      imageDigest,
      failure: { reason: 'image_build_failed', detail: 'FAILED' },
    });
  });

  it('ignores duplicate build success events after image inspection has advanced', async () => {
    const store = mutableStore({ ...revision, status: 'VERIFYING' });
    const ecrClient = { send: vi.fn() };
    const controlClient = { send: vi.fn() };
    const handler = createStatusHandler({
      store,
      ecrClient,
      controlClient,
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler(buildEvent);

    expect(result).toMatchObject({
      ignored: true,
      revision: { status: 'VERIFYING' },
    });
    expect(ecrClient.send).not.toHaveBeenCalled();
    expect(controlClient.send).not.toHaveBeenCalled();
  });

  it('ignores late build failure events after validation has started', async () => {
    const store = mutableStore({ ...revision, status: 'VERIFYING' });
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });

    const result = await handler({
      ...buildEvent,
      detail: {
        ...buildEvent.detail,
        'build-status': 'FAILED',
      },
    });

    expect(result).toMatchObject({
      ignored: true,
      revision: { status: 'VERIFYING' },
    });
    expect(store.updateRevision).not.toHaveBeenCalled();
  });

  it('records endpoint and command validation evidence', async () => {
    const verifying = {
      ...revision,
      status: 'VERIFYING',
      scanFindings: { severityCounts: { HIGH: 2 } },
      securityFindingsAcceptedAt: '2026-08-10T12:00:00.000Z',
      runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/custom',
      runtimeId: 'runtime-1',
      runtimeVersion: '3',
      runtimeEndpoint: 'revision_r_1',
      runtimeEndpointArn:
        'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime-endpoint/custom',
    };
    const store = mutableStore(verifying);
    const runtimeClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          response: {
            transformToString: async () => JSON.stringify({ ok: true, clis: ['node', 'python'] }),
          },
        })
        .mockResolvedValueOnce({
          response: {
            transformToString: async () =>
              JSON.stringify({
                ok: true,
                nonce: 'check-r-1',
                compatibilityVersion: '1',
                nonRoot: true,
                workspaceWritable: true,
                protectedRuntime: true,
              }),
          },
        }),
    };
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: { send: vi.fn().mockResolvedValue({ status: 'READY' }) },
      runtimeClient,
    });
    const result = await handler({ action: 'poll' });
    expect(result.results[0].revision.status).toBe('READY');
    expect(result.results[0].revision.verification).toMatchObject({
      status: 'PASSED',
      securityScan: 'ACCEPTED',
      endpoint: 'PASSED',
      toolBuilds: 'PASSED',
    });
    expect(runtimeClient.send.mock.calls[0][0].input.qualifier).toBe('revision_r_1');
    expect(runtimeClient.send.mock.calls[2][0].constructor.name).toBe('StopRuntimeSessionCommand');
    expect(runtimeClient.send.mock.calls[2][0].input).toMatchObject({
      agentRuntimeArn: verifying.runtimeArn,
      qualifier: 'revision_r_1',
      runtimeSessionId: expect.stringContaining('managed-environment-r-1-'),
    });
  });

  it('preserves the published image when runtime validation fails', async () => {
    const verifying = {
      ...revision,
      status: 'VERIFYING',
      runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/custom',
      runtimeId: 'runtime-1',
      runtimeVersion: '3',
      runtimeEndpoint: 'revision_r_1',
      runtimeEndpointArn:
        'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime-endpoint/custom',
      imageDigest: `sha256:${'c'.repeat(64)}`,
    };
    const store = mutableStore(verifying);
    const runtimeClient = {
      send: vi.fn().mockResolvedValue({
        response: {
          transformToString: async () => JSON.stringify({ ok: false }),
        },
      }),
    };
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: { send: vi.fn().mockResolvedValue({ status: 'READY' }) },
      runtimeClient,
    });
    const result = await handler({ action: 'poll' });
    expect(result.results[0].revision).toMatchObject({
      status: 'FAILED',
      imageDigest: verifying.imageDigest,
      failure: { reason: 'runtime_validation_failed' },
    });
    expect(runtimeClient.send.mock.calls[1][0].constructor.name).toBe('StopRuntimeSessionCommand');
  });

  it('propagates unexpected handler failures so the event source can retry', async () => {
    const store = {
      getLookup: vi.fn().mockRejectedValue(new Error('registry unavailable')),
    };
    const handler = createStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      controlClient: { send: vi.fn() },
      runtimeClient: { send: vi.fn() },
    });

    await expect(handler(buildEvent)).rejects.toThrow('registry unavailable');
  });
});
