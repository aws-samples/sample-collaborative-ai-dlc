import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

import { NativeDebugArchivesCard } from './NativeDebugArchivesCard';

const DEFAULTS = {
  nativeDebugArchivesEnabled: false,
  nativeDebugArchiveRetentionDays: 7,
};

beforeEach(() => {
  vi.resetAllMocks();
  getSettings.mockResolvedValue(DEFAULTS);
  updateSettings.mockResolvedValue({ saved: true });
});

describe('NativeDebugArchivesCard', () => {
  it('loads explicit off/seven-day defaults and distinguishes required recovery', async () => {
    render(<NativeDebugArchivesCard />);
    expect(
      await screen.findByRole('switch', { name: 'Store native debug archives' }),
    ).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Debug archive retention (days)' })).toHaveValue(
      7,
    );
    expect(screen.getByRole('button', { name: 'Save debug archive preferences' })).toBeDisabled();
    expect(
      screen.getByText(
        /never disable or shorten required recovery for unfinished or resumable work/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/Archive capture is not connected yet/)).toBeVisible();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { nativeDebugArchivesEnabled: false },
    { nativeDebugArchiveRetentionDays: 7 },
    { ...DEFAULTS, nativeDebugArchivesEnabled: 'false' },
    { ...DEFAULTS, nativeDebugArchivesEnabled: null },
    { ...DEFAULTS, nativeDebugArchiveRetentionDays: '7' },
    { ...DEFAULTS, nativeDebugArchiveRetentionDays: 0 },
    { ...DEFAULTS, nativeDebugArchiveRetentionDays: 1.5 },
    { ...DEFAULTS, nativeDebugArchiveRetentionDays: Number.MAX_SAFE_INTEGER + 1 },
    null,
  ])('prevents editing or saving when GET omits valid settings: %j', async (settings) => {
    getSettings.mockResolvedValue(settings);
    render(<NativeDebugArchivesCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Update the backend before editing these preferences',
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('saves only the two preferences and keeps custom retention when toggled off and back on', async () => {
    getSettings
      .mockResolvedValueOnce({
        nativeDebugArchivesEnabled: true,
        nativeDebugArchiveRetentionDays: 14,
        stageSkipping: 'enabled',
        prStrategy: 'pr-per-unit',
      })
      .mockResolvedValueOnce({
        nativeDebugArchivesEnabled: false,
        nativeDebugArchiveRetentionDays: 21,
      })
      .mockResolvedValueOnce({
        nativeDebugArchivesEnabled: true,
        nativeDebugArchiveRetentionDays: 21,
      });
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Store native debug archives' });
    const days = screen.getByRole('spinbutton', { name: 'Debug archive retention (days)' });
    const save = screen.getByRole('button', { name: 'Save debug archive preferences' });
    expect(toggle).toBeChecked();
    expect(days).toHaveValue(14);

    await user.clear(days);
    await user.type(days, '21');
    await user.click(toggle);
    expect(days).toBeEnabled();
    expect(days).toHaveValue(21);
    await user.click(save);
    await screen.findByText('Saved');
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeDebugArchivesEnabled: false,
      nativeDebugArchiveRetentionDays: 21,
    });
    expect(save).toBeDisabled();

    await user.click(toggle);
    expect(days).toHaveValue(21);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    await user.click(save);
    await screen.findByText('Saved');
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeDebugArchivesEnabled: true,
      nativeDebugArchiveRetentionDays: 21,
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(getSettings).toHaveBeenCalledTimes(3);
  });

  it('can configure retention while off without enabling archives', async () => {
    getSettings
      .mockResolvedValueOnce(DEFAULTS)
      .mockResolvedValueOnce({ ...DEFAULTS, nativeDebugArchiveRetentionDays: 30 });
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const days = await screen.findByRole('spinbutton', { name: 'Debug archive retention (days)' });
    await user.clear(days);
    await user.type(days, '30');
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        nativeDebugArchivesEnabled: false,
        nativeDebugArchiveRetentionDays: 30,
      }),
    );
    await screen.findByText('Saved');
    expect(screen.getByRole('switch', { name: 'Store native debug archives' })).not.toBeChecked();
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])(
    'blocks invalid retention %j with a visible validation message',
    async (value) => {
      const user = userEvent.setup();
      render(<NativeDebugArchivesCard />);
      await user.click(await screen.findByRole('switch', { name: 'Store native debug archives' }));
      const days = screen.getByRole('spinbutton', { name: 'Debug archive retention (days)' });
      fireEvent.change(days, { target: { value } });
      expect(days).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a positive whole number of days');
      const save = screen.getByRole('button', { name: 'Save debug archive preferences' });
      expect(save).toBeDisabled();
      await user.click(save);
      expect(updateSettings).not.toHaveBeenCalled();
    },
  );

  it('keeps controls unavailable after a failed load instead of saving defaults over unknown values', async () => {
    getSettings.mockRejectedValue(new Error('Unavailable'));
    render(<NativeDebugArchivesCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load debug archive preferences',
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('preserves edits for retry after save failure and disables controls during a pending save', async () => {
    getSettings
      .mockResolvedValueOnce(DEFAULTS)
      .mockResolvedValue({ ...DEFAULTS, nativeDebugArchivesEnabled: true });
    updateSettings.mockRejectedValueOnce(new Error('Save unavailable'));
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Store native debug archives' });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));
    expect(await screen.findByText('Save unavailable')).toBeVisible();
    expect(toggle).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save debug archive preferences' })).toBeEnabled();
    expect(getSettings).toHaveBeenCalledTimes(1);

    let finishSave!: (result: { saved: boolean }) => void;
    updateSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    finishSave({ saved: true });
    await screen.findByText('Saved');
    expect(toggle).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save debug archive preferences' })).toBeDisabled();
  });

  it.each([
    {},
    { nativeDebugArchivesEnabled: true },
    { nativeDebugArchiveRetentionDays: 14 },
    { nativeDebugArchivesEnabled: 'true', nativeDebugArchiveRetentionDays: 14 },
    { nativeDebugArchivesEnabled: true, nativeDebugArchiveRetentionDays: '14' },
    { nativeDebugArchivesEnabled: false, nativeDebugArchiveRetentionDays: 14 },
    { nativeDebugArchivesEnabled: true, nativeDebugArchiveRetentionDays: 7 },
  ])('preserves an unsaved draft when PUT succeeds but readback differs: %j', async (readback) => {
    getSettings.mockResolvedValueOnce(DEFAULTS).mockResolvedValueOnce(readback);
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Store native debug archives' });
    const days = screen.getByRole('spinbutton', { name: 'Debug archive retention (days)' });
    await user.click(toggle);
    await user.clear(days);
    await user.type(days, '14');
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));

    expect(await screen.findByText(/Save could not be verified/)).toHaveTextContent(
      'The server may have changed; your draft is preserved',
    );
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(days).toHaveValue(14);
    expect(screen.getByRole('button', { name: 'Save debug archive preferences' })).toBeEnabled();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('does not claim rollback after readback failure and can retry even the former saved values', async () => {
    getSettings
      .mockResolvedValueOnce(DEFAULTS)
      .mockRejectedValueOnce(new Error('Readback unavailable'))
      .mockResolvedValueOnce(DEFAULTS);
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Store native debug archives' });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));
    expect(await screen.findByText(/Save could not be verified/)).toBeVisible();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(toggle).toBeChecked();

    await user.click(toggle);
    const save = screen.getByRole('button', { name: 'Save debug archive preferences' });
    expect(save).toBeEnabled();
    await user.click(save);
    await screen.findByText('Saved');
    expect(updateSettings).toHaveBeenLastCalledWith(DEFAULTS);
    expect(save).toBeDisabled();
  });

  it('keeps controls pending after PUT until an exact GET readback confirms the save', async () => {
    let finishReadback!: (settings: typeof DEFAULTS) => void;
    getSettings.mockResolvedValueOnce(DEFAULTS).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReadback = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<NativeDebugArchivesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Store native debug archives' });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save debug archive preferences' }));
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    finishReadback({ ...DEFAULTS, nativeDebugArchivesEnabled: true });
    await screen.findByText('Saved');
    expect(toggle).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save debug archive preferences' })).toBeDisabled();
  });
});
