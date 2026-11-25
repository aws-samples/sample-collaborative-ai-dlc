import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(path.resolve(import.meta.dirname, '../../../index.html'), 'utf8');

function inlineThemeScript(): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const theme = scripts.find((m) => m[1].includes('aidlc-theme'));
  if (!theme) throw new Error('index.html has no inline theme script');
  return theme[1];
}

function runThemeScript(stored: string | null, systemDark: boolean) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem('aidlc-theme', stored);
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && systemDark,
      media: query,
    })),
  );
  new Function(inlineThemeScript())();
  return document.documentElement.classList;
}

describe('index.html anti-FOUC theme script', () => {
  beforeEach(() => {
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('is placed in <head> so it runs before first paint', () => {
    const headEnd = html.indexOf('</head>');
    const scriptAt = html.indexOf(inlineThemeScript());
    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(headEnd);
  });

  it('applies the stored dark theme', () => {
    const classes = runThemeScript('dark', false);
    expect(classes.contains('dark')).toBe(true);
    expect(classes.contains('light')).toBe(false);
  });

  it('applies the stored light theme even when the system prefers dark', () => {
    const classes = runThemeScript('light', true);
    expect(classes.contains('light')).toBe(true);
    expect(classes.contains('dark')).toBe(false);
  });

  it('falls back to the system preference when nothing is stored', () => {
    expect(runThemeScript(null, true).contains('dark')).toBe(true);
    document.documentElement.className = '';
    expect(runThemeScript(null, false).contains('light')).toBe(true);
  });

  it('resolves an explicit "system" preference from matchMedia', () => {
    expect(runThemeScript('system', true).contains('dark')).toBe(true);
  });

  it('never throws when storage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(() => runThemeScript(null, true)).not.toThrow();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      getItem.mockRestore();
    }
  });
});
