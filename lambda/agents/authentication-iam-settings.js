import { generateBedrockIamSetup, normalizeBedrockIam } from '../shared/bedrock-iam.js';

// Bedrock IAM setup steps. The route, admin check, space runtime and the verification probe,
// grant and invoke are foundation-owned; this module only shapes IAM input and documents.
export const BEDROCK_IAM_SETTINGS = Object.freeze({
  mode: 'iam',
  draft: Object.freeze({ mechanism: 'assume-role', prepare: normalizeBedrockIam }),
  actions: Object.freeze({
    defaults: async (_input, ctx) => ({
      statusCode: 200,
      body: {
        brokerRoleArn: ctx.env.CREDENTIAL_BROKER_ROLE_ARN || '',
        region: ctx.env.AWS_REGION || 'us-east-1',
      },
    }),
    setup: async (input, ctx) => ({
      statusCode: 200,
      body: generateBedrockIamSetup({
        brokerRoleArn: ctx.env.CREDENTIAL_BROKER_ROLE_ARN,
        config: input.config,
      }),
    }),
    // Invalid input is refused here, before any runtime call.
    verify: async (input, ctx) =>
      ctx.verifyConnection({
        mechanism: 'assume-role',
        configuration: normalizeBedrockIam(input.config),
      }),
  }),
});
