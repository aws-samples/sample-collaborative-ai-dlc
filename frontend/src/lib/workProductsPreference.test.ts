import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocumentOrder, setDocumentOrder } from './workProductsPreference';

describe('workProductsPreference', () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to documents in production order', () => {
    expect(getDocumentOrder()).toBe('oldest-first');
  });

  it('persists the selected document order', () => {
    setDocumentOrder('newest-first');

    expect(getDocumentOrder()).toBe('newest-first');
    expect(localStorage.getItem('aidlc.workProducts.documentOrder.v1')).toBe('newest-first');
  });

  it('falls back to production order for an invalid stored value', () => {
    localStorage.setItem('aidlc.workProducts.documentOrder.v1', 'invalid');

    expect(getDocumentOrder()).toBe('oldest-first');
  });
});
