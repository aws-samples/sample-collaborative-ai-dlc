import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrackerAttachmentImport } from './TrackerAttachmentImport';
import { intentsService } from '@/services/intents';

vi.mock('@/services/intents', () => ({
  intentsService: { trackerAttachments: vi.fn(), importTrackerAttachment: vi.fn() },
}));
const file = (id: string) => ({
  id,
  filename: `${id}.pdf`,
  url: `https://github.com/user-attachments/files/1/${id}.pdf`,
});
const imported = (id: string) => ({
  status: 'imported' as const,
  attachment: {
    attachmentId: id,
    filename: `${id}.pdf`,
    mimeType: 'application/pdf',
    size: 10,
    s3Key: 'key',
    s3VersionId: 'v1',
    uploadedAt: '',
    uploadedBy: 'u1',
  },
});

describe('tracker attachment import', () => {
  beforeEach(() => vi.resetAllMocks());

  it('imports once in StrictMode, shows only unresolved files, and continues after a failure', async () => {
    vi.mocked(intentsService.trackerAttachments)
      .mockResolvedValueOnce({
        attachments: [
          file('first'),
          file('failed'),
          { ...file('external'), skipReason: 'External file link' },
          file('last'),
        ],
      })
      .mockResolvedValue({
        attachments: [file('failed'), { ...file('external'), skipReason: 'External file link' }],
      });
    vi.mocked(intentsService.importTrackerAttachment)
      .mockResolvedValueOnce(imported('first'))
      .mockRejectedValueOnce(new Error('Missing access'))
      .mockResolvedValueOnce(imported('last'))
      .mockResolvedValueOnce(imported('failed'));
    const onBusyChange = vi.fn();
    const onImported = vi.fn();
    render(
      <StrictMode>
        <TrackerAttachmentImport
          projectId="p1"
          intentId="i1"
          autoImport
          onAutoImportStarted={vi.fn()}
          disabled={false}
          onBusyChange={onBusyChange}
          onImported={onImported}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
    expect(screen.getByText('failed.pdf: failed — Missing access')).toBeInTheDocument();
    expect(screen.getByText('external.pdf: skipped — External file link')).toBeInTheDocument();
    expect(screen.queryByText(/first\.pdf|last\.pdf/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry import' })).toBeEnabled();
    expect(intentsService.trackerAttachments).toHaveBeenCalledTimes(1);
    expect(intentsService.importTrackerAttachment).toHaveBeenCalledTimes(3);
    expect(onImported).toHaveBeenCalledTimes(2);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    await userEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(intentsService.importTrackerAttachment).mock.calls.map((call) => call[2]),
    ).toEqual(['first', 'failed', 'last', 'failed']);
    expect(screen.queryByText(/failed\.pdf/)).not.toBeInTheDocument();
    expect(screen.getByText('external.pdf: skipped — External file link')).toBeInTheDocument();
  });

  it('keeps the block hidden when reopening a draft with no remaining files', async () => {
    vi.mocked(intentsService.trackerAttachments).mockResolvedValue({ attachments: [] });
    const onBusyChange = vi.fn();
    const onAutoImportStarted = vi.fn();
    render(
      <StrictMode>
        <TrackerAttachmentImport
          projectId="p1"
          intentId="i1"
          autoImport={false}
          onAutoImportStarted={onAutoImportStarted}
          disabled={false}
          onBusyChange={onBusyChange}
          onImported={vi.fn()}
        />
      </StrictMode>,
    );
    expect(screen.queryByLabelText('Tracker attachment import')).not.toBeInTheDocument();
    await waitFor(() => expect(intentsService.trackerAttachments).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Tracker attachment import')).not.toBeInTheDocument();
    expect(intentsService.importTrackerAttachment).not.toHaveBeenCalled();
    expect(onAutoImportStarted).not.toHaveBeenCalled();
    expect(onBusyChange).not.toHaveBeenCalled();
  });

  it('discovers remaining files on reopening and imports them only after a manual retry', async () => {
    vi.mocked(intentsService.trackerAttachments).mockResolvedValue({
      attachments: [file('remaining')],
    });
    vi.mocked(intentsService.importTrackerAttachment).mockResolvedValue(imported('remaining'));
    render(
      <TrackerAttachmentImport
        projectId="p1"
        intentId="i1"
        autoImport={false}
        onAutoImportStarted={vi.fn()}
        disabled={false}
        onBusyChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    await screen.findByText('remaining.pdf: not imported');
    expect(intentsService.importTrackerAttachment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Tracker attachment import')).not.toBeInTheDocument(),
    );
    expect(intentsService.importTrackerAttachment).toHaveBeenCalledExactlyOnceWith(
      'p1',
      'i1',
      'remaining',
    );
  });

  it('keeps the draft usable when discovery fails and supports a retry', async () => {
    vi.mocked(intentsService.trackerAttachments)
      .mockRejectedValueOnce(new Error('Tracker disconnected'))
      .mockResolvedValueOnce({ attachments: [file('retry')] });
    vi.mocked(intentsService.importTrackerAttachment).mockResolvedValue(imported('retry'));
    const onBusyChange = vi.fn();
    render(
      <TrackerAttachmentImport
        projectId="p1"
        intentId="i1"
        autoImport
        onAutoImportStarted={vi.fn()}
        disabled={false}
        onBusyChange={onBusyChange}
        onImported={vi.fn()}
      />,
    );
    await screen.findByText('Tracker disconnected');
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole('button', { name: 'Import attachments' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Tracker attachment import')).not.toBeInTheDocument(),
    );
    expect(intentsService.importTrackerAttachment).toHaveBeenCalledExactlyOnceWith(
      'p1',
      'i1',
      'retry',
    );
  });

  it('stops scheduling downloads when leaving the draft', async () => {
    vi.mocked(intentsService.trackerAttachments).mockResolvedValue({
      attachments: [file('first'), file('second')],
    });
    let finish!: (value: ReturnType<typeof imported>) => void;
    vi.mocked(intentsService.importTrackerAttachment).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = render(
      <TrackerAttachmentImport
        projectId="p1"
        intentId="i1"
        autoImport
        onAutoImportStarted={vi.fn()}
        disabled={false}
        onBusyChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => expect(intentsService.importTrackerAttachment).toHaveBeenCalledTimes(1));
    unmount();
    finish(imported('first'));
    await Promise.resolve();
    expect(intentsService.importTrackerAttachment).toHaveBeenCalledTimes(1);
  });
});
