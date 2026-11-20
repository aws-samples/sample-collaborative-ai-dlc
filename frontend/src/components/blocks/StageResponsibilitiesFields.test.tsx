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
const changes: Array<StagePermissions | null> = [];
function Harness() {
  const [value, setValue] = useState<StagePermissions | null>({
    decisionMakerRoles: ['architect'],
    contributorRoles: ['developer'],
  });
  return (
    <StageResponsibilitiesFields
      value={value}
      roles={roles}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
    />
  );
}

describe('stage responsibility fields', () => {
  it('allows selecting roles directly and removing all assignments', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const architect = screen.getByRole('checkbox', { name: 'Decision Makers: Architect' });
    await user.click(architect);
    await user.click(screen.getByRole('checkbox', { name: 'Contributors: Developer' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    // Clearing the last role removes the mapping rather than saving empty lists.
    expect(changes.at(-1)).toBeNull();
    await user.click(architect);
    expect(architect).toBeChecked();
    expect(changes.at(-1)).toEqual({ decisionMakerRoles: ['architect'], contributorRoles: [] });
  });

  it('does not allow selecting responsibilities without a role catalog', () => {
    render(<StageResponsibilitiesFields value={null} roles={[]} onChange={() => {}} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('catalog is unavailable');
  });
});
