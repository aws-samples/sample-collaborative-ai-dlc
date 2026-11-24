import { describe, expect, it } from 'vitest';
import { ecrImageConsoleUrl, scanFindingsNote } from './ecrConsole';

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

describe('scanFindingsNote', () => {
  it('warns that the counts of an incomplete scan are partial', () => {
    expect(scanFindingsNote({ incomplete: true, findingsTruncated: true })).toMatch(
      /counts are partial.*may include Critical or High/,
    );
  });

  it('says only the most severe findings are listed when the list is cut', () => {
    expect(scanFindingsNote({ findingsTruncated: true, findings: [{}, {}] })).toBe(
      'Showing the 2 most severe findings. The complete list is in ECR.',
    );
  });

  it('says nothing about a complete list', () => {
    expect(scanFindingsNote({ findingsTruncated: false, findings: [{}] })).toBeNull();
    expect(scanFindingsNote(null)).toBeNull();
  });
});
