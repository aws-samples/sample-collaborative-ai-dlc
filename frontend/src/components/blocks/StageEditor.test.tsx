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

  it('shows the support agents picker so a stale reference can be fixed', () => {
    render(<StageEditor value={{ supportAgents: ['aidlc-qa-agent'] }} onChange={vi.fn()} />);

    expect(screen.getByText('Support agents')).toBeInTheDocument();
  });
  it('names where each agent option comes from, and accepts a typed id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StageEditor
        value={{}}
        onChange={onChange}
        referenceOptions={{
          agents: [
            { id: 'security-reviewer', label: 'Security reviewer', source: 'AI-DLC 2.11.0' },
            { id: 'team-reviewer', label: 'Team reviewer', source: 'library' },
          ],
        }}
      />,
    );

    await user.type(screen.getAllByPlaceholderText('Search agents')[0], 'reviewer');

    expect(
      screen.getByRole('button', { name: /Security reviewer.*AI-DLC 2\.11\.0/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Team reviewer.*library/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Security reviewer/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ leadAgent: 'security-reviewer' }),
    );
  });
});
