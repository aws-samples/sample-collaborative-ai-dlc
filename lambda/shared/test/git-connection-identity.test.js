import { describe, expect, it } from 'vitest';
import {
  gitConnectionIdentity,
  isGitConnectionCreatedAt,
  isGitConnectionIdentity,
} from '../git-connection-identity.js';

const connection = {
  provider: 'github',
  userId: 'u1',
  parameterName: '/test/dev/git-token/u1/github',
  createdAt: '2026-09-18T08:00:00.000Z',
};

describe('git connection identity', () => {
  it('has a stable legacy fingerprint independent of object order and mutable metadata', () => {
    const expected = 'f6aaed1e3c821ce98404762c7675688701e1b1a08c639051c8fdfbb3bd0e0cda';
    expect(gitConnectionIdentity(Object.freeze({ ...connection }))).toBe(expected);
    expect(
      gitConnectionIdentity({
        createdAt: connection.createdAt,
        parameterName: connection.parameterName,
        userId: connection.userId,
        provider: connection.provider,
        providerInstance: 'github#public',
        generation: null,
        scope: 'repo',
        token: 'ignored-secret',
        lastRefreshedAt: '2026-09-18T09:00:00.000Z',
      }),
    ).toBe(expected);
    expect(isGitConnectionIdentity(expected)).toBe(true);
    expect(expected).not.toContain(connection.parameterName);
  });

  it.each([
    { provider: 'gitlab' },
    { userId: 'u2' },
    { parameterName: '/test/dev/git-token/u1/github-new' },
    { createdAt: '2026-09-18T08:00:00.001Z' },
    { generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739' },
  ])('distinguishes a different connection component: %j', (change) => {
    expect(gitConnectionIdentity({ ...connection, ...change })).not.toBe(
      gitConnectionIdentity(connection),
    );
  });

  it('distinguishes two generations even with the same creation time and parameter path', () => {
    const first = { ...connection, generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739' };
    const second = { ...connection, generation: '5c7c48ee-f9d0-46e5-b033-c66a9bf8b59d' };
    expect(gitConnectionIdentity(first)).not.toBe(gitConnectionIdentity(second));
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'supports %s legacy and generation-specific paths without exposing either',
    (provider) => {
      for (const parameterName of [
        `/test/dev/git-token/${provider}/u1`,
        `/test/dev/git-token/u1/${provider}`,
        `/test/dev/git-token/u1/${provider}-039d1c06-8e25-4a24-a31e-6bdb6b55f739`,
      ]) {
        const identity = gitConnectionIdentity({ ...connection, provider, parameterName });
        expect(isGitConnectionIdentity(identity)).toBe(true);
        expect(identity).not.toContain(parameterName);
      }
    },
  );

  it.each([
    { provider: undefined },
    { provider: 'other' },
    { userId: '' },
    { userId: 'u1\nsecret' },
    { userId: 'a'.repeat(257) },
    { parameterName: '' },
    { parameterName: 'https://user:secret@example.com/token' },
    { parameterName: '/private/token?secret' },
    { parameterName: '/private/token\n' },
    { parameterName: `/${'a'.repeat(2048)}` },
    { createdAt: undefined },
    { createdAt: '2026-09-18' },
    { createdAt: '2026-02-30T08:00:00.000Z' },
    { generation: '' },
    { generation: 1 },
    { generation: {} },
    { generation: 'a'.repeat(257) },
  ])('rejects malformed metadata without echoing it: %j', (change) => {
    expect(() => gitConnectionIdentity({ ...connection, ...change })).toThrowError(
      expect.objectContaining({
        code: 'GIT_CONNECTION_IDENTITY_INVALID',
        message: 'Invalid git connection identity metadata',
      }),
    );
  });

  it.each([undefined, null, false])('rejects a missing connection: %s', (value) => {
    expect(() => gitConnectionIdentity(value)).toThrowError(
      expect.objectContaining({ code: 'GIT_CONNECTION_IDENTITY_INVALID' }),
    );
  });

  it.each([
    undefined,
    null,
    1,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    `${'a'.repeat(64)}\n`,
    '/private/token',
  ])('rejects an invalid persisted fingerprint: %s', (value) => {
    expect(isGitConnectionIdentity(value)).toBe(false);
  });

  it('validates exact canonical audit timestamps', () => {
    expect(isGitConnectionCreatedAt(connection.createdAt)).toBe(true);
    expect(isGitConnectionCreatedAt('2026-09-18T08:00:00Z')).toBe(false);
    expect(isGitConnectionCreatedAt('2026-09-18T08:00:00.000Z\n')).toBe(false);
    expect(isGitConnectionCreatedAt('2026-02-30T00:00:00.000Z')).toBe(false);
  });
});
