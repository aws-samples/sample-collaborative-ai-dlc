import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('SelectTrigger', () => {
  it('matches Input/Button height and uses a focus-visible ring', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Agent">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    expect(trigger).toHaveClass('h-9');
    expect(trigger).toHaveClass('focus-visible:outline-none', 'focus-visible:ring-ring');
    expect(trigger.className).not.toMatch(/(^|\s)focus:ring/);
  });
});
