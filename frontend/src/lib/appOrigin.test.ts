import { afterEach, describe, expect, it, vi } from 'vitest';

import { appOrigin, isNonCanonicalOrigin } from './appOrigin';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('appOrigin', () => {
  it('uses the canonical origin baked in at build time', () => {
    vi.stubEnv('VITE_APP_ORIGIN', 'https://aidlc.example.com');
    expect(appOrigin()).toBe('https://aidlc.example.com');
  });

  it('falls back to the browsing origin for local development', () => {
    vi.stubEnv('VITE_APP_ORIGIN', '');
    expect(appOrigin()).toBe(window.location.origin);
  });
});

describe('isNonCanonicalOrigin', () => {
  it('detects a mismatch between the browsing and canonical hostnames', () => {
    // A deployment with a custom domain still answers on the CloudFront domain
    // and on every alias, so this is reachable in normal operation.
    vi.stubEnv('VITE_APP_ORIGIN', 'https://aidlc.example.com');
    expect(isNonCanonicalOrigin()).toBe(true);
  });

  it('reports no mismatch when browsing the canonical hostname', () => {
    vi.stubEnv('VITE_APP_ORIGIN', window.location.origin);
    expect(isNonCanonicalOrigin()).toBe(false);
  });

  it('reports no mismatch when no canonical origin is configured', () => {
    vi.stubEnv('VITE_APP_ORIGIN', '');
    expect(isNonCanonicalOrigin()).toBe(false);
  });
});
