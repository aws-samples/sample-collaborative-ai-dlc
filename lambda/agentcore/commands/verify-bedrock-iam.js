import { listIamBedrockModels } from '../bedrock-iam.js';

const credentialFailures = new Map([
  [
    'BEDROCK_IAM_ACCESS_DENIED',
    'AWS denied the credential broker access to the inference role. Check that the role trusts this application’s credential broker, the broker can assume the role, and the ExternalId matches.',
  ],
  [
    'AGENT_CREDENTIAL_GRANT_EXPIRED',
    'The authorization for this IAM check expired. Run Test connection again.',
  ],
  [
    'AGENT_CREDENTIAL_GRANT_INVALID',
    'The runtime rejected the authorization for this IAM check. Check that the application and runtime use the same credential broker configuration.',
  ],
  [
    'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
    'The credential grant signing configuration is missing. Check the application and credential broker deployment.',
  ],
  [
    'CREDENTIAL_BROKER_NOT_CONFIGURED',
    'The runtime has no credential broker configured. Check the runtime deployment.',
  ],
]);

// These messages cross the runtime HTTP boundary. Never expose provider error
// text, signed grants, or credential values in a verification response.
export const iamVerificationFailure = (error) => ({
  verified: false,
  code: credentialFailures.has(error?.code) ? error.code : 'BEDROCK_IAM_VERIFICATION_FAILED',
  error:
    credentialFailures.get(error?.code) ||
    'The runtime could not prepare inference credentials for this IAM check. Check the credential broker configuration and runtime logs.',
});

export const verifyBedrockIam = async (
  payload,
  { env = {}, listModels = listIamBedrockModels } = {},
) => {
  if (env.BEDROCK_AUTH_MODE !== 'iam') return iamVerificationFailure();
  try {
    const models = await listModels(env);
    return { verified: true, models, region: env.BEDROCK_REGION };
  } catch (error) {
    const denied = ['AccessDenied', 'AccessDeniedException'].includes(error?.name);
    return {
      verified: false,
      code: denied ? 'BEDROCK_IAM_DISCOVERY_DENIED' : 'BEDROCK_IAM_DISCOVERY_FAILED',
      error: denied
        ? 'The inference role was assumed, but AWS denied Bedrock model discovery. Check the role’s Bedrock ListInferenceProfiles and ListFoundationModels permissions.'
        : 'The inference role was assumed, but Bedrock model discovery failed. Check the selected region and the runtime’s access to the Bedrock endpoint, then retry.',
    };
  }
};
