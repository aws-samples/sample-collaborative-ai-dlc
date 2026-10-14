import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router';
import { NativeIntentContent } from './NativeIntentContent';
import { NativeFileComparison, compareInventory } from './NativeHistoryView';
import { nativeHistorySearch, parseNativeHistoryLocation } from '@/lib/nativeRevisionLinks';
import { ApiError } from '@/services/api';
import { resetSessionExpiry, notifySessionExpired } from '@/services/sessionExpiry';
import type { NativeIntent } from '@/services/nativeIntents';
import type { NativeRevision, NativeRevisionFile } from '@/services/nativeHistory';
import { TooltipProvider } from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  revision: vi.fn(),
  decision: vi.fn(),
  file: vi.fn(),
  publication: vi.fn(),
  interaction: vi.fn(),
  graph: vi.fn(),
  respond: vi.fn(),
  denied: vi.fn(),
  close: vi.fn(),
  discussionFor: vi.fn(),
  openDiscussionById: vi.fn(),
  request: vi.fn(),
  status: vi.fn(),
}));
vi.mock('@/services/nativeHistory', async (load) => ({
  ...(await load<typeof import('@/services/nativeHistory')>()),
  nativeHistoryService: mocks,
}));
vi.mock('@/services/nativeIntents', async (load) => ({
  ...(await load<typeof import('@/services/nativeIntents')>()),
  nativeIntentsService: mocks,
}));
vi.mock('@/services/nativeResults', () => ({ nativeResultsService: mocks }));
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/components/discussion/DiscussionProvider', () => ({
  useDiscussions: () => ({ ...mocks, scope: { kind: 'native' }, assistAgentCli: 'codex' }),
}));

const oldId = 'a'.repeat(64),
  newId = 'b'.repeat(64),
  fileId = `nf-${'c'.repeat(64)}`,
  hash = 'd'.repeat(64);
const stamp = '2026-10-01T12:00:00Z';
const intent: NativeIntent = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Native revision test',
  prompt: 'Original request',
  harness: 'codex',
  status: 'READY',
  package: {
    version: '1.0.0',
    source: { provider: 'github', repository: 'owner/workflow', release: 'v1' },
  },
  createdAt: stamp,
  updatedAt: stamp,
  executionAvailable: true,
  execution: {
    status: 'AWAITING_USER',
    attemptId: '22222222-2222-4222-8222-222222222222',
    epoch: 2,
    publicationId: newId,
    interactionId: 'e'.repeat(64),
    turnSequence: 2,
    projectionStatus: 'complete',
    startedAt: stamp,
    updatedAt: stamp,
    model: null,
    repository: { provider: 'github', repository: 'owner/repo', branch: 'main', commit: null },
  },
};
const revision = (sequence = 1): NativeRevision => ({
  id: sequence === 1 ? oldId : newId,
  sequence,
  createdAt: stamp,
  question: null,
  files: [
    {
      id: fileId,
      sha256: hash,
      path: 'plan.unknown',
      bytes: 8,
      role: 'artifact',
      mediaType: 'application/octet-stream',
    },
  ],
  context: {
    projectId: intent.projectId,
    executionId: intent.id,
    attemptId: intent.execution!.attemptId,
    epoch: sequence,
    packageId: `sha256:${hash}`,
  },
  outcome: 'STOPPED',
  interactionId: String(sequence).repeat(64),
});
const file = (content = 'old plan', sequence = 1): NativeRevisionFile => ({
  ...revision(sequence).files[0],
  publicationId: revision(sequence).id,
  publicationSequence: sequence,
  content,
  encoding: 'utf8',
  truncated: false,
});
const selected = { publicationId: oldId, publicationSequence: 1 };
const search = nativeHistorySearch('', { revision: selected, file: revision().files[0] });
function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
const mount = (query = search, value = intent) =>
  render(
    <MemoryRouter initialEntries={[`/space/${value.projectId}/native-intent/${value.id}${query}`]}>
      <TooltipProvider>
        <Navigation />
        <NativeIntentContent
          intent={value}
          onAccessFailure={mocks.denied}
          onRefresh={async () => {}}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
it('keeps large current files obtainable without attempting the inline transport', async () => {
  const current = revision(2);
  current.files[0] = { ...current.files[0], bytes: 32 * 1024 * 1024 };
  mocks.publication.mockResolvedValue(current);
  mount('');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Files' }), { button: 0, ctrlKey: false });
  await screen.findByText(current.files[0].path);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(current.files[0].path) }));
  await screen.findByText(/File exceeds the 3 MiB inline limit/);
  expect(screen.getByRole('button', { name: 'Prepare file download' })).toBeInTheDocument();
  expect(mocks.file).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiry();
  mocks.list.mockResolvedValue({
    items: [{ id: oldId, sequence: 1, filesCount: 1, epoch: 1, admittedAt: null }],
    nextBefore: null,
    gaps: [],
  });
  mocks.revision.mockImplementation(async (_project, _intent, target) =>
    revision(target.publicationSequence),
  );
  mocks.file.mockImplementation(async (_project, _intent, rev) =>
    file(rev.sequence === 1 ? 'old plan' : 'new plan', rev.sequence),
  );
  mocks.decision.mockImplementation(async (_project, _intent, rev) => ({
    interaction: {
      id: rev.interactionId,
      sequence: rev.sequence,
      harness: 'codex',
      messages: [{ type: 'text', text: 'Exact old proposal' }],
      pendingInput: {
        questions: [
          {
            id: 'q1',
            prompt: 'Historical approval question?',
            options: [{ label: 'Approve' }, { label: 'Request changes' }],
            multiSelect: false,
          },
        ],
      },
    },
    answer: {
      actorId: 'member-one',
      acceptedAt: stamp,
      text: 'Accepted exact answer',
      deliveryStatus: 'delivered',
      deliveredAt: stamp,
      resultingPublication: { publicationId: newId, publicationSequence: 2 },
    },
  }));
  mocks.publication.mockResolvedValue(revision(2));
  mocks.interaction.mockResolvedValue({
    id: intent.execution!.interactionId,
    publicationId: newId,
    sequence: 2,
    harness: 'codex',
    messages: [{ type: 'text', text: 'Current question' }],
    createdAt: stamp,
    contentSha256: hash,
    kind: 'assistant_turn',
  });
  mocks.discussionFor.mockReturnValue(null);
});
afterEach(cleanup);

const uncertainIntent = (): NativeIntent => ({
  ...intent,
  execution: {
    ...intent.execution!,
    status: 'RECOVERY_REQUIRED',
    turnSequence: 3,
    publicationSequence: 2,
    recovery: { id: 'uncertain', reason: 'DELIVERY_UNCERTAIN', canRecover: false },
    stopStatus: { state: 'confirmed', confirmedAt: stamp },
  },
});
it('inspection uses the admitted publication, original request and immutable answer without dispatching a historical answer', async () => {
  mocks.decision.mockResolvedValueOnce({
    interaction: { harness: 'codex', messages: [{ type: 'text', text: 'Uncertain proposal' }] },
    answer: {
      text: 'Already accepted answer',
      actorId: 'member',
      acceptedAt: stamp,
      deliveryStatus: 'uncertain',
      deliveredAt: null,
      uncertainAt: stamp,
      resultingPublication: null,
    },
  });
  mount('?nativeInspect=1', uncertainIntent());
  expect(await screen.findByText('Uncertain proposal')).toBeVisible();
  expect(screen.getByText('Original request')).toBeVisible();
  expect(screen.getByText(/Runtime stop confirmed at/)).toBeVisible();
  expect(screen.getByText('Already accepted answer')).toBeVisible();
  expect(screen.getByText('Runtime delivery: uncertain')).toBeVisible();
  expect(screen.getByText(/Delivery uncertainty recorded at/)).toBeVisible();
  expect(mocks.revision).toHaveBeenCalledWith(intent.projectId, intent.id, {
    publicationId: newId,
    publicationSequence: 2,
  });
  expect(screen.getByRole('button', { name: 'Prepare result archive' })).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Send reply|Start agent|Recover session/ }),
  ).not.toBeInTheDocument();
  expect(mocks.respond).not.toHaveBeenCalled();
  expect(mocks.publication).not.toHaveBeenCalled();
  expect(mocks.interaction).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request.mockResolvedValueOnce({
    status: 'ready',
    download: {
      downloadUrl: 'https://result.example/exact',
      bytes: 8,
      sha256: hash,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  await screen.findByRole('button', { name: 'Download result archive' });
  expect(mocks.request).toHaveBeenCalledWith(
    intent.projectId,
    intent.id,
    expect.objectContaining({ publicationId: newId, publicationSequence: 2 }),
    undefined,
  );
  expect(mocks.respond).not.toHaveBeenCalled();
});
it('inspection does not infer stop or publication sequence from an old terminal row', async () => {
  mount('?nativeInspect=1', {
    ...intent,
    execution: { ...intent.execution!, status: 'CANCELLED' },
  });
  expect(await screen.findByText(/Runtime stop is not established/)).toBeVisible();
  expect(await screen.findByRole('link', { name: 'Open publication 1' })).toBeVisible();
  expect(mocks.revision).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Prepare result archive' })).not.toBeInTheDocument();
});
it('a missing last admitted revision in inspection never falls back to current bytes', async () => {
  mocks.revision.mockRejectedValueOnce(new Error('named revision missing'));
  mount('?nativeInspect=1', uncertainIntent());
  expect(await screen.findByRole('alert')).toHaveTextContent('has not been redirected');
  expect(mocks.publication).not.toHaveBeenCalled();
  expect(mocks.file).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Prepare result archive' })).not.toBeInTheDocument();
});
it.each([401, 403, 404])(
  'inspection propagates access denial %s and hides result actions',
  async (status) => {
    mocks.revision.mockRejectedValueOnce(new ApiError(status, 'denied'));
    mount('?nativeInspect=1', uncertainIntent());
    await screen.findByRole('alert');
    expect(mocks.denied).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: 'Prepare result archive' }),
    ).not.toBeInTheDocument();
  },
);
it('inspection discards a late revision after leaving inspection', async () => {
  let resolve!: (value: NativeRevision) => void;
  mocks.revision.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mount('?nativeInspect=1', uncertainIntent());
  fireEvent.click(screen.getByRole('link', { name: 'History' }));
  await act(async () => resolve(revision(2)));
  expect(screen.queryByText('Exact old proposal')).not.toBeInTheDocument();
  expect(mocks.decision).not.toHaveBeenCalled();
});
it.each(['session', 'execution', 'project', 'unmount'])(
  'inspection discards pending history after an identity change: %s',
  async (change) => {
    let resolve!: (value: NativeRevision) => void;
    mocks.revision.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const value = uncertainIntent();
    const view = (next: NativeIntent) => (
      <MemoryRouter initialEntries={['/?nativeInspect=1']}>
        <NativeIntentContent
          intent={next}
          onAccessFailure={mocks.denied}
          onRefresh={async () => {}}
        />
      </MemoryRouter>
    );
    const rendered = render(view(value));
    if (change === 'session') act(() => notifySessionExpired());
    else if (change === 'unmount') rendered.unmount();
    else {
      const next = {
        ...value,
        ...(change === 'project' ? { projectId: 'project-2' } : { id: 'run-2' }),
      };
      mocks.revision.mockReturnValueOnce(new Promise(() => {}));
      mocks.list.mockResolvedValueOnce({ items: [], nextBefore: null, gaps: [] });
      rendered.rerender(view(next));
    }
    await act(async () => resolve(revision(2)));
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(screen.queryByText('Exact old proposal')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Prepare result archive' }),
    ).not.toBeInTheDocument();
  },
);

it('opens the exact proposal, immutable answer, raw unknown file and resulting revision with no answer form', async () => {
  mount();
  expect(await screen.findByText('Exact old proposal')).toBeInTheDocument();
  expect(await screen.findByText('old plan')).toBeInTheDocument();
  expect(screen.getByText('Accepted exact answer')).toBeInTheDocument();
  expect(screen.getByText('Historical approval question?')).toBeInTheDocument();
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument();
  expect(mocks.interaction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Open resulting publication 2' }));
  expect(await screen.findByText(/Publication 2 · historical view/)).toBeInTheDocument();
  expect(screen.queryByText('old plan')).not.toBeInTheDocument();
  expect(mocks.respond).not.toHaveBeenCalled();
});

it('preserves a named revision across new heads, browser back/forward, and current/history switches', async () => {
  mount();
  await screen.findByText('old plan');
  fireEvent.click(screen.getByRole('link', { name: 'Current' }));
  expect(await screen.findByText('Current question')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByText('old plan');
  expect(screen.queryByText('Current question')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
  await screen.findByText('Current question');
  expect(screen.queryByText('Accepted exact answer')).not.toBeInTheDocument();
});

it('opens only the exact publication discussion even when the same file hash appears in a later publication', async () => {
  const thread = { id: 'disc-old', revision: { publicationId: oldId, publicationSequence: 1 } };
  mocks.discussionFor.mockImplementation((_type, _file, publicationId, sequence) =>
    publicationId === oldId && sequence === 1 ? thread : null,
  );
  mount(
    nativeHistorySearch('', { revision: selected, file: revision().files[0], discussion: true }),
  );
  await screen.findByText('old plan');
  expect(mocks.openDiscussionById).toHaveBeenCalledWith('disc-old');
  expect(mocks.discussionFor).toHaveBeenCalledWith('artifact', `${fileId}:${hash}`, oldId, 1);
  fireEvent.click(screen.getByRole('link', { name: 'Current' }));
  expect(mocks.close).toHaveBeenCalled();
});

it.each([400, 403, 404, 503])(
  'does not substitute newer content for a failed named read (%s)',
  async (status) => {
    mocks.revision.mockRejectedValue(new ApiError(status, 'Unavailable'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('not been redirected');
    expect(screen.queryByText('old plan')).not.toBeInTheDocument();
    expect(mocks.publication).not.toHaveBeenCalled();
    if (status === 403) expect(mocks.denied).toHaveBeenCalled();
  },
);

it('discards late file callbacks after navigation and session expiry', async () => {
  let resolve!: (value: NativeRevisionFile) => void;
  mocks.file.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mount();
  await screen.findByText('Exact old proposal');
  fireEvent.click(screen.getByRole('link', { name: 'Current' }));
  await screen.findByText('Current question');
  await act(async () => resolve(file('late private bytes')));
  expect(screen.queryByText('late private bytes')).not.toBeInTheDocument();
  cleanup();
  mocks.file.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mount();
  await screen.findByText('Exact old proposal');
  act(() => notifySessionExpired());
  await act(async () => resolve(file('expired private bytes')));
  expect(screen.queryByText('expired private bytes')).not.toBeInTheDocument();
});

it('paginates earlier admitted rows and describes explicit gaps', async () => {
  mocks.list
    .mockResolvedValueOnce({
      items: [{ id: newId, sequence: 2, filesCount: 1, epoch: 2, admittedAt: null }],
      nextBefore: 2,
      gaps: [],
    })
    .mockResolvedValueOnce({ items: [], nextBefore: null, gaps: [{ from: 1, to: 1 }] });
  mount('?nativeHistory=1');
  fireEvent.click(await screen.findByRole('button', { name: 'Earlier publications' }));
  expect(
    await screen.findByText(/Immutable history unavailable for publications 1–1/),
  ).toBeInTheDocument();
  expect(mocks.list).toHaveBeenLastCalledWith(intent.projectId, intent.id, 2);
});

it('compares complete changed, added, deleted and identical text, and labels binary/over-limit content', () => {
  const before = file('old\ntext\n'),
    after = file('new\ntext\n', 2);
  const { rerender } = render(<NativeFileComparison before={before} after={after} added={false} />);
  const comparison = screen.getByRole('region', { name: 'Complete file comparison' });
  expect(
    within(comparison).getByText('Removed text is red; added text is green.', { exact: false }),
  ).toBeInTheDocument();
  expect(comparison.querySelector('del')).toHaveTextContent('old');
  expect(comparison.querySelector('ins')).toHaveTextContent('new');
  rerender(<NativeFileComparison before={null} after={after} added />);
  expect(screen.getByText('Before (file absent)')).toBeInTheDocument();
  rerender(<NativeFileComparison before={before} after={null} added={false} />);
  expect(screen.getByText('After (file absent)')).toBeInTheDocument();
  rerender(
    <NativeFileComparison
      before={{ ...before, content: '', bytes: 0 }}
      after={null}
      added={false}
    />,
  );
  expect(screen.getByText('After (file absent)')).toBeInTheDocument();
  expect(screen.queryByText('Identical verified bytes.')).not.toBeInTheDocument();
  rerender(<NativeFileComparison before={before} after={before} added={false} />);
  expect(screen.getByText('Identical verified bytes.')).toBeInTheDocument();
  for (const encoding of ['binary', 'too_large'] as const) {
    rerender(
      <NativeFileComparison
        before={before}
        after={{ ...after, encoding, content: null }}
        added={false}
      />,
    );
    expect(screen.getByText(/No partial diff is shown/)).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  }
  expect(compareInventory(revision().files, [])).toMatchObject([{ status: 'deleted' }]);
  expect(compareInventory([], revision().files)).toMatchObject([{ status: 'added' }]);
  expect(compareInventory(revision().files, revision().files)).toMatchObject([
    { status: 'identical' },
  ]);
});

it('retries a failed deleted-file comparison without retaining its loading state', async () => {
  mocks.revision.mockImplementation(async (_project, _intent, target) => ({
    ...revision(target.publicationSequence),
    files: target.publicationSequence === 1 ? revision().files : [],
  }));
  mocks.file.mockRejectedValueOnce(new ApiError(503, 'Temporarily unavailable'));
  mount(
    nativeHistorySearch('', {
      revision: { publicationId: newId, publicationSequence: 2 },
      compare: selected,
    }),
  );
  const name = 'Compare deletion of plan.unknown';
  fireEvent.click(await screen.findByRole('button', { name }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  const retry = await screen.findByRole('button', { name });
  expect(retry).not.toBeDisabled();
  fireEvent.click(retry);
  await screen.findByRole('region', { name: 'Complete file comparison' });
  expect(screen.getByText('After (file absent)')).toBeInTheDocument();
  expect(screen.getByText('old plan')).toBeInTheDocument();
});

it.each([
  '?nativeRevision=bad',
  `?nativeRevision=01.${oldId}`,
  `?nativeRevision=1.${oldId}&nativeRevision=2.${newId}`,
  '?nativeFile=bad',
  `?nativeRevision=1.${oldId}&nativeDiscussion=1`,
  '?nativeUnknown=1',
])('rejects malformed links without loading content: %s', (query) => {
  expect(parseNativeHistoryLocation(query).mode).toBe('invalid');
  mount(query);
  expect(screen.getByRole('alert')).toHaveTextContent('revision link is invalid');
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.revision).not.toHaveBeenCalled();
});
