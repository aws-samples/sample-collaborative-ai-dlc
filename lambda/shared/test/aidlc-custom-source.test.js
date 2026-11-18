// The identity rules for a custom AI-DLC fork. The property under test: the
// grammar is strict enough that a validated slug can be pasted straight into a
// URL path and an S3 key prefix without any further escaping.

import { describe, expect, it } from 'vitest';
import {
  CustomSourceError,
  assertGithubOwner,
  assertGithubRepo,
  isGithubOwner,
  isGithubRepo,
  parseRepositorySlug,
} from '../aidlc-custom-source.js';

describe('isGithubOwner', () => {
  it('accepts real GitHub logins', () => {
    for (const owner of ['awslabs', 'a', 'a-b', 'Acme-Corp', 'user123', 'a'.repeat(39)]) {
      expect(isGithubOwner(owner)).toBe(true);
    }
  });

  it('rejects anything that could escape a URL or key segment', () => {
    for (const owner of [
      '',
      '.',
      '..',
      '-lead',
      'trail-',
      'a--b',
      'has space',
      'has/slash',
      'has.dot',
      'has_underscore',
      'a'.repeat(40),
      null,
      undefined,
      42,
    ]) {
      expect(isGithubOwner(owner)).toBe(false);
    }
  });
});

describe('isGithubRepo', () => {
  it('accepts real repository names', () => {
    for (const repo of [
      'aidlc-workflows',
      'x',
      'dot.name',
      'under_score',
      '.hidden',
      'a'.repeat(100),
    ]) {
      expect(isGithubRepo(repo)).toBe(true);
    }
  });

  it('rejects traversal segments and anything non-canonical', () => {
    for (const repo of [
      '',
      '.',
      '..',
      'a..b',
      '../escape',
      'has space',
      'has/slash',
      'a'.repeat(101),
      null,
      undefined,
    ]) {
      expect(isGithubRepo(repo)).toBe(false);
    }
  });
});

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

describe('assertGithubOwner / assertGithubRepo', () => {
  it('throws a typed error naming the offending half', () => {
    expect(() => assertGithubOwner('bad owner')).toThrow(CustomSourceError);
    expect(codeOf(() => assertGithubOwner('bad owner'))).toBe('custom_source_owner_invalid');
    expect(codeOf(() => assertGithubRepo('..'))).toBe('custom_source_repo_invalid');
  });

  it('returns the value unchanged when valid', () => {
    expect(assertGithubOwner('awslabs')).toBe('awslabs');
    expect(assertGithubRepo('aidlc-workflows')).toBe('aidlc-workflows');
  });
});

describe('parseRepositorySlug', () => {
  it('splits and normalizes a valid owner/name slug', () => {
    expect(parseRepositorySlug('  acme/fork  ')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'fork',
      repository: 'acme/fork',
      keySegments: ['acme', 'fork'],
    });
  });

  it('requires exactly one slash', () => {
    for (const value of ['acme', 'acme/fork/extra', '/fork', 'acme/', '', null]) {
      expect(() => parseRepositorySlug(value)).toThrow(CustomSourceError);
    }
    expect(codeOf(() => parseRepositorySlug('acme'))).toBe('custom_source_repository_invalid');
    expect(codeOf(() => parseRepositorySlug('/fork'))).toBe('custom_source_owner_invalid');
    expect(codeOf(() => parseRepositorySlug('acme/'))).toBe('custom_source_repo_invalid');
  });

  it('rejects a traversal attempt in either half', () => {
    expect(() => parseRepositorySlug('../etc')).toThrow(CustomSourceError);
    expect(() => parseRepositorySlug('acme/..')).toThrow(CustomSourceError);
    expect(() => parseRepositorySlug('acme/a..b')).toThrow(CustomSourceError);
  });
});

// GitLab custom sources: `gitlab:<namespace>/<project>`, nested groups allowed.
// The project path is percent-encoded into ONE key segment, so it can neither
// traverse nor collide with a GitHub `owner/name` prefix.
describe('parseRepositorySlug for GitLab sources', () => {
  it('parses a nested GitLab project path', () => {
    expect(parseRepositorySlug('  gitlab:acme/platform/aidlc-fork ')).toEqual({
      provider: 'gitlab',
      path: 'acme/platform/aidlc-fork',
      repository: 'gitlab:acme/platform/aidlc-fork',
      keySegments: ['gitlab', 'acme%2Fplatform%2Faidlc-fork'],
    });
  });
  it('accepts GitLab path characters', () => {
    expect(parseRepositorySlug('gitlab:my_group/my.project-1').path).toBe('my_group/my.project-1');
  });
  it('rejects paths GitLab would not accept or that could escape', () => {
    for (const value of [
      'gitlab:',
      'gitlab:acme',
      'gitlab:acme/',
      'gitlab:/fork',
      'gitlab:acme//fork',
      'gitlab:acme/../fork',
      'gitlab:acme/a..b',
      'gitlab:acme/.',
      'gitlab:acme/-fork',
      'gitlab:acme/fork.',
      'gitlab:acme/fork.git',
      'gitlab:acme/fork.atom',
      'gitlab:acme/fo%2Frk',
      'gitlab:acme/fo rk',
      `gitlab:${Array.from({ length: 23 }, () => 'g').join('/')}`,
      `gitlab:acme/${'a'.repeat(260)}`,
    ]) {
      expect(() => parseRepositorySlug(value), value).toThrow(CustomSourceError);
      expect(codeOf(() => parseRepositorySlug(value))).toBe('custom_source_repository_invalid');
    }
  });
  it('never yields a key segment a GitHub repository could also produce', () => {
    const { keySegments } = parseRepositorySlug('gitlab:acme/fork');
    expect(keySegments[1]).toContain('%');
    expect(() => parseRepositorySlug(`gitlab/${keySegments[1]}`)).toThrow(CustomSourceError);
  });
});
