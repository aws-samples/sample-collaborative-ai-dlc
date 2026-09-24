import { authError, normalizeConnection, connectionAudience } from './agent-auth-catalog.js';

export const authorizeConnectionChange = ({ actor, connection, sharedConsent = false }) => {
  const normalized = normalizeConnection(connection);
  const platformAdmin = actor?.platformAdmin === true;
  const spaceAdmin =
    normalized.source === 'space' && actor?.adminProjectIds?.includes(normalized.projectId);
  if (!platformAdmin && (!spaceAdmin || normalized.mechanism === 'assume-role')) {
    throw authError(
      'AGENT_AUTH_FORBIDDEN',
      'This connection change requires an authorized administrator',
    );
  }
  if (normalized.mechanism === 'oauth-user' && !sharedConsent) {
    throw authError(
      'AGENT_AUTH_SHARED_CONSENT_REQUIRED',
      'Sign-in establishes a shared space connection and delegates access to this space’s runs',
    );
  }
  return normalized;
};
export const validateOAuthCredential = ({
  connection,
  credential,
  expectedSubject = null,
  now = Date.now(),
}) => {
  const normalized = normalizeConnection(connection);
  if (!['oauth-machine', 'oauth-user'].includes(normalized.mechanism))
    throw authError(
      'AGENT_AUTH_INVALID',
      'OAuth acquisition requires an explicitly configured OAuth mechanism',
    );
  const expectedGrant =
    normalized.mechanism === 'oauth-machine' ? 'client_credentials' : 'authorization_code';
  if (
    credential?.grantType !== expectedGrant ||
    credential.issuer !== normalized.configuration.issuer ||
    credential.audience !== normalized.configuration.audience ||
    credential.clientId !== normalized.configuration.clientId ||
    typeof credential.subject !== 'string' ||
    !credential.subject ||
    (expectedSubject && credential.subject !== expectedSubject) ||
    typeof credential.accessToken !== 'string' ||
    !credential.accessToken ||
    !Number.isFinite(credential.expiresAt) ||
    credential.expiresAt <= now
  ) {
    throw authError(
      'AGENT_AUTH_IDENTITY_MISMATCH',
      'OAuth credential does not match the configured identity, audience and grant',
    );
  }
  return { ...credential, identity: connectionAudience(normalized), connectionId: normalized.id };
};

// Broker-only orchestration. stateRepository supplies durable CAS leases;
// secretRepository writes immutable encrypted secrets, then CAS promotes a
// reference. No refresh/access token is persisted in a control record.
export const createOAuthCredentialCoordinator = ({
  stateRepository,
  secretRepository,
  acquire,
  ownerId,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  leaseMs = 30_000,
  maxWaitMs = 35_000,
}) => ({
  async credential(connection) {
    const normalized = normalizeConnection(connection);
    const deadline = now() + maxWaitMs;
    while (now() < deadline) {
      const state = await stateRepository.read(normalized.id);
      if (
        !state ||
        state.identity !== connectionAudience(normalized) ||
        ['revoked', 'reconnect-required'].includes(state.status)
      ) {
        throw authError('AGENT_AUTH_RECONNECT_REQUIRED', 'Reconnect the shared OAuth connection');
      }
      if (state.credentialExpiresAt > now() + 60_000) {
        const credential = await secretRepository.read(state.secretReference);
        return validateOAuthCredential({
          connection: normalized,
          credential,
          expectedSubject: state.subject,
          now: now(),
        });
      }
      if (state.owner) {
        if (state.leaseUntil <= now()) {
          // A broker may have consumed a rotating refresh token before crashing.
          // Reusing it could revoke the family; require an explicit reconnect.
          await stateRepository.invalidate(normalized.id, state.version, 'reconnect-required');
          throw authError(
            'AGENT_AUTH_RECONNECT_REQUIRED',
            'OAuth refresh outcome is unknown; reconnect the shared connection',
          );
        }
        await wait(50);
        continue;
      }
      const claimed = await stateRepository.claim(
        normalized.id,
        state.version,
        ownerId,
        now() + leaseMs,
      );
      if (!claimed) continue;
      let reference = null;
      let refreshTimer;
      try {
        const previous = await secretRepository.read(state.secretReference);
        const controller = new AbortController();
        const timeout = new Promise((_, reject) => {
          refreshTimer = setTimeout(() => {
            controller.abort();
            reject(
              authError(
                'AGENT_AUTH_RECONNECT_REQUIRED',
                'OAuth refresh timed out; reconnect the shared connection',
              ),
            );
          }, leaseMs);
          refreshTimer.unref?.();
        });
        const next = validateOAuthCredential({
          connection: normalized,
          credential: await Promise.race([
            acquire({ connection: normalized, previous, signal: controller.signal }),
            timeout,
          ]),
          expectedSubject: state.subject,
          now: now(),
        });
        reference = await secretRepository.writeImmutable(normalized.id, next);
        const committed = await stateRepository.commit(normalized.id, {
          expectedVersion: state.version,
          ownerId,
          now: now(),
          secretReference: reference,
          credentialExpiresAt: next.expiresAt,
          subject: next.subject,
          identity: next.identity,
        });
        if (!committed)
          throw authError('AGENT_AUTH_REFRESH_CONFLICT', 'OAuth connection changed during refresh');
        return next;
      } catch (error) {
        if (reference) await secretRepository.remove(reference).catch(() => {});
        await stateRepository.invalidate(
          normalized.id,
          state.version,
          'reconnect-required',
          ownerId,
        );
        throw error;
      } finally {
        if (refreshTimer) clearTimeout(refreshTimer);
      }
    }
    throw authError(
      'AGENT_AUTH_REFRESH_BUSY',
      'Another broker is refreshing this shared connection',
    );
  },
});
