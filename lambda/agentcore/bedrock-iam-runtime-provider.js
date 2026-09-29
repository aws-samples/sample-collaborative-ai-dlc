import { IAM_MATERIAL_ADAPTER } from './bedrock-iam-material.js';
import { listIamBedrockModels } from './bedrock-iam.js';

// The host dispatches here only after this invocation prepared an IAM lease for the signed
// binding, so discovery runs with the role's session credentials and its region.
const verifyBedrockIam = async ({ env }) => {
  try {
    const models = await listIamBedrockModels(env);
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

export const BEDROCK_IAM_RUNTIME_PROVIDER = Object.freeze({
  id: 'bedrock-iam',
  modes: ['iam'],
  materials: { 'bedrock-iam': IAM_MATERIAL_ADAPTER },
  // Drivers prefer BEDROCK_REGION over AWS_REGION, so only this adapter may set it.
  controlledEnv: ['BEDROCK_REGION'],
  // A failed discovery reports no models instead of failing the probe; Kiro stays independent.
  capabilities: async ({ env }) => ({
    bedrockModels: await listIamBedrockModels(env).catch(() => []),
  }),
  verify: verifyBedrockIam,
  verificationFailures: {
    BEDROCK_IAM_ACCESS_DENIED:
      'AWS denied the credential broker access to the inference role. Check that the role trusts this application’s credential broker, the broker can assume the role, and the ExternalId matches.',
  },
});
