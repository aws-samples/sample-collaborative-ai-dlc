import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the agents service
const getSettings = vi.fn();
const getCapabilities = vi.fn();
const updateSettings = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    getCapabilities: (...a: unknown[]) => getCapabilities(...a),
    updateSettings: (...a: unknown[]) => updateSettings(...a),
  },
}));

import { DefaultModelsCard } from './DefaultModelsCard';

const defaultSettings = (over: Record<string, unknown> = {}) => ({
  bedrockBearerTokenSet: false,
  kiroApiKeySet: false,
  cliModels: {},
  ...over,
});

const defaultCapabilities = (over: Record<string, unknown> = {}) => ({
  available: ['kiro', 'claude', 'opencode', 'codex'],
  models: {
    kiro: [{ id: 'kiro-model-1', name: 'Kiro Model 1' }],
    claude: [
      { id: 'us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'us.anthropic.claude-opus-4-6', name: 'Claude Opus 4.6' },
    ],
    opencode: [{ id: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    codex: [{ id: 'openai.gpt-5.5', name: 'GPT-5.5' }],
    // The default fixture is a runtime that read the region's catalogue (#674);
    // tests about the fallback override this.
    codexSource: 'catalog',
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// jsdom implements no pointer capture, and Radix Select calls it the moment the
// trigger is pressed: without the shim the dropdown never opens in a test.
function shimPointerCapture() {
  const proto = Element.prototype as unknown as Record<string, () => unknown>;
  proto.hasPointerCapture = () => false;
  proto.releasePointerCapture = () => {};
  proto.setPointerCapture = () => {};
  proto.scrollIntoView = () => {};
}

describe('DefaultModelsCard', () => {
  it('renders skeletons while loading settings', () => {
    getSettings.mockReturnValue(new Promise(() => {}));
    getCapabilities.mockReturnValue(new Promise(() => {}));

    render(<DefaultModelsCard />);

    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders Select dropdowns once capabilities load successfully', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(defaultCapabilities());

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-kiro')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-model-select-claude')).toBeInTheDocument();
    expect(screen.getByTestId('default-model-select-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('default-model-select-codex')).toBeInTheDocument();
  });

  it('disables dropdowns while models are loading', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    let resolveCapabilities: (v: unknown) => void;
    getCapabilities.mockReturnValue(
      new Promise((resolve) => {
        resolveCapabilities = resolve;
      }),
    );

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-input-kiro')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-model-input-kiro')).toBeDisabled();
    expect(screen.getByTestId('default-model-input-claude')).toBeDisabled();
    expect(screen.getByTestId('default-model-input-opencode')).toBeDisabled();

    resolveCapabilities!(defaultCapabilities());

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-kiro')).toBeInTheDocument();
    });
  });

  it('falls back to Input when model list is empty for a CLI', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(
      defaultCapabilities({
        models: {
          kiro: [],
          claude: [{ id: 'some-model', name: 'Some Model' }],
          opencode: [],
        },
      }),
    );

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-input-kiro')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-model-select-claude')).toBeInTheDocument();
    expect(screen.getByTestId('default-model-input-opencode')).toBeInTheDocument();
  });

  it('falls back to Input fields when getCapabilities fails', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockRejectedValue(new Error('Network error'));

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-input-kiro')).toBeInTheDocument();
    });
    expect(screen.getByTestId('default-model-input-claude')).toBeInTheDocument();
    expect(screen.getByTestId('default-model-input-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('default-model-input-kiro')).not.toBeDisabled();
  });

  it('shows the sentinel default text in Select trigger when no model is set', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(defaultCapabilities());

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-kiro')).toBeInTheDocument();
    });

    const kiroTrigger = screen.getByTestId('default-model-select-kiro');
    expect(kiroTrigger).toHaveTextContent('No default');
  });

  it('shows the saved model name in Select trigger when a model is already set', async () => {
    getSettings.mockResolvedValue(
      defaultSettings({ cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' } }),
    );
    getCapabilities.mockResolvedValue(defaultCapabilities());

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-claude')).toBeInTheDocument();
    });

    const claudeTrigger = screen.getByTestId('default-model-select-claude');
    expect(claudeTrigger).toHaveTextContent('Claude Sonnet 4.6');
  });

  it('enables text input for editing when capabilities fail', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockRejectedValue(new Error('Network error'));

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-input-claude')).toBeInTheDocument();
    });

    const claudeInput = screen.getByTestId('default-model-input-claude');
    await user.type(claudeInput, 'us.anthropic.claude-sonnet-4-6');

    expect(claudeInput).toHaveValue('us.anthropic.claude-sonnet-4-6');

    const saveButton = screen.getByRole('button', { name: /Save Models/ });
    expect(saveButton).not.toBeDisabled();
  });

  it('renders the override table (three tiers + quorum, no fallback row) once expanded', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(defaultCapabilities());

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('tier-overrides-toggle')).toBeInTheDocument();
    });
    // Collapsed by default when nothing is configured.
    expect(screen.queryByTestId('admin-tier-model-judgment-claude')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('tier-overrides-toggle'));
    for (const row of ['judgment', 'balanced', 'templated', 'quorum']) {
      expect(screen.getByTestId(`admin-tier-model-${row}-claude`)).toBeInTheDocument();
    }
    // The legacy fallback row is not authored here — the default model is the fallback.
    expect(screen.queryByTestId('admin-tier-model-fallback-claude')).not.toBeInTheDocument();
  });

  it('auto-expands when the saved config already carries overrides, and shows them', async () => {
    getSettings.mockResolvedValue(
      defaultSettings({
        tierModels: { judgment: { claude: 'us.anthropic.claude-opus-4-6' } },
      }),
    );
    getCapabilities.mockResolvedValue(defaultCapabilities());

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-tier-model-judgment-claude')).toBeInTheDocument();
    });
    expect(screen.getByTestId('admin-tier-model-judgment-claude')).toHaveTextContent(
      'Claude Opus 4.6',
    );
    expect(screen.getByTestId('tier-overrides-toggle')).toHaveTextContent('1 set');
  });

  it('unset cells show the inherited default model as their placeholder', async () => {
    getSettings.mockResolvedValue(
      defaultSettings({ cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' } }),
    );
    getCapabilities.mockRejectedValue(new Error('no models')); // input mode

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('tier-overrides-toggle')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tier-overrides-toggle'));
    // Long ids are truncated for the narrow cell — the prefix is what matters.
    expect(screen.getByTestId('admin-tier-model-judgment-claude')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Default (us.anthropic.claude-sonnet'),
    );
    // No default configured for kiro → generic label.
    expect(screen.getByTestId('admin-tier-model-judgment-kiro')).toHaveAttribute(
      'placeholder',
      'Default',
    );
  });

  it('saves the edited tier config (canonicalized) alongside the flat models', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockRejectedValue(new Error('no models')); // input mode
    updateSettings.mockResolvedValue({});

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('tier-overrides-toggle')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tier-overrides-toggle'));
    await user.type(
      screen.getByTestId('admin-tier-model-quorum-claude'),
      'us.anthropic.claude-sonnet-4-6',
    );
    await user.click(screen.getByRole('button', { name: /Save Models/ }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        tierModels: { quorum: { claude: 'us.anthropic.claude-sonnet-4-6' } },
      }),
    );
  });

  it('lets a model ID the catalogue does not list be typed in (#674)', async () => {
    shimPointerCapture();
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(defaultCapabilities());
    updateSettings.mockResolvedValue({});

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-codex')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('default-model-select-codex'));
    await user.click(await screen.findByText('Custom model ID…'));

    const input = await screen.findByTestId('default-model-input-codex');
    expect(input).not.toBeDisabled();
    await user.type(input, 'openai.gpt-6.1-sol');

    await user.click(screen.getByRole('button', { name: /Save Models/ }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        cliModels: expect.objectContaining({ codex: 'openai.gpt-6.1-sol' }),
      }),
    );
  });

  it('goes back to the dropdown with the typed ID kept as a custom choice', async () => {
    shimPointerCapture();
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(defaultCapabilities());

    const user = userEvent.setup();
    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-codex')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('default-model-select-codex'));
    await user.click(await screen.findByText('Custom model ID…'));
    await user.type(await screen.findByTestId('default-model-input-codex'), 'openai.gpt-6.1-sol');

    await user.click(screen.getByTestId('default-model-list-codex'));

    const trigger = await screen.findByTestId('default-model-select-codex');
    expect(trigger).toHaveTextContent('openai.gpt-6.1-sol (custom)');
  });

  it('says so when the regional Codex catalogue could not be read (#674)', async () => {
    getSettings.mockResolvedValue(defaultSettings({ cliModels: { codex: 'openai.gpt-5.5' } }));
    getCapabilities.mockResolvedValue(
      defaultCapabilities({
        models: {
          kiro: [],
          claude: [],
          opencode: [],
          codex: [{ id: 'openai.gpt-5.5', name: 'GPT-5.5' }],
          codexSource: 'error',
        },
      }),
    );

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('codex-catalog-unavailable')).toBeInTheDocument();
    });
    // The saved selection is still the value in the field: the fallback list is
    // what the picker offers, not a reset of the configured model.
    expect(screen.getByTestId('default-model-select-codex')).toHaveTextContent('GPT-5.5');
  });

  it('says so when the runtime answered without a catalogue (#674)', async () => {
    getSettings.mockResolvedValue(defaultSettings({ cliModels: { codex: 'openai.gpt-5.5' } }));
    getCapabilities.mockResolvedValue(
      defaultCapabilities({
        models: {
          kiro: [],
          claude: [],
          opencode: [],
          codex: [{ id: 'openai.gpt-5.5', name: 'GPT-5.5' }],
          codexSource: 'static',
        },
      }),
    );

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('codex-catalog-unavailable')).toBeInTheDocument();
    });
  });

  it('keeps the saved selection when the region lists no Codex model (#674)', async () => {
    getSettings.mockResolvedValue(defaultSettings({ cliModels: { codex: 'openai.gpt-6.1-sol' } }));
    getCapabilities.mockResolvedValue(
      defaultCapabilities({
        models: { kiro: [], claude: [], opencode: [], codex: [], codexSource: 'catalog' },
      }),
    );

    render(<DefaultModelsCard />);

    // An empty regional catalogue means no dropdown to choose from — the saved
    // id stays in the field and a region-specific id can still be typed.
    await waitFor(() => {
      expect(screen.getByTestId('default-model-input-codex')).toHaveValue('openai.gpt-6.1-sol');
    });
    expect(screen.queryByTestId('codex-catalog-unavailable')).not.toBeInTheDocument();
  });

  it('shows no catalogue warning when the regional list was read', async () => {
    getSettings.mockResolvedValue(defaultSettings());
    getCapabilities.mockResolvedValue(
      defaultCapabilities({
        models: {
          kiro: [],
          claude: [],
          opencode: [],
          codex: [{ id: 'openai.gpt-6.1-sol', name: 'openai.gpt-6.1-sol' }],
          codexSource: 'catalog',
        },
      }),
    );

    render(<DefaultModelsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('default-model-select-codex')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('codex-catalog-unavailable')).not.toBeInTheDocument();
  });
});
