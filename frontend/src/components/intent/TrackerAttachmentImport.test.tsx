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

  it('imports once in StrictMode, reports every result, and continues after a file fails', async () => {
    vi.mocked(intentsService.trackerAttachments).mockResolvedValue({
      attachments: [
        file('first'),
        file('failed'),
        { ...file('external'), skipReason: 'External file link' },
        file('last'),
      ],
    });
    vi.mocked(intentsService.importTrackerAttachment)
      .mockResolvedValueOnce(imported('first'))
      .mockRejectedValueOnce(new Error('Missing access'))
      .mockResolvedValueOnce(imported('last'));
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
    await screen.findByText('last.pdf: imported');
    expect(screen.getByText('failed.pdf: failed — Missing access')).toBeInTheDocument();
    expect(screen.getByText('external.pdf: skipped — External file link')).toBeInTheDocument();
    expect(intentsService.trackerAttachments).toHaveBeenCalledTimes(1);
    expect(intentsService.importTrackerAttachment).toHaveBeenCalledTimes(3);
    expect(onImported).toHaveBeenCalledTimes(2);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
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
    await screen.findByText('retry.pdf: imported');
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
