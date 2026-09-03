// Metadata-only agent credential broker.
//
// This Lambda shares the dedicated credential-broker execution role, which is
// the only IAM principal allowed to read agent credential SecureStrings. Unlike
// the AgentCore redemption broker, this function has no value-returning action:
// trusted API Lambdas can ask only for set-state or effective source bindings.

import { SSMClient } from '@aws-sdk/client-ssm';
import {
  AGENT_CREDENTIAL_METADATA_ACTIONS,
  readCredentialScopeStatus,
  resolveEffectiveCredentialBindings,
} from '../shared/agent-credentials.js';

const ssm = new SSMClient({});

export const inspectAgentCredentialMetadata = async (
  event = {},
  { ssmClient = ssm, env = process.env } = {},
) => {
  const base = env.AGENT_SETTINGS_SSM_PREFIX || '';
  switch (event.action) {
    case AGENT_CREDENTIAL_METADATA_ACTIONS.READ_SCOPE_STATUS:
      return {
        status: await readCredentialScopeStatus(ssmClient, {
          base,
          source: event.source,
          projectId: event.projectId ?? null,
          userId: event.userId ?? null,
        }),
      };
    case AGENT_CREDENTIAL_METADATA_ACTIONS.RESOLVE_EFFECTIVE_BINDINGS:
      return {
        bindings: await resolveEffectiveCredentialBindings(ssmClient, {
          base,
          projectId: event.projectId,
          userId: event.userId,
        }),
      };
    default:
      throw Object.assign(new Error('Unsupported agent credential metadata action'), {
        code: 'INVALID_REQUEST',
      });
  }
};

export const handler = async (event) => {
  try {
    return { ok: true, ...(await inspectAgentCredentialMetadata(event)) };
  } catch (error) {
    const code =
      error?.code === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'CREDENTIAL_METADATA_FAILED';
    console.error('[credential-metadata] request denied', {
      code,
      action: event?.action || null,
      source: event?.source || null,
      projectId: event?.projectId || null,
    });
    return { ok: false, code };
  }
};
