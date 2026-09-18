import { describe, expect, it } from 'vitest';
import {
  isGitProvider,
  isOAuthGitProvider,
  parseCodeCommitRepo,
  repoDisplayName,
  repoWebUrl,
  trackerIdForGitProvider,
} from './gitProvider';

const ARN = 'arn:aws:codecommit:eu-west-1:123456789012:widgets';

describe('provider classification', () => {
  it('knows the four providers and which ones are OAuth-connected', () => {
    expect(isGitProvider('codecommit')).toBe(true);
    expect(isGitProvider('svn')).toBe(false);
    expect(isOAuthGitProvider('github')).toBe(true);
    expect(isOAuthGitProvider('codecommit')).toBe(false);
    expect(isOAuthGitProvider('')).toBe(false);
  });
  it('maps code-host-only providers to no tracker', () => {
    expect(trackerIdForGitProvider('github')).toBe('github-issues');
    expect(trackerIdForGitProvider('codecommit')).toBeNull();
  });
});

describe('CodeCommit repository ids', () => {
  it('parses an ARN and renders a readable name', () => {
    expect(parseCodeCommitRepo(ARN)).toEqual({
      arn: ARN,
      partition: 'aws',
      region: 'eu-west-1',
      accountId: '123456789012',
      name: 'widgets',
    });
    expect(parseCodeCommitRepo('owner/repo')).toBeNull();
    expect(repoDisplayName('codecommit', ARN)).toBe('widgets (eu-west-1)');
    expect(repoDisplayName('github', 'owner/repo')).toBe('owner/repo');
  });
});

describe('repoWebUrl', () => {
  it('keeps the SaaS URLs unchanged, branch encoded segment by segment', () => {
    expect(repoWebUrl('github', 'owner/repo')).toBe('https://github.com/owner/repo');
    expect(repoWebUrl('github', 'owner/repo', { branch: 'feat/x y' })).toBe(
      'https://github.com/owner/repo/tree/feat/x%20y',
    );
    expect(repoWebUrl('gitlab', 'owner/repo', { branch: 'feat/x' })).toBe(
      'https://gitlab.com/owner/repo/-/tree/feat/x',
    );
    expect(repoWebUrl('bitbucket', 'ws/slug', { branch: 'main' })).toBe(
      'https://bitbucket.org/ws/slug/src/main',
    );
  });
  it('points a CodeCommit ARN at the regional console', () => {
    expect(repoWebUrl('codecommit', ARN)).toBe(
      'https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/widgets/browse?region=eu-west-1',
    );
    expect(repoWebUrl('codecommit', ARN, { branch: 'feat/x' })).toBe(
      'https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/widgets/browse/refs/heads/feat/x/--/?region=eu-west-1',
    );
    expect(repoWebUrl('codecommit', 'arn:aws-cn:codecommit:cn-north-1:123456789012:w')).toBe(
      'https://cn-north-1.console.amazonaws.cn/codesuite/codecommit/repositories/w/browse?region=cn-north-1',
    );
    expect(repoWebUrl('codecommit', 'not-an-arn')).toBeNull();
  });
});
