import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { IntentGate } from '@/services/intents';
import { ExternalDevelopmentGateCard } from './ExternalDevelopmentGateCard';

const repository = (name: string) => ({
  name,
  repository: `jeromevdl/${name}`,
  provider: 'github',
  baseSha: 'a'.repeat(40),
  branch: 'aidlc/create-crud-bookstore--s1-unit-bookstore-api-contract',
});

const gate = (repositoryNames: string[]): IntentGate =>
  ({
    humanTaskId: 'external-s1-bookstore-api-contract-a0',
    stageInstanceId: 'si-code-generation',
    unitSlug: 'bookstore-api-contract',
    sectionIndex: 1,
    kind: 'external-development',
    status: 'pending',
    prompt: 'Develop externally',
    options: null,
    questions: null,
    externalDevelopment: {
      stageAttempt: 0,
      harness: 'kiro',
      repositories: repositoryNames.map(repository),
    },
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: '2026-09-11T00:00:00Z',
  }) as IntentGate;

const renderCard = (repositoryNames: string[]) =>
  render(
    <ExternalDevelopmentGateCard
      gate={gate(repositoryNames)}
      workspaceDownloaded
      onAnswer={vi.fn()}
    />,
  );

describe('ExternalDevelopmentGateCard repository instructions', () => {
  it('names the repository directly when the handoff has one repository', () => {
    renderCard(['bookstore-tracker-api']);

    const repositoryName = screen.getByText('bookstore-tracker-api', { selector: 'code' });
    expect(repositoryName.parentElement).toHaveTextContent(
      'From the bookstore-tracker-api repository root',
    );
    expect(screen.queryByText(/For each repository below/)).not.toBeInTheDocument();
  });

  it('labels every command block when the handoff has multiple repositories', () => {
    renderCard(['bookstore-tracker-api', 'bookstore-tracker-front']);

    expect(screen.getByText(/For each repository below/)).toBeInTheDocument();
    for (const name of ['bookstore-tracker-api', 'bookstore-tracker-front']) {
      const repositoryName = screen.getByText(name, { selector: 'code' });
      expect(repositoryName.parentElement).toHaveTextContent(`In ${name}:`);
    }
  });
});
