import { listIamBedrockModels } from '../bedrock-iam.js';

export const verifyBedrockIam = async (
  payload,
  { env = {}, listModels = listIamBedrockModels } = {},
) => {
  try {
    if (!env.BEDROCK_IAM_CREDENTIALS_URI)
      throw new Error(
        'The credential broker could not obtain inference credentials. Check the inference role trust policy, the broker AssumeRole permission, and the external ID, then retry.',
      );
    const models = await listModels(env);
    return { verified: true, models, region: env.BEDROCK_REGION };
  } catch (error) {
    return {
      verified: false,
      error: String(error?.message || 'Unable to assume the role and list Bedrock models').slice(
        0,
        1500,
      ),
    };
  }
};
