import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingQuestionsTabs, gateTabLabel } from './PendingQuestionsTabs';
import type { IntentGate } from '@/services/intents';

const gate = (over: Partial<IntentGate> = {}): IntentGate =>
  ({
    humanTaskId: 'h1',
    stageInstanceId: 'si-1',
    status: 'pending',
    kind: 'question',
    questions: '[{"text":"Question 1?"}]',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as IntentGate;

const makeGates = (count: number): IntentGate[] =>
  Array.from({ length: count }, (_, i) =>
    gate({
      humanTaskId: `h${i + 1}`,
      stageInstanceId: `si-${i + 1}`,
      questions: `[{"text":"Question ${i + 1}?"}]`,
    }),
  );

const renderTabs = (gates: IntentGate[], over: Record<string, unknown> = {}) =>
  render(
    <PendingQuestionsTabs
      gates={gates}
      activeGateId={gates[0]?.humanTaskId ?? null}
      renderGateCard={(g) => <div data-testid={`card-${g.humanTaskId}`} />}
      {...over}
    />,
  );

describe('gateTabLabel', () => {
  it('prefers the prompt', () => {
    expect(gateTabLabel(gate({ prompt: 'Approve the plan' }))).toBe('Approve the plan');
  });

  it('falls back to the first parsed question text', () => {
    expect(gateTabLabel(gate())).toBe('Question 1?');
  });

  it('labels validation gates without prompt/questions as reviews', () => {
    expect(gateTabLabel(gate({ kind: 'validation', questions: null }))).toBe('Review required');
  });

  it('labels unparseable non-question gates as approvals', () => {
    expect(gateTabLabel(gate({ kind: 'approval', questions: 'not-json' }))).toBe(
      'Approval required',
    );
  });
});

describe('PendingQuestionsTabs — gateContext prefix', () => {
  it('renders the context prefix on tabs and overflow items', async () => {
    renderTabs(makeGates(7), {
      gateContext: (g: IntentGate) => `Stage ${g.humanTaskId.slice(1)}`,
    });
    const firstTab = screen.getByRole('tab', { name: /Question 1\?/ });
    expect(within(firstTab).getByText('Stage 1')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/more questions/));
    expect(await screen.findByText('Stage 7')).toBeInTheDocument();
  });

  it('omits the prefix when gateContext returns null', () => {
    renderTabs(makeGates(3), { gateContext: () => null });
    expect(screen.getByRole('tab', { name: 'Question 1?' })).toBeInTheDocument();
  });
});

describe('PendingQuestionsTabs — keyboard navigation', () => {
  it('cycles visible tabs with arrow keys and reaches the overflow trigger from the last tab', async () => {
    renderTabs(makeGates(8));
    const firstTab = screen.getByRole('tab', { name: 'Question 1?' });
    firstTab.focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Question 2?' })).toHaveFocus();

    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Question 5?' })).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByLabelText('3 more questions')).toHaveFocus();
  });

  it('returns focus from the overflow trigger to the last visible tab on ArrowLeft', async () => {
    renderTabs(makeGates(8));
    screen.getByLabelText('3 more questions').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Question 5?' })).toHaveFocus();
  });

  it('wraps around without an overflow trigger', async () => {
    renderTabs(makeGates(3));
    await userEvent.click(screen.getByRole('tab', { name: 'Question 3?' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Question 1?' })).toHaveFocus();
  });
});
