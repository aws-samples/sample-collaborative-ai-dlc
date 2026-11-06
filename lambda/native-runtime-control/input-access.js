import { InvokeCommand } from '@aws-sdk/client-lambda';
import { inputFailure } from '../shared/native-inputs.js';

export const invokeNativeInputOwner = async (client, functionName, payload) => {
  if (!functionName) throw inputFailure('UNAVAILABLE');
  const result = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  if (result.FunctionError || !result.Payload || result.Payload.length > 6 * 1024 * 1024)
    throw inputFailure('UNAVAILABLE');
  return JSON.parse(Buffer.from(result.Payload).toString('utf8'));
};

// Check the captured delegation and issue, without refreshing imported bytes.
// Replies continue to use the original starter's admitted input access.
export const verifyNativeInputAccess = async ({ inputs, projectId, userId, invokeTracker }) => {
  const sources = new Map(
    [inputs.source, ...inputs.attachments.map((file) => file.source)]
      .filter(Boolean)
      .map((source) => [JSON.stringify([source.bindingFingerprint, source.resourceId]), source]),
  );
  for (const source of sources.values()) {
    const checked = await invokeTracker({
      action: 'native-issue-check',
      projectId,
      userId,
      bindingId: source.bindingId,
      resourceId: source.resourceId,
      bindingFingerprint: source.bindingFingerprint,
    });
    if (!checked.ok || checked.bindingFingerprint !== source.bindingFingerprint)
      throw inputFailure('ACCESS');
  }
};
