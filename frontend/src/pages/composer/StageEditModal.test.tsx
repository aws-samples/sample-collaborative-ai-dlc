// The composer's stage modal: a stage's content comes from where the composer
// resolved it (a release catalog or the live library).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const get = vi.fn();
const update = vi.fn();
const releaseBlock = vi.fn();
const loadOptions = vi.fn();

vi.mock('@/services/blocks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/blocks')>();
  return {
    ...original,
    blocksService: {
      get: (...a: unknown[]) => get(...a),
      update: (...a: unknown[]) => update(...a),
    },
  };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: { block: (...a: unknown[]) => releaseBlock(...a) },
  };
});
vi.mock('@/components/blocks/stageReferenceOptions', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/components/blocks/stageReferenceOptions')>();
  return { ...original, loadStageReferenceOptions: (...a: unknown[]) => loadOptions(...a) };
});

import { StageEditModal } from './StageEditModal';

const RELEASE = 'aidlc:2.11.0';

const stageBlock = (over: Record<string, unknown> = {}) => ({
  id: 'requirements',
  blockId: 'requirements',
  blockType: 'stage',
  tenantId: 'default',
  name: 'Requirements',
  version: 1,
  readOnly: false,
  hasBody: false,
  bodyBytes: 0,
  hasScript: false,
  scriptBytes: 0,
  createdAt: '',
  updatedAt: '',
  phase: 'inception',
  ...over,
});

const renderModal = (
  props: {
    stageReleaseId?: string | null;
    libraryReleaseId?: string | null;
    onSaved?: () => void;
  } = {},
) => {
  const onClose = vi.fn();
  const onSaved = props.onSaved ?? vi.fn();
  render(
    <MemoryRouter>
      <StageEditModal
        stageId="requirements"
        stageReleaseId={props.stageReleaseId ?? null}
        libraryReleaseId={props.libraryReleaseId === undefined ? RELEASE : props.libraryReleaseId}
        onClose={onClose}
        onSaved={onSaved}
      />
    </MemoryRouter>,
  );
  return { onClose, onSaved };
};

beforeEach(() => {
  get.mockReset();
  update.mockReset();
  releaseBlock.mockReset();
  loadOptions.mockReset().mockResolvedValue({ options: {}, release: null });
});

describe('StageEditModal stage provenance', () => {
  it('shows the release copy of a release-origin stage, not a live stage with the same id', async () => {
    get.mockResolvedValue(stageBlock({ name: 'Live requirements', phase: 'live-phase' }));
    releaseBlock.mockResolvedValue({
      block: stageBlock({
        tenantId: 'SYSTEM',
        readOnly: true,
        name: 'Release requirements',
        phase: 'release-phase',
        source: 'release',
        releaseId: RELEASE,
      }),
      body: '',
      script: '',
    });
    renderModal({ stageReleaseId: RELEASE });

    expect(await screen.findByPlaceholderText('ideation')).toHaveValue('release-phase');
    expect(releaseBlock).toHaveBeenCalledWith(RELEASE, 'stage', 'requirements');
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByText('Release requirements')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('ideation')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('loads a release-only stage from the release', async () => {
    get.mockRejectedValue(new Error('Not found'));
    releaseBlock.mockResolvedValue({
      block: stageBlock({
        tenantId: 'SYSTEM',
        readOnly: true,
        source: 'release',
        releaseId: RELEASE,
      }),
      body: '',
      script: '',
    });
    renderModal({ stageReleaseId: RELEASE });

    expect(await screen.findByPlaceholderText('ideation')).toHaveValue('inception');
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  it('keeps a user override live and editable', async () => {
    get.mockResolvedValue(stageBlock({ name: 'My requirements', phase: 'mine' }));
    update.mockResolvedValue({});
    const user = userEvent.setup();
    const { onSaved } = renderModal({ stageReleaseId: null });

    const phase = await screen.findByPlaceholderText('ideation');
    expect(phase).toHaveValue('mine');
    expect(releaseBlock).not.toHaveBeenCalled();
    await waitFor(() => expect(phase).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      'stage',
      'requirements',
      expect.objectContaining({ phase: 'mine' }),
    );
  });
});

// A failed save is recoverable: the member keeps what they typed and can retry.
// Only a stage or reference catalog that could not be loaded blocks editing.
describe('StageEditModal save failure', () => {
  it('keeps the form editable and retries after a failed save', async () => {
    get.mockResolvedValue(stageBlock({ phase: 'mine' }));
    update.mockRejectedValueOnce(new Error('Conflict')).mockResolvedValueOnce({});
    const user = userEvent.setup();
    const { onSaved } = renderModal({ stageReleaseId: null });

    const phase = await screen.findByPlaceholderText('ideation');
    await waitFor(() => expect(phase).toBeEnabled());
    await user.clear(phase);
    await user.type(phase, 'edited');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Conflict')).toBeInTheDocument();
    expect(phase).toHaveValue('edited');
    expect(phase).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenLastCalledWith(
      'stage',
      'requirements',
      expect.objectContaining({ phase: 'edited' }),
    );
  });
});

// Without a selected version the pickers are a convenience: a failed load
// leaves them empty and typed ids still save, as before versions existed.
describe('StageEditModal reference lists', () => {
  it('keeps editing and saving open when the lists fail without a selected version', async () => {
    get.mockResolvedValue(stageBlock({ phase: 'mine' }));
    update.mockResolvedValue({});
    loadOptions.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    const { onSaved } = renderModal({ stageReleaseId: null, libraryReleaseId: null });

    const phase = await screen.findByPlaceholderText('ideation');
    await waitFor(() => expect(phase).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('still blocks saving when the selected version cannot be loaded', async () => {
    get.mockResolvedValue(stageBlock({ phase: 'mine' }));
    loadOptions.mockRejectedValue(new Error('Network error'));
    renderModal({ stageReleaseId: null });

    expect(
      await screen.findByText(/The selected AI-DLC version could not be loaded/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
