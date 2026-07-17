import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentOutputTranscript } from './AgentOutputTranscript';
import type { IntentOutput } from '@/services/intents';

const row = (
  seq: number,
  content: string,
  display?: IntentOutput['display'],
  timestamp = `2026-07-16T12:57:${String(seq).padStart(2, '0')}.000Z`,
): IntentOutput => ({
  seq,
  stageInstanceId: 'si-1',
  kind: 'stdout',
  content,
  timestamp,
  ...(display ? { display } : {}),
});

describe('AgentOutputTranscript', () => {
  it('renders narration as Markdown with compact 24-hour timestamps', () => {
    render(
      <AgentOutputTranscript
        rows={[
          row(1, '**Step 1: Read README.md**', {
            type: 'message',
            summary: '**Step 1: Read README.md**',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Step 1: Read README.md', { selector: 'strong' })).toBeInTheDocument();
    expect(document.querySelector('time')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(document.querySelector('time')).toHaveAttribute('title', '2026-07-16T12:57:01.000Z');
  });

  it('coalesces a question, parked response, answer, and resume into one lifecycle event', () => {
    const { container } = render(
      <AgentOutputTranscript
        rows={[
          row(
            1,
            'Running tool ask_question\n{"questions":[{"text":"Should the local E2E continue?"}]}',
            { type: 'question', title: 'Asked a question' },
          ),
          row(2, '> Question parked - stopping immediately.', {
            type: 'message',
            summary: '> Question parked - stopping immediately.',
          }),
          row(3, 'The human answered "Proceed" - resuming the stage now.', {
            type: 'message',
            summary: 'The human answered "Proceed" - resuming the stage now.',
          }),
          row(4, 'Created artifact', { type: 'artifact', title: 'Created artifact: result' }),
        ]}
      />,
    );

    expect(screen.getByText('Question: Should the local E2E continue?')).toBeInTheDocument();
    expect(screen.getByText('Parked; Answered: Proceed; Resumed')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-output-type="question"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-output-type="message"]')).toHaveLength(0);
  });

  it('coalesces Kiro native create chatter and its numbered patch into one edit', () => {
    const { container } = render(
      <AgentOutputTranscript
        rows={[
          row(
            1,
            "I'll create the following file: /mnt/workspace/agent-output-kiro.txt (using tool: write)",
            {
              type: 'message',
              summary:
                "I'll create the following file: /mnt/workspace/agent-output-kiro.txt (using tool: write)",
            },
          ),
          row(2, '+    1: agent output parser fixture for kiro\n', {
            type: 'edit',
            title: 'Updated 1 line',
            details: '+    1: agent output parser fixture for kiro',
          }),
          row(3, 'Creating: /mnt/workspace/agent-output-kiro.txt', {
            type: 'message',
            summary: 'Creating: /mnt/workspace/agent-output-kiro.txt',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Created: agent-output-kiro.txt (+1 line)')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-output-type="edit"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-output-type="message"]')).toHaveLength(0);
  });

  it('marks final stage messages as success events and removes terminal prompt prefixes', () => {
    const { container } = render(
      <AgentOutputTranscript
        rows={[
          row(1, '> Stage complete - all artifacts recorded.', {
            type: 'message',
            summary: '> Stage complete - all artifacts recorded.',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Stage complete - all artifacts recorded.')).toBeInTheDocument();
    expect(container.querySelector('[data-output-level="success"]')).not.toBeNull();
  });
});
