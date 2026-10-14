import { beforeEach, describe, expect, it, vi } from 'vitest';
const get = vi.fn();
const post = vi.fn();
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: { get: (...args: unknown[]) => get(...args), post: (...args: unknown[]) => post(...args) },
}));
import { ApiError } from './api';
import { nativeDraftInputRejected, nativeIntentsService } from './nativeIntents';

const draft = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Game',
  prompt: 'Create a game',
  harness: 'kiro',
  status: 'DRAFT',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: '2026-09-25T08:00:00Z',
  updatedAt: '2026-09-25T08:00:00Z',
};
beforeEach(() => vi.resetAllMocks());
describe('native output and lifecycle history', () => {
  const output = { seq: 65, content: 'Public output' };
  const event = {
    revision: 89,
    eventId: 'native-89',
    type: 'native.published',
    summary: 'Published',
    timestamp: '2026-10-13T00:00:00Z',
  };
  it('decodes additive lifecycle pages and retains older output-only responses', async () => {
    get.mockResolvedValueOnce({
      outputs: [output],
      nextAfter: 65,
      events: [event],
      nextEventAfter: 89,
    });
    expect(await nativeIntentsService.outputs('p1', 'i1', 64, 80)).toMatchObject({
      events: [event],
    });
    expect(get).toHaveBeenCalledWith(
      '/projects/p1/native-intents/i1/outputs?afterSeq=64&afterEvent=80',
    );
    get.mockResolvedValueOnce({ outputs: [output], nextAfter: null });
    expect(await nativeIntentsService.outputs('p1', 'i1', 64)).toEqual({
      outputs: [output],
      nextAfter: null,
    });
  });
  it.each([
    { outputs: [output, output] },
    { outputs: [{ seq: 66, content: '' }, output] },
    { nextAfter: 80 },
    { events: [event], nextEventAfter: 90 },
    { events: [event, event], nextEventAfter: null },
    { events: [event] },
    { events: [{ ...event, timestamp: 'invalid' }], nextEventAfter: null },
  ])('rejects gaps, backwards pages and partial response shapes %j', async (patch) => {
    get.mockResolvedValue({ outputs: [output], nextAfter: null, ...patch });
    await expect(nativeIntentsService.outputs('p1', 'i1', 64, 80)).rejects.toThrow(
      'Invalid native output history',
    );
  });
});
describe('saved native prompt boundary', () => {
  const request = {
    requestId: '10000000-0000-4000-8000-000000000001',
    expectedRevision: 0,
    prompt: 'Saved task  \n',
  };
  const response = {
    ...draft,
    prompt: request.prompt,
    promptRevision: 1,
    promptAcceptance: { requestId: request.requestId, revision: 1, prompt: request.prompt },
  };
  it('verifies an exact save receipt and forwards the saved revision to Start', async () => {
    post.mockResolvedValueOnce(response).mockResolvedValueOnce(response);
    expect(await nativeIntentsService.savePrompt('project-1', 'run-1', request)).toMatchObject({
      prompt: request.prompt,
      promptRevision: 1,
    });
    expect(post).toHaveBeenNthCalledWith(
      1,
      '/projects/project-1/native-intents/run-1/prompt',
      request,
    );
    await nativeIntentsService.start('project-1', 'run-1', request.requestId, 1);
    expect(post).toHaveBeenNthCalledWith(2, '/projects/project-1/native-intents/run-1/start', {
      requestId: request.requestId,
      promptRevision: 1,
    });
  });
  it.each([
    { promptAcceptance: undefined },
    { promptRevision: -1 },
    { promptRevision: 0 },
    { promptRevision: '1' },
    { prompt: 'Different prompt' },
    { promptAcceptance: { ...response.promptAcceptance, revision: 2 } },
    { promptAcceptance: { ...response.promptAcceptance, prompt: 'Different accepted prompt' } },
  ])('rejects ambiguous or inconsistent save results %j', async (patch) => {
    post.mockResolvedValue({ ...response, ...patch });
    await expect(nativeIntentsService.savePrompt('project-1', 'run-1', request)).rejects.toThrow();
  });
  it('accepts an exact receipt alongside a newer current prompt without inventing acknowledgement', async () => {
    post.mockResolvedValue({ ...response, prompt: 'Later member save', promptRevision: 2 });
    expect(await nativeIntentsService.savePrompt('project-1', 'run-1', request)).toMatchObject({
      prompt: 'Later member save',
      promptRevision: 2,
    });
  });
  it.each(['', ' ', 'bad\0text', '\ud800'])(
    'blocks invalid prompt %j before POST',
    async (prompt) => {
      await expect(
        nativeIntentsService.savePrompt('project-1', 'run-1', { ...request, prompt }),
      ).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
    },
  );
});
describe('native draft rejection boundary', () => {
  const request = {
    intentId: 'run-1',
    title: 'Game',
    prompt: 'Create a game',
    harness: 'kiro' as const,
    sourceId: 'a'.repeat(64),
    packageJobId: '10000000-0000-4000-8000-000000000001',
    bindingRevision: '20000000-0000-4000-8000-000000000002',
  };
  it.each([
    [400, 'NATIVE_PREPARATION_INVALID'],
    [413, 'NATIVE_PREPARATION_BODY_TOO_LARGE'],
  ])('preserves the authoritative %s rejection through create', async (status, code) => {
    const error = new ApiError(status, 'Rejected input', { code, draftInputRejected: true });
    post.mockRejectedValue(error);
    await expect(nativeIntentsService.create('project-1', request)).rejects.toBe(error);
    expect(nativeDraftInputRejected(error)).toBe(true);
    expect(post).toHaveBeenCalledWith('/projects/project-1/native-intents', request);
  });
  it.each([
    new Error('Response lost'),
    new ApiError(400, 'Invalid', { code: 'NATIVE_PREPARATION_INVALID' }),
    new ApiError(400, 'Invalid', {
      code: 'NATIVE_PREPARATION_INVALID',
      draftInputRejected: 'true',
    }),
    new ApiError(503, 'Unavailable', {
      code: 'NATIVE_PREPARATION_INVALID',
      draftInputRejected: true,
    }),
    new ApiError(409, 'Conflict', {
      code: 'NATIVE_PREPARATION_CONFLICT',
      draftInputRejected: true,
    }),
    new ApiError(413, 'Gateway size limit'),
    new ApiError(400, 'Unknown', { code: 'UNKNOWN', draftInputRejected: true }),
  ])('does not interpret $message as definitive draft rejection', (error) => {
    expect(nativeDraftInputRejected(error)).toBe(false);
  });
  it.each([null, {}, { ...draft, id: 'foreign-id' }])(
    'does not interpret an invalid success body as rejection: %j',
    async (body) => {
      post.mockResolvedValue(body);
      const error = await nativeIntentsService.create('project-1', request).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(nativeDraftInputRejected(error)).toBe(false);
    },
  );
});
describe('native intent response boundary', () => {
  it.each([
    null,
    true,
    'enabled',
    [],
    {},
    { preparationEnabled: true },
    { executionEnabled: true },
    { preparationEnabled: false, executionEnabled: true },
    { preparationEnabled: false, executionEnabled: false },
    { preparationEnabled: 'true', executionEnabled: true },
    { preparationEnabled: 1, executionEnabled: false },
    ...[null, 'true', 'false', 'unknown', 0, 1, {}, []].map((executionEnabled) => ({
      preparationEnabled: true,
      executionEnabled,
    })),
  ])('rejects disabled preparation or malformed capabilities: %j', async (value) => {
    get.mockResolvedValue(value);
    expect(await nativeIntentsService.canPrepare('project-1')).toBe(false);
  });
  it.each([false, true])(
    'accepts enabled preparation with executionEnabled=%s',
    async (executionEnabled) => {
      get.mockResolvedValue({ preparationEnabled: true, executionEnabled });
      expect(await nativeIntentsService.canPrepare('project-1')).toBe(true);
      expect(get).toHaveBeenCalledWith('/projects/project-1/native-intents');
    },
  );
  it('propagates a failed capability request without enabling preparation', async () => {
    const failure = new Error('Capability lookup unavailable');
    get.mockRejectedValue(failure);
    await expect(nativeIntentsService.canPrepare('project-1')).rejects.toBe(failure);
    expect(post).not.toHaveBeenCalled();
  });
  it.each([
    { projectId: 'another-project' },
    { id: 'another-run' },
    { executionBackend: 'platform' },
    { status: 'RUNNING' },
    { harness: 'unknown' },
    { createdAt: 'invalid' },
  ])('rejects foreign or unrecognized status: %j', async (patch) => {
    get.mockResolvedValue({ ...draft, ...patch });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow(
      /could not be verified/,
    );
  });
  it('projects public fields without retaining authority or credentials', async () => {
    get.mockResolvedValue({ ...draft, executionRoleArn: 'secret-authority', credential: 'secret' });
    expect(await nativeIntentsService.get('project-1', 'run-1')).toEqual(draft);
  });
  it('prepares the existing identity without sending role, image or filesystem overrides', async () => {
    post.mockResolvedValue({ ...draft, status: 'PREPARING' });
    expect((await nativeIntentsService.prepare('project-1', 'run-1')).status).toBe('PREPARING');
    expect(post).toHaveBeenCalledWith('/projects/project-1/native-intents/run-1/prepare', {});
  });
});

describe('protected native discovery list', () => {
  const { prompt: _prompt, ...item } = draft;
  it('accepts prompt-only drafts with empty titles in both detail and discovery', async () => {
    get
      .mockResolvedValueOnce({ ...draft, title: '' })
      .mockResolvedValueOnce({ items: [{ ...item, title: '' }], nextCursor: null });
    expect((await nativeIntentsService.get('project-1', 'run-1')).title).toBe('');
    expect((await nativeIntentsService.list('project-1')).items[0].title).toBe('');
  });
  it('accepts an empty page with a continuation cursor', async () => {
    get.mockResolvedValue({ items: [], nextCursor: 'next_123' });
    expect(await nativeIntentsService.list('project-1')).toEqual({
      items: [],
      nextCursor: 'next_123',
    });
  });
  it('uses the explicit list view and preserves the capability GET', async () => {
    get
      .mockResolvedValueOnce({ items: [item], nextCursor: 'opaque-cursor_123' })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ preparationEnabled: true, executionEnabled: false });
    const first = await nativeIntentsService.list('project-1');
    expect(first).toEqual({ items: [item], nextCursor: 'opaque-cursor_123' });
    await nativeIntentsService.list('project-1', first.nextCursor);
    await nativeIntentsService.canPrepare('project-1');
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/projects/project-1/native-intents?view=list&limit=25',
      '/projects/project-1/native-intents?view=list&limit=25&cursor=opaque-cursor_123',
      '/projects/project-1/native-intents',
    ]);
  });
  it('never retains prompt, permissions or platform workflow fields in a summary', async () => {
    get.mockResolvedValue({
      items: [{ ...draft, workflowId: 'forged', role: 'owner' }],
      nextCursor: null,
    });
    const result = await nativeIntentsService.list('project-1');
    expect(result.items).toEqual([item]);
    expect(result.items[0]).not.toHaveProperty('prompt');
    expect(result.items[0]).not.toHaveProperty('workflowId');
  });
  it.each([
    {},
    { items: [], nextCursor: undefined },
    { items: [], nextCursor: '' },
    { items: [], nextCursor: 'line\nbreak' },
    { items: [], nextCursor: 1 },
    { items: [], nextCursor: 'x'.repeat(2049) },
    { items: [], nextCursor: 'cursor+/=' },
    { items: Array.from({ length: 26 }, (_, i) => ({ ...item, id: `id-${i}` })), nextCursor: null },
    { items: [item, item], nextCursor: null },
    { items: [{ ...item, projectId: 'project-2' }], nextCursor: null },
    { items: [{ ...item, id: '../foreign' }], nextCursor: null },
    { items: [{ ...item, executionBackend: 'platform' }], nextCursor: null },
    { items: [{ ...item, status: 'SUCCEEDED' }], nextCursor: null },
    { items: [{ ...item, status: ['READY'] }], nextCursor: null },
    { items: [{ ...item, harness: ['kiro'] }], nextCursor: null },
    { items: [{ ...item, updatedAt: 'unknown' }], nextCursor: null },
  ])('rejects an invalid page boundary %#', async (response) => {
    get.mockResolvedValue(response);
    await expect(nativeIntentsService.list('project-1')).rejects.toThrow();
  });
  it('rejects a repeated cursor and invalid request before fetching', async () => {
    get.mockResolvedValue({ items: [], nextCursor: 'same' });
    await expect(nativeIntentsService.list('project-1', 'same')).rejects.toThrow();
    get.mockClear();
    await expect(nativeIntentsService.list('../bad')).rejects.toThrow();
    await expect(nativeIntentsService.list('project-1', '')).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('native execution and committed publication boundary', () => {
  const requestId = 'a1227042-0661-4843-8138-9d08fdd0a890';
  const execution = {
    status: 'WAITING_FOR_INPUT',
    attemptId: 'attempt-1',
    epoch: 1,
    startedAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    model: 'selected-model',
    repository: { provider: 'github', repository: 'owner/repo', branch: 'main', commit: 'abc123' },
    publicationId: 'pub-1',
    projectionStatus: 'complete',
  };
  const descriptor = {
    id: 'file-1',
    path: 'aidlc-docs/questions.md',
    bytes: 3,
    sha256: 'a'.repeat(64),
    role: 'question',
    mediaType: 'text/markdown',
  };
  const publication = {
    id: 'pub-1',
    sequence: 1,
    createdAt: draft.createdAt,
    files: [descriptor],
    question: { fileId: 'file-1', path: descriptor.path, sha256: descriptor.sha256 },
    projectionStatus: 'complete',
  };
  const file = {
    id: descriptor.id,
    path: descriptor.path,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
    mediaType: descriptor.mediaType,
    encoding: 'utf8',
    content: 'Yes',
    publicationId: 'pub-1',
  };
  const graph = {
    publicationId: 'pub-1',
    nodes: [
      { id: 'native:intent:1', type: 'Intent', label: 'Request' },
      { id: 'file-1', type: 'Artifact', label: descriptor.path, artifactId: 'file-1' },
    ],
    edges: [{ source: 'native:intent:1', target: 'file-1', label: 'CONTAINS' }],
  };
  it('keeps an old API disabled and projects only public execution fields', async () => {
    get.mockResolvedValueOnce(draft).mockResolvedValueOnce({
      ...draft,
      executionAvailable: true,
      execution: {
        ...execution,
        credential: 'secret',
        runtimeArn: 'private',
        repository: { ...execution.repository, token: 'secret' },
      },
    });
    expect(
      (await nativeIntentsService.get('project-1', 'run-1')).executionAvailable,
    ).toBeUndefined();
    expect(await nativeIntentsService.get('project-1', 'run-1')).toEqual({
      ...draft,
      executionAvailable: true,
      execution,
    });
  });
  it('excludes execution detail and capabilities from discovery summaries', async () => {
    get.mockResolvedValue({
      items: [{ ...draft, executionAvailable: true, execution }],
      nextCursor: null,
    });
    const { prompt: _prompt, ...expected } = draft;
    expect((await nativeIntentsService.list('project-1')).items).toEqual([expected]);
  });
  it.each(['user', 'space', 'platform'])(
    'decodes captured %s scope and image without private metadata',
    async (credentialSource) => {
      const imageDigest = `sha256:${'b'.repeat(64)}`;
      get.mockResolvedValue({
        ...draft,
        execution: {
          ...execution,
          credentialSource,
          imageDigest,
          credentialBinding: { userId: 'private-user', parameterName: 'private-path' },
        },
      });
      const result = (await nativeIntentsService.get('project-1', 'run-1')).execution;
      expect(result).toEqual({ ...execution, credentialSource, imageDigest });
      expect(JSON.stringify(result)).not.toContain('private-');
    },
  );
  it('starts with only the retry identity, and cancels with an empty body', async () => {
    post.mockResolvedValue({ ...draft, executionAvailable: true, execution });
    await nativeIntentsService.start('project-1', 'run-1', requestId);
    await nativeIntentsService.cancel('project-1', 'run-1');
    expect(post.mock.calls).toEqual([
      ['/projects/project-1/native-intents/run-1/start', { requestId }],
      ['/projects/project-1/native-intents/run-1/cancel', {}],
    ]);
    await expect(nativeIntentsService.start('project-1', 'run-1', 'not-a-uuid')).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: 'SUCCEEDED' },
    { epoch: -1 },
    { epoch: 0.5 },
    { epoch: '1' },
    { attemptId: '../other' },
    { model: {} },
    { credentialSource: 'current-user' },
    { credentialSource: { source: 'user' } },
    { imageDigest: 'latest' },
    { imageDigest: `sha256:${'b'.repeat(64)}\n` },
    { updatedAt: 'invalid' },
    { repository: null },
    { repository: { ...execution.repository, branch: 1 } },
    { publicationId: '../foreign' },
    { projectionStatus: 'done' },
  ])('rejects invalid execution metadata %#', async (patch) => {
    get.mockResolvedValue({
      ...draft,
      executionAvailable: true,
      execution: { ...execution, ...patch },
    });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow(
      /could not be verified/,
    );
  });
  it('loads publication, files and graph only through native endpoints', async () => {
    get
      .mockResolvedValueOnce(publication)
      .mockResolvedValueOnce({
        ...file,
        credential: 'secret',
        storageKey: 'private',
      })
      .mockResolvedValueOnce(graph);
    expect(await nativeIntentsService.publication('project-1', 'run-1')).toEqual(publication);
    expect(await nativeIntentsService.file('project-1', 'run-1', 'file-1')).toEqual(file);
    expect(await nativeIntentsService.graph('project-1', 'run-1')).toEqual(graph);
    expect(get.mock.calls).toEqual([
      ['/projects/project-1/native-intents/run-1/publication'],
      ['/projects/project-1/native-intents/run-1/files/file-1'],
      ['/projects/project-1/native-intents/run-1/graph'],
    ]);
  });
  it.each([
    { files: [descriptor, descriptor] },
    { files: [{ ...descriptor, role: ['question'] }] },
    { files: [{ ...descriptor, path: '../credentials' }] },
    { files: [{ ...descriptor, path: '/absolute/path' }] },
    { files: [{ ...descriptor, path: 'aidlc-docs\\question.md' }] },
    { files: [{ ...descriptor, bytes: -1 }] },
    { files: [{ ...descriptor, sha256: 'invalid' }] },
    { question: { ...publication.question, fileId: 'unpublished-file' } },
    { question: { ...publication.question, sha256: 'b'.repeat(64) } },
    { question: { ...publication.question, path: 'wrong-path.md' } },
    { projectionStatus: ['complete'] },
  ])('rejects incomplete or conflicting publication metadata %#', async (patch) => {
    get.mockResolvedValue({ ...publication, ...patch });
    await expect(nativeIntentsService.publication('project-1', 'run-1')).rejects.toThrow();
  });
  it('preserves binary encoding and never decodes it into display text', async () => {
    get.mockResolvedValue({ ...file, encoding: 'base64', content: 'AAEC', mediaType: 'image/png' });
    expect(await nativeIntentsService.file('project-1', 'run-1', 'file-1')).toMatchObject({
      encoding: 'base64',
      content: 'AAEC',
      mediaType: 'image/png',
    });
  });
  it.each([
    { id: 'foreign' },
    { encoding: 'html' },
    { encoding: ['utf8'] },
    { encoding: 'base64', content: '<svg onload=alert(1)>' },
    { publicationId: null },
    { content: {} },
  ])('rejects invalid file payload %#', async (patch) => {
    get.mockResolvedValue({ ...file, ...patch });
    await expect(nativeIntentsService.file('project-1', 'run-1', 'file-1')).rejects.toThrow();
  });
  it.each([
    { nodes: [...graph.nodes, graph.nodes[0]] },
    { nodes: [{ id: '1', type: 'Intent' }] },
    { nodes: [{ ...graph.nodes[0], artifactId: {} }] },
    { edges: [{ ...graph.edges[0], target: 'missing-node' }] },
    { publicationId: '' },
  ])('rejects an inconsistent graph %#', async (patch) => {
    get.mockResolvedValue({ ...graph, ...patch });
    await expect(nativeIntentsService.graph('project-1', 'run-1')).rejects.toThrow();
  });
});
