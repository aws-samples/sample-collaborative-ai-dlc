import { authenticatedClis, resolveInvocationAgentAuth } from './auth-resolver.js';
import { createCredentialSession } from './credential-session.js';
import { accountCredentialInvocation, ownInvocationAccounting } from './invocation-accounting.js';

export const prepareCredentialInvocation = async ({
  payload,
  authMode,
  store,
  ddb,
  env = process.env,
  installedClis = [],
  broker,
  leaseAdapters,
}) => {
  const auth = await resolveInvocationAgentAuth({
    payload,
    authMode,
    store,
    env,
    broker,
    leaseAdapters,
  });
  const { accounting, ...context } = auth;
  let credentialSession;
  try {
    credentialSession =
      auth.credentialSession ??
      createCredentialSession({
        env: auth.env,
        credentialEnvironment: auth.credentialEnvironment,
        expiresAt: auth.expiresAt,
        authorizationExpiresAt: auth.authorizationExpiresAt,
        refresh: auth.refresh,
      });
    if (env.ENGINE_DATA_FUNCTION) {
      if (accounting) await ownInvocationAccounting({ session: credentialSession, ...accounting });
    } else {
      await accountCredentialInvocation({
        ddb,
        tableName: env.V2_PROCESS_TABLE,
        session: credentialSession,
        payload: { ...payload, projectId: auth.projectId },
        bindings: auth.bindings,
      });
    }
    return {
      ...context,
      credentialSession,
      availableClis: authenticatedClis({
        installed: installedClis,
        providers: auth.resolvedProviders,
      }),
    };
  } catch (error) {
    await credentialSession?.release();
    if (accounting) {
      try {
        await accounting.finish();
      } catch {
        /* Failed completion remains ACTIVE evidence; preserve the setup error. */
      }
    }
    throw error;
  }
};
