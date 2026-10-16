import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { audit, context } = vi.hoisted(() => ({
  audit: vi.fn(),
  context: {
    projectId: 'project',
    intentId: 'intent',
    detail: {
      intent: { status: 'SUCCEEDED', title: 'Example', completedAt: 'first' },
    },
    loading: false,
    error: null,
  },
}));
vi.mock('@/contexts/IntentContext', () => ({ useIntent: () => context }));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({ project: { name: 'Project' } }),
}));
vi.mock('@/services/intents', () => ({ intentsService: { audit } }));
import IntentAuditPage from './IntentAuditPage';

const result = (state = 'incomplete') => ({
  completion: {
    state,
    total: 2,
    integrated: 1,
    skipped: 0,
    reason: 'unit_unfinished',
    unresolved: [{ sectionIndex: 1, slug: 'feature', state: 'BLOCKED', reason: 'unit_unfinished' }],
  },
  environment: null,
  summary: {
    stageCount: 0,
    eventCount: 0,
    humanTaskCount: 0,
    metricSamples: 0,
    graphReadCalls: 0,
    graphReadBytes: 0,
    sensorRuns: 0,
    sensorFindings: 0,
  },
  graphReads: { totalBytes: 0, byTool: [] },
  enrichment: {
    mode: 'off',
    calls: 0,
    tokensInput: 0,
    tokensOutput: 0,
    credits: 0,
    reads: { compactCalls: 0, compactBytes: 0, fullCalls: 0, fullBytes: 0, compactShare: null },
  },
  derivation: {
    runs: 0,
    failures: 0,
    partial: 0,
    enrichmentSkips: 0,
    structuredBlocks: { present: 0, absent: 0, malformed: 0, checked: 0, complianceRate: null },
  },
  promptContext: { samples: 0, promptBytes: 0, compiledContextBytes: 0, avgPromptBytes: null },
  units: [],
  metrics: [],
  sensors: { runs: 0, findings: [] },
  advisories: [],
});
beforeEach(() => {
  audit.mockReset();
  context.detail.intent.status = 'SUCCEEDED';
  context.detail.intent.completedAt = crypto.randomUUID();
});
const page = () => (
  <MemoryRouter>
    <IntentAuditPage />
  </MemoryRouter>
);

it('shows the unfinished unit and links to the recorded work', async () => {
  audit.mockResolvedValue(result());
  render(page());
  expect(await screen.findByText('Completion consistency')).toBeInTheDocument();
  expect(screen.getByText(/Section 1 · feature: BLOCKED/)).toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Review integrated work and remaining scope' }),
  ).toHaveAttribute('href', '/space/project/intent/intent');
});

it('does not present a cached clean result when a replacement execution audit fails', async () => {
  audit.mockResolvedValueOnce(result('complete'));
  const view = render(page());
  expect(await screen.findByText('Completion consistency')).toBeInTheDocument();
  audit.mockRejectedValueOnce(new Error('read failed'));
  context.detail.intent.completedAt = 'replacement';
  view.rerender(page());
  expect(await screen.findByText('Failed to load intent audit')).toBeInTheDocument();
  expect(screen.queryByText('Completion consistency')).not.toBeInTheDocument();
});

it('shows cancellation as aborted while preserving the unfinished unit evidence', async () => {
  context.detail.intent.status = 'CANCELLED';
  const data = result('aborted');
  data.completion.reason = 'execution_aborted';
  audit.mockResolvedValue(data);
  render(page());
  expect(await screen.findByText(/aborted: 1 of 2 units verified integrated/)).toBeInTheDocument();
  expect(screen.getByText('execution aborted')).toBeInTheDocument();
  expect(screen.getByText(/Section 1 · feature: BLOCKED/)).toBeInTheDocument();
  expect(screen.queryByText(/Unverified:/)).not.toBeInTheDocument();
});
