import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invokeCredentialBroker } from './clients.js';

const ASKPASS_BODY = `#!/bin/sh
case "$1" in
  *Username*) printf '%s' "$AIDLC_GIT_USERNAME" ;;
  *) printf '%s' "$AIDLC_GIT_PASSWORD" ;;
esac
`;

const request = async (
  { executionId, projectId, provider, repository, requiredAccess },
  broker = invokeCredentialBroker,
) => {
  if (!executionId || !projectId || !provider || !repository) {
    throw Object.assign(new Error('Git credential context is incomplete'), {
      code: 'INVALID_CREDENTIAL_CONTEXT',
    });
  }
  return broker({ executionId, projectId, provider, repository, requiredAccess });
};

export const resolveGitCommitter = async (context, { broker = invokeCredentialBroker } = {}) => {
  const result = await request({ ...context, requiredAccess: 'identity' }, broker);
  return result.committer ?? null;
};

// Keep the credential in one child-process environment only. The helper has no
// embedded secret, the remote remains clean, and both helper and env object are
// destroyed before this function resolves.
export const withGitCredential = async (
  context,
  operation,
  {
    broker = invokeCredentialBroker,
    fsOps = { chmod, mkdtemp, rm, writeFile },
    tempRoot = tmpdir(),
  } = {},
) => {
  const credential = await request(
    { ...context, requiredAccess: context.requiredAccess || 'write' },
    broker,
  );
  if (!credential.username || !credential.password) {
    throw Object.assign(new Error('Credential broker returned an incomplete credential'), {
      code: 'CREDENTIAL_BROKER_FAILED',
    });
  }

  const dir = await fsOps.mkdtemp(path.join(tempRoot, 'aidlc-askpass-'));
  const helper = path.join(dir, 'askpass.sh');
  const env = {
    GIT_ASKPASS: helper,
    GIT_TERMINAL_PROMPT: '0',
    AIDLC_GIT_USERNAME: credential.username,
    AIDLC_GIT_PASSWORD: credential.password,
  };
  try {
    await fsOps.writeFile(helper, ASKPASS_BODY, { encoding: 'utf8', mode: 0o700 });
    await fsOps.chmod(helper, 0o700);
    return await operation({ env, committer: credential.committer ?? null });
  } finally {
    env.AIDLC_GIT_USERNAME = '';
    env.AIDLC_GIT_PASSWORD = '';
    for (const key of Object.keys(env)) delete env[key];
    await fsOps.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

export { ASKPASS_BODY };
