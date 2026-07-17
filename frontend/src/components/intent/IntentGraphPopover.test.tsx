import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IntentGraphPopover } from './IntentGraphPopover';
import { onWorkProductFocus, type WorkProductFocus } from './workProductsFocus';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';

const NEIGHBORS: GraphNeighbor[] = [
  {
    id: 'requirement:i:req-auth',
    type: 'Requirement',
    label: 'Authentication',
    edgeLabel: 'COVERS',
    direction: 'outgoing',
    graphLayer: 'derived',
  },
  {
    id: 'art-stories',
    type: 'Artifact',
    label: 'Stories doc',
    edgeLabel: 'HAS_ITEM',
    direction: 'incoming',
  },
  {
    id: 'intent-1',
    type: 'Intent',
    label: 'The intent',
    edgeLabel: 'CONTAINS',
    direction: 'incoming',
  },
];

let focused: WorkProductFocus[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  focused = [];
  unsubscribe();
  unsubscribe = onWorkProductFocus((f) => focused.push(f));
});

function renderPopover(neighbors: GraphNeighbor[]) {
  return render(
    <TooltipProvider>
      <IntentGraphPopover neighbors={neighbors} />
    </TooltipProvider>,
  );
}

describe('IntentGraphPopover', () => {
  it('renders a placeholder icon without neighbors', () => {
    renderPopover([]);
    expect(screen.getByRole('button', { hidden: true })).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens a popover with neighbors grouped by direction + humanized edge label', async () => {
    const user = userEvent.setup();
    renderPopover(NEIGHBORS);
    await user.click(screen.getByRole('button', { name: /3 connections/i }));

    expect(screen.getByText('3 connections')).toBeInTheDocument();
    // Humanized edge labels from the shared map.
    expect(screen.getByText('covers')).toBeInTheDocument();
    expect(screen.getByText('has item')).toBeInTheDocument();
    expect(screen.getByText('contains')).toBeInTheDocument();
    expect(screen.getByText('Authentication')).toBeInTheDocument();
  });

  it('clicking an item neighbor emits an in-page item focus (never navigates away)', async () => {
    const user = userEvent.setup();
    renderPopover(NEIGHBORS);
    await user.click(screen.getByRole('button', { name: /3 connections/i }));
    await user.click(screen.getByRole('button', { name: /Authentication/i }));

    expect(focused).toEqual([{ kind: 'item', id: 'requirement:i:req-auth' }]);
  });

  it('clicking an artifact neighbor emits an artifact focus', async () => {
    const user = userEvent.setup();
    renderPopover(NEIGHBORS);
    await user.click(screen.getByRole('button', { name: /3 connections/i }));
    await user.click(screen.getByRole('button', { name: /Stories doc/i }));

    expect(focused).toEqual([{ kind: 'artifact', id: 'art-stories' }]);
  });

  it('non-navigable neighbors (Intent hub) render read-only — no button', async () => {
    const user = userEvent.setup();
    renderPopover(NEIGHBORS);
    await user.click(screen.getByRole('button', { name: /3 connections/i }));

    expect(screen.getByText('The intent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /The intent/i })).not.toBeInTheDocument();
  });
});
