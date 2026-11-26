import { createHash } from 'node:crypto';

const boundedString = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');

export const isGitConnectionCreatedAt = (value) => {
  if (!boundedString(value, 32) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
};

export const isGitConnectionIdentity = (value) =>
  typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

// This fingerprint identifies a connection incarnation; it is not a credential
// or an attestation. Callers still need an authoritative current connection read.
// Legacy rows have no generation. Keep their existing path and creation time
// exact, so migrating metadata or refreshing tokens does not change identity.
export const gitConnectionIdentity = (connection) => {
  if (
    !['github', 'gitlab', 'bitbucket'].includes(connection?.provider) ||
    !boundedString(connection.userId, 256) ||
    !boundedString(connection.parameterName, 2048) ||
    !/^\/[A-Za-z0-9_./-]+$/.test(connection.parameterName) ||
    !isGitConnectionCreatedAt(connection.createdAt) ||
    (connection.generation != null && !boundedString(connection.generation, 256))
  ) {
    throw Object.assign(new Error('Invalid git connection identity metadata'), {
      code: 'GIT_CONNECTION_IDENTITY_INVALID',
    });
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        'git-connection-identity-v1',
        connection.provider,
        connection.userId,
        connection.parameterName,
        connection.createdAt,
        connection.generation ?? null,
      ]),
    )
    .digest('hex');
};
