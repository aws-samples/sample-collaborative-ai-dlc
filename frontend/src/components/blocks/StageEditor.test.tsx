import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StageEditor, type StageForm } from './StageEditor';

describe('StageEditor', () => {
  it('shows a disabled branch switch with the seeded value', () => {
    render(
      <StageEditor
        value={{ forEach: 'unit-of-work', phase: 'construction' }}
        onChange={vi.fn()}
        disabled
      />,
    );

    const branchSwitch = screen.getByRole('switch', { name: /branch by unit of work/i });
    expect(branchSwitch).toBeDisabled();
    expect(branchSwitch).toBeChecked();
  });

  it('updates forEach through the branch switch when editable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StageEditor value={{ forEach: null }} onChange={onChange} />);

    await user.click(screen.getByRole('switch', { name: /branch by unit of work/i }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ forEach: 'unit-of-work' }));
  });

  it('shows advanced manual fields directly when the Advanced tab is opened', async () => {
    const user = userEvent.setup();
    const value: StageForm = {
      requires: ['scope-definition'],
      produces: ['scope-document'],
    };
    const onChange = vi.fn();
    render(<StageEditor value={value} onChange={onChange} />);

    expect(screen.queryByLabelText(/manual stage dependencies/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /advanced/i }));

    expect(screen.getByLabelText(/manual stage dependencies/i)).toHaveValue('scope-definition');
    expect(screen.getByLabelText(/manual output artifacts/i)).toHaveValue('scope-document');
  });
});
