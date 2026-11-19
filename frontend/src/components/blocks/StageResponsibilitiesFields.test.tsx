import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StagePermissions } from '@/services/workflows';
import { StageResponsibilitiesFields } from './StageResponsibilitiesFields';

const roles = [
  { id: 'architect', name: 'Architect' },
  { id: 'developer', name: 'Developer' },
];
function Harness() {
  const [value, setValue] = useState<StagePermissions | null>({
    decisionMakerRoles: ['architect'],
    contributorRoles: ['developer'],
  });
  return <StageResponsibilitiesFields value={value} roles={roles} onChange={setValue} />;
}

describe('stage responsibility fields', () => {
  it('allows selecting roles directly and removing all assignments', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const architect = screen.getByRole('checkbox', { name: 'Decision Makers: Architect' });
    await user.click(architect);
    await user.click(screen.getByRole('checkbox', { name: 'Contributors: Developer' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    await user.click(architect);
    expect(architect).toBeChecked();
  });

  it('does not allow selecting responsibilities without a role catalog', () => {
    render(<StageResponsibilitiesFields value={null} roles={[]} onChange={() => {}} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('catalog is unavailable');
  });
});
