import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnpricedModelNote, UNPRICED_MODEL_NOTE } from './UnpricedModelNote';

const options = [
  { id: 'openai.gpt-6.1-terra', name: 'openai.gpt-6.1-terra' },
  { id: 'openai.gpt-7-nova', name: 'openai.gpt-7-nova', priced: false },
];

describe('UnpricedModelNote', () => {
  it('uses the wording the pickers share', () => {
    expect(UNPRICED_MODEL_NOTE).toBe('Cost estimate unavailable for this model');
  });

  it('shows the note when the selected model has no price', () => {
    render(<UnpricedModelNote options={options} selected="openai.gpt-7-nova" data-testid="note" />);
    expect(screen.getByTestId('note')).toHaveTextContent(UNPRICED_MODEL_NOTE);
  });

  it.each([
    ['a priced model', 'openai.gpt-6.1-terra'],
    ['the default (no model selected)', ''],
    // Nothing is known about an id that is not in the list, so nothing is claimed.
    ['a custom id that is not in the list', 'openai.gpt-8-custom'],
  ])('shows nothing for %s', (_label, selected) => {
    const { container } = render(<UnpricedModelNote options={options} selected={selected} />);
    expect(container).toBeEmptyDOMElement();
  });
});
