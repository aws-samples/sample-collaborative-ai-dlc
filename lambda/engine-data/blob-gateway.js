// engine-data: the server side of the runtime's execution-owned objects.
//
// Each blob call arrives as `{ op: 'blob.<name>', args: [input], grant }` and is
// authorized on its own:
//   1. the grant is verified and must be an engine grant (execution, stage or
//      conflict); discussion grants get no object access;
//   2. the op must be on the shared allowlist and its input must match the
//      strict schema;
//   3. the execution META (consistent read) must exist and belong to the
//      grant's project and intent. There is deliberately no terminal or
//      active-stage gate, as for store calls;
//   4. the objects read are the ones META lists, at the exact keys the writing
//      Lambdas use for the granted project (rules) or intent (attachments).
//      A META entry outside those keys denies the call rather than being
//      skipped, so a poisoned row cannot turn into a quiet partial read.
// Rule reads stay best-effort per document (missing, oversized or unreadable
// objects are skipped, as the runtime reader did); a denial never is.
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  ENGINE_DATA_ATTACHMENT_CHUNK_BYTES,
  ENGINE_DATA_BLOB_OPS,
  ENGINE_DATA_BLOB_PREFIX,
} from '../shared/engine-data-ops.js';
import { pinCustomRuleVersions } from '../shared/custom-rule-versions.js';
import {
  BLOB_OPS,
  MAX_CUSTOM_RULE_BYTES,
  attachmentDescriptor,
  customRuleDescriptor,
} from './blob-schemas.js';
import {
  ENGINE_GRANT_MODES,
  EngineDataAccessDenied,
  denialResponse,
  deny,
  grantAudit,
  hasPrototypeKey,
  issuePaths,
  serializeError,
  verifyGrantOrDeny,
} from './gateway-common.js';

const ALLOWED_OPS = new Set(ENGINE_DATA_BLOB_OPS);
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

export class EngineBlobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineBlobError';
    this.code = code;
  }
}

// Counts bytes as they stream so an object that grew past the cap after its
// HEAD is still refused without being buffered whole.
const readBounded = async (body, maxBytes) => {
  if (!body) return Buffer.alloc(0);
  if (typeof body[Symbol.asyncIterator] !== 'function') {
    throw new EngineBlobError('unreadable_body', 'Object body is not a stream');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy?.();
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const ruleDescriptors = (grant, meta) =>
  (Array.isArray(meta.customRules) ? meta.customRules : []).map((rule) => {
    const descriptor = customRuleDescriptor(grant.projectId, rule);
    if (!descriptor) deny('rule_key_not_allowed');
    return { rule, descriptor };
  });

const selectRules = (rules, filenames) => {
  if (!filenames) return rules;
  const byName = new Map(rules.map((entry) => [entry.descriptor.filename, entry]));
  return [...new Set(filenames)].map((filename) => byName.get(filename) ?? deny('rule_not_found'));
};

export const createBlobGateway = ({
  verifyGrant,
  createStore,
  s3,
  bucket,
  audit = () => {},
  maxRuleBytes = MAX_CUSTOM_RULE_BYTES,
  chunkBytes = ENGINE_DATA_ATTACHMENT_CHUNK_BYTES,
}) => {
  const readRule = async ({ descriptor }) => {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: descriptor.s3Key }));
    if (typeof head.ContentLength === 'number' && head.ContentLength > maxRuleBytes) return null;
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: descriptor.s3Key }));
    const bytes = await readBounded(object.Body, maxRuleBytes);
    return bytes ? { filename: descriptor.filename, body: bytes.toString('utf8') } : null;
  };

  const RUN = {
    readCustomRules: async ({ grant, meta, input, record }) => {
      const selected = selectRules(ruleDescriptors(grant, meta), input.filenames);
      const out = [];
      let skipped = 0;
      for (const entry of selected) {
        const doc = await readRule(entry).catch(() => null);
        if (doc) out.push(doc);
        else skipped += 1;
      }
      Object.assign(record, { rules: out.length, rulesSkipped: skipped });
      return out;
    },
    pinCustomRuleVersions: ({ grant, meta }) =>
      pinCustomRuleVersions({
        s3,
        bucket,
        rules: ruleDescriptors(grant, meta).map(({ rule }) => rule),
      }),
    readAttachmentChunk: async ({ grant, meta, input }) => {
      const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
      const stored = attachments.find((entry) => entry?.attachmentId === input.attachmentId);
      if (!stored) deny('attachment_not_found');
      const attachment = attachmentDescriptor(grant.intentId, stored);
      if (!attachment) deny('attachment_key_not_allowed');
      if (input.offset >= attachment.size) deny('invalid_arguments');

      const end = Math.min(input.offset + chunkBytes, attachment.size) - 1;
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: attachment.s3Key,
          VersionId: attachment.s3VersionId,
          Range: `bytes=${input.offset}-${end}`,
        }),
      );
      if (object.VersionId !== attachment.s3VersionId) {
        throw new EngineBlobError('attachment_version_mismatch', 'Attachment version changed');
      }
      const range = CONTENT_RANGE.exec(object.ContentRange ?? '');
      if (
        !range ||
        Number(range[1]) !== input.offset ||
        Number(range[2]) !== end ||
        Number(range[3]) !== attachment.size
      ) {
        throw new EngineBlobError('attachment_range_mismatch', 'Attachment range does not match');
      }
      const bytes = await readBounded(object.Body, end - input.offset + 1);
      if (!bytes || bytes.length !== end - input.offset + 1) {
        throw new EngineBlobError('attachment_range_mismatch', 'Attachment range does not match');
      }
      return {
        attachmentId: attachment.attachmentId,
        versionId: attachment.s3VersionId,
        offset: input.offset,
        totalBytes: attachment.size,
        bytesBase64: bytes.toString('base64'),
        nextOffset: end + 1 < attachment.size ? end + 1 : null,
      };
    },
  };

  const authorize = async (event, record) => {
    const grant = await verifyGrantOrDeny(verifyGrant, event?.grant);
    Object.assign(record, grantAudit(grant));
    if (!ENGINE_GRANT_MODES.has(grant.mode)) deny('grant_mode_not_allowed');

    const op = typeof event.op === 'string' ? event.op : '';
    const name = op.startsWith(ENGINE_DATA_BLOB_PREFIX)
      ? op.slice(ENGINE_DATA_BLOB_PREFIX.length)
      : null;
    if (!name || !ALLOWED_OPS.has(name) || !Object.hasOwn(BLOB_OPS, name)) deny('op_not_allowed');
    const { args } = event;
    if (!Array.isArray(args) || args.length !== 1 || hasPrototypeKey(args)) {
      deny('invalid_arguments');
    }
    const result = BLOB_OPS[name].safeParse(args[0]);
    if (!result.success) deny('invalid_arguments', { issues: issuePaths(0, result.error) });

    const meta = await createStore().getExecution(grant.executionId, { consistentRead: true });
    if (!meta) deny('execution_not_found');
    if (meta.projectId !== grant.projectId || meta.intentId !== grant.intentId) {
      deny('scope_mismatch');
    }
    return { grant, name, input: result.data, meta };
  };

  return async (event) => {
    const startedAt = Date.now();
    const record = { op: typeof event?.op === 'string' ? event.op : null };
    const finish = (fields) => audit({ ...record, ...fields, ms: Date.now() - startedAt });
    let authorized;
    try {
      authorized = await authorize(event, record);
      if (!bucket) {
        finish({ decision: 'error', outcome: 'misconfigured' });
        return {
          error: {
            name: 'EngineBlobError',
            code: 'blob_misconfigured',
            message: 'Engine data has no artifacts bucket',
            conflict: false,
          },
        };
      }
      const result = await RUN[authorized.name]({ ...authorized, record });
      finish({ decision: 'allow', outcome: 'ok' });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof EngineDataAccessDenied) {
        finish({ ...error.detail, decision: 'deny', reason: error.reason });
        return denialResponse(error);
      }
      finish({
        decision: authorized ? 'allow' : 'error',
        outcome: authorized ? 'blob_error' : 'error',
        error: error?.name ?? 'Error',
      });
      return { error: serializeError(error) };
    }
  };
};
