// Metadata-only agent credential broker.
//
// This Lambda shares the dedicated credential-broker execution role, which is
// the only IAM principal allowed to read agent credential SecureStrings. Unlike
// the AgentCore redemption broker, this function has no value-returning action:
// trusted API Lambdas can ask only for set-state or effective source bindings.

import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import {
  AGENT_CREDENTIAL_METADATA_ACTIONS,
  readCredentialScopeStatus,
  resolveEffectiveCredentialState,
} from '../shared/agent-credentials.js';
import { parseAssumableRoleArns, preflightBedrockRoleBinding } from '../shared/bedrock-role.js';

const ssm = new SSMClient({});
const sts = new STSClient({});

export const inspectAgentCredentialMetadata = async (
  event = {},
  { ssmClient = ssm, stsClient = sts, env = process.env } = {},
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
      // Returns the effective binding per provider plus secret-free descriptive
      // metadata: kind, binding scope, override reason, and whether a stored key
      // is inactive. No value, role ARN, or external ID crosses this boundary.
      return await resolveEffectiveCredentialState(ssmClient, {
        base,
        projectId: event.projectId,
        userId: event.userId,
      });
    // specs/bedrock-iam-role-credential-mode: req-binding-preflight.
    //
    // A bare AssumeRole with NO model invocation, so a wrong trust policy becomes
    // an input-validation error at save time instead of a mid-stage failure. It
    // lives here because this function shares the credential-broker execution
    // role, the only principal holding sts:AssumeRole for customer Bedrock roles —
    // so the settings API gains no STS permission and the number of principals
    // able to assume a customer role stays at one.
    //
    // The role ARN comes from the REQUEST rather than SSM, because the point is to
    // check a binding before it is persisted. That is safe precisely because the
    // broker's own IAM policy bounds which ARNs it can assume at all, and the
    // action returns no credentials — only a verdict.
    case AGENT_CREDENTIAL_METADATA_ACTIONS.PREFLIGHT_BEDROCK_ROLE: {
      const preflight = await preflightBedrockRoleBinding(
        {
          roleArn: event.roleArn,
          externalId: event.externalId ?? null,
          projectId: event.projectId ?? null,
          assumableRoleArns: parseAssumableRoleArns(env.BEDROCK_ASSUMABLE_ROLE_ARNS),
          brokerRoleArn: env.CREDENTIAL_BROKER_ROLE_ARN || null,
          platformAccountId: env.PLATFORM_ACCOUNT_ID || null,
          // Pass the raw value across this boundary. The shared preflight helper
          // validates the mandatory ceiling and converts configuration failures
          // into an available negative verdict, so save-time callers fail closed
          // instead of mistaking a thrown parser error for a broker outage.
          sessionPolicy: env.BEDROCK_SESSION_POLICY,
        },
        stsClient,
      );
      return { preflight };
    }
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
