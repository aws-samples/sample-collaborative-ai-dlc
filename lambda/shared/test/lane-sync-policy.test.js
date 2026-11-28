import { describe, expect, it } from 'vitest';

import {
  effectiveLaneSyncPolicy,
  normalizePlatformLaneSyncPolicy,
  normalizeProjectLaneSyncPolicy,
} from '../lane-sync-policy.js';

describe('lane sync policy', () => {
  it.each([
    ['before-stage', 'before-stage'],
    ['none', 'none'],
    [undefined, 'none'],
    ['', 'none'],
    ['always', 'none'],
  ])('normalizes platform value %j to %j', (raw, expected) => {
    expect(normalizePlatformLaneSyncPolicy(raw)).toBe(expected);
  });

  it.each([
    [undefined, 'default'],
    [null, 'default'],
    ['', 'default'],
    ['default', 'default'],
    ['none', 'none'],
    ['before-stage', 'before-stage'],
    ['always', null],
  ])('normalizes project value %j to %j', (raw, expected) => {
    expect(normalizeProjectLaneSyncPolicy(raw)).toBe(expected);
  });

  it.each([
    ['before-stage', 'default', 'before-stage'],
    ['none', 'default', 'none'],
    ['before-stage', 'none', 'none'],
    ['none', 'before-stage', 'before-stage'],
    [undefined, undefined, 'none'],
    ['garbage', 'garbage', 'none'],
  ])('platform %j with project %j resolves to %j', (platform, project, expected) => {
    expect(effectiveLaneSyncPolicy(platform, project)).toBe(expected);
  });
});
