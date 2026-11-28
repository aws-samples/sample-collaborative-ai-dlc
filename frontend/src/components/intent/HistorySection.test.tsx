import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { IntentGate, IntentSteering } from '@/services/intents';

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    stageNameOf: (key: string) => key,
    stageRows: [],
    reviseGate: vi.fn(),
    gateAccess: () => ({ access: { edit: true, decide: true } }),
  }),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({ DiscussButton: () => null }));

import { HistorySection } from './HistorySection';

const gate = (id: string): IntentGate => ({
  humanTaskId: id,
  stageInstanceId: 'si-1',
  kind: 'question',
  status: 'answered',
  prompt: null,
  options: null,
  questions: JSON.stringify([{ text: `Question ${id}?` }]),
  answer: JSON.stringify({ answers: [{ selected: [0], freeText: 'Cognito' }] }),
  answeredBy: 'ada',
  answeredAt: '2026-01-01T01:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
});

describe('HistorySection', () => {
  it('is one inline Disclosure without a count, collapsed until opened (design review W36 §4)', async () => {
    render(
      <HistorySection
        questionGates={[gate('q1'), gate('q2'), { ...gate('q3'), status: 'pending' }]}
        steering={[]}
        influencedArtifactsByQuestion={new Map()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Past questions & corrections' });
    expect(trigger.closest('[data-slot="disclosure"]')).toHaveAttribute('data-variant', 'inline');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Question q1?')).toBeNull();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Question q1?')).toBeInTheDocument();
    expect(screen.getByText('Question q2?')).toBeInTheDocument();
    expect(screen.queryByText('Question q3?')).toBeNull();
  });

  it('shows no count beside a stage group or Course corrections', async () => {
    const steer: IntentSteering = {
      steerId: 's1',
      kind: 'gate-steer',
      status: 'consumed',
      message: 'Use Cognito instead',
      targetGateId: null,
      targetStageId: null,
      createdBy: 'ada',
      createdByName: 'Ada',
      createdAt: '2026-01-01T02:00:00Z',
      consumedAt: null,
      consumedByStageInstanceId: null,
    };
    render(
      <HistorySection
        questionGates={[gate('q1'), gate('q2'), { ...gate('q3'), stageInstanceId: 'si-2' }]}
        steering={[steer]}
        influencedArtifactsByQuestion={new Map()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Past questions & corrections' }));

    // Two stage groups, so each gets its heading.
    expect(screen.getAllByText('Agent question')).toHaveLength(2);
    const corrections = screen.getByRole('button', { name: 'Course corrections' });
    expect(screen.queryByText(/^\(?\d+\)?$/)).toBeNull();

    await userEvent.click(corrections);
    expect(screen.getByText('Use Cognito instead')).toBeInTheDocument();
  });

  it('renders nothing without past questions or corrections', () => {
    const { container } = render(
      <HistorySection questionGates={[]} steering={[]} influencedArtifactsByQuestion={new Map()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
