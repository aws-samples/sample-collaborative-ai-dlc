import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GateAnswer, IntentGate } from '@/services/intents';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ stageNameOf: (id: string) => id, detail: null }),
}));

import { GateCard } from './GateCard';

const gate: IntentGate = {
  humanTaskId: 'h1',
  stageInstanceId: 'si-1',
  kind: 'approval',
  status: 'pending',
  prompt: 'Choose an action',
  options: ['approve', 'request-changes'],
  questions: null,
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: null,
};

const renderGate = (onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>) =>
  render(<GateCard gate={gate} projectId="p1" intentId="i1" userName="Ada" onAnswer={onAnswer} />);

describe('GateCard answer actions', () => {
  it('disables every option while one answer is pending', async () => {
    let resolveAnswer!: () => void;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    renderGate(onAnswer);
    const approve = screen.getByRole('button', { name: 'approve' });
    const requestChanges = screen.getByRole('button', { name: 'request-changes' });

    await userEvent.click(approve);

    expect(approve).toBeDisabled();
    expect(requestChanges).toBeDisabled();
    await userEvent.click(approve);
    expect(onAnswer).toHaveBeenCalledTimes(1);

    resolveAnswer();
    await waitFor(() => expect(approve).not.toBeDisabled());
  });

  it('shows an inline error when answering an engine gate fails', async () => {
    renderGate(
      vi.fn(async () => {
        throw new Error('Gate answer failed');
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'approve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Gate answer failed');
  });
});
