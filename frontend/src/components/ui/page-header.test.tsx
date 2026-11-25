import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Button } from './button';
import { PageHeader } from './page-header';

function renderHeader(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('PageHeader', () => {
  it('renders exactly one h1 with the title and no overflow tooltip by default', () => {
    renderHeader(
      <PageHeader
        eyebrow="Space · Payments"
        title="Checkout redesign"
        subtitle="Compose reusable stages into runnable workflows"
        status={<span>Running</span>}
        meta={<span>v2.4</span>}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Checkout redesign');
    expect(headings[0]).not.toHaveAttribute('title');
    expect(screen.getByText('Space · Payments')).toBeInTheDocument();
    expect(screen.getByText('Compose reusable stages into runnable workflows')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('v2.4')).toBeInTheDocument();
  });

  it('places status and meta in a block that wraps under the title below sm', () => {
    renderHeader(<PageHeader title="Intent" status={<span>Waiting</span>} />);
    const status = screen.getByText('Waiting');
    const wrap = status.closest('[data-slot="page-header-status"]') as HTMLElement;
    expect(wrap).toHaveClass('basis-full', 'sm:basis-auto');
  });

  it('renders a single back link when backTo is given', () => {
    renderHeader(
      <PageHeader title="Settings" backTo={{ href: '/space/1', label: 'Back to space' }} />,
    );
    const back = screen.getByRole('link', { name: 'Back to space' });
    expect(back).toHaveAttribute('href', '/space/1');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('uses a semantic header landmark with the primary action', () => {
    renderHeader(<PageHeader title="Spaces" primaryAction={<Button>New space</Button>} />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'New space' })).toBeInTheDocument();
  });
});
