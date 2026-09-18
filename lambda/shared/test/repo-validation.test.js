import { describe, expect, it } from 'vitest';

import { isValidRepoPath, repoRelativePath } from '../repo-validation.js';

const ARN = 'arn:aws:codecommit:eu-west-1:123456789012:my-service';

describe('repoRelativePath', () => {
  it('maps a CodeCommit ARN to <account>/<name> and leaves path ids untouched', () => {
    expect(repoRelativePath(ARN)).toBe('123456789012/my-service');
    expect(repoRelativePath('arn:aws-cn:codecommit:cn-north-1:123456789012:svc.api')).toBe(
      '123456789012/svc.api',
    );
    expect(repoRelativePath('octo/hello')).toBe('octo/hello');
    expect(repoRelativePath('group/sub/project')).toBe('group/sub/project');
    expect(repoRelativePath(null)).toBeNull();
  });
});

describe('isValidRepoPath', () => {
  it('accepts owner/repo paths as before', () => {
    expect(isValidRepoPath('octo/hello')).toBe(true);
    expect(isValidRepoPath('group/sub/project')).toBe(true);
    expect(isValidRepoPath('just-a-name')).toBe(false);
    expect(isValidRepoPath('a/../b')).toBe(false);
    expect(isValidRepoPath('a/./b')).toBe(false);
  });
  it('accepts a CodeCommit repository ARN', () => {
    expect(isValidRepoPath(ARN)).toBe(true);
  });
  it('rejects ARN look-alikes that are not a CodeCommit repository', () => {
    for (const bad of [
      'arn:aws:codecommit:eu-west-1:123456789012:', // empty name
      'arn:aws:codecommit:eu-west-1:12345:name', // short account
      'arn:aws:codecommit:europe:123456789012:name', // not a region
      'arn:aws:s3:::bucket', // other service
      'arn:aws:iam::123456789012:role/x', // other service
      'arn:aws:codecommit:eu-west-1:123456789012:name/with/slash',
      'arn:aws:codecommit:eu-west-1:123456789012:name;rm', // shell char
      'arn:aws:codecommit:eu-west-1:123456789012:..', // traversal
    ]) {
      expect(isValidRepoPath(bad)).toBe(false);
    }
  });
});
