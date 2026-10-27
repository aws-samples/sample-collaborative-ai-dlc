import { STSClient } from '@aws-sdk/client-sts';
import { assumeInferenceRole } from './bedrock-iam.js';

// Preserve the audience and lifetime so renewal tokens already in flight keep verifying.
// The host signs them; the eight-hour ceiling is fixed at handoff and never slides.
export const BEDROCK_IAM_RENEWAL = Object.freeze({
  action: 'renew-bedrock-credentials',
  audience: 'aidlc-bedrock-credential-renewal-v2',
  ttlSeconds: 8 * 60 * 60,
});

export const BEDROCK_IAM_BROKER_PROVIDER = Object.freeze({
  id: 'bedrock-iam',
  adapters: {
    // `connection` is the stored row, or the signed binding when verifying an unsaved role.
    'bedrock:assume-role': async ({ connection, claims, deps }) => {
      const credentials = await assumeInferenceRole(claims, connection, deps.stsClient);
      return {
        material: { type: 'bedrock-iam', credentials },
        expiresAt: Date.parse(credentials.Expiration),
      };
    },
  },
  renewal: BEDROCK_IAM_RENEWAL,
  verification: true,
  // A broken role must not hide Kiro from model discovery.
  isolateCapabilityFailures: true,
  // The runtime session treats this code as terminal instead of retrying the refresh.
  errorCodes: ['BEDROCK_IAM_ACCESS_DENIED'],
  classifyError: (error) =>
    ['AccessDenied', 'AccessDeniedException'].includes(error?.name)
      ? 'BEDROCK_IAM_ACCESS_DENIED'
      : null,
  createDependencies: () => ({ stsClient: new STSClient({}) }),
});
