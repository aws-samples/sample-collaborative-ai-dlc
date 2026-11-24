import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import { ApiError } from '@/services/api';
import type {
  NativeIntent,
  NativeInteractionView,
  NativeUserReply,
} from '@/services/nativeIntents';
import {
  expireDocument,
  openedDocuments,
  resetCollaborationFakes,
} from '@/test/collaborationFakes';
import { AppShell } from './AppShell';
import IntentView from '@/pages/IntentView';
// @ts-expect-error Exercise the real backend output producer; no frontend production import.
import { createNativeActivityLog } from '../../../../lambda/agentcore/native/activity.js';

// Task-2 shared collaboration on the real native shell: two signed-in members
// render the deployed providers/page; only service boundaries and the Yjs
// transport (an in-memory relay with server-side retention) are replaced.
const service = vi.hoisted(() => ({
  get: vi.fn(),
  outputs: vi.fn(),
  list: vi.fn(),
  publication: vi.fn(),
  interaction: vi.fn(),
  file: vi.fn(),
  graph: vi.fn(),
  respond: vi.fn(),
  handlers: new Map<string, Set<(value: any) => void>>(),
  connect: vi.fn(async () => {}),
}));
const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const who = vi.hoisted(() => ({
  current: { userId: 'ada', username: 'ada', displayName: 'Ada', groups: [] as string[] },
}));
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api')>()),
  api: transport,
}));
vi.mock('@/services/nativeIntents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeIntents')>()),
  nativeIntentsService: service,
}));
vi.mock('@/services/auth', () => ({
  authService: {
    isAuthenticated: async () => true,
    getCurrentUser: async () => ({ ...who.current }),
  },
}));
vi.mock('@/services/projects', () => ({
  projectsService: { list: async () => [], listMembers: async () => [] },
}));
vi.mock('@/services/realtime', () => {
  const subscribe = (name: string, fn: (value: any) => void) => {
    const set = service.handlers.get(name) ?? new Set();
    set.add(fn);
    service.handlers.set(name, set);
    return () => {
      set.delete(fn);
    };
  };
  return {
    realtimeService: {
      connect: service.connect,
      disconnect: vi.fn(),
      getStatus: () => 'connected',
      on: subscribe,
      onStatusChange: (fn: (value: any) => void) => subscribe('status', fn),
    },
  };
});

const time = '2026-10-01T00:00:00Z';
const INTERACTION = 'c'.repeat(64);
const DIGEST = createHash('sha256')
  .update(JSON.stringify(['project', 'one']))
  .digest('hex');
const REPLY_DOC = `native-reply-${DIGEST}-${INTERACTION}-2`;
const FILE = {
  id: `nf-${'d'.repeat(64)}`,
  path: 'docs/plan.md',
  bytes: 22,
  sha256: 'e'.repeat(64),
  role: 'artifact',
  mediaType: 'text/markdown',
};
const messages = [{ type: 'text' as const, text: 'How wide should the pipe gap be?' }];
const contentSha256 = createHash('sha256').update(JSON.stringify(messages)).digest('hex');

const waiting = (
  overrides: Partial<NonNullable<NativeIntent['execution']>> = {},
): NativeIntent => ({
  id: 'one',
  projectId: 'project',
  executionBackend: 'native',
  title: 'Moving pipes',
  prompt: 'Add pipes',
  harness: 'codex',
  status: 'READY',
  executionAvailable: true,
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: time,
  updatedAt: time,
  execution: {
    recoveryMode: 'efs-workspace-v1',
    status: 'AWAITING_USER',
    revision: 9,
    imageStatus: 'retained',
    attemptId: 'attempt',
    epoch: 1,
    startedAt: time,
    updatedAt: time,
    model: 'fixed-model',
    repository: {
      provider: 'github',
      repository: 'JWThewes/flappy-bird',
      branch: 'main',
      commit: null,
    },
    publicationId: 'publication',
    projectionStatus: 'complete',
    interactionId: INTERACTION,
    turnSequence: 2,
    responsePending: false,
    ...overrides,
  },
});
const interaction = (
  response: NativeUserReply | null = null,
  id = INTERACTION,
): NativeInteractionView => ({
  id,
  sequence: 2,
  kind: 'assistant_turn',
  harness: 'codex',
  publicationId: 'publication',
  messages,
  contentSha256,
  createdAt: time,
  response,
});
const receipt = (text: string): NativeUserReply => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'user_reply',
  interactionId: INTERACTION,
  sequence: 3,
  actorId: 'ada',
  text,
  acceptedAt: time,
  deliveryStatus: 'pending',
});

function member(name: string, entry = '/space/project/native-intent/one') {
  who.current = {
    userId: name.toLowerCase(),
    username: name.toLowerCase(),
    displayName: name,
    groups: [],
  };
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/space/:projectId/native-intent/:intentId/*" element={<IntentView />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );
}
const replyBox = async (view: ReturnType<typeof render>) => {
  const box = await within(view.container).findByRole('textbox', { name: 'Reply to AI-DLC' });
  await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
  return box;
};

beforeEach(() => {
  vi.stubGlobal('localStorage', window.localStorage);
  // jsdom lacks the layout APIs the real discussion thread uses.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
  service.handlers.clear();
  localStorage.clear();
  resetSessionExpiry();
  clearNativeIntents();
  invalidateProjects();
  resetCollaborationFakes();
  service.get.mockResolvedValue(waiting());
  service.outputs.mockResolvedValue({ outputs: [], nextAfter: null });
  service.list.mockResolvedValue({ items: [], enabled: true });
  service.publication.mockResolvedValue({
    id: 'publication',
    sequence: 2,
    createdAt: time,
    files: [FILE],
    question: null,
    projectionStatus: 'complete',
  });
  service.interaction.mockResolvedValue(interaction());
  service.file.mockResolvedValue({
    ...FILE,
    publicationId: 'publication',
    encoding: 'utf8',
    content: '# Plan\nGap 120px\n',
  });
  service.graph.mockResolvedValue({ publicationId: 'publication', nodes: [], edges: [] });
  transport.get.mockImplementation(async (path: string) =>
    path.endsWith('/discussions') ? [] : { messages: [], hasMore: false },
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared native reply drafts', () => {
  it('renders real runtime phase notices without admitting an unverified next question', async () => {
    const accepted = { ...receipt('Use a 120px gap.'), deliveryStatus: 'delivered' as const };
    service.get.mockResolvedValue(
      waiting({ status: 'RUNNING', turnSequence: 3, revision: 11, responsePending: false }),
    );
    service.interaction.mockResolvedValue(interaction(accepted));
    const log = createNativeActivityLog({
      writerGeneration: 1,
      now: () => Date.parse(time) + 1000,
    });
    const turn = log.turn({ sequence: 3, harness: 'claude' });
    turn.lifecycle({ title: 'Saving recovery checkpoint' });
    turn.lifecycle({ title: 'Checkpoint uploaded; awaiting publication verification' });
    const records = log.pull().events;
    expect(records).toHaveLength(2);
    service.outputs.mockResolvedValueOnce({
      outputs: records.map((record: any) => ({
        seq: record.index,
        stageInstanceId: null,
        kind: record.kind,
        content: record.content,
        timestamp: new Date(record.capturedAt).toISOString(),
        display: record.display,
      })),
      nextAfter: null,
      events: [],
      nextEventAfter: null,
    });
    const view = member('Ada');
    const progress = await within(view.container).findByRole('region', { name: 'Reply progress' });
    await waitFor(() =>
      expect(progress).toHaveTextContent(
        'Last runtime update: Checkpoint uploaded; awaiting publication verification',
      ),
    );
    expect(progress).toHaveTextContent('Reply delivered.');
    expect(within(view.container).getByRole('textbox')).toHaveAttribute('readonly');
    expect(within(view.container).getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(service.respond).not.toHaveBeenCalled();
    expect(service.outputs).toHaveBeenCalledWith('project', 'one', 0, 0);
    turn.close();
  });
  it('shows three minutes of quiet runtime waiting using the existing pollers, then prioritizes the admitted form', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    const view = member('Ada');
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        within(view.container).getByRole('textbox', { name: 'Reply to AI-DLC' }),
      ).not.toHaveAttribute('readonly');
    });
    const accepted = receipt('Use a 120px gap.');
    let execution = waiting({
      status: 'DISPATCHING',
      responsePending: true,
      turnSequence: 3,
      revision: 10,
    });
    service.get.mockImplementation(async () => execution);
    service.interaction.mockResolvedValue(interaction(accepted));
    service.respond.mockResolvedValue({ execution: execution.execution, response: accepted });
    fireEvent.change(within(view.container).getByRole('textbox', { name: 'Reply to AI-DLC' }), {
      target: { value: accepted.text },
    });
    await act(async () =>
      fireEvent.click(within(view.container).getByRole('button', { name: 'Send reply' })),
    );
    const progress = () => within(view.container).getByRole('region', { name: 'Reply progress' });
    expect(progress()).toHaveTextContent('Reply accepted. Delivery pending.');

    execution = waiting({
      status: 'RUNNING',
      responsePending: false,
      turnSequence: 3,
      revision: 11,
    });
    service.interaction.mockResolvedValue(
      interaction({ ...accepted, deliveryStatus: 'delivered' }),
    );
    service.outputs.mockResolvedValueOnce({
      outputs: [
        {
          seq: 1,
          stageInstanceId: null,
          kind: 'stdout',
          timestamp: time,
          content: 'private tool arguments never belong in a progress card',
          display: { type: 'tool', details: 'private detail' },
        },
      ],
      nextAfter: null,
      events: [
        {
          revision: 11,
          eventId: 'native-11',
          type: 'native.running',
          timestamp: time,
          summary: 'Turn 3 · writer 1: Runtime delivery confirmed',
          stageInstanceId: null,
          actor: null,
        },
      ],
      nextEventAfter: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(progress()).toHaveTextContent('Reply delivered. Waiting for the next AI-DLC response.');
    const before = {
      reads: service.get.mock.calls.length,
      activity: service.outputs.mock.calls.length,
    };
    for (let i = 0; i < 60; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    expect(progress()).toHaveTextContent('Waiting since reply acceptance: 3m');
    expect(progress()).toHaveTextContent('Execution update last observed 3m');
    expect(progress()).toHaveTextContent('Activity checked');
    expect(progress()).not.toHaveTextContent(/private|model thinking|complete|outdated/);
    expect(service.outputs.mock.calls.length - before.activity).toBe(90);
    expect(service.get.mock.calls.length - before.reads).toBe(60);
    expect(service.outputs).toHaveBeenLastCalledWith('project', 'one', 1, 11);
    expect(service.respond).toHaveBeenCalledTimes(1);

    service.outputs.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(progress()).toHaveTextContent('Activity has not refreshed recently');
    const stalledCalls = service.outputs.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(service.outputs).toHaveBeenCalledTimes(stalledCalls);
    expect(service.respond).toHaveBeenCalledTimes(1);

    // A next interaction is admitted by execution/publication, regardless of a
    // stalled activity transport. It has an empty draft and requires a new click.
    const next = 'f'.repeat(64);
    execution = waiting({ interactionId: next, turnSequence: 3, revision: 12 });
    service.publication.mockResolvedValue({
      id: 'publication',
      sequence: 3,
      createdAt: time,
      files: [],
      question: null,
      projectionStatus: 'complete',
    });
    service.interaction.mockResolvedValue({
      ...interaction(null, next),
      sequence: 3,
      messages: [{ type: 'text', text: 'Confirm the next required human decision.' }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => {
      expect(progress()).toHaveTextContent('A member reply is needed.');
      expect(within(view.container).getByRole('textbox', { name: 'Reply to AI-DLC' })).toHaveValue(
        '',
      );
    });
    const box = within(view.container).getByRole('textbox', { name: 'Reply to AI-DLC' });
    const response = within(view.container).getByText('Confirm the next required human decision.');
    expect(response.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(view.container).getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(service.respond).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('two members edit one revision-specific draft with presence, and both see the one accepted answer', async () => {
    const ada = member('Ada');
    const adaBox = await replyBox(ada);
    const grace = member('Grace');
    const graceBox = await replyBox(grace);

    for (const view of [ada, grace]) {
      expect(
        within(view.container).getByRole('status', { name: 'Intent status' }),
      ).toHaveTextContent('Awaiting member reply');
      expect(
        within(view.container).getByRole('region', { name: 'Reply progress' }),
      ).toHaveTextContent('A member reply is needed.');
    }
    // Exactly this interaction/turn's document, with its revision-specific token target.
    expect(new Set(openedDocuments.map((d) => d.documentId))).toEqual(new Set([REPLY_DOC]));
    for (const opened of openedDocuments) {
      expect(opened.target).toEqual({
        projectId: 'project',
        intentId: 'one',
        executionBackend: 'native',
        document: { kind: 'reply', interactionId: INTERACTION, sequence: 2 },
      });
    }
    fireEvent.change(adaBox, { target: { value: 'Use a 120px gap.' } });
    await waitFor(() => expect(graceBox).toHaveValue('Use a 120px gap.'));
    fireEvent.change(graceBox, { target: { value: 'Use a 120px gap, narrowing over time.' } });
    await waitFor(() => expect(adaBox).toHaveValue('Use a 120px gap, narrowing over time.'));
    expect(within(ada.container).getByLabelText('Also editing: Grace')).toBeInTheDocument();
    expect(within(grace.container).getByLabelText('Also editing: Ada')).toBeInTheDocument();

    // Ada submits the shared value; the protected request carries exactly it.
    const accepted = receipt('Use a 120px gap, narrowing over time.');
    service.respond.mockResolvedValue({
      execution: waiting({
        status: 'DISPATCHING',
        responsePending: true,
        turnSequence: 3,
        revision: 10,
      }).execution,
      response: accepted,
    });
    fireEvent.click(within(ada.container).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(service.respond).toHaveBeenCalledTimes(1));
    const [, , request] = service.respond.mock.calls[0];
    expect(request).toMatchObject({
      interactionId: INTERACTION,
      contentSha256,
      text: 'Use a 120px gap, narrowing over time.',
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);

    // Grace's view refreshes to the same protected receipt; nobody can submit again.
    service.get.mockResolvedValue(
      waiting({ status: 'DISPATCHING', responsePending: true, turnSequence: 3, revision: 10 }),
    );
    service.interaction.mockResolvedValue(interaction(accepted));
    fireEvent.click(within(grace.container).getByRole('button', { name: 'Refresh status' }));
    await within(grace.container).findByText('Reply accepted. Delivery pending.');
    await within(ada.container).findByText('Reply accepted. Delivery pending.');
    for (const view of [ada, grace]) {
      expect(
        within(view.container).getByRole('status', { name: 'Intent status' }),
      ).toHaveTextContent('Continuing agent');
      expect(within(view.container).queryByText('Awaiting member reply')).toBeNull();
      expect(within(view.container).getByRole('textbox', { name: 'Reply to AI-DLC' })).toHaveValue(
        accepted.text,
      );
      expect(within(view.container).getByRole('button', { name: 'Send reply' })).toBeDisabled();
    }
    expect(service.respond).toHaveBeenCalledTimes(1);
  });

  it("a changed interaction gets a new draft; the old turn's text is never carried over", async () => {
    const view = member('Ada');
    fireEvent.change(await replyBox(view), { target: { value: 'Answer for turn two.' } });
    // The workflow advanced: a new interaction/turn is awaiting a reply.
    const next = 'f'.repeat(64);
    service.get.mockResolvedValue(waiting({ interactionId: next, turnSequence: 3, revision: 12 }));
    service.publication.mockResolvedValue({
      id: 'publication-3',
      sequence: 3,
      createdAt: time,
      files: [FILE],
      question: null,
      projectionStatus: 'complete',
    });
    service.interaction.mockResolvedValue({
      ...interaction(null, next),
      sequence: 3,
      publicationId: 'publication-3',
    });
    service.get.mockResolvedValue({
      ...waiting({ interactionId: next, turnSequence: 3, revision: 12 }),
      execution: {
        ...waiting().execution!,
        interactionId: next,
        turnSequence: 3,
        revision: 12,
        publicationId: 'publication-3',
      },
    });
    fireEvent.click(within(view.container).getByRole('button', { name: 'Refresh status' }));
    await waitFor(() =>
      expect(openedDocuments.map((d) => d.documentId)).toContain(
        `native-reply-${DIGEST}-${next}-3`,
      ),
    );
    expect(await replyBox(view)).toHaveValue('');
    expect(openedDocuments.find((d) => d.documentId.endsWith(`${next}-3`))?.target).toMatchObject({
      document: { interactionId: next, sequence: 3 },
    });
  });

  it('keeps a draft through reconnects within the Yjs lifecycle, but not after every client leaves and it expires', async () => {
    let view = member('Ada');
    fireEvent.change(await replyBox(view), { target: { value: 'Draft kept while retained.' } });
    view.unmount();
    view = member('Ada');
    expect(await replyBox(view)).toHaveValue('Draft kept while retained.');
    view.unmount();
    // Last client gone and the server grace period elapsed: not durable.
    expireDocument(REPLY_DOC);
    view = member('Ada');
    expect(await replyBox(view)).toHaveValue('');
  });
});

describe('native graph source links in the shared Intent shell', () => {
  const route = '/space/project/native-intent/one';
  const base = '/projects/project/native-intents/one';
  const text = '\uFEFF# Plan\r\n## Scope\r\nRetain the original 🐦.\r\n## Next\r\n';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const path = 'aidlc/spaces/default/intents/261013-request/inception/application-design/plan.md';
  const file = {
    ...FILE,
    path,
    id: `nf-${digest(JSON.stringify({ executionId: 'one', path, projectId: 'project' }))}`,
    bytes: Buffer.byteLength(text),
    sha256: digest(text),
  };
  const context = {
    projectId: 'project',
    executionId: 'one',
    attemptId: '11111111-1111-4111-8111-111111111111',
    epoch: 1,
    packageId: `sha256:${'e'.repeat(64)}`,
  };
  const revision = {
    id: 'a'.repeat(64),
    sequence: 1,
    files: [file],
    question: null,
    createdAt: time,
    context,
    outcome: 'STOPPED',
    interactionId: null,
  };
  const query = `publicationId=${revision.id}&publicationSequence=1`;
  const fileRead = `${base}/files/${file.id}?${query}&sha256=${file.sha256}`;
  const href = `${route}?nativeRevision=1.${revision.id}&nativeFile=${file.id}%3A${file.sha256}`;
  const provenance = {
    contract: 'native-trace-v1',
    method: 'deterministic',
    projectId: context.projectId,
    executionId: context.executionId,
    packageId: context.packageId,
    publicationId: revision.id,
    publicationSequence: 1,
    fileId: file.id,
    sha256: file.sha256,
    path,
    revisionId: `${file.id}:${file.sha256}`,
  };
  const artifact = {
    id: file.id,
    type: 'Artifact',
    label: path,
    artifactId: file.id,
    path,
    sha256: file.sha256,
    publicationId: revision.id,
  };
  const section = {
    ...artifact,
    id: 'section',
    type: 'Section',
    label: 'Scope',
    provenance: { ...provenance, sourceKind: 'markdown-section', startLine: 2, endLine: 3 },
  };
  const graph = {
    publicationId: revision.id,
    nodes: [
      {
        id: 'intent',
        type: 'Intent',
        label: 'Moving pipes',
        executionBackend: 'native',
        intentId: 'one',
      },
      artifact,
      section,
      {
        ...artifact,
        id: 'stage',
        type: 'NativeStage',
        label: 'application-design',
        provenance: {
          ...provenance,
          sourceKind: 'record-path',
          locationContract: 'native-record-layout-v1',
        },
      },
    ],
    edges: [
      { source: 'intent', target: file.id, label: 'CONTAINS' },
      { source: 'intent', target: section.id, label: 'CONTAINS' },
      { source: 'intent', target: 'stage', label: 'CONTAINS' },
      { source: file.id, target: section.id, label: 'HAS_SECTION' },
    ],
  };
  const rawFile = {
    fileId: file.id,
    path,
    bytes: file.bytes,
    mediaType: file.mediaType,
    sha256: file.sha256,
    publicationId: revision.id,
    publicationSequence: 1,
    encoding: 'utf8',
    content: text,
    truncated: false,
  };

  async function fixture() {
    const { nativeIntentsService } = await vi.importActual<
      typeof import('@/services/nativeIntents')
    >('@/services/nativeIntents');
    service.publication.mockImplementation(nativeIntentsService.publication);
    service.graph.mockImplementation(nativeIntentsService.graph);
    const current = {
      id: revision.id,
      sequence: 1,
      createdAt: time,
      files: [file],
      question: null,
      projectionStatus: 'complete',
    };
    service.get.mockImplementation(async () =>
      waiting({
        status: 'STOPPED',
        attemptId: context.attemptId,
        interactionId: null,
        publicationId: current.id,
        publicationSequence: current.sequence,
      }),
    );
    const read = vi.fn(async (request: string): Promise<unknown> => {
      if (request === `${base}/publication`) return current;
      if (request === `${base}/graph`) return graph;
      if (request === `${base}/publication?history=1`)
        return {
          items: [current, ...(current.sequence > 1 ? [revision] : [])].map(({ id, sequence }) => ({
            id,
            sequence,
            outcome: 'STOPPED',
            filesCount: 1,
            epoch: 1,
            admittedAt: Date.parse(time),
            interactionId: null,
          })),
          nextBefore: null,
          gaps: [],
        };
      if (request === `${base}/publication?${query}`) return revision;
      if (request === `${base}/interaction?${query}`) return { interaction: null, answer: null };
      if (request === fileRead) return rawFile;
      if (request.endsWith('/discussions')) return [];
      throw new Error('Unavailable in fixture');
    });
    transport.get.mockImplementation(read);
    return { current, read };
  }

  it('follows a section and reopens its copied file link as a second member after the same path changes', async () => {
    const { current, read } = await fixture();
    const first = member('Member A');
    fireEvent.click(await screen.findByRole('button', { name: 'Graph' }));
    const source = await screen.findByRole('link', { name: 'Open file for Scope' });
    const copied = source.getAttribute('href')!;
    expect(copied).toBe(`${href}#L2-L3`);
    expect(screen.getByRole('link', { name: 'Open file for application-design' })).toHaveAttribute(
      'href',
      href,
    );
    expect(screen.getByRole('link', { name: `Open file for ${path}` })).toHaveAttribute(
      'href',
      href,
    );
    fireEvent.click(within(source).getByText('Scope'));
    expect(await screen.findByRole('region', { name: 'Lines 2–3' })).toHaveTextContent(
      'Retain the original 🐦.',
    );
    expect(screen.getByRole('link', { name: 'Link to file revision' })).toHaveAttribute(
      'href',
      copied,
    );
    expect(read).toHaveBeenCalledWith(fileRead);
    first.unmount();
    resetSessionExpiry();
    current.id = 'b'.repeat(64);
    current.sequence = 2;
    current.files = [{ ...file, sha256: digest('Replacement'), bytes: 11 }];
    read.mockClear();
    member('Member B', copied);
    await screen.findByRole('link', { name: 'Open publication 2' });
    const reopened = await screen.findByRole('region', { name: 'Lines 2–3' });
    expect(reopened.querySelector('code')?.textContent).toBe('## Scope\nRetain the original 🐦.');
    expect(screen.getByRole('heading', { name: 'Publication 1 · historical view' })).toBeVisible();
    expect(read).toHaveBeenCalledWith(fileRead);
    expect(read).not.toHaveBeenCalledWith(`${base}/publication`);
    expect(read).not.toHaveBeenCalledWith(`${base}/graph`);
    expect(service.file).not.toHaveBeenCalled();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('offers the same source when a member inspects a section through a graph relationship', async () => {
    await fixture();
    member('Member A');
    fireEvent.click(await screen.findByRole('button', { name: 'Graph' }));
    const canvas = within(screen.getByRole('region', { name: 'Knowledge graph' }));
    fireEvent.click(await canvas.findByText('Moving pipes'));
    fireEvent.click(canvas.getByRole('button', { name: /Scope.*Section/i }));
    expect(canvas.getByText('Lines 2–3 (markdown-section)')).toBeVisible();
    expect(canvas.getByRole('link', { name: 'Open published source' })).toHaveAttribute(
      'href',
      `${href}#L2-L3`,
    );
  });

  it.each(['foreign revision', 'changed digest', 'revoked access', 'missing receipt'])(
    'withholds source bytes for %s when reopening a graph link',
    async (failure) => {
      const { read } = await fixture();
      transport.get.mockImplementation(async (request: string) => {
        if (request === `${base}/publication?${query}` && failure === 'foreign revision')
          return { ...revision, context: { ...context, projectId: 'other' } };
        if (request === `${base}/publication?${query}` && failure === 'missing receipt')
          throw new ApiError(404, 'Revision unavailable', {
            code: 'NATIVE_ARTIFACT_REVISION_INVALID',
          });
        if (request === fileRead && failure === 'changed digest')
          return { ...rawFile, content: text.replace('original', 'modified') };
        if (request === fileRead && failure === 'revoked access')
          throw new ApiError(403, 'Access revoked');
        return read(request);
      });
      member('Member B', href);
      await screen.findByText(
        failure === 'revoked access'
          ? /Native intent access is no longer available/
          : /revision or its history is unavailable/,
      );
      expect(screen.queryByRole('region', { name: `File ${path}` })).not.toBeInTheDocument();
      expect(screen.queryByText(/Retain the modified/)).not.toBeInTheDocument();
      if (failure === 'foreign revision' || failure === 'missing receipt')
        expect(transport.get).not.toHaveBeenCalledWith(fileRead);
      expect(service.file).not.toHaveBeenCalled();
    },
  );
});

describe('native artifact discussion and Quorum', () => {
  it('opens a thread for the exact displayed revision on the native API and asks Quorum about it', async () => {
    const thread = {
      id: 'disc-0f8fad5b-d9cb-469f-a165-70867728950e',
      title: null,
      entityType: 'artifact',
      entityId: `${FILE.id}:${FILE.sha256}`,
      entityTitle: FILE.path,
      sprintId: `native-discussions-${DIGEST}`,
      status: 'open',
      createdAt: time,
      createdBy: 'ada',
      createdByName: 'Ada',
      lastMessageAt: time,
      revision: {
        fileId: FILE.id,
        path: FILE.path,
        sha256: FILE.sha256,
        publicationId: 'publication',
        publicationSequence: 2,
      },
    };
    transport.post.mockImplementation(async (path: string, body: any) =>
      path.endsWith('/assist')
        ? {
            requestId: body.requestId,
            message: {
              id: 'dm-1',
              content: 'Quorum is preparing an explanation...',
              authorId: 'quorum',
              authorName: 'Quorum',
              authorType: 'agent',
              assistStatus: 'running',
              mentions: [],
              redacted: false,
              createdAt: time,
              updatedAt: time,
              discussionId: thread.id,
              sprintId: thread.sprintId,
            },
          }
        : thread,
    );
    const view = member('Ada');
    fireEvent.mouseDown(await within(view.container).findByRole('button', { name: 'Work' }));
    fireEvent.click(await within(view.container).findByRole('button', { name: 'Work' }));
    fireEvent.click(await within(view.container).findByRole('button', { name: /docs\/plan\.md/ }));
    fireEvent.click(await within(view.container).findByRole('button', { name: 'Discuss' }));
    await waitFor(() =>
      expect(transport.post).toHaveBeenCalledWith(
        '/projects/project/native-intents/one/discussions',
        {
          entityType: 'artifact',
          entityId: `${FILE.id}:${FILE.sha256}`,
          entityTitle: FILE.path,
          publicationId: 'publication',
          publicationSequence: 2,
        },
      ),
    );
    // The thread's live document is native-scoped, never a platform intent doc.
    await waitFor(() =>
      expect(openedDocuments).toContainEqual({
        documentId: `native-discussion-${DIGEST}-${thread.id}`,
        target: { intentId: 'one', projectId: 'project', executionBackend: 'native' },
      }),
    );
    expect(openedDocuments.some((d) => d.documentId.startsWith('intent-'))).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }));
    await waitFor(() =>
      expect(transport.post).toHaveBeenCalledWith(
        `/projects/project/native-intents/one/discussions/${thread.id}/assist`,
        expect.objectContaining({ command: 'explain', agentCli: 'codex' }),
      ),
    );
    // Quorum assistance never reaches edit/apply or workflow approval routes.
    expect(
      transport.post.mock.calls
        .map(([path]) => path)
        .filter((path: string) => /quorum-edit|decision|approve|response/.test(path)),
    ).toEqual([]);
    await act(async () => {});
  });
});

describe('task-3 structured native answers', () => {
  const gateInput = {
    schemaVersion: 1 as const,
    kind: 'approval' as const,
    source: 'engine-gate' as const,
    stage: 'requirements-analysis',
    questions: [
      {
        id: 'q1',
        prompt: 'Requirements complete. How would you like to proceed?',
        header: 'Approval',
        multiSelect: false,
        options: [
          { label: 'Approve', description: 'Continue to user stories' },
          { label: 'Request Changes', description: 'Provide revision feedback' },
        ],
      },
    ],
  };
  it('freezes an uncertain shared choice and starts the revised approval with an empty draft for both members', async () => {
    service.interaction.mockResolvedValue({ ...interaction(), pendingInput: gateInput });
    const ada = member('Ada');
    await within(ada.container).findByText('Request Changes');
    const grace = member('Grace');
    fireEvent.click(await within(grace.container).findByText('Request Changes'));
    fireEvent.change(await within(grace.container).findByRole('textbox'), {
      target: { value: 'Add offline mode.' },
    });
    const submitAda = within(ada.container).getByRole('button', { name: 'Submit Answer' });
    await waitFor(() => expect(submitAda).toBeEnabled());
    service.respond.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    fireEvent.click(submitAda);
    await within(ada.container).findByText(/Your answer could not be confirmed/);
    const frozen = structuredClone(service.respond.mock.calls[0][2]);
    expect(frozen).toMatchObject({
      text: 'Request Changes\n\nAdd offline mode.',
      selection: { answers: [{ selectedOptions: [1], freeText: 'Add offline mode.' }] },
    });
    // Another member continues editing while Ada retries the already-frozen request.
    fireEvent.click(within(grace.container).getByText('Approve'));
    service.respond.mockResolvedValueOnce({
      execution: waiting({ status: 'DISPATCHING', responsePending: true, turnSequence: 3 })
        .execution,
      response: receipt(frozen.text),
    });
    fireEvent.click(within(ada.container).getByRole('button', { name: 'Submit Answer' }));
    await waitFor(() => expect(service.respond).toHaveBeenCalledTimes(2));
    expect(service.respond.mock.calls[1][2]).toEqual(frozen);
    await within(ada.container).findByText('Reply accepted. Delivery pending.');

    const next = 'f'.repeat(64);
    const revision = {
      ...interaction(null, next),
      sequence: 3,
      publicationId: 'revised-publication',
      contentSha256: '9'.repeat(64),
      pendingInput: gateInput,
      messages: [
        {
          type: 'text' as const,
          text: 'Revised plan includes offline mode. Approve or request changes.',
        },
      ],
    };
    service.get.mockResolvedValue(
      waiting({
        interactionId: next,
        publicationId: revision.publicationId,
        turnSequence: 3,
        revision: 12,
      }),
    );
    service.publication.mockResolvedValue({
      id: revision.publicationId,
      sequence: 3,
      createdAt: time,
      files: [FILE],
      question: null,
      projectionStatus: 'complete',
    });
    service.interaction.mockResolvedValue(revision);
    for (const view of [ada, grace]) {
      fireEvent.click(within(view.container).getByRole('button', { name: 'Refresh status' }));
      await within(view.container).findByText(revision.messages[0].text);
      expect(within(view.container).getByRole('button', { name: 'Submit Answer' })).toBeDisabled();
    }
    expect(openedDocuments.map((d) => d.documentId)).toContain(`native-answer-${DIGEST}-${next}-3`);
    fireEvent.click(within(ada.container).getByText('Approve'));
    const submitGrace = within(grace.container).getByRole('button', { name: 'Submit Answer' });
    await waitFor(() => expect(submitGrace).toBeEnabled());
    service.respond.mockResolvedValueOnce({
      execution: waiting({ status: 'DISPATCHING', responsePending: true, turnSequence: 4 })
        .execution,
      response: { ...receipt('Approve'), actorId: 'grace', interactionId: next, sequence: 4 },
    });
    fireEvent.click(submitGrace);
    await waitFor(() => expect(service.respond).toHaveBeenCalledTimes(3));
    expect(service.respond.mock.calls[2][2]).toMatchObject({
      interactionId: next,
      contentSha256: revision.contentSha256,
      text: 'Approve',
      selection: { answers: [{ selectedOptions: [0] }] },
    });
    expect(service.respond.mock.calls[2][2].requestId).not.toBe(frozen.requestId);
    await within(grace.container).findByText('Reply accepted. Delivery pending.');
  });

  it('two members choose together and one submits the exact label, never a number', async () => {
    service.interaction.mockResolvedValue({ ...interaction(), pendingInput: gateInput });
    const ada = member('Ada');
    await within(ada.container).findByText(/Continue to user stories/);
    const grace = member('Grace');
    await within(grace.container).findByText(/Continue to user stories/);
    // No free-text box for a structured turn; the answer document is revision-specific.
    expect(within(ada.container).queryByRole('textbox', { name: 'Reply to AI-DLC' })).toBeNull();
    await waitFor(() =>
      expect(openedDocuments.map((d) => d.documentId)).toContain(
        `native-answer-${DIGEST}-${INTERACTION}-2`,
      ),
    );
    expect(openedDocuments.find((d) => d.documentId.startsWith('native-answer-'))?.target).toEqual({
      intentId: 'one',
      projectId: 'project',
      executionBackend: 'native',
      document: { kind: 'answer', interactionId: INTERACTION, sequence: 2 },
    });
    // Grace selects; Ada sees the shared selection and submits it.
    fireEvent.click(within(grace.container).getByText('Approve'));
    const submit = within(ada.container).getByRole('button', { name: 'Submit Answer' });
    await waitFor(() => expect(submit).toBeEnabled());
    service.respond.mockResolvedValue({
      execution: waiting({
        status: 'DISPATCHING',
        responsePending: true,
        turnSequence: 3,
        revision: 10,
      }).execution,
      response: receipt('Approve'),
    });
    fireEvent.click(submit);
    await waitFor(() => expect(service.respond).toHaveBeenCalledTimes(1));
    const [, , request] = service.respond.mock.calls[0];
    expect(request).toMatchObject({
      interactionId: INTERACTION,
      contentSha256,
      text: 'Approve',
      selection: { answers: [{ selectedOptions: [0] }] },
    });
    await within(ada.container).findByText('Reply accepted. Delivery pending.');
  });

  it('keeps request-changes feedback separate from the decision', async () => {
    service.interaction.mockResolvedValue({ ...interaction(), pendingInput: gateInput });
    const ada = member('Ada');
    fireEvent.click(await within(ada.container).findByText('Request Changes'));
    const feedback = await within(ada.container).findByRole('textbox');
    fireEvent.change(feedback, { target: { value: 'Add offline mode.' } });
    service.respond.mockResolvedValue({
      execution: waiting({
        status: 'DISPATCHING',
        responsePending: true,
        turnSequence: 3,
        revision: 10,
      }).execution,
      response: receipt('Request Changes\n\nAdd offline mode.'),
    });
    fireEvent.click(within(ada.container).getByRole('button', { name: 'Submit Answer' }));
    await waitFor(() => expect(service.respond).toHaveBeenCalledTimes(1));
    expect(service.respond.mock.calls[0][2]).toMatchObject({
      text: 'Request Changes\n\nAdd offline mode.',
      selection: { answers: [{ selectedOptions: [1], freeText: 'Add offline mode.' }] },
    });
  });
});
