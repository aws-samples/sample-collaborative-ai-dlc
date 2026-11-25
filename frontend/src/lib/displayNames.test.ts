import { describe, expect, it } from 'vitest';
import { displayProvider } from './displayNames';

describe('displayProvider', () => {
  it.each([
    ['codecommit', 'AWS CodeCommit'],
    ['GitHub', 'GitHub'],
    ['azure-devops', 'Azure Devops'],
  ])('provider %s → %s', (slug, expected) => {
    expect(displayProvider(slug)).toBe(expected);
  });
});
