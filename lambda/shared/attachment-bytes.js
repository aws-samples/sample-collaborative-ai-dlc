import { createHash } from 'node:crypto';
const MAX_BYTES = 5 * 1024 * 1024;
// Both promotion and materialization verify the complete stream, including
// unknown/chunked lengths. Never truncate a required input.
export const readAttachmentBytes = async (body, { size, sha256 } = {}) => {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BYTES || (size !== undefined && length > size))
        throw new Error('Attachment exceeds its declared size');
      chunks.push(bytes);
    }
  } finally {
    body?.destroy?.();
  }
  const bytes = Buffer.concat(chunks, length);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (length === 0 || (size !== undefined && length !== size) || (sha256 && sha256 !== hash))
    throw new Error('Attachment does not match its admitted content');
  return { bytes, sha256: hash };
};
