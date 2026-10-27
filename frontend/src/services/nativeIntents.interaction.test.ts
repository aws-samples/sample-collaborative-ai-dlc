import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const get = vi.fn();
const post = vi.fn();
vi.mock('./api', () => ({
  api: { get: (...args: unknown[]) => get(...args), post: (...args: unknown[]) => post(...args) },
}));
import { nativeIntentsService, nativeReplyTextValid } from './nativeIntents';

const messages = [
  { type: 'text', text: 'Choose a workflow.' },
  { type: 'text', text: '| Workflow | Scope |\n| --- | --- |\n| poc | Prototype |' },
];
const interaction = {
  id: 'a'.repeat(64),
  sequence: 1,
  kind: 'assistant_turn',
  harness: 'codex',
  publicationId: 'pub-1',
  messages,
  contentSha256: createHash('sha256')
    .update(JSON.stringify(messages.map(({ text, type }) => ({ text, type }))))
    .digest('hex'),
  createdAt: '2026-09-29T12:00:00Z',
};
const request = {
  requestId: 'a1227042-0661-4843-8138-9d08fdd0a890',
  interactionId: interaction.id,
  contentSha256: interaction.contentSha256,
  text: '  Use the prototype workflow.\nKeep 🐦 simple.  ',
};
const response = {
  id: 'bed6a902-10ce-459c-87b3-e5689a57c57b',
  kind: 'user_reply',
  interactionId: interaction.id,
  sequence: 2,
  actorId: 'member-1',
  text: request.text,
  acceptedAt: '2026-09-29T12:01:00Z',
  deliveryStatus: 'pending',
};
const execution = {
  status: 'AWAITING_USER',
  attemptId: 'attempt-1',
  epoch: 1,
  startedAt: '2026-09-29T11:50:00Z',
  updatedAt: interaction.createdAt,
  model: 'selected-model',
  repository: { provider: 'github', repository: 'owner/repo', branch: 'main', commit: 'abc123' },
  publicationId: 'pub-1',
  projectionStatus: 'complete',
  interactionId: interaction.id,
  turnSequence: 1,
};
const detail = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Game',
  prompt: 'Fix the pipes',
  harness: 'codex',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: execution.startedAt,
  updatedAt: execution.updatedAt,
  executionAvailable: true,
  execution,
};
const acceptance = {
  executionAvailable: true,
  execution: { ...execution, status: 'DISPATCHING', turnSequence: 2, responsePending: true },
  response,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe('native recovery contract', () => {
  it.each(
    [['created'], { value: 'created' }, 1, null, true, 'unknown'].map((workflowResumeState) => ({
      workflowResumeState,
    })),
  )(
    'rejects nonliteral or unknown workflow recovery evidence %j',
    async ({ workflowResumeState }) => {
      get.mockResolvedValue({
        ...detail,
        execution: {
          ...execution,
          status: 'RECOVERY_REQUIRED',
          recoveryMode: 'efs-workspace-v1',
          recovery: {
            id: 'recovery-1',
            reason: 'SESSION_LOST',
            canRecover: true,
            workflowResumeState,
          },
        },
      });
      await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow(
        'The native recovery status could not be verified.',
      );
    },
  );

  it.each([
    ['created', 'SESSION_LOST', true],
    ['not_created', 'INTAKE_UNAVAILABLE', false],
    ['unavailable', 'WORKFLOW_STATE_UNAVAILABLE', false],
    [undefined, 'WORKFLOW_STATE_UNAVAILABLE', false],
  ])(
    'requires created proof before exposing EFS recovery from %s',
    async (state, reason, canRecover) => {
      get.mockResolvedValue({
        ...detail,
        execution: {
          ...execution,
          status: 'RECOVERY_REQUIRED',
          recoveryMode: 'efs-workspace-v1',
          recovery: {
            id: 'recovery-1',
            reason: 'SESSION_LOST',
            canRecover: true,
            ...(state === undefined ? {} : { workflowResumeState: state }),
          },
        },
      });
      const result = await nativeIntentsService.get('project-1', 'run-1');
      expect(result.execution?.recovery).toEqual({
        id: 'recovery-1',
        reason,
        canRecover,
        ...(state === undefined ? {} : { workflowResumeState: state }),
      });
      expect(result.execution?.publicationId).toBe(execution.publicationId);
    },
  );

  it('reads exact publication sequence and public stop evidence independently of pending turn sequence', async () => {
    get.mockResolvedValue({
      ...detail,
      execution: {
        ...execution,
        status: 'RECOVERY_REQUIRED',
        turnSequence: 2,
        publicationSequence: 1,
        stopStatus: { state: 'confirmed', confirmedAt: execution.updatedAt, privateKey: 'hidden' },
      },
    });
    const result = await nativeIntentsService.get('project-1', 'run-1');
    expect(result.execution?.publicationSequence).toBe(1);
    expect(result.execution?.turnSequence).toBe(2);
    expect(result.execution?.stopStatus).toEqual({
      state: 'confirmed',
      confirmedAt: execution.updatedAt,
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it.each([
    { publicationSequence: 0 },
    { publicationSequence: null },
    { stopStatus: { state: 'confirmed', confirmedAt: null } },
    { stopStatus: { state: 'confirmed', confirmedAt: '2030-01-01T00:00:00Z' } },
    { stopStatus: { state: 'confirmed', confirmedAt: execution.updatedAt } },
    { stopStatus: { state: 'pending', confirmedAt: null } },
    { stopStatus: { state: 'unconfirmed', confirmedAt: execution.updatedAt } },
    { stopStatus: { state: 'absent', confirmedAt: null } },
  ])('rejects malformed or contradictory public stop/publication metadata %j', async (patch) => {
    get.mockResolvedValue({ ...detail, execution: { ...execution, ...patch } });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow();
  });
  const recovery = { id: 'recovery-1', reason: 'RESTORE_FAILED', canRecover: true };
  const recovering = {
    ...detail,
    execution: {
      ...acceptance.execution,
      status: 'RECOVERING',
      revision: 11,
      recovery: { ...recovery, canRecover: false },
    },
  };
  const recoveryRequest = {
    requestId: '62e0aef9-a09a-4d40-851a-33b814de26b9',
    recoveryId: recovery.id,
  };

  it('reads explicit recovery metadata while discarding private checkpoint fields', async () => {
    get.mockResolvedValue({
      ...recovering,
      execution: {
        ...recovering.execution,
        recovery: { ...recovering.execution.recovery, checkpointKey: 'private', token: 'secret' },
      },
    });
    expect(await nativeIntentsService.get('project-1', 'run-1')).toEqual(recovering);
  });

  it.each([
    { status: 'DISPATCHING', recovery: null },
    {
      status: 'RECOVERING',
      recovery: { ...recovery, reason: 'SESSION_LOST', canRecover: false },
    },
    {
      status: 'RECOVERY_REQUIRED',
      recovery: { ...recovery, reason: 'SESSION_LOST', canRecover: false },
    },
    {
      status: 'RECOVERY_REQUIRED',
      recovery: { ...recovery, reason: 'CHECKPOINT_UNAVAILABLE', canRecover: false },
    },
    {
      status: 'RECOVERY_REQUIRED',
      recovery: { ...recovery, reason: 'DELIVERY_UNCERTAIN', canRecover: false },
    },
    { status: 'RECOVERY_REQUIRED', recovery },
  ])(
    'preserves the controller revision and saved pending reply for $status / $recovery',
    async (patch) => {
      const { turnSequence, ...wireExecution } = acceptance.execution;
      get.mockResolvedValue({
        ...detail,
        execution: {
          ...wireExecution,
          ...patch,
          sequence: turnSequence,
          revision: 27,
          responsePending: true,
        },
      });
      const result = await nativeIntentsService.get('project-1', 'run-1');
      expect(result.execution).toEqual({
        ...acceptance.execution,
        ...patch,
        turnSequence: 2,
        revision: 27,
        responsePending: true,
      });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    'accepts view-only recovery with absent metadata %s',
    async (value) => {
      get.mockResolvedValue({
        ...recovering,
        execution: { ...recovering.execution, revision: undefined, recovery: value },
      });
      const next = await nativeIntentsService.get('project-1', 'run-1');
      expect(next.execution?.status).toBe('RECOVERING');
      expect(next.execution?.recovery).toBe(value);
      expect(next.execution?.revision).toBeUndefined();
    },
  );

  it.each([
    { revision: -1 },
    { revision: 1.5 },
    { revision: '11' },
    { revision: null },
    { recovery: true },
    { recovery: {} },
    { recovery: { ...recovery, id: '../foreign' } },
    { recovery: { ...recovery, reason: 'PRIVATE_STACK' } },
    { recovery: { ...recovery, canRecover: 'true' } },
    { recovery },
  ])('rejects malformed or contradictory recovery metadata %#', async (patch) => {
    get.mockResolvedValue({
      ...recovering,
      execution: { ...recovering.execution, ...patch },
    });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('posts only the recovery episode and retry identity, never reply or runtime overrides', async () => {
    post.mockResolvedValue(recovering);
    const input = {
      ...recoveryRequest,
      text: 'do not resend',
      checkpoint: 'private',
      approved: true,
    };
    expect(await nativeIntentsService.recover('project-1', 'run-1', input)).toEqual(recovering);
    expect(post).toHaveBeenCalledWith(
      '/projects/project-1/native-intents/run-1/recover',
      recoveryRequest,
    );
  });

  it.each([
    { requestId: 'invalid', recoveryId: recovery.id },
    { ...recoveryRequest, recoveryId: '' },
    { ...recoveryRequest, recoveryId: '../other' },
  ])('rejects an invalid recovery request before POST %#', async (input) => {
    await expect(nativeIntentsService.recover('project-1', 'run-1', input)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    { ...recovering, id: 'other-run' },
    { ...recovering, projectId: 'other-project' },
    { ...recovering, execution: null },
    { ...recovering, execution: { ...recovering.execution, revision: undefined } },
    {
      ...recovering,
      execution: {
        ...recovering.execution,
        recovery: { ...recovering.execution.recovery, id: 'other-recovery' },
      },
    },
  ])('does not confirm an unrelated or unverified recovery acknowledgement %#', async (value) => {
    post.mockResolvedValue(value);
    await expect(
      nativeIntentsService.recover('project-1', 'run-1', recoveryRequest),
    ).rejects.toThrow(/could not be verified/);
  });
});

describe('published assistant turn contract', () => {
  it('verifies the canonical content digest, preserves ordered messages and drops private envelope fields', async () => {
    get.mockResolvedValue({
      ...interaction,
      scope: 'private',
      nativeSessionId: 'private',
      transcript: ['secret'],
    });
    expect(await nativeIntentsService.interaction('project-1', 'run-1')).toEqual({
      ...interaction,
      pendingInput: null,
    });
    expect(get).toHaveBeenCalledWith('/projects/project-1/native-intents/run-1/interaction');
  });
  it('restores the separately protected reply, bound to the displayed interaction', async () => {
    get.mockResolvedValue({ ...interaction, response: { ...response, credentials: 'secret' } });
    expect((await nativeIntentsService.interaction('project-1', 'run-1')).response).toEqual(
      response,
    );
  });
  it.each([
    { id: 'invalid' },
    { kind: 'question' },
    { harness: 'unknown' },
    { harness: ['codex'] },
    { sequence: 0 },
    { sequence: 1.5 },
    { createdAt: 'invalid' },
    { contentSha256: 'b'.repeat(64) },
    { messages: [] },
    { messages: [{ type: 'tool_result', text: 'secret' }] },
    { messages: [{ type: 'text', text: 'visible', reasoning: 'secret' }] },
    { messages: [{ type: 'text', text: '\u0000unsafe' }] },
    { messages: [{ type: 'text', text: '\ud800' }] },
    { messages: [{ type: 'text', text: ' ' }] },
    { messages: [{ type: 'text', text: 'x'.repeat(65537) }] },
    { messages: Array.from({ length: 257 }, () => ({ type: 'text', text: 'x' })) },
    { response: { ...response, interactionId: 'b'.repeat(64) } },
    { response: { ...response, sequence: 3 } },
  ])('rejects invalid or unbound content %#', async (patch) => {
    get.mockResolvedValue({ ...interaction, ...patch });
    await expect(nativeIntentsService.interaction('project-1', 'run-1')).rejects.toThrow(
      /could not be verified/,
    );
  });
  it('requires explicit interaction identity and a valid turn counter for AWAITING_USER', async () => {
    get.mockResolvedValue(detail);
    expect((await nativeIntentsService.get('project-1', 'run-1')).execution).toEqual(execution);
    get.mockResolvedValue({ ...detail, execution: { ...execution, interactionId: undefined } });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow();
    get.mockResolvedValue({ ...detail, execution: { ...execution, turnSequence: undefined } });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow();
  });
  it('normalizes the wire sequence alias while rejecting disagreements', async () => {
    get.mockResolvedValue({
      ...detail,
      execution: { ...execution, turnSequence: undefined, sequence: 1 },
    });
    expect((await nativeIntentsService.get('project-1', 'run-1')).execution?.turnSequence).toBe(1);
    get.mockResolvedValue({ ...detail, execution: { ...execution, sequence: 2 } });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow();
  });
  it.each([
    { turnSequence: null },
    { turnSequence: -1 },
    { responsePending: 'true' },
    { responsePending: true },
  ])('rejects malformed or contradictory AWAITING_USER metadata %j', async (patch) => {
    get.mockResolvedValue({ ...detail, execution: { ...execution, ...patch } });
    await expect(nativeIntentsService.get('project-1', 'run-1')).rejects.toThrow();
  });
});

describe('ordinary reply contract', () => {
  it('sends only the four fields, preserving exact text, and validates the receipt', async () => {
    post.mockResolvedValue(acceptance);
    const input = { ...request, actorId: 'forged', approved: true };
    expect(await nativeIntentsService.respond('project-1', 'run-1', input)).toEqual({
      execution: acceptance.execution,
      response,
    });
    expect(post).toHaveBeenCalledWith('/projects/project-1/native-intents/run-1/response', request);
  });
  it('counts UTF-8 bytes rather than characters and preserves a valid leading BOM', async () => {
    expect(nativeReplyTextValid('🐦'.repeat(4096))).toBe(true);
    expect(nativeReplyTextValid('🐦'.repeat(4096) + 'a')).toBe(false);
    expect(nativeReplyTextValid('\ufeffordinary reply')).toBe(true);
    post.mockResolvedValue({ ...acceptance, response: { ...response, text: '🐦'.repeat(4096) } });
    await nativeIntentsService.respond('project-1', 'run-1', {
      ...request,
      text: '🐦'.repeat(4096),
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it.each(['', ' \n\t', '🐦'.repeat(4096) + 'a', 'a\u0000b', '\ud800'])(
    'rejects invalid reply text before POST %#',
    async (text) => {
      await expect(
        nativeIntentsService.respond('project-1', 'run-1', { ...request, text }),
      ).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { ...acceptance, projectId: 'foreign-project', id: 'run-1' },
    { ...acceptance, projectId: 'project-1', id: 'foreign-run' },
    { ...acceptance, response: null },
    { ...acceptance, response: { ...response, interactionId: 'b'.repeat(64) } },
    { ...acceptance, response: { ...response, text: request.text.trim() } },
    { ...acceptance, response: { ...response, deliveryStatus: 'complete' } },
    { ...acceptance, execution: { ...acceptance.execution, turnSequence: 1 } },
  ])('does not confirm an unverified acknowledgement %#', async (value) => {
    post.mockResolvedValue(value);
    await expect(nativeIntentsService.respond('project-1', 'run-1', request)).rejects.toThrow();
  });
  it('accepts interaction graph navigation without treating it as an artifact', async () => {
    const node = {
      id: 'response-node',
      type: 'NativeInteraction',
      label: 'AI-DLC response',
      interactionId: interaction.id,
    };
    get.mockResolvedValue({ publicationId: 'pub-1', nodes: [node], edges: [] });
    expect((await nativeIntentsService.graph('project-1', 'run-1')).nodes[0]).toEqual(node);
    get.mockResolvedValue({
      publicationId: 'pub-1',
      nodes: [{ ...node, artifactId: 'file-1' }],
      edges: [],
    });
    await expect(nativeIntentsService.graph('project-1', 'run-1')).rejects.toThrow();
  });
});

describe('task-3 structured question contract', () => {
  const pendingInput = {
    schemaVersion: 1,
    kind: 'approval',
    source: 'engine-gate',
    stage: 'requirements-analysis',
    questions: [
      {
        id: 'q1',
        prompt: 'Requirements complete. How would you like to proceed?',
        header: 'Approval',
        multiSelect: false,
        options: [
          { label: 'Approve', description: 'Continue to user stories' },
          { label: 'Request Changes', description: null },
        ],
      },
    ],
  };
  // Mirrors the server: sorted-key canonical JSON over messages and the question.
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : value && typeof value === 'object'
        ? `{${Object.keys(value)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
            )
            .join(',')}}`
        : JSON.stringify(value);
  const v2 = {
    ...interaction,
    pendingInput,
    contentSha256: createHash('sha256').update(canonical({ messages, pendingInput })).digest('hex'),
  };
  it('verifies the digest over messages and the exact presented options', async () => {
    get.mockResolvedValue(v2);
    expect((await nativeIntentsService.interaction('project-1', 'run-1')).pendingInput).toEqual(
      pendingInput,
    );
  });
  it('rejects options changed after the digest was computed', async () => {
    const tampered = structuredClone(v2);
    tampered.pendingInput.questions[0].options[0].label = 'Approve and merge';
    get.mockResolvedValue(tampered);
    await expect(nativeIntentsService.interaction('project-1', 'run-1')).rejects.toThrow();
  });
  it('sends the selection alongside its exact label text', async () => {
    post.mockResolvedValue({
      executionAvailable: true,
      execution: {
        status: 'DISPATCHING',
        attemptId: 'attempt-1',
        epoch: 1,
        startedAt: '2026-09-29T11:50:00Z',
        updatedAt: '2026-09-29T12:00:00Z',
        model: 'm',
        repository: { provider: 'github', repository: 'o/r', branch: 'main', commit: 'abc' },
        publicationId: 'pub-1',
        interactionId: interaction.id,
        turnSequence: 2,
        responsePending: true,
      },
      response: { ...response, text: 'Approve' },
    });
    const selection = { answers: [{ selectedOptions: [0] }] };
    await nativeIntentsService
      .respond('project-1', 'run-1', {
        ...request,
        contentSha256: v2.contentSha256,
        text: 'Approve',
        selection,
      })
      .catch(() => undefined);
    expect(post).toHaveBeenCalledWith('/projects/project-1/native-intents/run-1/response', {
      requestId: request.requestId,
      interactionId: interaction.id,
      contentSha256: v2.contentSha256,
      text: 'Approve',
      selection,
    });
  });
});
