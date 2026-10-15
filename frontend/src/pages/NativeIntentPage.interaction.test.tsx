import { createHash, webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/services/api';
import { canonicalJson, nativePendingInput } from '@/lib/nativePendingInput';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { resetCollaborationFakes } from '@/test/collaborationFakes';
import {
  armSessionExpiry,
  notifySessionExpired,
  resetSessionExpiry,
} from '@/services/sessionExpiry';
import type {
  NativeIntent,
  NativePublication,
  NativeInteractionView,
  NativeUserReply,
  NativeReplyRequest,
  NativeExecution,
} from '@/services/nativeIntents';

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// Shared drafts: in-memory Yjs relay + textarea stand-in (see test/collaborationFakes).
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api')>()),
  api: transport,
}));
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => {
    throw new Error('Platform IntentContext mounted on native route');
  },
}));
vi.mock('@/contexts/DiscussionContext', () => ({
  useDiscussion: () => {
    throw new Error('Platform discussion mounted on native route');
  },
}));
import NativeIntentPage from './NativeIntentPage';
// Exercise the production producer as well as the rendered consumer.
// @ts-expect-error The backend JS workspace intentionally has no frontend declarations.
import { buildNativePendingInput } from '../../../lambda/shared/native-pending-input.js';

const messages: NativeInteractionView['messages'] = [
  { type: 'text', text: 'Choose a workflow for these changes.' },
  { type: 'text', text: '| Workflow | Scope |\n| --- | --- |\n| poc | Prototype |' },
  { type: 'text', text: 'Reply with the workflow name.' },
];
const initialInteraction: NativeInteractionView = {
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
  response: null,
};
const initial: NativeIntent = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Fix pipes',
  prompt: 'Private pipe visualization request',
  harness: 'codex',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: '2026-09-29T11:00:00Z',
  updatedAt: '2026-09-29T12:00:00Z',
  executionAvailable: true,
  execution: {
    status: 'AWAITING_USER',
    attemptId: 'attempt-1',
    epoch: 1,
    startedAt: '2026-09-29T11:50:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    model: 'selected-model',
    repository: { provider: 'github', repository: 'owner/repo', branch: 'main', commit: 'abc123' },
    publicationId: 'pub-1',
    projectionStatus: 'complete',
    interactionId: initialInteraction.id,
    turnSequence: 1,
  },
};
const initialPublication: NativePublication = {
  id: 'pub-1',
  sequence: 1,
  createdAt: initialInteraction.createdAt,
  files: [
    {
      id: 'code-1',
      path: 'src/pipe.ts',
      bytes: 4,
      sha256: 'c'.repeat(64),
      role: 'code',
      mediaType: 'text/plain',
    },
  ],
  question: null,
  projectionStatus: 'complete',
};
let intent: NativeIntent;
let interaction: NativeInteractionView;
let publication: NativePublication;
const readInteraction = vi.fn();
const readFile = vi.fn();
const readGraph = vi.fn();
function receipt(text = 'poc'): NativeUserReply {
  return {
    id: 'bed6a902-10ce-459c-87b3-e5689a57c57b',
    kind: 'user_reply',
    interactionId: initialInteraction.id,
    sequence: 2,
    actorId: 'member-1',
    text,
    acceptedAt: '2026-09-29T12:01:00Z',
    deliveryStatus: 'pending',
  };
}
function accept(request: NativeReplyRequest) {
  const response = receipt(request.text);
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'DISPATCHING',
      turnSequence: 2,
      updatedAt: '2026-09-29T12:01:00Z',
      responsePending: true,
    },
  };
  interaction = { ...interaction, response };
  return { executionAvailable: true, execution: intent.execution, response };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/space/project-1/native-intent/run-1']}>
      <Link to="/space/project-1/native-intent/run-2">Other run</Link>
      <Routes>
        <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function loaded() {
  await screen.findByText('Choose a workflow for these changes.');
  return screen.getByRole('textbox', { name: 'Reply to AI-DLC' });
}
function completionTransport(
  read: (value: unknown) => Promise<unknown>,
  harness: NativeIntent['harness'] = 'codex',
) {
  const publicationId = 'f'.repeat(64);
  const attemptId = '11111111-1111-4111-8111-111111111111';
  intent = { ...intent, harness, execution: { ...intent.execution!, publicationId, attemptId } };
  publication = { ...publication, id: publicationId };
  interaction = { ...interaction, harness, publicationId };
  const original = transport.get.getMockImplementation()!;
  transport.get.mockImplementation((path: string) => {
    if (!path.includes('&evidence=1')) return original(path);
    return read({
      schemaVersion: 1,
      publicationId,
      publicationSequence: 1,
      context: {
        projectId: intent.projectId,
        executionId: intent.id,
        attemptId,
        epoch: 1,
        configurationSha256: 'b'.repeat(64),
        packageId: `sha256:${'c'.repeat(64)}`,
        harness,
      },
      workflowCompletion: 'not_verified',
      requiredChecks: 'not_recorded',
      finalReview: 'not_recorded',
      humanApproval: 'not_recorded',
      policy: 'pinned_workflow',
      requirementsStatus: 'unknown',
      policyStatus: 'unsupported',
      reason: 'unsupported_package_protocol',
      definition: null,
      effectivePlan: 'not_recorded',
      engineApplication: 'not_recorded',
      terminalOutcome: 'not_recorded',
      memberDecision: {
        status: 'recorded',
        origin: 'protected_member_selection',
        commandId: receipt().id,
        interactionId: interaction.id,
        contentSha256: interaction.contentSha256,
        sequence: 2,
        epoch: 1,
        actorId: 'member-1',
        acceptedAt: receipt().acceptedAt,
        membershipRecorded: true,
        presentedStage: 'requirements-analysis',
        label: 'Approve',
        additionalText: false,
        applicationStatus: 'not_recorded',
      },
      decisionDelivery: 'delivered',
    });
  });
}
async function click(name: string | RegExp) {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
}
async function typeReply(text = 'poc') {
  const textbox = await loaded();
  await act(async () => fireEvent.change(textbox, { target: { value: text } }));
}
function cleared() {
  expect(screen.queryByText(initial.prompt)).not.toBeInTheDocument();
  expect(screen.queryByText(messages[0].text)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
}
beforeEach(() => {
  resetCollaborationFakes();
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  resetSessionExpiry();
  clearNativeIntents();
  intent = structuredClone(initial);
  interaction = structuredClone(initialInteraction);
  publication = structuredClone(initialPublication);
  readInteraction.mockImplementation(async () => interaction);
  readFile.mockResolvedValue({
    ...initialPublication.files[0],
    encoding: 'utf8',
    content: 'pipe',
    publicationId: 'pub-1',
  });
  readGraph.mockResolvedValue({
    publicationId: 'pub-1',
    nodes: [
      {
        id: 'turn-node',
        type: 'NativeInteraction',
        label: 'AI-DLC turn',
        interactionId: initialInteraction.id,
      },
    ],
    edges: [],
  });
  transport.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/interaction')) return readInteraction();
    if (path.endsWith('/publication')) return publication;
    if (path.endsWith('/graph')) return readGraph();
    if (path.includes('/files/')) return readFile();
    return intent;
  });
  transport.post.mockImplementation(async (_path: string, request: NativeReplyRequest) =>
    accept(request),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('renders every explicitly offered scope as a choice and submits its exact label once', async () => {
  // Sanitized shape from the admitted 2026-10-15 scope response. These are
  // fixture options, not a production list or an inference from assistant prose.
  const plans = [
    'compose',
    'bugfix',
    'classic',
    'enterprise',
    'express',
    'feature',
    'infra',
    'mvp',
    'poc',
    'refactor',
    'security-patch',
    'workshop',
  ];
  const scopeMessages = [
    {
      type: 'text' as const,
      text: 'The complete plan offer is in the form below.',
    },
  ];
  const pendingInput = nativePendingInput(
    buildNativePendingInput({
      spec: {
        version: 3,
        ask: {
          kind: 'ask',
          ask_type: 'compose-offer',
          response_route: 'next',
          question: 'Choose the plan for this task.',
          compose_command: 'aidlc engine orchestrate next compose --request fixture',
          scope_commands: plans.slice(1).map((scope) => ({
            scope,
            command: `aidlc engine orchestrate next --scope ${scope} --request fixture`,
          })),
        },
      },
      messagesText: scopeMessages[0].text,
    }),
  );
  interaction = {
    ...interaction,
    messages: scopeMessages,
    pendingInput,
    contentSha256: createHash('sha256')
      .update(
        canonicalJson({
          messages: scopeMessages,
          pendingInput,
        }),
      )
      .digest('hex'),
  };
  renderPage();
  const form = await screen.findByRole('form', { name: 'Workflow questions' });
  for (const plan of plans) expect(within(form).getByText(plan)).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Reply to AI-DLC' })).not.toBeInTheDocument();
  expect(within(form).getByRole('button', { name: 'Submit Answer' })).toBeDisabled();
  fireEvent.click(within(form).getByText('classic'));
  fireEvent.submit(form);
  fireEvent.submit(form);
  await screen.findByText('Reply accepted. Delivery pending.');
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(transport.post.mock.calls[0][1]).toMatchObject({
    interactionId: interaction.id,
    contentSha256: interaction.contentSha256,
    text: 'classic',
    selection: { answers: [{ selectedOptions: [2] }] },
  });
});

it('keeps a degraded form explicitly waiting, submits once and retains its notice and accepted reply on refresh', async () => {
  const presentation = { status: 'degraded' as const, reason: 'invalid_json' as const };
  interaction = {
    ...interaction,
    pendingInput: null,
    presentation,
    contentSha256: createHash('sha256')
      .update(canonicalJson({ messages: interaction.messages, pendingInput: null, presentation }))
      .digest('hex'),
  };
  const page = renderPage();
  await screen.findByText(
    'The structured question form is unavailable for this turn. The response and checkpoint are saved.',
  );
  expect(screen.queryByRole('form', { name: 'Workflow questions' })).not.toBeInTheDocument();
  const field = await screen.findByRole('textbox', { name: 'Reply to AI-DLC' });
  await userEvent.type(field, 'Please present the current questions and options.');
  fireEvent.submit(screen.getByRole('form', { name: 'Reply to AI-DLC' }));
  fireEvent.submit(screen.getByRole('form', { name: 'Reply to AI-DLC' }));
  await screen.findByText('Reply accepted. Delivery pending.');
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(transport.post.mock.calls[0][1]).toMatchObject({
    interactionId: interaction.id,
    contentSha256: interaction.contentSha256,
    text: 'Please present the current questions and options.',
  });
  expect(transport.post.mock.calls[0][1]).not.toHaveProperty('selection');
  page.unmount();
  renderPage();
  await screen.findByText(
    'The structured question form is unavailable for this turn. The response and checkpoint are saved.',
  );
  expect(
    await screen.findByDisplayValue('Please present the current questions and options.'),
  ).toHaveAttribute('readonly');
  expect(transport.post).toHaveBeenCalledTimes(1);
});

it('submits one complete grouped form, retries identical bytes after a lost ack and restores the receipt on reload', async () => {
  const pendingInput = nativePendingInput({
    schemaVersion: 2,
    kind: 'choice',
    source: 'rendered-question',
    stage: null,
    questions: [
      {
        id: 'q1',
        prompt: 'Which platforms?',
        header: 'Platforms',
        multiSelect: true,
        options: [
          { label: 'Web', description: null },
          { label: 'Mobile', description: null },
        ],
      },
      {
        id: 'q2',
        prompt: 'What constraints apply?',
        header: 'Constraints',
        multiSelect: false,
        options: [],
      },
    ],
  });
  interaction = {
    ...interaction,
    pendingInput,
    contentSha256: createHash('sha256')
      .update(canonicalJson({ messages, pendingInput }))
      .digest('hex'),
  };
  const pending = deferred<unknown>();
  transport.post.mockReturnValueOnce(pending.promise);
  const page = renderPage();
  const form = await screen.findByRole('form', { name: 'Workflow questions' });
  expect(within(form).getByRole('button', { name: 'Submit All Answers' })).toBeDisabled();
  fireEvent.click(within(form).getByText('Web'));
  fireEvent.click(within(form).getByText('Mobile'));
  expect(within(form).getByRole('button', { name: 'Submit All Answers' })).toBeDisabled();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Answer question 2' }), {
    target: { value: 'Offline support.' },
  });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(transport.post).toHaveBeenCalledTimes(1);
  const [path, request] = transport.post.mock.calls[0];
  expect(request).toMatchObject({
    interactionId: interaction.id,
    contentSha256: interaction.contentSha256,
    text: '1. Platforms: Web, Mobile\n2. Constraints: Offline support.',
    selection: {
      answers: [{ selectedOptions: [0, 1] }, { selectedOptions: [], freeText: 'Offline support.' }],
    },
  });
  await act(async () => pending.reject(new ApiError(502, 'unconfirmed')));
  fireEvent.change(within(form).getByRole('textbox', { name: 'Answer question 2' }), {
    target: { value: 'A later collaborator draft' },
  });
  fireEvent.submit(form);
  expect(transport.post.mock.calls[1]).toEqual([path, request]);
  await screen.findByText('Reply accepted. Delivery pending.');
  page.unmount();
  clearNativeIntents();
  renderPage();
  await screen.findByText('Reply accepted. Delivery pending.');
  expect(screen.getByRole('textbox', { name: 'Reply to AI-DLC' })).toHaveValue(request.text);
  expect(screen.queryByRole('form', { name: 'Workflow questions' })).not.toBeInTheDocument();
  expect(transport.post).toHaveBeenCalledTimes(2);
});

it('presents OpenCode decision and delivery evidence through the real decoder without recognizing a Codex definition', async () => {
  completionTransport(async (value) => value, 'opencode');
  renderPage();
  await loaded();
  const evidence = screen.getByRole('region', { name: 'Workflow completion evidence' });
  await within(evidence).findByText(/Approve · requirements-analysis · member-1/);
  expect(within(evidence).getByText(/Runtime delivery: delivered/)).toBeVisible();
  expect(within(evidence).getByText(/no supported definition profile/)).toBeVisible();
  expect(within(evidence).queryByText('Inspect pinned package defaults')).not.toBeInTheDocument();
  expect(within(evidence).getByText('Workflow completion: not verified')).toBeVisible();
  expect(transport.post).not.toHaveBeenCalled();
});

it('keeps the current reply first and usable while independent evidence loads and fails', async () => {
  const pending = deferred<unknown>();
  completionTransport(() => pending.promise);
  renderPage();
  const reply = await loaded();
  const evidence = screen.getByRole('region', { name: 'Workflow completion evidence' });
  expect(within(evidence).getByText(/Loading evidence/)).toBeVisible();
  expect(reply.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => pending.reject(new Error('evidence unavailable')));
  await within(evidence).findByText(/Completion evidence is unavailable/);
  expect(reply.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(reply).not.toHaveAttribute('readonly');
  await typeReply('poc');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled();
  expect(transport.post).not.toHaveBeenCalled();
});

it('renders actual ordered text and composer tables without a fake artifact or verified question', async () => {
  renderPage();
  const textbox = await loaded();
  const section = screen.getByRole('region', { name: 'Published AI-DLC response' });
  expect(within(section).getByRole('table')).toHaveTextContent('pocPrototype');
  expect(section.textContent!.indexOf(messages[0].text)).toBeLessThan(
    section.textContent!.indexOf('WorkflowScope'),
  );
  expect(section.textContent!.indexOf('WorkflowScope')).toBeLessThan(
    section.textContent!.indexOf(messages[2].text),
  );
  expect(screen.queryByRole('region', { name: 'Published question' })).not.toBeInTheDocument();
  expect(readFile).not.toHaveBeenCalled();
  expect(textbox).not.toHaveAttribute('readonly');
  expect(screen.getByText('AI-DLC is waiting for your reply.')).toBeInTheDocument();
  expect(screen.getByText(/one member sends it to continue this session/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  for (const name of ['Edit artifacts', 'Create unit PR', 'Delete intent']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(transport.post).not.toHaveBeenCalled();
});

it('preserves the draft and request identity through navigation, an uncertain POST and a retry', async () => {
  const pending = deferred<unknown>();
  transport.post.mockReturnValueOnce(pending.promise);
  renderPage();
  const text = '  poc\nKeep 🐦 simple  ';
  await typeReply(text);
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  const node = await screen.findByRole('button', { name: 'Open response for AI-DLC turn' });
  fireEvent.keyDown(node, { key: 'Enter' });
  expect(await loaded()).toHaveValue(text);
  await click('Send reply');
  await click('Sending reply…');
  expect(transport.post).toHaveBeenCalledTimes(1);
  const [path, request] = transport.post.mock.calls[0];
  expect(path).toBe('/projects/project-1/native-intents/run-1/response');
  expect(request).toEqual({
    requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    interactionId: initialInteraction.id,
    contentSha256: initialInteraction.contentSha256,
    text,
  });
  await act(async () =>
    pending.reject(new ApiError(502, 'Bearer secret', { error: 'raw stack secret' })),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Reply acceptance could not be confirmed');
  expect(document.body).not.toHaveTextContent('secret');
  expect(screen.getByRole('textbox')).toHaveValue(text);
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  await click('Retry same reply');
  expect(transport.post.mock.calls[1]).toEqual([path, request]);
  await screen.findByText('Reply accepted. Delivery pending.');
  expect(screen.getByRole('textbox')).toHaveValue(text);
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
});

it('restores a protected accepted reply on reload, then shows a new interaction with an empty editable form', async () => {
  accept({ requestId: '', interactionId: initialInteraction.id, contentSha256: '', text: 'poc' });
  renderPage();
  await loaded();
  expect(await screen.findByText('Reply accepted. Delivery pending.')).toBeInTheDocument();
  expect(screen.getByText('Continuing agent')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('poc');
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  publication = { ...publication, id: 'pub-2', sequence: 2 };
  interaction = {
    ...interaction,
    id: 'b'.repeat(64),
    publicationId: 'pub-2',
    sequence: 2,
    response: null,
  };
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'AWAITING_USER',
      publicationId: 'pub-2',
      interactionId: interaction.id,
      responsePending: false,
      updatedAt: '2026-09-29T12:02:00Z',
    },
  };
  await click('Refresh status');
  await loaded();
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
  expect(screen.queryByText('Reply accepted. Delivery pending.')).not.toBeInTheDocument();
  expect(transport.post).not.toHaveBeenCalled();
});

it('does not invent a next assistant response when delivery has completed', async () => {
  accept({ requestId: '', interactionId: initialInteraction.id, contentSha256: '', text: 'poc' });
  intent.execution = { ...intent.execution!, status: 'RUNNING', responsePending: false };
  interaction.response = { ...interaction.response!, deliveryStatus: 'delivered' };
  renderPage();
  await loaded();
  expect(
    screen.getByText('Reply delivered. Waiting for the next AI-DLC response.'),
  ).toBeInTheDocument();
  expect(screen.getByText(/Turn 1/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
});

it('keeps missing historical delivery confirmation distinct from a delivered reply', async () => {
  accept({ requestId: '', interactionId: initialInteraction.id, contentSha256: '', text: 'poc' });
  intent.execution = { ...intent.execution!, status: 'RUNNING', responsePending: false };
  interaction.response = { ...interaction.response!, deliveryStatus: 'unknown' };
  renderPage();
  await loaded();
  expect(
    screen.getByText('Reply accepted. Historical delivery confirmation is unavailable.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByText('Reply delivered. Waiting for the next AI-DLC response.'),
  ).not.toBeInTheDocument();
});

it('keeps text after a stale 409 and requires refreshed authority before any new submission', async () => {
  transport.post.mockRejectedValue(
    new ApiError(409, 'private detail', { code: 'NATIVE_EXECUTION_CONFLICT' }),
  );
  renderPage();
  await typeReply();
  await click('Send reply');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'interaction changed or a reply was already accepted',
  );
  expect(screen.getByRole('textbox')).toHaveValue('poc');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  expect(document.body).not.toHaveTextContent('private detail');
  expect(transport.post).toHaveBeenCalledTimes(1);
});

it('does not enable replies for file-question waits or stopped turns', async () => {
  intent.execution = { ...intent.execution!, status: 'WAITING_FOR_INPUT' };
  renderPage();
  await loaded();
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  intent.execution = { ...intent.execution, status: 'STOPPED', updatedAt: '2026-09-29T12:01:00Z' };
  await click('Refresh status');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
});

it('limits replies by UTF-8 bytes and never posts an empty or oversized reply', async () => {
  renderPage();
  await typeReply('🐦'.repeat(4096) + 'a');
  expect(screen.getByRole('alert')).toHaveTextContent('16 KiB');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  await typeReply(' \n ');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  expect(transport.post).not.toHaveBeenCalled();
});

it.each([
  { id: 'd'.repeat(64) },
  { publicationId: 'other-publication' },
  { sequence: 2 },
  { harness: 'kiro' },
])('rejects an interaction not bound to the current execution %j', async (patch) => {
  readInteraction.mockResolvedValue({ ...interaction, ...patch });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Published content could not be verified',
  );
  expect(screen.queryByText(messages[0].text)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(transport.post).not.toHaveBeenCalled();
});

it.each([401, 403, 404])(
  'clears all native data after interaction access denial %s',
  async (status) => {
    readInteraction.mockRejectedValue(new ApiError(status, 'private authority'));
    renderPage();
    await screen.findByText(/Native intent access is no longer available/);
    cleared();
  },
);

it('a file denial invalidates an in-flight reply acknowledgement and discards its text', async () => {
  const pending = deferred<unknown>();
  transport.post.mockReturnValueOnce(pending.promise);
  renderPage();
  await typeReply('private draft');
  await click('Send reply');
  readFile.mockRejectedValue(new ApiError(403, 'denied'));
  await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
  await click(/src\/pipe.ts/);
  await screen.findByText(/Native intent access is no longer available/);
  cleared();
  const request = transport.post.mock.calls[0][1];
  await act(async () => pending.resolve(accept(request)));
  cleared();
  expect(document.body).not.toHaveTextContent('private draft');
});

it('a graph denial clears interaction text and ignores a late interaction refresh', async () => {
  const pending = deferred<NativeInteractionView>();
  renderPage();
  await typeReply('private draft');
  intent.execution = {
    ...intent.execution!,
    status: 'RUNNING',
    turnSequence: 2,
    updatedAt: '2026-09-29T12:01:00Z',
  };
  readInteraction.mockReturnValueOnce(pending.promise);
  await click('Refresh status');
  readGraph.mockRejectedValue(new ApiError(403, 'denied'));
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByText(/Native intent access is no longer available/);
  await act(async () => pending.resolve(initialInteraction));
  cleared();
});

it('invalidates late interaction loads on project access revision', async () => {
  const pending = deferred<NativeInteractionView>();
  readInteraction.mockReturnValueOnce(pending.promise);
  renderPage();
  await screen.findByText('Loading the published AI-DLC response…');
  await act(async () => clearNativeIntents('project-1', true));
  await act(async () => pending.resolve(initialInteraction));
  cleared();
});

it('does not retain interaction text or a draft across a session reset', async () => {
  renderPage();
  await typeReply('private draft');
  transport.get.mockReturnValueOnce(deferred<NativeIntent>().promise);
  await act(async () => resetSessionExpiry());
  cleared();
  expect(document.body).not.toHaveTextContent('private draft');
});

it('shows the actual protected reply when another member wins, retaining the unsent draft separately', async () => {
  renderPage();
  await typeReply('my unsent draft');
  accept({
    requestId: '',
    interactionId: initialInteraction.id,
    contentSha256: '',
    text: 'another member reply',
  });
  await click('Refresh status');
  await screen.findByText('A different reply was accepted. Your draft is retained below.');
  expect(screen.getByLabelText('Accepted reply')).toHaveTextContent('another member reply');
  expect(screen.getByRole('textbox')).toHaveValue('my unsent draft');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
});

it('disables ordinary replies when execution capability is disabled', async () => {
  intent.executionAvailable = false;
  renderPage();
  await loaded();
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
});

it('retains an uncertain reply without exposing raw errors from the follow-up status request', async () => {
  renderPage();
  await typeReply('private draft');
  transport.post.mockRejectedValueOnce(new ApiError(502, 'raw response secret'));
  transport.get.mockRejectedValueOnce(new ApiError(503, 'raw status secret'));
  await click('Send reply');
  expect(screen.getByRole('textbox')).toHaveValue('private draft');
  expect(screen.getByRole('button', { name: 'Retry same reply' })).toBeEnabled();
  expect(document.body).not.toHaveTextContent('secret');
  expect(
    screen.getByText('Status could not be refreshed. The last confirmed status is shown.'),
  ).toBeInTheDocument();
});

it('retries graph loading without dropping an uncertain reply or request ID', async () => {
  renderPage();
  await typeReply('keep this exact draft');
  transport.post.mockRejectedValueOnce(new ApiError(502, 'lost reply acknowledgement'));
  await click('Send reply');
  const first = transport.post.mock.calls[0];
  readGraph.mockRejectedValueOnce(new ApiError(502, 'transient graph error'));
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(screen.getByRole('textbox')).toHaveValue('keep this exact draft');
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('button', { name: 'Open response for AI-DLC turn' });
  await click('Open response for AI-DLC turn');
  await loaded();
  expect(screen.getByRole('textbox')).toHaveValue('keep this exact draft');
  await click('Retry same reply');
  expect(transport.post.mock.calls[1]).toEqual(first);
  await screen.findByText('Reply accepted. Delivery pending.');
});

it('invalidates a pending reply on session expiry', async () => {
  const pending = deferred<unknown>();
  transport.post.mockReturnValueOnce(pending.promise);
  renderPage();
  await typeReply('private draft');
  await click('Send reply');
  await act(async () => {
    armSessionExpiry();
    notifySessionExpired();
  });
  await act(async () => pending.resolve(accept(transport.post.mock.calls[0][1])));
  cleared();
});

it('a late old-run interaction cannot populate a newly navigated native intent', async () => {
  const pending = deferred<NativeInteractionView>();
  readInteraction.mockReturnValueOnce(pending.promise);
  renderPage();
  await screen.findByText('Loading the published AI-DLC response…');
  intent = { ...initial, id: 'run-2', prompt: 'Different request', execution: null };
  await userEvent.click(screen.getByRole('link', { name: 'Other run' }));
  await screen.findByText('Different request');
  await act(async () => pending.resolve(initialInteraction));
  expect(screen.queryByText(messages[0].text)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('rejects graph nodes pointing to a different interaction', async () => {
  readGraph.mockResolvedValue({
    publicationId: 'pub-1',
    nodes: [
      {
        id: 'foreign-turn',
        type: 'NativeInteraction',
        label: 'Foreign',
        interactionId: 'd'.repeat(64),
      },
    ],
    edges: [],
  });
  renderPage();
  await loaded();
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: /Open response for/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(screen.getByText(messages[0].text)).toBeInTheDocument();
});

function requireRecovery(patch: Partial<NativeExecution> = {}) {
  accept({ requestId: '', interactionId: initialInteraction.id, contentSha256: '', text: 'poc' });
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'RECOVERY_REQUIRED',
      revision: 10,
      recovery: { id: 'recovery-1', reason: 'RESTORE_FAILED', canRecover: true },
      ...patch,
    },
  };
}

function recovering(revision = 11): NativeIntent {
  return {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'RECOVERING',
      revision,
      recovery: { ...intent.execution!.recovery!, canRecover: false },
    },
  };
}

// Real WebCrypto work is not controlled by the polling clock. Flush React and
// wait for the verified content rather than assuming advancing timers loads it.
async function verifiedText(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(screen.getByText(text)).toBeInTheDocument();
  });
}

it.each(['claude', 'codex', 'kiro', 'opencode'] as const)(
  'shows a saved reply and explicit recovery for %s without enabling advanced actions',
  async (harness) => {
    requireRecovery();
    intent.harness = harness;
    interaction.harness = harness;
    renderPage();
    await loaded();
    expect(screen.getByText('Session recovery required')).toBeInTheDocument();
    expect(screen.getByText('Your reply is saved.')).toBeInTheDocument();
    expect(screen.queryByText('Continuing agent')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('poc');
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Recover session' })).toBeEnabled();
    for (const name of ['Start agent', 'Edit artifacts', 'Create unit PR', 'Delete intent'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(transport.post).not.toHaveBeenCalled();
  },
);

it('keeps committed files, graph and the same saved reply through recovery and the next turn', async () => {
  requireRecovery();
  const savedReply = structuredClone(interaction.response);
  const pending = deferred<NativeIntent>();
  transport.post.mockReturnValueOnce(pending.promise);
  renderPage();
  await loaded();
  await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
  await click(/src\/pipe.ts/);
  await screen.findByText('pipe');
  await click('Recover session');
  await click('Requesting recovery…');
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(transport.post.mock.calls[0]).toEqual([
    '/projects/project-1/native-intents/run-1/recover',
    { requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), recoveryId: 'recovery-1' },
  ]);
  intent = recovering();
  await act(async () => pending.resolve(intent));
  expect(screen.getByText('Restoring session')).toBeInTheDocument();
  expect(screen.getByText('pipe')).toBeInTheDocument();
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('button', { name: 'Open response for AI-DLC turn' });
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(await loaded()).toHaveValue('poc');
  expect(screen.getByText('Your reply is saved.')).toBeInTheDocument();
  expect(interaction.response).toEqual(savedReply);
  expect(intent.execution?.turnSequence).toBe(2);

  intent = {
    ...intent,
    execution: { ...intent.execution!, status: 'RUNNING', revision: 12, recovery: null },
  };
  await click('Refresh status');
  expect(screen.getByText('Agent running')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  publication = { ...publication, id: 'pub-2', sequence: 2 };
  interaction = {
    ...interaction,
    id: 'b'.repeat(64),
    publicationId: 'pub-2',
    sequence: 2,
    response: null,
  };
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'AWAITING_USER',
      revision: 13,
      publicationId: 'pub-2',
      interactionId: interaction.id,
      responsePending: false,
    },
  };
  await click('Refresh status');
  expect(await loaded()).toHaveValue('');
  expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
  expect(transport.post).toHaveBeenCalledTimes(1);
});

it('retries an uncertain recovery with the same request without resending the accepted reply', async () => {
  requireRecovery();
  transport.post.mockRejectedValueOnce(
    new ApiError(502, 'private token', { stack: 'private stack' }),
  );
  transport.post.mockImplementationOnce(async () => (intent = recovering()));
  renderPage();
  await loaded();
  await click('Recover session');
  const first = transport.post.mock.calls[0];
  expect(document.body).not.toHaveTextContent('private token');
  expect(document.body).not.toHaveTextContent('private stack');
  expect(screen.getByRole('textbox')).toHaveValue('poc');
  await click('Recover session');
  expect(transport.post.mock.calls[1]).toEqual(first);
  expect(screen.getByText('Restoring session')).toBeInTheDocument();
  expect(transport.post.mock.calls.every(([path]) => path.endsWith('/recover'))).toBe(true);
});

it('retains an uncertain reply across recovery without claiming it was saved or resending it', async () => {
  transport.post.mockRejectedValueOnce(new ApiError(502, 'unconfirmed'));
  renderPage();
  await typeReply('uncertain private reply');
  await click('Send reply');
  expect(screen.getByRole('button', { name: 'Retry same reply' })).toBeEnabled();
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'RECOVERY_REQUIRED',
      revision: 10,
      recovery: { id: 'recovery-1', reason: 'RESTORE_FAILED', canRecover: true },
    },
  };
  await click('Refresh status');
  expect(screen.getByRole('textbox')).toHaveValue('uncertain private reply');
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Retry same reply' })).toBeDisabled();
  expect(screen.queryByText('Your reply is saved.')).not.toBeInTheDocument();
  transport.post.mockImplementationOnce(async () => (intent = recovering()));
  await click('Recover session');
  expect(transport.post.mock.calls[1]).toEqual([
    '/projects/project-1/native-intents/run-1/recover',
    { requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), recoveryId: 'recovery-1' },
  ]);
  expect(screen.getByRole('textbox')).toHaveValue('uncertain private reply');
  expect(transport.post).toHaveBeenCalledTimes(2);
});

it.each([
  { recovery: undefined },
  { recovery: null },
  { revision: undefined },
  { recovery: { id: 'recovery-1', reason: 'CHECKPOINT_UNAVAILABLE', canRecover: false } },
] satisfies Partial<NativeExecution>[])(
  'keeps recovery view-only when capability evidence is absent %#',
  async (patch) => {
    requireRecovery(patch);
    renderPage();
    await loaded();
    expect(screen.getByText('Session recovery required')).toBeInTheDocument();
    expect(screen.getByText('Your reply is saved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(transport.post).not.toHaveBeenCalled();
  },
);

it('does not offer recovery when execution is disabled', async () => {
  requireRecovery();
  intent.executionAvailable = false;
  renderPage();
  await loaded();
  expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
  expect(transport.post).not.toHaveBeenCalled();
});

it.each(['claude', 'codex', 'kiro', 'opencode'] as const)(
  'follows server-led recovery for %s through the next turn without any POST',
  async (harness) => {
    vi.useFakeTimers();
    requireRecovery({ status: 'DISPATCHING', revision: 9, recovery: null });
    intent.harness = harness;
    interaction.harness = harness;
    const savedReply = structuredClone(interaction.response);
    await act(async () => renderPage());
    expect(screen.getByText('Continuing agent')).toBeInTheDocument();
    await verifiedText('Reply accepted. Delivery pending.');
    intent = {
      ...intent,
      execution: {
        ...intent.execution!,
        status: 'RECOVERING',
        revision: 10,
        recovery: { id: 'recovery-1', reason: 'SESSION_LOST', canRecover: false },
        responsePending: true,
      },
    };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('Restoring session')).toBeInTheDocument();
    await verifiedText('Your reply is saved.');
    expect(screen.queryByText('Continuing agent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(savedReply!.text);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(interaction.response).toEqual(savedReply);
    expect(screen.getByText(/Current committed revision 1/)).toBeInTheDocument();

    intent = {
      ...intent,
      execution: {
        ...intent.execution!,
        status: 'RUNNING',
        revision: 11,
        recovery: null,
        responsePending: false,
      },
    };
    interaction.response = { ...savedReply!, deliveryStatus: 'delivered' };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('Agent running')).toBeInTheDocument();
    await verifiedText('Reply delivered. Waiting for the next AI-DLC response.');
    expect(screen.getByRole('textbox')).toHaveValue(savedReply!.text);
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(interaction.response.id).toBe(savedReply!.id);
    expect(intent.execution?.turnSequence).toBe(2);

    publication = { ...publication, id: 'pub-2', sequence: 2 };
    interaction = {
      ...interaction,
      id: 'b'.repeat(64),
      publicationId: 'pub-2',
      sequence: 2,
      response: null,
    };
    intent = {
      ...intent,
      execution: {
        ...intent.execution!,
        status: 'AWAITING_USER',
        revision: 12,
        publicationId: publication.id,
        interactionId: interaction.id,
      },
    };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('Awaiting your reply')).toBeInTheDocument();
    await verifiedText(messages[0].text);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
    expect(transport.post).not.toHaveBeenCalled();
  },
);

it.each([
  ['SESSION_LOST', 'The saved AI-DLC session needs to be restored'],
  ['CHECKPOINT_UNAVAILABLE', 'A verified recovery checkpoint is unavailable'],
  ['DELIVERY_UNCERTAIN', 'The last command may have executed'],
  ['RESTORE_FAILED', 'The session could not be restored'],
] as const)(
  'keeps %s blocked without a recovery capability and never posts automatically',
  async (reason, explanation) => {
    vi.useFakeTimers();
    requireRecovery({
      recovery: { id: 'recovery-1', reason, canRecover: false },
      responsePending: true,
    });
    await act(async () => renderPage());
    expect(screen.getByText('Session recovery required')).toBeInTheDocument();
    expect(screen.getByText(explanation, { exact: false })).toBeInTheDocument();
    await verifiedText('Your reply is saved.');
    await act(async () => vi.advanceTimersByTimeAsync(18000));
    expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('poc');
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(transport.post).not.toHaveBeenCalled();
  },
);

it('offers a manual retry only after the server publishes RESTORE_FAILED with canRecover', async () => {
  vi.useFakeTimers();
  requireRecovery({
    status: 'RECOVERING',
    recovery: { id: 'recovery-1', reason: 'SESSION_LOST', canRecover: false },
  });
  await act(async () => renderPage());
  expect(screen.getByText('Restoring session')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
  intent = {
    ...intent,
    execution: {
      ...intent.execution!,
      status: 'RECOVERY_REQUIRED',
      revision: 11,
      recovery: { id: 'recovery-1', reason: 'RESTORE_FAILED', canRecover: true },
      responsePending: true,
    },
  };
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(screen.getByText('Session recovery required')).toBeInTheDocument();
  await verifiedText('Your reply is saved.');
  expect(screen.getByRole('button', { name: 'Recover session' })).toBeEnabled();
  expect(transport.post).not.toHaveBeenCalled();
  transport.post.mockImplementationOnce(async () => (intent = recovering(12)));
  await click('Recover session');
  expect(transport.post.mock.calls).toEqual([
    [
      '/projects/project-1/native-intents/run-1/recover',
      { requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), recoveryId: 'recovery-1' },
    ],
  ]);
  expect(screen.getByText('Restoring session')).toBeInTheDocument();
  expect(screen.getByText('Your reply is saved.')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('poc');
});

it.each([9, undefined])(
  'rejects a stale status with revision %s after a newer recovery revision',
  async (revision) => {
    requireRecovery();
    renderPage();
    await loaded();
    const stale = {
      ...intent,
      execution: { ...intent.execution!, revision, updatedAt: '2027-01-01T00:00:00Z' },
    };
    intent = recovering();
    intent.execution!.updatedAt = '2026-09-29T11:00:00Z';
    await click('Refresh status');
    expect(screen.getByText('Restoring session')).toBeInTheDocument();
    intent = stale;
    await click('Refresh status');
    expect(screen.getByText('Restoring session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover session' })).not.toBeInTheDocument();
  },
);

it('ignores a late recovery acknowledgement after newer execution progress', async () => {
  requireRecovery();
  const pending = deferred<NativeIntent>();
  const ack = recovering();
  transport.post.mockReturnValueOnce(pending.promise);
  renderPage();
  await loaded();
  await click('Recover session');
  intent = {
    ...intent,
    execution: { ...intent.execution!, status: 'RUNNING', revision: 12, recovery: null },
  };
  await click('Refresh status');
  expect(screen.getByText('Agent running')).toBeInTheDocument();
  await act(async () => pending.resolve(ack));
  expect(screen.getByText('Agent running')).toBeInTheDocument();
  expect(screen.queryByText('Restoring session')).not.toBeInTheDocument();
});

it('refreshes a stale recovery episode and uses a new identity only after another explicit click', async () => {
  requireRecovery();
  transport.post.mockImplementationOnce(async () => {
    intent = {
      ...intent,
      execution: {
        ...intent.execution!,
        revision: 11,
        recovery: { id: 'recovery-2', reason: 'RESTORE_FAILED', canRecover: true },
      },
    };
    throw new ApiError(409, 'private detail', { code: 'NATIVE_EXECUTION_CONFLICT' });
  });
  transport.post.mockImplementationOnce(async () => (intent = recovering(12)));
  renderPage();
  await loaded();
  await click('Recover session');
  expect(transport.post).toHaveBeenCalledTimes(1);
  await click('Recover session');
  const first = transport.post.mock.calls[0][1];
  const second = transport.post.mock.calls[1][1];
  expect(first.recoveryId).toBe('recovery-1');
  expect(second.recoveryId).toBe('recovery-2');
  expect(second.requestId).not.toBe(first.requestId);
  expect(transport.post.mock.calls.every(([path]) => path.endsWith('/recover'))).toBe(true);
});

it.each(['access-revision', 'session-expiry', 'file-denial'] as const)(
  'invalidates a pending recovery and all published data on %s',
  async (boundary) => {
    requireRecovery();
    const pending = deferred<NativeIntent>();
    const ack = recovering();
    transport.post.mockReturnValueOnce(pending.promise);
    renderPage();
    await loaded();
    await click('Recover session');
    if (boundary === 'access-revision') {
      await act(async () => clearNativeIntents('project-1', true));
    } else if (boundary === 'session-expiry') {
      await act(async () => notifySessionExpired());
    } else {
      readFile.mockRejectedValue(new ApiError(403, 'denied'));
      await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
      await click(/src\/pipe.ts/);
      await screen.findByText(/Native intent access is no longer available/);
    }
    cleared();
    await act(async () => pending.resolve(ack));
    cleared();
    expect(screen.queryByText('Your reply is saved.')).not.toBeInTheDocument();
    expect(transport.post).toHaveBeenCalledTimes(1);
  },
);

it.each([401, 403, 404])(
  'clears native content when recovery is denied with %s',
  async (status) => {
    requireRecovery();
    transport.post.mockRejectedValue(new ApiError(status, 'private denial'));
    renderPage();
    await loaded();
    await click('Recover session');
    cleared();
    expect(screen.queryByText('Your reply is saved.')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private denial');
    expect(transport.post).toHaveBeenCalledTimes(1);
  },
);
