import { describe, expect, it } from 'vitest';

import {
  assertUniqueCheckoutPaths,
  findCheckoutPathCollision,
  isValidRepoPath,
  repoCheckoutPath,
} from '../repo-validation.js';

const ARN = 'arn:aws:codecommit:eu-west-1:123456789012:my-service';

describe('repoCheckoutPath', () => {
  it('keeps the whole CodeCommit identity under a provider namespace', () => {
    expect(repoCheckoutPath(ARN)).toBe('codecommit/aws/eu-west-1/123456789012/my-service');
    expect(repoCheckoutPath('arn:aws-cn:codecommit:cn-north-1:123456789012:svc.api')).toBe(
      'codecommit/aws-cn/cn-north-1/123456789012/svc.api',
    );
  });
  it('leaves path ids untouched', () => {
    expect(repoCheckoutPath('octo/hello')).toBe('octo/hello');
    expect(repoCheckoutPath('group/sub/project')).toBe('group/sub/project');
    expect(repoCheckoutPath(null)).toBeNull();
  });
  it('gives same-name repositories in different regions different directories', () => {
    const west1 = 'arn:aws:codecommit:eu-west-1:123456789012:app';
    const west2 = 'arn:aws:codecommit:eu-west-2:123456789012:app';
    expect(repoCheckoutPath(west1)).not.toBe(repoCheckoutPath(west2));
    expect(findCheckoutPathCollision([west1, west2])).toBeNull();
  });
});

describe('checkout path collisions', () => {
  it('detects distinct repositories that share or nest a directory', () => {
    expect(findCheckoutPathCollision(['codecommit/aws', ARN])).toEqual({
      first: 'codecommit/aws',
      second: ARN,
    });
    expect(findCheckoutPathCollision(['team/app', 'team/app/sub'])).toEqual({
      first: 'team/app',
      second: 'team/app/sub',
    });
    expect(findCheckoutPathCollision(['octo/hello', 'octo/world', ARN])).toBeNull();
  });
  it('does not treat the same repository listed twice as a collision', () => {
    expect(findCheckoutPathCollision([ARN, ARN])).toBeNull();
  });
  it('throws a typed error for a colliding batch', () => {
    expect(() => assertUniqueCheckoutPaths(['codecommit/aws/eu-west-1', ARN])).toThrow(
      expect.objectContaining({ code: 'REPOSITORY_PATH_COLLISION' }),
    );
    expect(() => assertUniqueCheckoutPaths(['octo/hello', ARN])).not.toThrow();
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
