import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntentArtifact } from '@/services/intents';
vi.mock('./ArtifactEditControls', () => ({
  ArtifactEditControls: () => <button>Edit platform artifact</button>,
  ArtifactStaleBadge: () => <span>Platform stale badge</span>,
}));
vi.mock('./ArtifactHistoryDrawer', () => ({
  ArtifactHistoryDrawer: () => <button>Platform history</button>,
}));
vi.mock('./DerivedItemCountChip', () => ({
  DerivedItemCountChip: () => <button>Platform derived items</button>,
}));
vi.mock('./IntentGraphPopover', () => ({
  IntentGraphPopover: () => <button>Platform graph popover</button>,
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button>Platform discussion</button>,
}));
import { ArtifactViewer } from './ArtifactViewer';

const artifact: IntentArtifact = {
  id: 'file-1',
  title: 'Questions',
  artifactType: 'question',
  content: '# Exact question\n\nChoose a style.',
  createdByExecutionId: null,
  createdByStageInstanceId: null,
  createdAt: null,
};
afterEach(cleanup);
it('renders markdown without mounting any platform controls when read-only', () => {
  render(<ArtifactViewer artifact={artifact} readOnly />);
  expect(screen.getByRole('heading', { name: 'Exact question' })).toBeInTheDocument();
  expect(screen.getByText('Choose a style.')).toBeInTheDocument();
  expect(screen.queryByText(/Platform/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('preserves all platform controls by default', () => {
  render(<ArtifactViewer artifact={artifact} />);
  for (const name of [
    'Edit platform artifact',
    'Platform history',
    'Platform derived items',
    'Platform graph popover',
    'Platform discussion',
  ]) {
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  }
  expect(screen.getByText('Platform stale badge')).toBeInTheDocument();
});
