import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const contents = vi.fn();

vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: { contents: (...a: unknown[]) => contents(...a) },
  };
});

import { ReleaseContentsDialog } from './ReleaseContentsDialog';

const RELEASE_ID = 'aidlc-custom:gitlab:acme/aidlc@abc123';
const agent = (id: string, name: string, description?: string) => ({
  id,
  blockId: id,
  blockType: 'AGENT',
  tenantId: 'SYSTEM',
  name,
  description,
  version: 1,
  readOnly: true,
  hasBody: true,
  bodyBytes: 10,
  hasScript: false,
  scriptBytes: 0,
  createdAt: '',
  updatedAt: '',
  source: 'release',
  releaseId: RELEASE_ID,
});

const Location = () => {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
};

const renderDialog = (onClose = vi.fn()) =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ReleaseContentsDialog releaseId={RELEASE_ID} onClose={onClose} />
              <Location />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

describe('ReleaseContentsDialog', () => {
  beforeEach(() => {
    contents.mockReset().mockResolvedValue({
      release: { releaseId: RELEASE_ID, upstreamVersion: '2.11.0' },
      workflow: {
        id: 'aidlc-v2',
        workflowId: 'aidlc-v2',
        name: 'AI-DLC v2',
        objective: '',
        workflowVersion: 1,
        readOnly: true,
        phases: [{ phaseId: 'inception', path: '01' }],
        placements: [
          { stageId: 'a', phasePath: '01', order: 0, scopeMembership: {} },
          { stageId: 'b', phasePath: '01', order: 1, scopeMembership: {} },
        ],
        scopeRefs: [{ scopeId: 'feature' }, { scopeId: 'mvp' }],
        ruleRefs: [],
        source: 'release',
        releaseId: RELEASE_ID,
      },
      blocks: {
        agent: [
          agent('security-reviewer', 'Security reviewer', 'Reviews for CDL security standards'),
          agent('pipeline-reviewer', 'Pipeline reviewer'),
        ],
        stage: [],
      },
    });
  });

  it('lists the release workflow and its blocks by type', async () => {
    renderDialog();

    expect(await screen.findByText('Security reviewer')).toBeInTheDocument();
    expect(contents).toHaveBeenCalledWith(RELEASE_ID);
    expect(screen.getByText(/Release contents: AI-DLC 2\.11\.0/)).toBeInTheDocument();
    expect(screen.getByText(RELEASE_ID)).toBeInTheDocument();
    expect(screen.getByTestId('release-workflow')).toHaveTextContent(
      '2 stages · 1 phases · scopes: feature, mvp',
    );
    expect(screen.getByRole('tab', { name: 'Agents (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Stages (0)' })).toBeInTheDocument();
  });

  it('filters by name or id', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('Security reviewer');

    await user.type(screen.getByLabelText('Search release blocks'), 'pipeline');

    expect(screen.queryByText('Security reviewer')).not.toBeInTheDocument();
    expect(screen.getByText('Pipeline reviewer')).toBeInTheDocument();
  });

  it('opens a block read-only from the release', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog(onClose);

    await user.click(await screen.findByText('Security reviewer'));

    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/blocks/agent/security-reviewer?release=${encodeURIComponent(RELEASE_ID)}`,
    );
  });

  it('shows why the contents could not be read', async () => {
    contents.mockRejectedValue(new Error('Release not found'));
    renderDialog();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Release not found'));
  });
});
