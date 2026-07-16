import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    projectId: 'p1',
    intentId: 'i1',
    detail: { intent: { id: 'i1', status: 'RUNNING' } },
    compiled: { graph: { nodes: [{ stageId: 's1', phasePath: '01' }], edges: [] } },
    stageRows: [{ stageId: 's1', phase: '01', state: 'RUNNING', done: 0, total: 1 }],
    loading: false,
    phaseNameOf: () => 'Build',
    initializationPhasePaths: new Set(),
    workflowPhases: [{ path: '01', name: 'Build' }],
    currentPhasePath: '01',
  }),
}));

vi.mock('@/lib/intentPhases', () => ({
  groupByPhase: (rows: unknown[]) => (rows.length > 0 ? [{ phase: '01', done: 0, total: 1 }] : []),
  derivePhaseState: () => 'active',
}));

import { IntentPipelineBar, detectSection } from './IntentPipelineBar';
import { getLastIntentSection } from '@/lib/intentSectionPreference';

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <IntentPipelineBar />
      </TooltipProvider>
    </MemoryRouter>,
  );

describe('IntentPipelineBar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders phase progress chips on the work route', () => {
    const { container } = renderAt('/space/p1/intent/i1');
    expect(container.textContent).toContain('Build');
  });

  it('persists work when on the root intent route', () => {
    renderAt('/space/p1/intent/i1');
    expect(getLastIntentSection('i1')).toBe('work');
  });

  it('persists overview when on the observability route', () => {
    renderAt('/space/p1/intent/i1/observability');
    expect(getLastIntentSection('i1')).toBe('overview');
  });

  it('persists overview when on the audit route', () => {
    renderAt('/space/p1/intent/i1/audit');
    expect(getLastIntentSection('i1')).toBe('overview');
  });

  it('persists graph when on the graph route', () => {
    renderAt('/space/p1/intent/i1/graph');
    expect(getLastIntentSection('i1')).toBe('graph');
  });
});

describe('detectSection', () => {
  it('maps root intent path to work', () => {
    expect(detectSection('/space/p1/intent/i1')).toBe('work');
  });

  it('maps review subroute to work', () => {
    expect(detectSection('/space/p1/intent/i1/review/h1')).toBe('work');
  });

  it('maps /observability to overview', () => {
    expect(detectSection('/space/p1/intent/i1/observability')).toBe('overview');
  });

  it('maps /audit to overview', () => {
    expect(detectSection('/space/p1/intent/i1/audit')).toBe('overview');
  });

  it('maps /graph to graph', () => {
    expect(detectSection('/space/p1/intent/i1/graph')).toBe('graph');
  });
});
