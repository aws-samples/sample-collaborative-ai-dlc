import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Accordion } from '@/components/ui/accordion';
import { DerivedItemsSection, DERIVED_ITEMS_ACCORDION_VALUE } from './DerivedItemsSection';
import type { IntentGraphNode } from '@/services/intents';

const ITEMS: IntentGraphNode[] = [
  {
    id: 'story:i:s-login',
    type: 'Story',
    label: 'User logs in',
    graphLayer: 'derived',
    slug: 's-login',
    artifactId: 'art-stories',
    priority: 'must-have',
  },
  {
    id: 'story:i:s-report',
    type: 'Story',
    label: 'User views report',
    graphLayer: 'derived',
    slug: 's-report',
    artifactId: 'art-stories',
  },
  {
    id: 'requirement:i:req-auth',
    type: 'Requirement',
    label: 'Authentication',
    graphLayer: 'derived',
    slug: 'req-auth',
    artifactId: 'art-reqs',
  },
];

const renderSection = (overrides: Partial<Parameters<typeof DerivedItemsSection>[0]> = {}) =>
  render(
    <Accordion type="multiple" defaultValue={[DERIVED_ITEMS_ACCORDION_VALUE]}>
      <DerivedItemsSection
        items={ITEMS}
        getNeighbors={() => []}
        openItemPreview={() => {}}
        filterArtifactId={null}
        onClearFilter={() => {}}
        artifactTitleById={new Map([['art-stories', 'Stories doc']])}
        {...overrides}
      />
    </Accordion>,
  );

describe('DerivedItemsSection', () => {
  it('renders nothing without items', () => {
    const { container } = renderSection({ items: [] });
    expect(container.querySelector('[id^="item-"]')).toBeNull();
    expect(screen.queryByText('Derived items')).not.toBeInTheDocument();
  });

  it('groups items by type in canonical order with counts and anchors', () => {
    renderSection();
    expect(screen.getByText('Derived items')).toBeInTheDocument();
    // Requirement group renders before Stories (canonical order).
    const headings = screen.getAllByText(/Requirements|Stories/).map((el) => el.textContent);
    expect(headings).toEqual(['Requirements', 'Stories']);
    // Anchor ids for in-page navigation.
    expect(document.getElementById('item-story:i:s-login')).not.toBeNull();
    // Priority badge shows.
    expect(screen.getByText('must-have')).toBeInTheDocument();
  });

  it('filters to one source artifact and clears via the pill', async () => {
    const user = userEvent.setup();
    const onClearFilter = vi.fn();
    renderSection({ filterArtifactId: 'art-stories', onClearFilter });

    // Only the two stories are visible; the requirement is filtered out.
    expect(screen.getByText('User logs in')).toBeInTheDocument();
    expect(screen.queryByText('Authentication')).not.toBeInTheDocument();
    // Pill names the artifact and clears.
    expect(screen.getByText(/from: Stories doc/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear artifact filter/i }));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-filter hint when the artifact has no items', () => {
    renderSection({ filterArtifactId: 'art-unknown' });
    expect(screen.getByText('no items from this artifact')).toBeInTheDocument();
  });

  it('opens the item preview when a row is clicked', async () => {
    const user = userEvent.setup();
    const openItemPreview = vi.fn();
    renderSection({ openItemPreview });

    await user.click(screen.getByText('User logs in'));
    expect(openItemPreview).toHaveBeenCalledWith('story:i:s-login');
  });

  it('opens the item preview via keyboard (Enter)', async () => {
    const user = userEvent.setup();
    const openItemPreview = vi.fn();
    renderSection({ openItemPreview });

    const row = document.getElementById('item-story:i:s-login')!;
    row.focus();
    await user.keyboard('{Enter}');
    expect(openItemPreview).toHaveBeenCalledWith('story:i:s-login');
  });
});
