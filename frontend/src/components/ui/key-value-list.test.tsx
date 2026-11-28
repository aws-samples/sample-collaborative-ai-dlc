import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyValueList } from './key-value-list';

describe('KeyValueList', () => {
  it('renders a description list with dt/dd pairs', () => {
    render(
      <KeyValueList
        items={[
          { label: 'Model', value: 'Claude Opus 4.6' },
          { label: 'Runtime', value: 'Codex CLI' },
        ]}
      />,
    );
    const list = screen.getByText('Model').closest('dl') as HTMLElement;
    expect(list.querySelectorAll('dt')).toHaveLength(2);
    expect(screen.getByText('Model').tagName).toBe('DT');
    expect(screen.getByText('Claude Opus 4.6').closest('dd')).not.toBeNull();
  });

  it('shows a dash (or a custom empty label) for missing values', () => {
    render(
      <KeyValueList
        items={[
          { label: 'Tracker', value: undefined },
          { label: 'Environment', value: null, empty: 'Not configured' },
          { label: 'Notes', value: '' },
        ]}
      />,
    );
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('copies the full value when a copy source is provided', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<KeyValueList items={[{ label: 'Run ID', value: 'abc…', copy: 'abc123def456' }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy Run ID' }));
    expect(writeText).toHaveBeenCalledWith('abc123def456');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('supports a two-column layout', () => {
    render(
      <KeyValueList
        columns={2}
        items={[
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
        ]}
      />,
    );
    const list = screen.getByText('A').closest('dl') as HTMLElement;
    expect(list).toHaveClass('sm:grid-cols-2');
  });
});
