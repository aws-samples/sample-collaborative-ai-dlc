import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Project } from '@/services/projects';
import { UNPRICED_MODEL_NOTE } from '@/components/settings/UnpricedModelNote';

const getProjectCapabilities = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getProjectCapabilities: (...a: unknown[]) => getProjectCapabilities(...a),
    getSettings: () => Promise.resolve({ cliModels: {} }),
  },
}));
vi.mock('@/services/projects', () => ({
  projectsService: {
    getCustomRules: () => Promise.resolve({ customRules: [] }),
    getCustomMcpServers: () => Promise.resolve({ customMcpServers: '{}' }),
    getMcpSecrets: () => Promise.resolve({ mcpSecretsSet: {} }),
  },
}));
vi.mock('@/components/settings/AgentCredentialScopeCard', () => ({
  AgentCredentialScopeCard: () => null,
}));
vi.mock('@/components/settings/CustomMcpServersSection', () => ({
  CustomMcpServersSection: () => null,
}));
vi.mock('@/components/settings/CustomRulesSection', () => ({
  CustomRulesSection: () => null,
}));

import { AgentTab } from './AgentTab';

const project = (cliModels: Project['cliModels'], tierModels?: Project['tierModels']) =>
  ({ id: 'p-1', name: 'Space', agentCli: 'codex', cliModels, tierModels }) as Project;

beforeEach(() => {
  vi.clearAllMocks();
  getProjectCapabilities.mockResolvedValue({
    available: ['codex'],
    models: {
      kiro: [],
      claude: [
        { id: 'us.anthropic.claude-sonnet-4-6', name: 'us.anthropic.claude-sonnet-4-6' },
        { id: 'us.anthropic.claude-opus-9', name: 'us.anthropic.claude-opus-9', priced: false },
      ],
      opencode: [],
      codex: [
        { id: 'openai.gpt-6.1-terra', name: 'openai.gpt-6.1-terra' },
        { id: 'openai.gpt-7-nova', name: 'openai.gpt-7-nova', priced: false },
      ],
      codexSource: 'catalog',
    },
  });
});

describe('AgentTab model overrides', () => {
  it('shows the cost note below each picker whose selected model has no price', async () => {
    render(
      <AgentTab
        project={project({ codex: 'openai.gpt-7-nova', claude: 'us.anthropic.claude-opus-9' })}
        canEdit
        onProjectUpdated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('model-unpriced-codex')).toHaveTextContent(UNPRICED_MODEL_NOTE);
    });
    expect(screen.getByTestId('model-unpriced-claude')).toHaveTextContent(UNPRICED_MODEL_NOTE);
    // The list is untouched: the selected option shows the name it was given.
    expect(document.getElementById('model-codex')).toHaveTextContent(/^openai\.gpt-7-nova$/);
  });

  it('shows no note for a priced model or the default', async () => {
    render(
      <AgentTab
        project={project({ codex: 'openai.gpt-6.1-terra' })}
        canEdit
        onProjectUpdated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.getElementById('model-codex')).toHaveTextContent('openai.gpt-6.1-terra');
    });
    expect(screen.queryByTestId('model-unpriced-codex')).toBeNull();
    expect(screen.queryByTestId('model-unpriced-claude')).toBeNull();
  });

  it('says which lists are the last ones read, in the space and the per-tier pickers', async () => {
    getProjectCapabilities.mockResolvedValue({
      available: ['codex'],
      models: {
        kiro: [{ id: 'auto', name: 'Auto' }],
        claude: [{ id: 'us.anthropic.claude-sonnet-4-6', name: 'us.anthropic.claude-sonnet-4-6' }],
        opencode: [],
        codex: [{ id: 'openai.gpt-6.1-terra', name: 'openai.gpt-6.1-terra' }],
        sources: { kiro: 'cached', claude: 'catalog', opencode: 'catalog', codex: 'cached' },
        codexSource: 'cached',
      },
    });

    render(
      <AgentTab
        project={project({}, { judgment: { codex: 'openai.gpt-6.1-terra' } })}
        canEdit
        onProjectUpdated={vi.fn()}
      />,
    );

    for (const cli of ['kiro', 'codex']) {
      expect(await screen.findByTestId(`model-source-${cli}`)).toHaveTextContent(
        'showing the last list read',
      );
      expect(screen.getByTestId(`project-tier-model-source-${cli}`)).toHaveTextContent(
        'last list read',
      );
    }
    expect(screen.queryByTestId('model-source-claude')).toBeNull();
    expect(screen.queryByTestId('project-tier-model-source-claude')).toBeNull();
  });

  it('reads the Codex source of a backend that predates per-CLI sources', async () => {
    getProjectCapabilities.mockResolvedValue({
      available: ['codex'],
      models: {
        kiro: [],
        claude: [],
        opencode: [],
        codex: [{ id: 'openai.gpt-6.1-terra', name: 'openai.gpt-6.1-terra' }],
        codexSource: 'cached',
      },
    });

    render(<AgentTab project={project({})} canEdit onProjectUpdated={vi.fn()} />);

    expect(await screen.findByTestId('model-source-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('model-source-kiro')).toBeNull();
  });

  it('shows no cached-list note when the lists were read now', async () => {
    render(<AgentTab project={project({})} canEdit onProjectUpdated={vi.fn()} />);

    await waitFor(() => {
      expect(document.getElementById('model-codex')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('model-source-codex')).toBeNull();
  });
});
