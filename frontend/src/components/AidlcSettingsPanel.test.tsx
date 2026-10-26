import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AidlcSettingsPanel } from './AidlcSettingsPanel';

beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('AidlcSettingsPanel', () => {
  // An unpinned intent, and every AI-DLC release before the settings existed,
  // author nothing — the team must see no new control at all rather than an
  // empty box or a switch that does nothing.
  it('renders nothing when the pinned release authors no setting', () => {
    const { container } = render(
      <AidlcSettingsPanel authored={null} chosen={null} onChange={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders only the settings the scope authors, pre-filled from their defaults', () => {
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'strict', planApproval: 'on', collaborators: 'on' }}
        chosen={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Guard Policy' })).toHaveTextContent('Strict');
    expect(screen.getByRole('combobox', { name: 'Plan Approval' })).toHaveTextContent('On');
    expect(screen.getByRole('combobox', { name: 'Collaborators' })).toHaveTextContent('On');
    // `existing_code` is not authored by this scope, so it is not offered.
    expect(screen.queryByRole('combobox', { name: 'Project type' })).toBeNull();
  });

  it('pre-fills the lighter defaults of a lighter scope', () => {
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off', planApproval: 'off', collaborators: 'off' }}
        chosen={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Guard Policy' })).toHaveTextContent('Off');
    expect(screen.getByRole('combobox', { name: 'Plan Approval' })).toHaveTextContent('Off');
    expect(screen.getByRole('combobox', { name: 'Collaborators' })).toHaveTextContent('Off');
  });

  it('labels the authored project type a scope written for existing code', () => {
    render(
      <AidlcSettingsPanel authored={{ existingCode: true }} chosen={null} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('combobox', { name: 'Project type' })).toHaveTextContent('Brownfield');
  });

  // Two sentences only, and both are facts about STATE rather than about a
  // person: a row either follows the scope's own default or was changed for
  // this intent. Who changed it is on the timeline.
  it('says whether the run follows the scope default or a change made here', () => {
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off', planApproval: 'on' }}
        chosen={{ guardPolicy: 'strict' }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Guard Policy' })).toHaveTextContent('Strict');
    expect(screen.getByTestId('aidlc-setting-source-guardPolicy')).toHaveTextContent(
      'Changed for this intent (scope default: Off)',
    );
    expect(screen.getByTestId('aidlc-setting-source-planApproval')).toHaveTextContent(
      'Scope default — On',
    );
  });

  it('names nobody anywhere in the panel', () => {
    const { container } = render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off' }}
        chosen={{ guardPolicy: 'strict' }}
        onChange={vi.fn()}
      />,
    );

    expect(container.textContent).not.toMatch(/chosen by/i);
    expect(container.textContent).toMatch(/timeline/i);
  });

  it('reports a pick as the chosen value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off', planApproval: 'on' }}
        chosen={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Guard Policy' }));
    await user.click(screen.getByRole('option', { name: 'Strict' }));

    expect(onChange).toHaveBeenCalledWith('guardPolicy', 'strict');
  });

  // Picking the value the scope already has is not an override. Storing it
  // would be storing a value equal to the default, which is the one piece of
  // state capable of later claiming a value came from a scope that does not
  // supply it.
  it('clears the entry when a member picks the authored default itself', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off' }}
        chosen={{ guardPolicy: 'strict' }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Guard Policy' }));
    await user.click(screen.getByRole('option', { name: 'Off' }));

    expect(onChange).toHaveBeenCalledWith('guardPolicy', null);
  });

  it('reports the boolean project type as a boolean, not as its label', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AidlcSettingsPanel authored={{ existingCode: true }} chosen={null} onChange={onChange} />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Project type' }));
    await user.click(screen.getByRole('option', { name: 'Greenfield' }));

    expect(onChange).toHaveBeenCalledWith('existingCode', false);
  });

  it('is read-only while the run is being started', () => {
    render(
      <AidlcSettingsPanel
        authored={{ guardPolicy: 'off', planApproval: 'on' }}
        chosen={null}
        disabled
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Guard Policy' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Plan Approval' })).toBeDisabled();
  });
});
