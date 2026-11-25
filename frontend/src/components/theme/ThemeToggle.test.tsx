import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { ThemeToggle } from './ThemeToggle';

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && dark,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

async function openMenu() {
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
  return user;
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('exposes the three themes as a radio group with the stored one checked', async () => {
    localStorage.setItem('aidlc-theme', 'dark');
    await openMenu();

    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('defaults to System when nothing is stored', async () => {
    await openMenu();
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('persists and applies the picked theme', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(localStorage.getItem('aidlc-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
