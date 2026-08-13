import { describe, expect, it } from 'vitest';
import { buildIntentUrl } from '../intent-url.js';

describe('buildIntentUrl', () => {
  it('trims trailing slashes and encodes route identifiers', () => {
    expect(
      buildIntentUrl({
        applicationUrl: 'https://aidlc.example///',
        projectId: 'project/one',
        intentId: 'intent two',
      }),
    ).toBe('https://aidlc.example/space/project%2Fone/intent/intent%20two');
  });
});
