import { createHash } from 'node:crypto';
import { KEY_PROVIDERS } from './agent-auth-providers.js';
import { authError, assertIdentifier, assertSource } from './agent-auth-contracts.js';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const credentialUpdateCandidate = ({ source, projectId, userId, update }) => {
  assertSource(source);
  const changes = Object.entries(KEY_PROVIDERS)
    .filter(([, descriptor]) => typeof update?.[descriptor.inputField] === 'string')
    .map(([provider, descriptor]) => {
      const value = update[descriptor.inputField].trim();
      if (Buffer.byteLength(value, 'utf8') > 4096)
        throw authError(
          'AGENT_AUTH_INVALID',
          'API keys must fit in a standard encrypted parameter (4096 bytes)',
        );
      return { provider, action: value ? 'rotate' : 'clear', digest: hash(value) };
    });
  if (!changes.length) throw authError('AGENT_AUTH_INVALID', 'No credential changes supplied');
  return {
    kind: 'credential-update',
    source,
    changes,
    ...(source === 'space' ? { projectId: assertIdentifier(projectId, 'projectId') } : {}),
    ...(source === 'user' ? { userId: assertIdentifier(userId, 'userId') } : {}),
  };
};
