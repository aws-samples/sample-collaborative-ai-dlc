import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('renders the fallback without a wordmark', () => {
    render(<BrandMark wordmarkClassName="h-5" fallback={<span>default logo</span>} />);
    expect(screen.getByText('default logo')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the light and dark wordmarks', () => {
    vi.stubEnv('VITE_BRAND_NAME', 'Example Corp');
    vi.stubEnv('VITE_BRAND_WORDMARK', '/branding/wordmark.svg');
    vi.stubEnv('VITE_BRAND_WORDMARK_DARK', '/branding/wordmark-dark.svg');
    render(<BrandMark wordmarkClassName="h-5" fallback={<span>default logo</span>} />);
    const [light, dark] = screen.getAllByRole('img', { name: 'Example Corp' });
    expect(light).toHaveAttribute('src', '/branding/wordmark.svg');
    expect(light).toHaveClass('h-5', 'dark:hidden');
    expect(dark).toHaveAttribute('src', '/branding/wordmark-dark.svg');
    expect(dark).toHaveClass('hidden', 'dark:block');
    expect(screen.queryByText('default logo')).not.toBeInTheDocument();
  });

  it('uses the light wordmark in dark mode when there is no dark one', () => {
    vi.stubEnv('VITE_BRAND_WORDMARK', '/branding/wordmark.svg');
    render(<BrandMark wordmarkClassName="h-5" fallback={null} />);
    const images = screen.getAllByRole('img');
    expect(images.map((i) => i.getAttribute('src'))).toEqual([
      '/branding/wordmark.svg',
      '/branding/wordmark.svg',
    ]);
  });
});
