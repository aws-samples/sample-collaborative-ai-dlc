import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/services/api';
import { clearNativeIntents, refreshNativeIntents } from '@/hooks/useNativeIntents';
import {
  armSessionExpiry,
  notifySessionExpired,
  resetSessionExpiry,
} from '@/services/sessionExpiry';
import type {
  NativeExecution,
  NativeFileContent,
  NativeGraph,
  NativeIntent,
  NativePublication,
} from '@/services/nativeIntents';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  prepare: vi.fn(),
  publication: vi.fn(),
  file: vi.fn(),
  graph: vi.fn(),
  list: vi.fn(),
}));
// Shared drafts: in-memory Yjs relay + textarea stand-in (see test/collaborationFakes).
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/nativeIntents', () => ({ nativeIntentsService: api }));
// Native content must work without either platform provider, including markdown.
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

const ready: NativeIntent = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Fix the pipe visualization',
  prompt: 'Make the pipes more interesting.',
  harness: 'codex',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: {
      provider: 'github',
      repository: 'awslabs/aidlc-workflows',
      release: 'v2.9.0',
    },
  },
  createdAt: '2026-09-29T09:00:00Z',
  updatedAt: '2026-09-29T09:02:00Z',
  executionAvailable: true,
  execution: null,
};
const execution: NativeExecution = {
  status: 'WAITING_FOR_INPUT',
  attemptId: 'attempt-1',
  epoch: 1,
  startedAt: '2026-09-29T09:03:00Z',
  updatedAt: '2026-09-29T09:04:00Z',
  model: 'selected-model',
  repository: {
    provider: 'github',
    repository: 'JWThewes/flappy-bird',
    branch: 'main',
    commit: 'abc123',
  },
  publicationId: 'pub-1',
  projectionStatus: 'complete',
};
const waiting: NativeIntent = { ...ready, execution };
const publication: NativePublication = {
  id: 'pub-1',
  sequence: 1,
  createdAt: '2026-09-29T09:04:00Z',
  files: [
    {
      id: 'question-1',
      path: 'aidlc-docs/questions.md',
      bytes: 29,
      sha256: 'a'.repeat(64),
      role: 'question',
      mediaType: 'text/markdown',
    },
    {
      id: 'code-1',
      path: 'src/pipe.ts',
      bytes: 22,
      sha256: 'b'.repeat(64),
      role: 'code',
      mediaType: 'text/plain',
    },
    {
      id: 'binary-1',
      path: 'assets/pipe.png',
      bytes: 3,
      sha256: 'c'.repeat(64),
      role: 'code',
      mediaType: 'image/png',
    },
  ],
  question: { fileId: 'question-1', path: 'aidlc-docs/questions.md', sha256: 'a'.repeat(64) },
  projectionStatus: 'complete',
};
const contents: Record<string, NativeFileContent> = {
  'question-1': {
    ...publication.files[0],
    encoding: 'utf8',
    content: '# Which pipe style?\n\nChoose one.',
    publicationId: 'pub-1',
  },
  'code-1': {
    ...publication.files[1],
    encoding: 'utf8',
    content: 'export const pipe = 1;',
    publicationId: 'pub-1',
  },
  'binary-1': {
    ...publication.files[2],
    encoding: 'base64',
    content: 'AAEC',
    publicationId: 'pub-1',
  },
};
const graph: NativeGraph = {
  publicationId: 'pub-1',
  nodes: [
    { id: 'native-intent-1', type: 'Intent', label: 'Pipe request' },
    { id: 'artifact-code-1', type: 'Artifact', label: 'Pipe source', artifactId: 'code-1' },
  ],
  edges: [{ source: 'native-intent-1', target: 'artifact-code-1', label: 'CONTAINS' }],
};
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/space/project-1/native-intent/run-1']}>
      <Link to="/space/project-1/native-intent/run-2">Other native run</Link>
      <Routes>
        <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
      </Routes>
    </MemoryRouter>,
  );
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
async function click(name: string) {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
}
function cleared() {
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Native intent$/);
  expect(screen.queryByText(ready.prompt)).not.toBeInTheDocument();
  expect(screen.queryByText('Which pipe style?')).not.toBeInTheDocument();
  expect(screen.queryByText('export const pipe = 1;')).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Open file for/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
}
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
  clearNativeIntents();
  api.get.mockResolvedValue(ready);
  api.publication.mockResolvedValue(publication);
  api.file.mockImplementation(
    async (_project: string, _intent: string, id: string) => contents[id],
  );
  api.graph.mockResolvedValue(graph);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('starts only explicitly, deduplicates pending clicks and reuses the request ID after a lost response', async () => {
  const pending = deferred<NativeIntent>();
  api.start.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
    ...ready,
    execution: { ...execution, status: 'REQUESTED', publicationId: null, projectionStatus: null },
  });
  renderPage();
  await screen.findByText(ready.prompt);
  expect(api.start).not.toHaveBeenCalled();
  await click('Start agent');
  await click('Requesting start…');
  expect(api.start).toHaveBeenCalledTimes(1);
  const requestId = api.start.mock.calls[0][2];
  expect(requestId).toMatch(/^[\da-f-]{36}$/);
  await act(async () => pending.reject(new Error('Acknowledgement lost')));
  expect(screen.getByRole('alert')).toHaveTextContent('Start could not be confirmed');
  await click('Start agent');
  expect(api.start.mock.calls).toEqual([
    ['project-1', 'run-1', requestId],
    ['project-1', 'run-1', requestId],
  ]);
  expect(screen.getByRole('status')).toHaveTextContent('Start requested');
  expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Intent actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Intent configuration' }));
  const configuration = screen.getByRole('dialog', { name: 'Intent configuration' });
  expect(within(configuration).getByText('selected-model')).toBeInTheDocument();
  expect(within(configuration).getByText('JWThewes/flappy-bird')).toBeInTheDocument();
  expect(within(configuration).getByText('main')).toBeInTheDocument();
  expect(within(configuration).getByText('abc123')).toBeInTheDocument();
  expect(
    within(configuration).getByText(
      /managed environments, custom MCP servers and uploaded custom rules do not apply/,
    ),
  ).toBeInTheDocument();
  expect(
    within(configuration).getByText('Captured scope unavailable from this API'),
  ).toBeInTheDocument();
  expect(
    within(configuration).getByText('Captured image unavailable from this API'),
  ).toBeInTheDocument();
});

const credentialError = {
  code: 'NATIVE_EXECUTION_CONFIG_CREDENTIAL_REQUIRED',
  error: 'Configure a credential for the selected coding harness before starting',
};
const startFallback = 'Start could not be confirmed. Refresh status or retry the same request.';

it.each([
  [409, credentialError.code, credentialError.error],
  [
    409,
    'NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_CHANGED',
    'The application repository binding changed; reload before starting',
  ],
  [
    409,
    'NATIVE_EXECUTION_CONFIG_REPOSITORY_REQUIRED',
    'Link one application repository in project source-control settings',
  ],
  [
    409,
    'NATIVE_EXECUTION_CONFIG_REPOSITORY_AMBIGUOUS',
    'The first native milestone requires exactly one application repository',
  ],
  [409, 'NATIVE_EXECUTION_CONFIG_PROMPT_REQUIRED', 'Add a prompt before starting native execution'],
  [503, 'NATIVE_EXECUTION_UNAVAILABLE', 'Native execution is unavailable; retry the same request'],
  [409, 'WORKFLOW_SOURCE_INVALID', 'Workflow source must be reverified'],
  [503, 'NATIVE_EXECUTION_DISABLED', 'Native execution is disabled'],
] as const)('shows the safe native Start response for %s / %s', async (status, code, message) => {
  api.start.mockRejectedValueOnce(new ApiError(status, message, { code, error: message }));
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled();
});

it('reuses the same Start request after an actionable error and clears feedback on success', async () => {
  api.start
    .mockRejectedValueOnce(new ApiError(409, credentialError.error, credentialError))
    .mockResolvedValueOnce({
      ...ready,
      execution: { ...execution, status: 'REQUESTED', publicationId: null, projectionStatus: null },
    });
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  expect(screen.getByRole('alert')).toHaveTextContent(credentialError.error);
  const requestId = api.start.mock.calls[0][2];
  await click('Start agent');
  expect(api.start.mock.calls).toEqual([
    ['project-1', 'run-1', requestId],
    ['project-1', 'run-1', requestId],
  ]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Start requested');
});

it.each([
  ['transport', new Error('private transport details and stack')],
  ['raw response', new ApiError(502, '<html>private gateway body</html>')],
  [
    'unknown code',
    new ApiError(409, 'private response', { code: 'UNKNOWN', error: 'private response' }),
  ],
  [
    'inherited key',
    new ApiError(409, 'private response', { code: 'constructor', error: 'private response' }),
  ],
  ['wrong status', new ApiError(500, 'private response', credentialError)],
  [
    'untrusted text on known code',
    new ApiError(409, 'private credential value', {
      code: credentialError.code,
      error: 'private credential value',
    }),
  ],
  [
    'missing structured message',
    new ApiError(409, credentialError.error, { code: credentialError.code }),
  ],
  ['non-API object', { status: 409, body: credentialError, message: 'private response' }],
])('keeps the generic Start fallback for %s', async (_description, error) => {
  api.start.mockRejectedValueOnce(error);
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  expect(screen.getByRole('alert').textContent).toBe(startFallback);
  expect(document.body).not.toHaveTextContent('private');
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled();
});

it('renders only the fixed safe message when ApiError includes additional untrusted text', async () => {
  api.start.mockRejectedValueOnce(
    new ApiError(409, 'private credential value', {
      ...credentialError,
      message: 'private credential value',
      stack: 'private stack trace',
    }),
  );
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  expect(screen.getByRole('alert').textContent).toBe(credentialError.error);
  expect(document.body).not.toHaveTextContent('private');
});

it.each([401, 403, 404])(
  'clears detail safely when Start returns an access error %s',
  async (status) => {
    api.start.mockRejectedValueOnce(
      new ApiError(status, 'private access response', credentialError),
    );
    renderPage();
    await screen.findByText(ready.prompt);
    await click('Start agent');
    cleared();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Native intent access is no longer available',
    );
    expect(document.body).not.toHaveTextContent('private');
  },
);

it.each(['denial', 'listing', 'expiry', 'reset'] as const)(
  'ignores a late actionable Start error after %s',
  async (boundary) => {
    const pending = deferred<NativeIntent>();
    api.start.mockReturnValueOnce(pending.promise);
    renderPage();
    await screen.findByText(ready.prompt);
    await click('Start agent');
    if (boundary === 'denial') {
      api.get.mockRejectedValueOnce(new ApiError(403, 'Access denied'));
      await click('Refresh status');
    } else {
      await act(async () => {
        if (boundary === 'listing') {
          api.list.mockRejectedValueOnce(
            new ApiError(403, 'Disabled', { code: 'NATIVE_PREPARATION_PROJECT_DISABLED' }),
          );
          await refreshNativeIntents('project-1', 'refresh', true);
        } else if (boundary === 'expiry') notifySessionExpired();
        else {
          api.get.mockRejectedValue(new ApiError(403, 'Signed out'));
          resetSessionExpiry();
        }
      });
    }
    cleared();
    const before = screen.getByRole('alert').textContent;
    await act(async () =>
      pending.reject(new ApiError(409, credentialError.error, credentialError)),
    );
    cleared();
    expect(screen.getByRole('alert').textContent).toBe(before);
    expect(screen.queryByText(credentialError.error)).not.toBeInTheDocument();
  },
);

it('ignores a late actionable Start error after navigating to another draft', async () => {
  const pending = deferred<NativeIntent>();
  api.start.mockReturnValueOnce(pending.promise);
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  api.get.mockResolvedValueOnce({ ...ready, id: 'run-2', prompt: 'Other draft prompt.' });
  await userEvent.setup().click(screen.getByRole('link', { name: 'Other native run' }));
  await screen.findByText('Other draft prompt.');
  await act(async () => pending.reject(new ApiError(409, credentialError.error, credentialError)));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Other draft prompt.')).toBeInTheDocument();
});

it('also uses safe API feedback for cancellation without discarding committed content', async () => {
  const message = 'Native execution changed; refresh its status';
  api.get.mockResolvedValue(waiting);
  api.cancel.mockRejectedValueOnce(
    new ApiError(409, message, { code: 'NATIVE_EXECUTION_CONFLICT', error: message }),
  );
  renderPage();
  await screen.findByText('Which pipe style?');
  await click('Cancel execution');
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeEnabled();
});

it('does not let a GET begun before Start erase its accepted execution', async () => {
  const pending = deferred<NativeIntent>();
  api.start.mockResolvedValue({
    ...ready,
    execution: { ...execution, status: 'RUNNING', publicationId: null },
  });
  renderPage();
  await screen.findByText(ready.prompt);
  api.get.mockReturnValueOnce(pending.promise);
  await click('Refresh status');
  await click('Start agent');
  await act(async () => pending.resolve(ready));
  expect(screen.getByRole('status')).toHaveTextContent('Agent running');
  expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
});

it('does not regress a newer execution when the Start acknowledgement arrives late', async () => {
  const pending = deferred<NativeIntent>();
  api.start.mockReturnValueOnce(pending.promise);
  renderPage();
  await screen.findByText(ready.prompt);
  await click('Start agent');
  api.get.mockResolvedValueOnce(waiting);
  await click('Refresh status');
  await screen.findByText('Which pipe style?');
  await act(async () =>
    pending.resolve({
      ...ready,
      execution: {
        ...execution,
        status: 'REQUESTED',
        publicationId: null,
        projectionStatus: null,
        updatedAt: '2026-09-29T09:03:00Z',
      },
    }),
  );
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for input');
  expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
});

it.each(['start', 'cancel'] as const)(
  'cannot restore protected content with a late %s acknowledgement after GET denies access',
  async (action) => {
    const pending = deferred<NativeIntent>();
    if (action === 'cancel') api.get.mockResolvedValue(waiting);
    api[action].mockReturnValueOnce(pending.promise);
    renderPage();
    await screen.findByText(ready.prompt);
    await click(action === 'start' ? 'Start agent' : 'Cancel execution');
    api.get.mockRejectedValueOnce(new ApiError(403, 'Access revoked'));
    await click('Refresh status');
    cleared();
    await act(async () => pending.resolve(waiting));
    cleared();
  },
);

it('reloads committed files and graph and navigates from the graph into the native file view', async () => {
  api.get.mockResolvedValue(waiting);
  const user = userEvent.setup();
  const first = renderPage();
  await screen.findByText('Which pipe style?');
  expect(api.start).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(screen.getByText(/Current committed revision 1/)).toBeInTheDocument();
  for (const name of ['Start agent', 'Edit artifacts', 'Create unit PR', 'Delete intent'])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  first.unmount();
  renderPage();
  await screen.findByText('Which pipe style?');
  expect(api.publication).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('tab', { name: 'Graph' }));
  await user.click(await screen.findByRole('button', { name: 'Open file for Pipe source' }));
  expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active');
  expect(await screen.findByText('export const pipe = 1;')).toBeInTheDocument();
  expect(api.graph).toHaveBeenCalledWith('project-1', 'run-1');
  expect(api.file).toHaveBeenLastCalledWith('project-1', 'run-1', 'code-1');
  expect(api.start).not.toHaveBeenCalled();
});

it('does not announce a question until its committed file is available', async () => {
  const pending = deferred<NativeFileContent>();
  api.get.mockResolvedValue(waiting);
  api.file.mockReturnValueOnce(pending.promise);
  renderPage();
  await screen.findByText('Loading the published question file…');
  const evidence = screen.getByRole('region', { name: 'Workflow completion evidence' });
  expect(
    screen.getByText('Loading the published question file…').compareDocumentPosition(evidence) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Workflow question' })).not.toBeInTheDocument();
  await act(async () => pending.resolve(contents['question-1']));
  expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
  expect(
    screen.getByRole('region', { name: 'Published question' }).compareDocumentPosition(evidence) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('handles binary content without interpreting it as markdown, an image or executable HTML', async () => {
  api.get.mockResolvedValue(waiting);
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Which pipe style?');
  await user.click(screen.getByRole('tab', { name: 'Files' }));
  await user.click(screen.getByRole('button', { name: /assets\/pipe.png/ }));
  expect(await screen.findByText(/Binary file. Preview is not available/)).toBeInTheDocument();
  expect(screen.queryByText('AAEC')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it.each(['file', 'graph', 'publication'] as const)(
  'clears all protected detail on a %s denial and ignores older successful detail and file responses',
  async (operation) => {
    const oldGet = deferred<NativeIntent>();
    const oldFile = deferred<NativeFileContent>();
    api.get.mockResolvedValue(waiting);
    const user = userEvent.setup();
    if (operation === 'publication')
      api.publication.mockRejectedValueOnce(new ApiError(403, 'Not a member'));
    else api.file.mockReturnValueOnce(oldFile.promise);
    renderPage();
    if (operation === 'publication') {
      await screen.findByRole('alert');
      cleared();
      return;
    }
    await screen.findByText('Loading the published question file…');
    api.get.mockReturnValueOnce(oldGet.promise);
    await click('Refresh status');
    if (operation === 'file') {
      api.file.mockRejectedValueOnce(new ApiError(403, 'File access revoked'));
      await user.click(screen.getByRole('tab', { name: 'Files' }));
      await user.click(screen.getByRole('button', { name: /src\/pipe.ts/ }));
    } else {
      api.graph.mockRejectedValueOnce(new ApiError(403, 'Graph access revoked'));
      await user.click(screen.getByRole('tab', { name: 'Graph' }));
    }
    await screen.findByRole('alert');
    cleared();
    await act(async () => {
      oldGet.resolve(waiting);
      oldFile.resolve(contents['question-1']);
    });
    cleared();
  },
);

it.each(['listing', 'expiry', 'reset'] as const)(
  'clears graph and files on %s and fences their late responses',
  async (boundary) => {
    const oldGraph = deferred<NativeGraph>();
    const oldFile = deferred<NativeFileContent>();
    api.get.mockResolvedValue(waiting);
    api.file.mockReturnValueOnce(oldFile.promise);
    api.graph.mockReturnValueOnce(oldGraph.promise);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Loading the published question file…');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));
    expect(api.graph).toHaveBeenCalledTimes(1);
    api.get.mockRejectedValue(new ApiError(403, 'Signed out'));
    await act(async () => {
      if (boundary === 'listing') {
        api.list.mockRejectedValueOnce(
          new ApiError(403, 'Project preparation disabled', {
            code: 'NATIVE_PREPARATION_PROJECT_DISABLED',
          }),
        );
        await refreshNativeIntents('project-1', 'refresh', true);
      } else if (boundary === 'expiry') notifySessionExpired();
      else resetSessionExpiry();
    });
    cleared();
    await act(async () => {
      oldFile.resolve(contents['question-1']);
      oldGraph.resolve(graph);
    });
    cleared();
  },
);

it('clears already-loaded files and graph on a later file denial', async () => {
  api.get.mockResolvedValue(waiting);
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Which pipe style?');
  await user.click(screen.getByRole('tab', { name: 'Graph' }));
  await user.click(await screen.findByRole('button', { name: 'Open file for Pipe source' }));
  await screen.findByText('export const pipe = 1;');
  api.file.mockRejectedValueOnce(new ApiError(404, 'File is no longer available'));
  await user.click(screen.getByRole('button', { name: /assets\/pipe.png/ }));
  await screen.findByRole('alert');
  cleared();
  api.get.mockResolvedValueOnce(ready);
  await click('Refresh status');
  expect(screen.getByText(ready.prompt)).toBeInTheDocument();
  expect(screen.queryByText('Which pipe style?')).not.toBeInTheDocument();
  expect(screen.queryByText('export const pipe = 1;')).not.toBeInTheDocument();
});

it('discards loaded detail on expiry instead of revealing it when expiry is rearmed', async () => {
  const oldGet = deferred<NativeIntent>();
  api.get.mockResolvedValue(waiting);
  renderPage();
  await screen.findByText('Which pipe style?');
  api.get.mockReturnValueOnce(oldGet.promise);
  await click('Refresh status');
  await act(async () => notifySessionExpired());
  cleared();
  await act(async () => {
    armSessionExpiry();
    clearNativeIntents();
    oldGet.resolve(waiting);
  });
  cleared();
  api.get.mockResolvedValueOnce(ready);
  await click('Refresh status');
  expect(screen.getByText(ready.prompt)).toBeInTheDocument();
  expect(screen.queryByText('Which pipe style?')).not.toBeInTheDocument();
});

it('honors a late file denial after an isolated graph transport error', async () => {
  const pending = deferred<NativeFileContent>();
  api.get.mockResolvedValue(waiting);
  api.file.mockReturnValueOnce(pending.promise);
  api.graph.mockRejectedValueOnce(new Error('Graph connection interrupted'));
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Loading the published question file…');
  await user.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('alert');
  expect(screen.getByText(ready.title)).toBeInTheDocument();
  await act(async () => pending.reject(new ApiError(403, 'Membership revoked')));
  cleared();
});

it('opens a source file from a verified derived node and preserves it after a graph outage', async () => {
  api.get.mockResolvedValue(waiting);
  const file = publication.files[1];
  api.graph.mockResolvedValueOnce({
    publicationId: publication.id,
    nodes: [
      {
        id: 'derived',
        type: 'Section',
        label: 'Source section',
        artifactId: file.id,
        path: file.path,
        sha256: file.sha256,
        publicationId: publication.id,
        provenance: {
          projectId: 'project-1',
          executionId: 'run-1',
          publicationId: publication.id,
          publicationSequence: publication.sequence,
          fileId: file.id,
          sha256: file.sha256,
          path: file.path,
          revisionId: `${file.id}:${file.sha256}`,
          contract: 'native-trace-v1',
          method: 'deterministic',
          sourceKind: 'markdown-section',
          startLine: 1,
          endLine: 1,
        },
      },
    ],
    edges: [],
  });
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Which pipe style?');
  await user.click(screen.getByRole('tab', { name: 'Graph' }));
  await user.click(await screen.findByRole('button', { name: 'Open file for Source section' }));
  expect(api.file).toHaveBeenLastCalledWith('project-1', 'run-1', file.id);
  api.graph.mockRejectedValueOnce(new Error('Graph unavailable'));
  await user.click(screen.getByRole('tab', { name: 'Graph' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(await screen.findByText('Which pipe style?')).toBeInTheDocument();
});

it('keeps a different native route isolated from an old publication denial', async () => {
  const pending = deferred<NativePublication>();
  api.get.mockResolvedValueOnce(waiting).mockResolvedValueOnce({
    ...ready,
    id: 'run-2',
    title: 'Another native run',
    prompt: 'Other request.',
  });
  api.publication.mockReturnValueOnce(pending.promise);
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Loading the committed revision…');
  await user.click(screen.getByRole('link', { name: 'Other native run' }));
  await screen.findByText('Other request.');
  await act(async () => pending.reject(new ApiError(403, 'Old publication denied')));
  expect(screen.getByText('Other request.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each(['publication', 'file', 'graph'] as const)(
  'rejects a %s from a different publication without showing its content',
  async (operation) => {
    api.get.mockResolvedValue(waiting);
    const user = userEvent.setup();
    if (operation === 'publication')
      api.publication.mockResolvedValueOnce({ ...publication, id: 'foreign' });
    else if (operation === 'file')
      api.file.mockResolvedValueOnce({ ...contents['question-1'], publicationId: 'foreign' });
    else api.graph.mockResolvedValueOnce({ ...graph, publicationId: 'foreign' });
    renderPage();
    if (operation === 'graph') {
      await screen.findByText('Which pipe style?');
      await user.click(screen.getByRole('tab', { name: 'Graph' }));
    }
    await screen.findByRole('alert');
    expect(screen.getByText(ready.title)).toBeInTheDocument();
    expect(screen.queryByText('Which pipe style?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open file for/ })).not.toBeInTheDocument();
    if (operation === 'graph') {
      await user.click(screen.getByRole('tab', { name: 'Overview' }));
      expect(await screen.findByText('Which pipe style?')).toBeInTheDocument();
    } else expect(screen.getByRole('button', { name: 'Reload publication' })).toBeEnabled();
  },
);

it('observes another member cancelling a legacy wait after graph projection catches up', async () => {
  vi.useFakeTimers();
  api.get
    .mockResolvedValueOnce({
      ...ready,
      execution: { ...execution, status: 'RUNNING', publicationId: null, projectionStatus: null },
    })
    .mockResolvedValueOnce({
      ...waiting,
      execution: { ...execution, projectionStatus: 'pending' },
    })
    .mockResolvedValue(waiting);
  api.publication.mockResolvedValue({ ...publication, projectionStatus: 'pending' });
  await act(async () => renderPage());
  expect(screen.getByRole('status')).toHaveTextContent('Agent running');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for input');
  expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
  await act(async () =>
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Graph' }), { button: 0 }),
  );
  expect(screen.getByText(/Graph projection is still pending/)).toBeInTheDocument();
  expect(api.graph).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.graph).toHaveBeenCalledTimes(1);
  api.get.mockResolvedValueOnce({
    ...waiting,
    execution: {
      ...execution,
      status: 'CANCEL_REQUESTED',
      updatedAt: '2026-09-29T09:05:00Z',
    },
  });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
  expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeDisabled();
  api.get.mockResolvedValueOnce({
    ...waiting,
    execution: { ...execution, status: 'CANCELLED', updatedAt: '2026-09-29T09:06:00Z' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('status')).toHaveTextContent('Execution cancelled');
  expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
  expect(api.cancel).not.toHaveBeenCalled();
  const requests = api.get.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(api.get).toHaveBeenCalledTimes(requests);
});

it.each(['legacy timestamps', 'server revision', 'missing revision'] as const)(
  'ignores an older refresh after polling confirms cancellation using %s',
  async (ordering) => {
    vi.useFakeTimers();
    const revision = ordering === 'legacy timestamps' ? undefined : 8;
    const stale: NativeIntent = {
      ...waiting,
      execution: {
        ...execution,
        revision: ordering === 'server revision' ? 7 : undefined,
        // A server revision takes precedence even over a later timestamp.
        updatedAt: ordering === 'legacy timestamps' ? execution.updatedAt : '2027-01-01T00:00:00Z',
      },
    };
    api.get.mockResolvedValueOnce(waiting);
    await act(async () => renderPage());
    const oldRefresh = deferred<NativeIntent>();
    api.get.mockReturnValueOnce(oldRefresh.promise);
    await click('Refresh status');
    api.get.mockResolvedValueOnce({
      ...waiting,
      execution: {
        ...execution,
        revision,
        status: 'CANCEL_REQUESTED',
        updatedAt: '2026-09-29T09:05:00Z',
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
    await act(async () => oldRefresh.resolve(stale));
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
    expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeDisabled();
    api.get.mockResolvedValueOnce({
      ...waiting,
      execution: {
        ...execution,
        revision: revision === undefined ? undefined : revision + 1,
        status: 'CANCELLED',
        updatedAt: '2026-09-29T09:06:00Z',
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Execution cancelled');
    expect(api.cancel).not.toHaveBeenCalled();
  },
);

it.each(['legacy', 'revisioned'] as const)(
  'does not let an outstanding %s poll overwrite a cancellation acknowledgement',
  async (contract) => {
    vi.useFakeTimers();
    const oldPoll = deferred<NativeIntent>();
    api.get.mockResolvedValueOnce(waiting).mockReturnValueOnce(oldPoll.promise);
    await act(async () => renderPage());
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(api.get).toHaveBeenCalledTimes(2);
    api.cancel.mockResolvedValueOnce({
      ...waiting,
      execution: {
        ...execution,
        revision: contract === 'revisioned' ? 8 : undefined,
        status: 'CANCEL_REQUESTED',
        updatedAt: '2026-09-29T09:05:00Z',
      },
    });
    await click('Cancel execution');
    await act(async () => oldPoll.resolve(waiting));
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
    expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeDisabled();
    expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
    api.get.mockResolvedValueOnce({
      ...waiting,
      execution: {
        ...execution,
        revision: contract === 'revisioned' ? 9 : undefined,
        status: 'CANCELLED',
        updatedAt: '2026-09-29T09:06:00Z',
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Execution cancelled');
    const requests = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.get).toHaveBeenCalledTimes(requests);
  },
);

it.each(['legacy', 'revisioned'] as const)(
  'does not let a late %s cancellation acknowledgement overwrite terminal status from polling',
  async (contract) => {
    vi.useFakeTimers();
    api.get.mockResolvedValueOnce(waiting);
    await act(async () => renderPage());
    const oldCancel = deferred<NativeIntent>();
    api.cancel.mockReturnValueOnce(oldCancel.promise);
    await click('Cancel execution');
    api.get.mockResolvedValueOnce({
      ...waiting,
      execution: {
        ...execution,
        revision: contract === 'revisioned' ? 9 : undefined,
        status: 'CANCELLED',
        updatedAt: '2026-09-29T09:06:00Z',
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Execution cancelled');
    await act(async () =>
      oldCancel.resolve({
        ...waiting,
        execution: {
          ...execution,
          revision: contract === 'revisioned' ? 8 : undefined,
          status: 'CANCEL_REQUESTED',
          updatedAt: '2026-09-29T09:05:00Z',
        },
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Execution cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
    const requests = api.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.get).toHaveBeenCalledTimes(requests);
  },
);

it.each(['STOPPED', 'FAILED'] as const)(
  'uses the existing cancellation action to stop an unconfirmed %s runtime',
  async (status) => {
    api.get.mockResolvedValue({ ...waiting, execution: { ...execution, status } });
    api.cancel.mockResolvedValue({
      ...waiting,
      execution: {
        ...execution,
        status: 'CANCEL_REQUESTED',
        stopStatus: { state: 'pending', confirmedAt: null },
      },
    });
    renderPage();
    await screen.findByText('Which pipe style?');
    expect(api.cancel).not.toHaveBeenCalled();
    await click('Cancel execution');
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith('project-1', 'run-1');
    expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  },
);

it.each(['success', 'denial'] as const)(
  'discards an outstanding waiting poll %s after the account changes',
  async (outcome) => {
    vi.useFakeTimers();
    const oldPoll = deferred<NativeIntent>();
    api.get.mockResolvedValueOnce(waiting).mockReturnValueOnce(oldPoll.promise);
    await act(async () => renderPage());
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(api.get).toHaveBeenCalledTimes(2);
    const nextAccount = { ...ready, title: 'New account', prompt: 'New account content' };
    api.get.mockResolvedValueOnce(nextAccount);
    await act(async () => resetSessionExpiry());
    expect(screen.getByText(nextAccount.prompt)).toBeVisible();
    expect(screen.queryByText(ready.prompt)).not.toBeInTheDocument();
    await act(async () => {
      if (outcome === 'success') oldPoll.resolve(waiting);
      else oldPoll.reject(new ApiError(403, 'Previous account denied'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(screen.getByText(nextAccount.prompt)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Which pipe style?')).not.toBeInTheDocument();
  },
);

it('keeps polling after a stale preparation-only response and accepts the later committed question', async () => {
  vi.useFakeTimers();
  api.get
    .mockResolvedValueOnce({
      ...ready,
      execution: { ...execution, status: 'RUNNING', publicationId: null, projectionStatus: null },
    })
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({
      ...waiting,
      execution: { ...execution, updatedAt: '2026-09-29T09:05:00Z' },
    });
  await act(async () => renderPage());
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('status')).toHaveTextContent('Agent running');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.get).toHaveBeenCalledTimes(3);
  expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
});

it('cancels explicitly and disables cancellation while the server acknowledges the request', async () => {
  api.get.mockResolvedValue(waiting);
  api.cancel.mockResolvedValue({
    ...waiting,
    execution: { ...execution, status: 'CANCEL_REQUESTED' },
  });
  renderPage();
  await screen.findByText('Which pipe style?');
  await click('Cancel execution');
  expect(api.cancel).toHaveBeenCalledWith('project-1', 'run-1');
  expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');
  expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeDisabled();
  expect(
    within(screen.getByRole('region', { name: 'Published question' })).getByText(
      'Which pipe style?',
    ),
  ).toBeVisible();
});

it.each(['STOPPED', 'FAILED', 'CANCELLED'] as const)(
  'polls %s only until projection catches up and never enables another Start',
  async (status) => {
    vi.useFakeTimers();
    api.get
      .mockResolvedValueOnce({
        ...waiting,
        execution: { ...execution, status, projectionStatus: 'pending' },
      })
      .mockResolvedValue({ ...waiting, execution: { ...execution, status } });
    await act(async () => renderPage());
    expect(screen.getByText('Which pipe style?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();
    if (status === 'CANCELLED')
      expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.get).toHaveBeenCalledTimes(2);
  },
);
