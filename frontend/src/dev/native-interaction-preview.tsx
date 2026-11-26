import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import NativeIntentPage from '@/pages/NativeIntentPage';
import { api, ApiError } from '@/services/api';
import type { NativeReplyRequest } from '@/services/nativeIntents';
import { nativeInteractionFixture } from './native-interaction.fixture';
import '@/index.css';

// A separate Vite HTML entry, like agent-output-preview.html. It is not an app
// route or production build input. Only this document's API module is replaced.
if (!import.meta.env.DEV) throw new Error('The native fixture preview is development-only.');
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'waiting';
const fixture = await nativeInteractionFixture(scenario);
const base = '/projects/preview-project/native-intents/preview-run';
let firstReply = true;
const reject = async (): Promise<never> => {
  throw new ApiError(403, 'Outside the local preview fixture');
};
Object.assign(api, { get: reject, post: reject, put: reject, patch: reject, delete: reject });
api.get = async <T,>(path: string): Promise<T> => {
  const value =
    path === base
      ? fixture.intent
      : path === `${base}/interaction`
        ? fixture.interaction
        : path === `${base}/publication`
          ? fixture.publication
          : path === `${base}/graph`
            ? fixture.graph
            : path === `${base}/files/preview-readme`
              ? fixture.file
              : undefined;
  if (value === undefined) return reject();
  return structuredClone(value) as T;
};
api.post = async <T,>(path: string, body: unknown): Promise<T> => {
  if (path !== `${base}/response`) return reject();
  if (scenario === 'retry' && firstReply) {
    firstReply = false;
    throw new ApiError(503, 'Synthetic connection failure');
  }
  const request = body as NativeReplyRequest;
  if (
    request.interactionId !== fixture.interaction.id ||
    request.contentSha256 !== fixture.interaction.contentSha256
  ) {
    throw new ApiError(409, 'Synthetic stale interaction');
  }
  fixture.interaction.response = {
    id: 'bed6a902-10ce-459c-87b3-e5689a57c57b',
    kind: 'user_reply',
    interactionId: fixture.interaction.id,
    sequence: fixture.interaction.sequence + 1,
    actorId: 'preview-member',
    text: request.text,
    acceptedAt: new Date().toISOString(),
    deliveryStatus: 'pending',
  };
  fixture.intent.execution = {
    ...fixture.intent.execution!,
    status: 'DISPATCHING',
    turnSequence: fixture.interaction.sequence + 1,
    responsePending: true,
    updatedAt: new Date().toISOString(),
  };
  return structuredClone({ ...fixture.intent, response: fixture.interaction.response }) as T;
};

const rootElement = document.getElementById('root')!;
const root = import.meta.hot?.data.root ?? createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <StrictMode>
    <div className="min-h-screen bg-background text-foreground">
      <aside className="space-y-2 border-b bg-muted px-4 py-3 text-sm">
        <p>
          <strong>Local fixture preview.</strong> Real native intent page with synthetic data. No
          API, model or deployment calls.
        </p>
        <nav aria-label="Preview scenarios" className="flex flex-wrap gap-4">
          <a className="underline" href="?scenario=waiting">
            Assistant response
          </a>
          <a className="underline" href="?scenario=retry">
            Reply retry
          </a>
          <a className="underline" href="?scenario=pending">
            Accepted, delivery pending
          </a>
          <a className="underline" href="?scenario=next">
            Next assistant turn
          </a>
        </nav>
      </aside>
      <MemoryRouter initialEntries={['/space/preview-project/native-intent/preview-run']}>
        <Routes>
          <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
          <Route
            path="*"
            element={
              <p className="p-4">This local preview only contains the native intent page.</p>
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  </StrictMode>,
);
