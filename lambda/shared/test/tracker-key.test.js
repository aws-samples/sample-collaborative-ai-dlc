import { describe, it, expect } from 'vitest';
import { trackerKey, withTrackerKeyPrefix } from '../tracker-key.js';

const jira = (resourceId, over = {}) => ({
  bindingId: 'b1',
  provider: 'jira-cloud',
  resourceType: 'issue',
  resourceId,
  ...over,
});

describe('trackerKey', () => {
  it.each([
    [jira('ABC-12'), 'ABC-12'],
    [jira('A1_B-7', { resourceType: undefined }), 'A1_B-7'],
    [jira('abc-12'), null],
    [jira('ABC-0'), null],
    [jira('ABC-12 rm -rf'), null],
    [jira('ABC-12', { resourceType: 'epic-link' }), null],
    [{ provider: 'github-issues', resourceType: 'issue', resourceId: '42' }, null],
    [null, null],
  ])('%j gives %s', (source, key) => {
    expect(trackerKey(source)).toBe(key);
  });
});

describe('withTrackerKeyPrefix', () => {
  it.each([
    ['Fix invoice rounding', jira('ABC-12'), '[ABC-12] Fix invoice rounding'],
    ['[ABC-12] Fix invoice rounding', jira('ABC-12'), '[ABC-12] Fix invoice rounding'],
    ['Fix invoice rounding', null, 'Fix invoice rounding'],
    [
      'Fix invoice rounding',
      { provider: 'gitlab-issues', resourceId: '9' },
      'Fix invoice rounding',
    ],
  ])('%s with %j is %s', (title, source, expected) => {
    expect(withTrackerKeyPrefix(title, source)).toBe(expected);
  });
});
