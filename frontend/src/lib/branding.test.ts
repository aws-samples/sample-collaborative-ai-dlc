import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBranding, getBranding } from './branding';

const brandLink = () => document.head.querySelector<HTMLLinkElement>('link[data-brand]');

describe('getBranding', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the stock logo and name', () => {
    expect(getBranding()).toEqual({
      name: 'AI-DLC',
      logo: '/logo.svg',
      wordmark: undefined,
      wordmarkDark: undefined,
      stylesheet: undefined,
      favicon: undefined,
      title: undefined,
    });
  });

  it('reads trimmed VITE_BRAND_* settings and ignores blank ones', () => {
    vi.stubEnv('VITE_BRAND_NAME', ' Example Corp ');
    vi.stubEnv('VITE_BRAND_WORDMARK', '/branding/wordmark.svg');
    vi.stubEnv('VITE_BRAND_LOGO', '   ');
    expect(getBranding()).toMatchObject({
      name: 'Example Corp',
      wordmark: '/branding/wordmark.svg',
      logo: '/logo.svg',
    });
  });
});

describe('applyBranding', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/logo.svg" />';
    document.title = 'Default';
  });

  it('changes nothing without branding', async () => {
    await applyBranding(getBranding());
    expect(document.title).toBe('Default');
    expect(document.head.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/logo.svg');
    expect(brandLink()).toBeNull();
  });

  it('sets the title and favicon', async () => {
    await applyBranding({
      ...getBranding(),
      title: 'Example AI-DLC',
      favicon: '/branding/icon.png',
    });
    expect(document.title).toBe('Example AI-DLC');
    const icon = document.head.querySelector('link[rel="icon"]');
    expect(icon?.getAttribute('href')).toBe('/branding/icon.png');
    expect(icon?.hasAttribute('type')).toBe(false);
  });

  it('appends the stylesheet last and waits for it to load', async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<link rel="stylesheet" href="/assets/app.css" />',
    );
    let settled = false;
    const pending = applyBranding({ ...getBranding(), stylesheet: '/branding/brand.css' }).then(
      () => {
        settled = true;
      },
    );
    const link = brandLink();
    expect(link?.getAttribute('href')).toBe('/branding/brand.css');
    expect(document.head.lastElementChild).toBe(link);
    await Promise.resolve();
    expect(settled).toBe(false);
    link?.dispatchEvent(new Event('load'));
    await pending;
    expect(settled).toBe(true);
  });

  it('carries on when the stylesheet fails to load', async () => {
    const pending = applyBranding({ ...getBranding(), stylesheet: '/branding/missing.css' });
    brandLink()?.dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops waiting after the timeout', async () => {
    vi.useFakeTimers();
    const pending = applyBranding(
      { ...getBranding(), stylesheet: '/branding/slow.css' },
      document,
      50,
    );
    vi.advanceTimersByTime(50);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
