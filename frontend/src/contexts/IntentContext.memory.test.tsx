import { Session } from 'node:inspector/promises';
import { useCallback, useEffect, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@/test/query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntentArtifact } from '@/services/intents';
import { queryClient } from '@/lib/queryClient';
import { clearIntentCache, IntentProvider, useIntent } from './IntentContext';

vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/services/realtime', () => ({
  realtimeService: { onStatusChange: () => () => {} },
}));
vi.mock('@/services/intents', () => ({
  intentsService: {
    // No vi.fn result history: it would retain the very DTOs we want GC to collect.
    get: async (_projectId: string, intentId: string) => ({
      intent: { id: intentId, projectId: 'p', title: intentId, status: 'SUCCEEDED' },
      stages: [],
      events: [],
      gates: [],
      metrics: [],
      sensorRuns: [],
      artifacts: [{ id: 'artifact', content: `# Body for ${intentId}`, generation: 1 }],
    }),
  },
}));

afterEach(() => {
  cleanup();
  clearIntentCache();
  queryClient.clear();
});

async function collectGarbage() {
  // Cross a task boundary: WeakRef targets stay alive through the current job.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.collectGarbage');
    await session.post('HeapProfiler.collectGarbage');
  } finally {
    session.disconnect();
  }
}

it('releases superseded artifact arrays while route and panel callbacks change independently', async () => {
  const arrays: WeakRef<IntentArtifact[]>[] = [];
  const seen = new WeakSet<IntentArtifact[]>();

  function Probe() {
    const { detail, openTimeline, activityTabRequest } = useIntent();
    const navigate = useNavigate();
    useEffect(() => {
      if (detail && !seen.has(detail.artifacts)) {
        seen.add(detail.artifacts);
        arrays.push(new WeakRef(detail.artifacts));
      }
    }, [detail]);
    return (
      <>
        <span data-testid="intent">{detail?.intent.id}</span>
        <span data-testid="tab-request">
          {activityTabRequest?.tab}:{activityTabRequest?.seq}
        </span>
        <button onClick={() => navigate('/space/p/intent/i1')}>Intent one</button>
        <button onClick={() => navigate('/space/p/intent/i2')}>Intent two</button>
        <button onClick={openTimeline}>Timeline</button>
      </>
    );
  }

  function Shell() {
    const [open, setOpen] = useState(false);
    // Like AppShell: panel visibility changes this callback independently of ids.
    const showPanel = useCallback(() => {
      if (!open) setOpen(true);
    }, [open]);
    return (
      <>
        <span data-testid="panel">{String(open)}</span>
        <button onClick={() => setOpen((value) => !value)}>Toggle panel</button>
        <IntentProvider onAgentFocus={showPanel}>
          <Probe />
        </IntentProvider>
      </>
    );
  }

  render(
    <MemoryRouter initialEntries={['/space/p/intent/i1']}>
      <Routes>
        <Route path="/space/:projectId/intent/:intentId" element={<Shell />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(arrays).toHaveLength(1));
  for (let visit = 0; visit < 12; visit++) {
    const previousCount = arrays.length;
    // Each visit reads a new detail generation (cached details are otherwise reused).
    void queryClient.invalidateQueries({ queryKey: ['intent'], refetchType: 'none' });
    await act(async () => {
      screen.getByRole('button', { name: visit % 2 === 0 ? 'Intent two' : 'Intent one' }).click();
    });
    await waitFor(() => expect(arrays.length).toBeGreaterThan(previousCount));
    // Separate render: memoized loading callbacks survive this panel change.
    await act(async () => {
      screen.getByRole('button', { name: 'Toggle panel' }).click();
    });
  }

  // Both keys have newer details. Keep the provider, caches and latest callbacks
  // alive; only old arrays must disappear (the final renders may retain a tail).
  await collectGarbage();
  expect(arrays.slice(0, 8).map((reference) => reference.deref() === undefined)).toEqual(
    Array(8).fill(true),
  );

  // The retained actions still invoke the current parent callback and preserve
  // sequence numbers, including a repeated request for the same tab.
  for (const seq of [1, 2]) {
    await act(async () => {
      screen.getByRole('button', { name: 'Timeline' }).click();
    });
    expect(screen.getByTestId('tab-request')).toHaveTextContent(`timeline:${seq}`);
    expect(screen.getByTestId('panel')).toHaveTextContent('true');
  }
}, 15_000);
