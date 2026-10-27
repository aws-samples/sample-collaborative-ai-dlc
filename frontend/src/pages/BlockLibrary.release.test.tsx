// The block library and block editor with an AI-DLC release in play (#607).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const list = vi.fn();
const get = vi.fn();
const getBody = vi.fn();
const getScript = vi.fn();
const stableCatalog = vi.fn();
const contents = vi.fn();
const releaseBlock = vi.fn();

vi.mock('@/services/blocks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/blocks')>();
  return {
    ...original,
    blocksService: {
      list: (...a: unknown[]) => list(...a),
      get: (...a: unknown[]) => get(...a),
      getBody: (...a: unknown[]) => getBody(...a),
      getScript: (...a: unknown[]) => getScript(...a),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      stableCatalog: (...a: unknown[]) => stableCatalog(...a),
      contents: (...a: unknown[]) => contents(...a),
      block: (...a: unknown[]) => releaseBlock(...a),
    },
  };
});

import BlockLibrary from './BlockLibrary';
import BlockEditor from './BlockEditor';

const STABLE = 'aidlc-custom:gitlab:acme/aidlc@abc123';
const OTHER = 'aidlc:def456';

const block = (id: string, tenantId: string, over: Record<string, unknown> = {}) => ({
  id,
  blockId: id,
  blockType: 'AGENT',
  tenantId,
  name: id,
  version: 1,
  readOnly: tenantId === 'SYSTEM',
  hasBody: false,
  bodyBytes: 0,
  hasScript: false,
  scriptBytes: 0,
  createdAt: '',
  updatedAt: '',
  ...over,
});
const fromRelease = (id: string, releaseId = STABLE, over: Record<string, unknown> = {}) =>
  block(id, 'SYSTEM', { source: 'release', releaseId, ...over });

const catalog = (
  releaseId: string,
  upstreamVersion: string,
  blocks: Record<string, unknown[]>,
) => ({
  release: { releaseId, upstreamVersion },
  workflow: null,
  blocks,
});

const Location = () => {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/blocks/:type" element={<BlockLibrary />} />
        <Route path="/blocks/:type/:id" element={<BlockEditor />} />
      </Routes>
      <Location />
    </MemoryRouter>,
  );

// Radix measures some controls; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  list.mockReset().mockResolvedValue({ blocks: [] });
  get.mockReset();
  getBody.mockReset();
  getScript.mockReset();
  contents.mockReset();
  releaseBlock.mockReset();
  stableCatalog.mockReset().mockResolvedValue(null);
});

describe('BlockLibrary with a stable release', () => {
  it('shows the stable release blocks beside the library, read-only and labelled', async () => {
    list.mockResolvedValue({ blocks: [block('team-agent', 'default')] });
    stableCatalog.mockResolvedValue({
      releaseId: STABLE,
      release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
      contents: catalog(STABLE, '2.11.0', {
        agent: [fromRelease('security-reviewer'), fromRelease('team-agent')],
      }),
    });

    renderAt('/blocks/agent');

    const section = await screen.findByTestId('release-blocks');
    expect(stableCatalog).toHaveBeenCalledWith(['agent']);
    expect(section).toHaveTextContent('Agents in AI-DLC 2.11.0 (stable)');
    expect(section).toHaveTextContent(STABLE);
    expect(section).toHaveTextContent('security-reviewer');
    // A library block with the same id is what a pinned intent runs.
    expect(section).toHaveTextContent('Replaced by the library block with this id');
  });

  it('shows no release section while no stable release is in force', async () => {
    list.mockResolvedValue({ blocks: [block('team-agent', 'default', { name: 'Team agent' })] });

    renderAt('/blocks/agent');

    expect(await screen.findByText('Team agent')).toBeInTheDocument();
    expect(screen.queryByTestId('release-blocks')).not.toBeInTheDocument();
  });

  it("drops the previous type's release blocks as soon as the type changes", async () => {
    const user = userEvent.setup();
    let resolveStages: (value: unknown) => void = () => {};
    stableCatalog.mockImplementation(([type]: string[]) =>
      type === 'agent'
        ? Promise.resolve({
            releaseId: STABLE,
            release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
            contents: catalog(STABLE, '2.11.0', {
              agent: [fromRelease('security-reviewer', STABLE, { name: 'Security reviewer' })],
            }),
          })
        : new Promise((resolve) => {
            resolveStages = resolve;
          }),
    );

    renderAt('/blocks/agent');
    expect(await screen.findByText('Security reviewer')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Stages' }));

    // The stage read hasn't answered: the agent card must not linger under "Stages".
    expect(screen.queryByText('Security reviewer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-blocks')).not.toBeInTheDocument();
    resolveStages(null);
  });

  it('browses a named release with ?release=', async () => {
    contents.mockResolvedValue(
      catalog(OTHER, '2.9.0', { stage: [fromRelease('old-stage', OTHER)] }),
    );

    renderAt(`/blocks/stage?release=${encodeURIComponent(OTHER)}`);

    const section = await screen.findByTestId('release-blocks');
    expect(contents).toHaveBeenCalledWith(OTHER, ['stage']);
    expect(stableCatalog).not.toHaveBeenCalled();
    expect(section).toHaveTextContent('Stages in AI-DLC 2.9.0');
    expect(section).not.toHaveTextContent('(stable)');
  });

  it('opens a release block in the editor with its release', async () => {
    const user = userEvent.setup();
    stableCatalog.mockResolvedValue({
      releaseId: STABLE,
      release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
      contents: catalog(STABLE, '2.11.0', {
        agent: [fromRelease('security-reviewer', STABLE, { name: 'Security reviewer' })],
      }),
    });
    releaseBlock.mockResolvedValue({
      block: fromRelease('security-reviewer', STABLE, { name: 'Security reviewer' }),
      body: '# Security reviewer',
      script: '',
    });

    renderAt('/blocks/agent');
    await user.click(await screen.findByText('Security reviewer'));

    expect(screen.getByTestId('location')).toHaveTextContent(
      `/blocks/agent/security-reviewer?release=${encodeURIComponent(STABLE)}`,
    );
    expect(await screen.findByText('Release · read-only')).toBeInTheDocument();
  });
});

describe('BlockEditor', () => {
  it('loads a ?release= block from the release, read-only, never from the library', async () => {
    releaseBlock.mockResolvedValue({
      block: fromRelease('security-reviewer', STABLE, { name: 'Security reviewer', hasBody: true }),
      body: '# Review for security',
      script: '',
    });

    renderAt(`/blocks/agent/security-reviewer?release=${encodeURIComponent(STABLE)}`);

    expect(await screen.findByText('Release · read-only')).toBeInTheDocument();
    expect(releaseBlock).toHaveBeenCalledWith(STABLE, 'agent', 'security-reviewer');
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Security reviewer')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('names the stable release the stage pickers include', async () => {
    get.mockResolvedValue(block('my-stage', 'default', { blockType: 'STAGE', name: 'My stage' }));
    stableCatalog.mockResolvedValue({
      releaseId: STABLE,
      release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
      contents: catalog(STABLE, '2.11.0', { agent: [fromRelease('security-reviewer')] }),
    });
    const user = userEvent.setup();

    renderAt('/blocks/stage/my-stage');
    await user.click(await screen.findByRole('tab', { name: 'Configuration' }));

    expect(await screen.findByTestId('picker-release-note')).toHaveTextContent(
      'The pickers include AI-DLC 2.11.0, the stable release new intents pin.',
    );
  });
});
