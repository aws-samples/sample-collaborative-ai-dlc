import { describe, expect, it } from 'vitest';

import {
  PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS,
  assertPrStrategySupported,
  draftlessProviders,
} from '../pr-strategy.js';
import { getCapabilities } from '../git-providers.js';

describe('PR strategy provider support', () => {
  it('matches the providers that declare no draft pull requests', () => {
    const declared = ['github', 'gitlab', 'bitbucket', 'codecommit'].filter(
      (provider) => getCapabilities(provider).draftPullRequests === false,
    );
    expect([...PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS].toSorted()).toEqual(declared.toSorted());
  });

  it('refuses pr-per-unit when any repository provider lacks drafts', () => {
    expect(() => assertPrStrategySupported('pr-per-unit', ['github', 'codecommit'])).toThrow(
      expect.objectContaining({
        code: 'PR_STRATEGY_UNSUPPORTED',
        status: 409,
        providers: ['codecommit'],
      }),
    );
  });

  it('accepts intent-pr everywhere and pr-per-unit on draft-capable providers', () => {
    expect(() => assertPrStrategySupported('intent-pr', ['codecommit'])).not.toThrow();
    expect(() =>
      assertPrStrategySupported('pr-per-unit', ['github', 'gitlab', 'bitbucket']),
    ).not.toThrow();
    expect(draftlessProviders(['codecommit', 'codecommit', 'github'])).toEqual(['codecommit']);
  });
});
