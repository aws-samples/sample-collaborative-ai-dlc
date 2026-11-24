import { describe, expect, it } from 'vitest';
import { ecrImageConsoleUrl, httpsHref, scanFindingsNote } from './ecrConsole';

const digest = `sha256:${'a'.repeat(64)}`;

describe('ecrImageConsoleUrl', () => {
  it('links to the image in its repository and region', () => {
    expect(
      ecrImageConsoleUrl('111111111111.dkr.ecr.eu-west-1.amazonaws.com/team/core:latest', digest),
    ).toBe(
      `https://eu-west-1.console.aws.amazon.com/ecr/repositories/private/111111111111/team/core/_/image/sha256%3A${'a'.repeat(64)}/details?region=eu-west-1`,
    );
  });

  it('returns null without a private ECR image or a digest', () => {
    expect(ecrImageConsoleUrl('public.ecr.aws/team/core', digest)).toBeNull();
    expect(ecrImageConsoleUrl(null, digest)).toBeNull();
    expect(
      ecrImageConsoleUrl('111111111111.dkr.ecr.eu-west-1.amazonaws.com/core', null),
    ).toBeNull();
  });
});

describe('httpsHref', () => {
  it('keeps only https links', () => {
    expect(httpsHref('https://nvd.nist.gov/vuln/detail/CVE-1')).toBe(
      'https://nvd.nist.gov/vuln/detail/CVE-1',
    );
    for (const value of ['javascript:alert(1)', 'http://example.test', 'relative/path', '', null])
      expect(httpsHref(value)).toBeNull();
  });
});

describe('scanFindingsNote', () => {
  it('warns that the counts of an incomplete scan are partial', () => {
    expect(scanFindingsNote({ incomplete: true, findingsTruncated: true })).toMatch(
      /counts are partial.*may include Critical or High.*before accepting them/,
    );
    // After acceptance the note records the decision instead of asking for it.
    const accepted = scanFindingsNote({ incomplete: true, findingsTruncated: true }, true);
    expect(accepted).toMatch(/counts are partial.*accepted them without a complete count/);
    expect(accepted).not.toMatch(/before accepting/);
  });

  it('says the list is cut when it does not hold every finding', () => {
    expect(scanFindingsNote({ findingsTruncated: true, findings: [{}, {}] })).toBe(
      'This list may not hold every finding. The complete list is in ECR.',
    );
  });

  it('says nothing about a complete list', () => {
    expect(scanFindingsNote({ findingsTruncated: false, findings: [{}] })).toBeNull();
    expect(scanFindingsNote(null)).toBeNull();
  });
});
