// Attachment limits and committed-object keys shared by the intents Lambda,
// which writes them, and the runtime and engine-data, which read them back.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB

// Builds the immutable committed object's intent-scoped key.
export const attachmentCommittedKey = (intentId, attachmentId, extension) =>
  `intent-attachments/committed/${intentId}/${attachmentId}${extension}`;
