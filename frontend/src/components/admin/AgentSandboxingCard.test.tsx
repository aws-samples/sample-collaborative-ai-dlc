import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSandboxingCard } from './AgentSandboxingCard';
import { ApiError } from '@/services/api';
import type { SandboxSettings, SandboxSettingsUpdate } from '@/services/agents';

const { getSettings, updateSandbox } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSandbox: vi.fn(),
}));
vi.mock('@/services/agents', () => ({ agentsService: { getSettings, updateSandbox } }));

const basic = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
    strictAllowlist: false,
    allowAllUnixSockets: true,
  },
  filesystem: { disabled: true, allowWrite: [], denyRead: [], denyWrite: [] },
};
const restricted = { ...basic, network: { ...basic.network, deniedDomains: ['example.com'] } };
const reorderedBasic = {
  filesystem: { denyWrite: [], denyRead: [], allowWrite: [], disabled: true },
  network: {
    allowAllUnixSockets: true,
    strictAllowlist: false,
    deniedDomains: [],
    allowedDomains: [],
  },
};
let saved: SandboxSettings;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  saved = {
    revision: 4,
    enabled: true,
    applied: { version: 2, settings: basic, appliedAt: '2026-10-29', appliedBy: 'admin' },
    draft: basic,
    defaultSettings: basic,
  };
  getSettings.mockImplementation(async () => ({
    sandbox: structuredClone(saved),
    bedrockRegion: 'eu-central-1',
  }));
  updateSandbox.mockImplementation(async (update: SandboxSettingsUpdate) => {
    expect(update.expectedRevision).toBe(saved.revision);
    saved.revision += 1;
    if (update.action === 'toggle') {
      saved.enabled = update.enabled;
      if (update.enabled && !saved.applied) {
        saved.applied = {
          version: saved.revision,
          settings: basic,
          appliedAt: '2026-10-29',
          appliedBy: 'admin',
        };
        saved.draft ??= basic;
      }
    } else {
      saved.draft = JSON.parse(update.config);
      if (update.action === 'apply') {
        saved.applied = {
          version: saved.revision,
          settings: saved.draft!,
          appliedAt: '2026-10-29',
          appliedBy: 'admin',
        };
      }
    }
    return structuredClone(saved);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = async () => {
  await act(async () => {
    render(<AgentSandboxingCard />);
  });
};
const edit = (value: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
};
const pauseTyping = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
};
const click = async (role: 'button' | 'switch', name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
  });
};

describe('sandbox JSON settings', () => {
  it.each([null, restricted])(
    'enables the starter in one click without applying a draft: %j',
    async (draft) => {
      saved.applied = null;
      saved.draft = draft;
      saved.enabled = false;
      await show();
      expect(JSON.parse((screen.getByRole('textbox') as HTMLTextAreaElement).value)).toEqual(
        draft ?? basic,
      );
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByRole('switch')).toBeEnabled();
      if (!draft) {
        expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
      }
      await pauseTyping();
      expect(updateSandbox).not.toHaveBeenCalled();
      await click('switch', 'Enable sandboxing for new runs');
      expect(updateSandbox).toHaveBeenCalledExactlyOnceWith({
        action: 'toggle',
        enabled: true,
        expectedRevision: 4,
      });
      expect(saved.enabled).toBe(true);
      expect(saved.applied).toMatchObject({ settings: basic });
      expect(saved.draft).toEqual(draft ?? basic);
      if (!draft) {
        expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
      }
    },
  );

  it('enables Apply only for changed JSON, ignoring whitespace changes', async () => {
    await show();
    const apply = screen.getByRole('button', { name: 'Apply configuration' });
    expect(apply).toBeDisabled();
    edit(JSON.stringify(basic, null, 4));
    expect(apply).toBeDisabled();
    edit(JSON.stringify(restricted));
    expect(apply).toBeEnabled();
    edit('{');
    expect(apply).toBeDisabled();
    edit(JSON.stringify(basic));
    expect(apply).toBeDisabled();
  });

  it.each([false, true])(
    'ignores object key order when loading unchanged settings (applied: %s)',
    async (applied) => {
      if (!applied) {
        saved.applied = null;
        saved.enabled = false;
      }
      saved.draft = reorderedBasic;
      await show();
      expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: applied ? 'Restore applied' : 'Restore starter' }),
      ).toBeDisabled();
      edit(JSON.stringify(basic));
      await pauseTyping();
      expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
      expect(updateSandbox).not.toHaveBeenCalled();
    },
  );

  it('disables Apply after the server returns the same config with reordered keys', async () => {
    await show();
    const reordered = {
      ...reorderedBasic,
      network: { ...reorderedBasic.network, deniedDomains: ['example.com'] },
    };
    updateSandbox.mockResolvedValueOnce({
      ...saved,
      revision: 5,
      draft: reordered,
      applied: { ...saved.applied, version: 5, settings: reordered },
    });
    edit(JSON.stringify(restricted));
    await click('button', 'Apply configuration');
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    expect(screen.getByText('Applied configuration')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(restricted));
    await pauseTyping();
    expect(updateSandbox).toHaveBeenCalledTimes(1);
  });

  it('can enable the starter with invalid unsaved edits and restore it afterwards', async () => {
    saved.applied = null;
    saved.draft = null;
    saved.enabled = false;
    await show();
    edit('{');
    await pauseTyping();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    await click('switch', 'Enable sandboxing for new runs');
    expect(saved.applied).toMatchObject({ settings: basic });
    expect(saved.enabled).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue('{');
    await click('button', 'Restore applied');
    expect(JSON.parse((screen.getByRole('textbox') as HTMLTextAreaElement).value)).toEqual(basic);
  });

  it('debounces valid drafts without applying or toggling them', async () => {
    await show();
    edit(JSON.stringify(restricted));
    expect(updateSandbox).not.toHaveBeenCalled();
    await pauseTyping();
    expect(updateSandbox).toHaveBeenCalledTimes(1);
    expect(saved.draft).toEqual(restricted);
    expect(saved.applied?.settings).toEqual(basic);
    expect(saved.enabled).toBe(true);
    expect(screen.getByText('Draft autosaved · not applied')).toBeInTheDocument();
    await pauseTyping();
    expect(updateSandbox).toHaveBeenCalledTimes(1);
  });

  it('never saves invalid JSON and allows toggling the existing applied config', async () => {
    await show();
    edit('{');
    await pauseTyping();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    await click('switch', 'Enable sandboxing for new runs');
    expect(saved.enabled).toBe(false);
    expect(saved.draft).toEqual(basic);
    expect(screen.getByRole('textbox')).toHaveValue('{');
  });

  it('shows backend SRT errors without saving or repeatedly sending the same invalid edit', async () => {
    await show();
    updateSandbox.mockRejectedValueOnce(
      new ApiError(400, 'Invalid SRT configuration', {
        issues: [{ path: 'network.strictAllowList', message: 'Unknown SRT setting' }],
      }),
    );
    edit(JSON.stringify({ ...basic, network: { ...basic.network, strictAllowList: true } }));
    await pauseTyping();
    expect(screen.getByText('network.strictAllowList: Unknown SRT setting')).toBeInTheDocument();
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    await pauseTyping();
    expect(updateSandbox).toHaveBeenCalledTimes(1);
    expect(saved.draft).toEqual(basic);
    edit(JSON.stringify(restricted));
    await pauseTyping();
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeEnabled();
    expect(saved.draft).toEqual(restricted);
  });

  it('allows retrying Apply after a service error without marking valid JSON invalid', async () => {
    await show();
    updateSandbox.mockRejectedValueOnce(new ApiError(503, 'Service unavailable'));
    edit(JSON.stringify(restricted));
    await pauseTyping();
    expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeEnabled();
    await click('button', 'Apply configuration');
    expect(saved.applied?.settings).toEqual(restricted);
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
  });

  it('Apply changes the policy without enabling it; Restore discards editor edits', async () => {
    saved.enabled = false;
    await show();
    edit(JSON.stringify(restricted));
    await click('button', 'Apply configuration');
    expect(saved.applied?.settings).toEqual(restricted);
    expect(saved.enabled).toBe(false);
    edit('{');
    await click('button', 'Restore applied');
    expect(JSON.parse((screen.getByRole('textbox') as HTMLTextAreaElement).value)).toEqual(
      restricted,
    );
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
  });

  it('keeps newer typing when an older save returns and saves it using the new revision', async () => {
    await show();
    let finish!: (value: SandboxSettings) => void;
    updateSandbox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    edit(JSON.stringify(restricted));
    await pauseTyping();
    const next = { ...restricted, network: { ...restricted.network, strictAllowlist: true } };
    edit(JSON.stringify(next));
    saved = { ...saved, revision: 5, draft: restricted };
    await act(async () => {
      finish(structuredClone(saved));
    });
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(next));
    await pauseTyping();
    expect(saved.draft).toEqual(next);
    expect(saved.revision).toBe(6);
  });

  it('stops writes after a revision conflict and preserves edits until explicit reload', async () => {
    await show();
    updateSandbox.mockRejectedValue(new ApiError(409, 'Changed'));
    edit(JSON.stringify(restricted));
    await pauseTyping();
    expect(screen.getByRole('alert')).toHaveTextContent('Another administrator changed');
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(restricted));
    expect(screen.getByRole('switch')).toBeDisabled();
    await pauseTyping();
    expect(updateSandbox).toHaveBeenCalledTimes(1);
    await click('button', 'Reload settings');
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(basic, null, 2));
  });

  it('does not overwrite edits with a late schema error for an older draft', async () => {
    await show();
    let reject!: (reason: Error) => void;
    updateSandbox.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    edit(JSON.stringify(restricted));
    await pauseTyping();
    edit('{');
    await act(async () => {
      reject(new ApiError(400, 'Old schema error'));
    });
    expect(screen.queryByText('Old schema error')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('{');
  });
});

describe('network access help', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  });

  const openHelp = async () => {
    const details = screen.getByText('Network access help').closest('details')!;
    details.scrollIntoView = vi.fn();
    await click('button', 'Network access help');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return details;
  };

  it.each([false, true])(
    'opens, focuses and scrolls to help (reduced motion: %s)',
    async (reduced) => {
      vi.mocked(window.matchMedia).mockReturnValue({ matches: reduced } as MediaQueryList);
      await show();
      const button = screen.getByRole('button', { name: 'Network access help' });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      const details = await openHelp();
      expect(details.open).toBe(true);
      expect(details.querySelector('summary')).toHaveFocus();
      expect(details.scrollIntoView).toHaveBeenCalledWith({
        behavior: reduced ? 'instant' : 'smooth',
        block: 'start',
      });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      await act(async () => {
        fireEvent.click(details.querySelector('summary')!);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(updateSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(['eu-central-1', 'us-west-2'])(
    'copies the four harness examples using %s without changing the policy',
    async (bedrockRegion) => {
      getSettings.mockResolvedValueOnce({ sandbox: structuredClone(saved), bedrockRegion });
      await show();
      await openHelp();
      const examples = [
        [
          'Kiro',
          ['*.kiro.dev', 'q.us-east-1.amazonaws.com', 'codewhisperer.us-east-1.amazonaws.com'],
        ],
        [
          'Claude Code',
          [
            `bedrock-runtime.${bedrockRegion}.amazonaws.com`,
            `bedrock.${bedrockRegion}.amazonaws.com`,
          ],
        ],
        [
          'OpenCode',
          [
            `bedrock-runtime.${bedrockRegion}.amazonaws.com`,
            `bedrock.${bedrockRegion}.amazonaws.com`,
            'models.dev',
          ],
        ],
        ['Codex', [`bedrock-mantle.${bedrockRegion}.api.aws`]],
      ] as const;
      for (const [name, domains] of examples) {
        await click('button', `Copy ${name} allowedDomains`);
        const fragment = writeText.mock.lastCall![0];
        expect(JSON.parse(`{${fragment}}`)).toEqual({ allowedDomains: domains });
        expect(
          screen.getByText(fragment, { exact: true, collapseWhitespace: false }),
        ).toBeVisible();
      }
      expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(4);
      expect(screen.getByText('registry.npmjs.org')).toBeVisible();
      expect(screen.getByText('pypi.org')).toBeVisible();
      expect(screen.getByText('repo.maven.apache.org')).toBeVisible();
      expect(screen.getByText('docs.aws.amazon.com')).toBeVisible();
      expect(screen.getByText('api.github.com')).toBeVisible();
      expect(screen.getByText('aws-mcp.eu-central-1.api.aws')).toBeVisible();
      await pauseTyping();
      expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(basic, null, 2));
      expect(updateSandbox).not.toHaveBeenCalled();
      expect(getSettings).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a region placeholder with an older backend instead of guessing a region', async () => {
    getSettings.mockResolvedValueOnce({ sandbox: structuredClone(saved) });
    await show();
    await openHelp();
    await click('button', 'Copy Codex allowedDomains');
    expect(writeText).toHaveBeenCalledWith(
      '"allowedDomains": [\n  "bedrock-mantle.<bedrock_region>.api.aws"\n]',
    );
    expect(screen.getByText(/with your inference region/)).toBeVisible();
  });

  it('reports a clipboard failure without changing unsaved edits', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await show();
    edit('{');
    await openHelp();
    await click('button', 'Copy Kiro allowedDomains');
    expect(
      screen.getByText('Copy unavailable. Select the example and copy it manually.'),
    ).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('{');
    await pauseTyping();
    expect(updateSandbox).not.toHaveBeenCalled();
  });
});
