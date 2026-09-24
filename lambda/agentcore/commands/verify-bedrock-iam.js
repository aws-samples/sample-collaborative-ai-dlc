import { listIamBedrockModels } from '../bedrock-iam.js';

export const verifyBedrockIam = async (
  payload,
  { env = {}, listModels = listIamBedrockModels } = {},
) => {
  try {
    if (env.BEDROCK_AUTH_MODE !== 'iam')
      throw new Error(
        'The credential broker could not obtain inference credentials. Check the inference role trust policy, the broker AssumeRole permission, and the external ID, then retry.',
      );
    const models = await listModels(env);
    return { verified: true, models, region: env.BEDROCK_REGION };
  } catch {
    return {
      verified: false,
      error:
        'Unable to assume the inference role and list Bedrock models. Check trust, broker permission, ExternalId and region.',
    };
  }
};
