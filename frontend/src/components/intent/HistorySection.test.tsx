import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { IntentGate } from '@/services/intents';

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
  it('is one inline Disclosure with the count, collapsed until opened (design review W36 §4)', async () => {
    render(
      <HistorySection
        questionGates={[gate('q1'), gate('q2'), { ...gate('q3'), status: 'pending' }]}
        steering={[]}
        influencedArtifactsByQuestion={new Map()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Past questions & corrections (2)' });
    expect(trigger.closest('[data-slot="disclosure"]')).toHaveAttribute('data-variant', 'inline');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Question q1?')).toBeNull();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Question q1?')).toBeInTheDocument();
    expect(screen.getByText('Question q2?')).toBeInTheDocument();
    expect(screen.queryByText('Question q3?')).toBeNull();
  });

  it('renders nothing without past questions or corrections', () => {
    const { container } = render(
      <HistorySection questionGates={[]} steering={[]} influencedArtifactsByQuestion={new Map()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
