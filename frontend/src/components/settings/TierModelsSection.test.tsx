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

const renderSection = (value: Parameters<typeof TierModelsSection>[0]['value']) =>
  render(
    <TierModelsSection
      value={value}
      onChange={vi.fn()}
      modelOptions={modelOptions}
      modelsLoaded
      idPrefix="admin"
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
});
