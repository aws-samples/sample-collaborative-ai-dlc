import { describe, expect, it } from 'vitest';
import { isUntitledIntent } from './intentGrouping';

describe('isUntitledIntent', () => {
  it('treats empty and placeholder titles as untitled', () => {
    expect(isUntitledIntent(null)).toBe(true);
    expect(isUntitledIntent('   ')).toBe(true);
    expect(isUntitledIntent('Title')).toBe(true);
    expect(isUntitledIntent('I want to do XYZ')).toBe(true);
    expect(isUntitledIntent('Add a low-stock badge')).toBe(false);
  });
});
