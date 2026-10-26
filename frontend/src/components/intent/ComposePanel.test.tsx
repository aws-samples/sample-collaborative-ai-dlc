import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const compose = vi.fn();
const listComposes = vi.fn();
const composeReportUpload = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    compose: (...a: unknown[]) => compose(...a),
    listComposes: (...a: unknown[]) => listComposes(...a),
    composeReportUpload: (...a: unknown[]) => composeReportUpload(...a),
  },
}));

import { ComposePanel } from './ComposePanel';
import { aidlcSettingsFromComposeProposal } from '@/lib/aidlcSettings';
import type { ComposeSession } from '@/services/intents';

const session = (
  proposal: Partial<NonNullable<ComposeSession['proposal']>>,
  extra: Record<string, unknown> = {},
): ComposeSession =>
  ({
    composeId: 'c1',
    mode: 'front',
    state: 'COMPLETED',
    source: 'llm',
    requestedBy: 'u1',
    requestedByName: 'Dana Okonkwo',
    instructions: null,
    reportKey: null,
    proposal: { mode: 'matched', scope: 'bugfix', grid: null, rationale: [], ...proposal },
    validation: { valid: true, errors: [], warnings: [], summary: null },
    failureReason: null,
    ...extra,
  }) as unknown as ComposeSession;

const onApply = vi.fn();

const renderPanel = () =>
  render(<ComposePanel projectId="p1" intentId="i1" agentCli="claude" onApply={onApply} />);

describe('ComposePanel — the composer settings proposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composeReportUpload.mockResolvedValue({ uploadUrl: 'u', key: 'k' });
  });

  it('shows no settings block for a proposal that carries none', async () => {
    listComposes.mockResolvedValue({ composes: [session({})] });
    renderPanel();

    await waitFor(() => expect(screen.getByTestId('compose-proposal')).toBeInTheDocument());
    expect(screen.queryByTestId('proposal-settings')).not.toBeInTheDocument();
  });

  it('shows every proposed setting, and says which of them this intent can take', async () => {
    listComposes.mockResolvedValue({
      composes: [
        session({
          guardPolicy: 'strict',
          scopeSettings: { plan_approval: 'off', collaborators: 'on', review_cap: 'advisory' },
        }),
      ],
    });
    renderPanel();

    const block = await waitFor(() => screen.getByTestId('proposal-settings'));
    expect(block).toHaveTextContent('guard_policy: strict');
    expect(block).toHaveTextContent('plan_approval: off');
    expect(block).toHaveTextContent('collaborators: on');
    // Not per-intent here, so it is reported rather than offered — and never
    // silently absent from what the member reads before accepting.
    expect(block).toHaveTextContent('review_cap: advisory');
    expect(block).toHaveTextContent('this setting is not per-intent here');
  });

  it('names the base scope and depth a custom proposal runs on', async () => {
    listComposes.mockResolvedValue({
      composes: [
        session({
          mode: 'custom',
          scope: 'lean-fix',
          grid: { init: 'EXECUTE' },
          guardPolicy: 'relaxed',
          baseScope: 'classic',
          creationDepth: 'standard',
        }),
      ],
    });
    renderPanel();

    const block = await waitFor(() => screen.getByTestId('proposal-settings'));
    expect(block).toHaveTextContent('Base scope: classic');
    expect(block).toHaveTextContent('depth standard');
  });

  // Apply hands the whole proposal and the settings scope it was validated
  // against to the page, which writes them in one transaction. The card is
  // Applied because that transaction committed — there is no promise to inspect.
  it('reports the proposal and its settings scope on Apply, then disables retry', async () => {
    const user = userEvent.setup();
    listComposes.mockResolvedValue({
      composes: [
        session(
          { guardPolicy: 'strict' },
          { settingsScope: 'classic', settingsAuthored: { guardPolicy: 'off' } },
        ),
      ],
    });
    renderPanel();

    const apply = await waitFor(() => screen.getByTestId('proposal-apply'));
    await user.click(apply);

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ guardPolicy: 'strict' });
    expect(onApply.mock.calls[0][1]).toBe('classic');
    expect(onApply.mock.calls[0][2]).toEqual({ guardPolicy: 'off' });
    expect(screen.getByTestId('proposal-apply')).toBeDisabled();
  });

  it('reports a null settings scope for a proposal that resolved none', async () => {
    const user = userEvent.setup();
    listComposes.mockResolvedValue({ composes: [session({})] });
    renderPanel();

    await user.click(await waitFor(() => screen.getByTestId('proposal-apply')));

    expect(onApply.mock.calls[0][1]).toBeNull();
  });
});

describe('aidlcSettingsFromComposeProposal', () => {
  it('keeps only the settings this intent can actually take', () => {
    expect(
      aidlcSettingsFromComposeProposal({
        guardPolicy: 'strict',
        scopeSettings: {
          plan_approval: 'off',
          collaborators: 'on',
          review_cap: 'advisory',
          sensors: 'off',
        },
      }),
    ).toEqual({ guardPolicy: 'strict', planApproval: 'off', collaborators: 'on' });
  });

  it('returns nothing for a proposal that proposed no setting', () => {
    expect(aidlcSettingsFromComposeProposal({})).toEqual({});
  });
});
