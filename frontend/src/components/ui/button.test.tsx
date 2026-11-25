import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Plus } from 'lucide-react';
import { Button } from './button';

describe('Button', () => {
  it('supports size="xs" with a 28px height and 3.5 icons', () => {
    render(
      <Button size="xs">
        <Plus />
        Add
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Add' });
    expect(button).toHaveClass('h-7', '[&_svg]:size-3.5');
    expect(button).not.toHaveClass('h-9');
  });

  it('loading sets aria-busy, disables the button and blocks clicks', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    await userEvent.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading keeps the label in the DOM and renders a decorative motion-safe spinner', () => {
    const { rerender } = render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    const spinner = button.querySelector('svg');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner?.getAttribute('class')).toContain('motion-safe:animate-spin');
    rerender(<Button>Save</Button>);
    expect(button.querySelector('svg')).toBeNull();
  });

  // A disabled primary/destructive reads as a muted surface, not a faded primary;
  // secondary variants keep the plain fade.
  it.each([
    ['default', true],
    ['destructive', true],
    ['outline', false],
    ['secondary', false],
    ['ghost', false],
    ['link', false],
  ] as const)('disabled %s: muted surface %s', (variant, muted) => {
    render(
      <Button variant={variant} disabled>
        Submit
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Submit' });
    if (muted) {
      expect(button).toHaveClass('disabled:bg-muted', 'disabled:opacity-100');
    } else {
      expect(button).toHaveClass('disabled:opacity-50');
      expect(button).not.toHaveClass('disabled:bg-muted');
    }
  });

  it('keeps the muted disabled surface when a caller overrides the colour', () => {
    render(
      <Button disabled className="bg-agent-success text-white">
        Submit answer
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Submit answer' })).toHaveClass(
      'bg-agent-success',
      'disabled:bg-muted',
    );
  });

  it('passes disabled through to an asChild element', () => {
    render(
      <Button asChild disabled>
        <button type="button">Child</button>
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Child' })).toBeDisabled();
  });
});
