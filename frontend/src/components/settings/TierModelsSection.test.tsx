import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TierModelsSection } from './TierModelsSection';
import { UNPRICED_MODEL_NOTE } from './UnpricedModelNote';

const modelOptions = {
  codex: [
    { id: 'openai.gpt-6.1-terra', name: 'openai.gpt-6.1-terra' },
    { id: 'openai.gpt-7-nova', name: 'openai.gpt-7-nova', priced: false },
  ],
};

type SectionProps = Parameters<typeof TierModelsSection>[0];
const renderSection = (value: SectionProps['value'], extra: Partial<SectionProps> = {}) =>
  render(
    <TierModelsSection
      value={value}
      onChange={vi.fn()}
      modelOptions={modelOptions}
      modelsLoaded
      idPrefix="admin"
      {...extra}
    />,
  );

describe('TierModelsSection', () => {
  it('shows the cost note below the cell whose selected model has no price', () => {
    renderSection({
      judgment: { codex: 'openai.gpt-7-nova' },
      balanced: { codex: 'openai.gpt-6.1-terra' },
    });

    expect(screen.getByTestId('admin-tier-model-judgment-codex-unpriced')).toHaveTextContent(
      UNPRICED_MODEL_NOTE,
    );
    expect(screen.queryByTestId('admin-tier-model-balanced-codex-unpriced')).toBeNull();
    expect(screen.queryByTestId('admin-tier-model-templated-codex-unpriced')).toBeNull();
    // The option keeps the name the catalogue gave it.
    expect(screen.getByTestId('admin-tier-model-judgment-codex')).toHaveTextContent(
      /^openai\.gpt-7-nova$/,
    );
  });

  it('says once per CLI when its list is the last one read, not the current one', () => {
    renderSection({}, { modelSources: { codex: 'cached', claude: 'catalog', kiro: 'error' } });

    expect(screen.getByTestId('admin-tier-model-source-codex')).toHaveTextContent('last list read');
    expect(screen.queryByTestId('admin-tier-model-source-claude')).toBeNull();
    expect(screen.queryByTestId('admin-tier-model-source-kiro')).toBeNull();
    expect(screen.queryByTestId('admin-tier-model-source-opencode')).toBeNull();
  });

  it('shows no note when no source is known', () => {
    renderSection({});

    expect(screen.queryByTestId('admin-tier-model-source-codex')).toBeNull();
  });
});
