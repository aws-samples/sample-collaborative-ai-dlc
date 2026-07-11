import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Accordion } from '@/components/ui/accordion';
import { CodeSection, CODE_ACCORDION_VALUE, buildCodeItems, type CodeItem } from './CodeSection';
import type { IntentDetail } from '@/services/intents';

// Minimal IntentDetail carrying only what buildCodeItems reads (repos, branch,
// gitProvider, pullRequests, events). Everything else is irrelevant here.
const detailWith = (over: {
  repos?: string[];
  branch?: string | null;
  gitProvider?: string | null;
  pullRequests?: IntentDetail['pullRequests'];
  pushedRepos?: string[];
}): IntentDetail =>
  ({
    intent: {
      repos: over.repos ?? [],
      branch: over.branch ?? null,
      gitProvider: over.gitProvider ?? null,
    },
    pullRequests: over.pullRequests ?? [],
    events: (over.pushedRepos ?? []).map((slug, i) => ({
      eventId: `e${i}`,
      type: 'v2.git.pushed',
      summary: `pushed to ${slug}`,
      stageInstanceId: null,
      actor: null,
      timestamp: '2026-01-01T00:00:00Z',
    })),
  }) as unknown as IntentDetail;

const renderSection = (items: CodeItem[]) =>
  render(
    <Accordion type="multiple" defaultValue={[CODE_ACCORDION_VALUE]}>
      <CodeSection items={items} />
    </Accordion>,
  );

describe('buildCodeItems', () => {
  it('hides repos that neither pushed nor have a PR', () => {
    const items = buildCodeItems(detailWith({ repos: ['owner/repo'], branch: 'feat/x' }));
    expect(items).toEqual([]);
  });

  it('includes a pushed repo as a bare branch (no PR fields)', () => {
    const items = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: 'github',
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: 'owner/repo',
      branch: 'feat/x',
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      branchUrl: 'https://github.com/owner/repo/tree/feat/x',
    });
  });

  it('promotes a repo with a PR, carrying number, url and base branch', () => {
    const items = buildCodeItems(
      detailWith({
        repos: ['https://github.com/owner/repo.git'],
        gitProvider: 'github',
        pullRequests: [
          {
            id: 'pr1',
            repository: 'owner/repo',
            prUrl: 'https://github.com/owner/repo/pull/9',
            prNumber: '9',
            branch: 'feat/x',
            baseBranch: 'main',
            createdAt: null,
          },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: 'owner/repo',
      branch: 'feat/x',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/9',
      prNumber: '9',
    });
  });

  it('builds a GitLab branch url and null url for an unknown provider', () => {
    const [gl] = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: 'gitlab',
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(gl.branchUrl).toBe('https://gitlab.com/owner/repo/-/tree/feat/x');

    const [unknown] = buildCodeItems(
      detailWith({
        repos: ['owner/repo'],
        branch: 'feat/x',
        gitProvider: null,
        pushedRepos: ['owner/repo'],
      }),
    );
    expect(unknown.branchUrl).toBeNull();
  });
});

const item = (over: Partial<CodeItem> = {}): CodeItem => ({
  repo: 'owner/repo',
  branch: 'feat/x',
  baseBranch: null,
  branchUrl: null,
  prUrl: null,
  prNumber: null,
  ...over,
});

describe('CodeSection', () => {
  it('renders nothing without items', () => {
    renderSection([]);
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
  });

  it('renders a bare branch entry (no PR affordances)', () => {
    renderSection([item()]);
    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByText('feat/x')).toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open pr/i })).not.toBeInTheDocument();
  });

  it('renders PR number, source → target branches, and an Open PR link', () => {
    renderSection([
      item({
        branch: 'feat/x',
        baseBranch: 'main',
        branchUrl: 'https://github.com/owner/repo/tree/feat/x',
        prUrl: 'https://github.com/owner/repo/pull/9',
        prNumber: '9',
      }),
    ]);
    expect(screen.getByText('PR #9')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'feat/x' })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/tree/feat/x',
    );
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open pr/i })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/pull/9',
    );
  });
});
