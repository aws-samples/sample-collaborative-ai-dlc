// Input schemas and object-key rules for the execution-owned blob operations.
//
// Callers name objects only by what the execution META already lists (a rule
// filename, an attachment id); the S3 key and version are rebuilt from META and
// must sit exactly where the writing Lambda puts them for the granted project
// or intent. A prefix match is not enough: `custom-rules/p-1/` must not admit
// `custom-rules/p-10/...`, nor a nested path under the granted project.
import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES, attachmentCommittedKey } from '../shared/intent-attachment-keys.js';

const ID_MAX = 512;
const RULE_FILENAME_MAX = 255;
// Same cap as the projects Lambda's MAX_CUSTOM_RULES.
const CUSTOM_RULES_MAX = 20;
const ATTACHMENT_EXTENSION = /^\.[a-z0-9]{1,10}$/;

// The browser enforces this at upload, but a presigned PUT carries no size
// constraint, so the server read is the enforcement (as in the runtime's own
// custom-rules reader).
export const MAX_CUSTOM_RULE_BYTES = 100 * 1024;
export { MAX_ATTACHMENT_BYTES };

const hasControlChar = (value) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

export const isSafeRuleFilename = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= RULE_FILENAME_MAX &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !hasControlChar(name) &&
  name !== '.' &&
  name !== '..' &&
  name.toLowerCase().endsWith('.md');

export const customRuleKey = (projectId, filename) => `custom-rules/${projectId}/${filename}`;

// The rule as engine-data trusts it, or null: its key must be the exact key the
// projects Lambda writes for this project and filename.
export const customRuleDescriptor = (projectId, rule) => {
  if (!rule || typeof rule !== 'object' || typeof rule.s3Key !== 'string') return null;
  const prefix = customRuleKey(projectId, '');
  if (!rule.s3Key.startsWith(prefix)) return null;
  const basename = rule.s3Key.slice(prefix.length);
  if (!isSafeRuleFilename(basename)) return null;
  if (rule.filename !== undefined && rule.filename !== null && rule.filename !== basename) {
    return null;
  }
  return { filename: basename, s3Key: rule.s3Key };
};

// The committed attachment as engine-data trusts it, or null: its key must be
// the intents Lambda's committed key for this intent and attachment id, with a
// stored object version and a size within the supported limit.
export const attachmentDescriptor = (intentId, attachment) => {
  if (!attachment || typeof attachment !== 'object') return null;
  const { attachmentId, s3Key, s3VersionId, size } = attachment;
  if (typeof attachmentId !== 'string' || !attachmentId || typeof s3Key !== 'string') return null;
  const prefix = attachmentCommittedKey(intentId, attachmentId, '');
  if (!s3Key.startsWith(prefix) || !ATTACHMENT_EXTENSION.test(s3Key.slice(prefix.length))) {
    return null;
  }
  if (typeof s3VersionId !== 'string' || !s3VersionId) return null;
  if (!Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) return null;
  return { attachmentId, s3Key, s3VersionId, size };
};

const ruleFilename = z.string().refine(isSafeRuleFilename, 'rule_filename');

export const BLOB_OPS = Object.freeze({
  readCustomRules: z
    .object({ filenames: z.array(ruleFilename).max(CUSTOM_RULES_MAX).optional() })
    .strict(),
  pinCustomRuleVersions: z.object({}).strict(),
  readAttachmentChunk: z
    .object({
      attachmentId: z.string().min(1).max(ID_MAX),
      offset: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
    })
    .strict(),
});
