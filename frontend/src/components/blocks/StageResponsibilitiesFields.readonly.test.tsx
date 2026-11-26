import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageResponsibilitiesFields } from './StageResponsibilitiesFields';

describe('stage responsibilities view', () => {
  it('shows saved assignments including IDs missing from the catalog using disabled checkboxes', () => {
    render(
      <StageResponsibilitiesFields
        readOnly
        value={{ decisionMakerRoles: ['architect', 'unknown-role'], contributorRoles: [] }}
        roles={[{ id: 'architect', name: 'Architect' }]}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Decision Makers: Architect' })).toBeChecked();
    expect(screen.getByText('unknown-role')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Contributors: Architect' })).not.toBeChecked();
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows only disabled role checkboxes for unmapped and automatic stages', () => {
    const roles = [{ id: 'architect', name: 'Architect' }];
    const { rerender } = render(
      <StageResponsibilitiesFields readOnly value={null} roles={roles} />,
    );
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
    }
    rerender(
      <StageResponsibilitiesFields
        readOnly
        value={{ automatic: true, decisionMakerRoles: [], contributorRoles: [] }}
        roles={roles}
      />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByText('Assign responsibilities')).not.toBeInTheDocument();
    expect(screen.queryByText('Automatic stage (no human decision)')).not.toBeInTheDocument();
    expect(screen.queryByText('Space Owners decide.', { exact: false })).not.toBeInTheDocument();
  });
});
