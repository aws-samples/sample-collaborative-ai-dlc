// Required native run content, independent of optional diagnostic archives.
// A completed assistant turn is not a human decision or workflow authority.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { canonicalJson } from './workflow-checkpoint.js';
import { nativePublicationScope } from './native-publication.js';
import { nativePendingInput, nativePresentation } from './native-pending-input.js';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
export const NATIVE_INTERACTION_LIMITS = Object.freeze({
  messages: 256,
  textBytes: 64 * 1024,
  envelopeBytes: 256 * 1024,
  responseBytes: 16 * 1024,
});
const fail = () => {
  throw Object.assign(new Error('Native interaction could not be verified'), {
    code: 'NATIVE_INTERACTION_INVALID',
  });
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) =>
  object(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const sequence = (value) => Number.isSafeInteger(value) && value >= 1;
const safeVersion = (value) =>
  typeof value === 'string' && value !== 'null' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(value);
const text = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  // oxlint-disable-next-line no-control-regex -- Reject terminal controls; preserve tabs and line endings.
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
  Buffer.from(value, 'utf8').toString('utf8') === value;

const scopeOf = (identity) => {
  if (
    !object(identity) ||
    !['projectId', 'executionId', 'bindingId', 'attemptId', 'runtimeSessionId'].every(
      (field) => typeof identity[field] === 'string',
    )
  )
    fail();
  let publication;
  try {
    publication = nativePublicationScope(identity);
  } catch {
    fail();
  }
  if (!matches(identity.bindingId, UUID) || !matches(identity.runtimeSessionId, UUID)) fail();
  return {
    prefix: publication.prefix,
    scope: {
      projectId: publication.projectId,
      executionId: publication.executionId,
      bindingId: identity.bindingId,
      attemptId: publication.attemptId,
      epoch: publication.epoch,
      runtimeSessionId: identity.runtimeSessionId,
    },
  };
};

export const nativeInteractionMessages = (messages) => {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > NATIVE_INTERACTION_LIMITS.messages
  )
    fail();
  let bytes = 0;
  let nonblank = false;
  for (const message of messages) {
    if (!exact(message, ['type', 'text']) || message.type !== 'text' || !text(message.text)) fail();
    bytes += Buffer.byteLength(message.text);
    if (bytes > NATIVE_INTERACTION_LIMITS.textBytes) fail();
    nonblank ||= Boolean(message.text.trim());
  }
  if (!nonblank) fail();
  return structuredClone(messages);
};

export const nativeInteractionReceipt = (value, identity) => {
  if (
    !exact(value, ['id', 'sequence', 'nativeSessionId', 'publicationId', 'object']) ||
    !matches(value.id, SHA) ||
    !sequence(value.sequence) ||
    !matches(value.nativeSessionId, SESSION) ||
    !matches(value.publicationId, SHA) ||
    !exact(value.object, ['key', 'versionId', 'sha256', 'bytes']) ||
    value.object.sha256 !== value.id ||
    !safeVersion(value.object.versionId) ||
    !Number.isSafeInteger(value.object.bytes) ||
    value.object.bytes < 1 ||
    value.object.bytes > NATIVE_INTERACTION_LIMITS.envelopeBytes
  )
    fail();
  const expected = `${scopeOf(identity).prefix}interactions/${value.id}.json`;
  if (value.object.key !== expected) fail();
  return structuredClone(value);
};

const BODY_FIELDS = [
  'schemaVersion',
  'scope',
  'sequence',
  'kind',
  'harness',
  'nativeSessionId',
  'packageId',
  'publicationId',
  'createdAt',
  'messages',
  'contentSha256',
];
// v1: messages only. v2 (task-3): plus a structured pendingInput, and the
// content hash covers both, so a reply bound to contentSha256 is bound to the
// exact options the member was shown.
export const nativeInteractionContentSha256 = (
  messages,
  pendingInput = undefined,
  presentation = undefined,
) =>
  hash(
    canonicalJson(
      presentation !== undefined
        ? { messages, pendingInput: pendingInput ?? null, presentation }
        : pendingInput === undefined
          ? messages
          : { messages, pendingInput },
    ),
  );

const validate = (value, identity) => {
  const v2 = object(value) && value.schemaVersion === 2;
  const v3 = object(value) && value.schemaVersion === 3;
  if (
    !exact(
      value,
      v3
        ? [...BODY_FIELDS, 'pendingInput', 'presentation']
        : v2
          ? [...BODY_FIELDS, 'pendingInput']
          : BODY_FIELDS,
    ) ||
    ![1, 2, 3].includes(value.schemaVersion) ||
    canonicalJson(value.scope) !== canonicalJson(scopeOf(identity).scope) ||
    !sequence(value.sequence) ||
    value.kind !== 'assistant_turn' ||
    !HARNESSES.includes(value.harness) ||
    !matches(value.nativeSessionId, SESSION) ||
    !matches(value.packageId, /^sha256:[a-f0-9]{64}$/) ||
    !matches(value.publicationId, SHA) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    fail();
  const messages = nativeInteractionMessages(value.messages);
  let pendingInput;
  if (v2 || (v3 && value.pendingInput !== null)) {
    try {
      pendingInput = nativePendingInput(value.pendingInput);
    } catch {
      fail();
    }
  }
  let presentation;
  if (v3) {
    try {
      presentation = nativePresentation(value.presentation);
    } catch {
      fail();
    }
    if (pendingInput !== undefined) fail(); // A degraded form is never a structured approval.
  }
  if (value.contentSha256 !== nativeInteractionContentSha256(messages, pendingInput, presentation))
    fail();
  return structuredClone(value);
};

export const createNativeInteractions = ({
  s3,
  bucket,
  accountId,
  now = () => new Date().toISOString(),
}) => {
  if (
    typeof s3?.send !== 'function' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
    !matches(accountId, /^\d{12}$/) ||
    typeof now !== 'function'
  )
    fail();
  const base = { Bucket: bucket, ExpectedBucketOwner: accountId };
  return Object.freeze({
    async write({
      identity,
      packageId,
      sequence: turnSequence,
      harness,
      nativeSessionId,
      publicationId,
      messages,
      pendingInput = null,
      presentation = null,
    }) {
      const { scope, prefix } = scopeOf(identity);
      const normalized = nativeInteractionMessages(messages);
      // Free-text turns keep the exact v1 body; v2 only when structured input exists.
      let input;
      if (pendingInput !== null) {
        try {
          input = nativePendingInput(pendingInput);
        } catch {
          fail();
        }
      }
      const body = validate(
        {
          schemaVersion: presentation ? 3 : input ? 2 : 1,
          scope,
          sequence: turnSequence,
          kind: 'assistant_turn',
          harness,
          nativeSessionId,
          packageId,
          publicationId,
          createdAt: now(),
          messages: normalized,
          contentSha256: nativeInteractionContentSha256(
            normalized,
            input,
            presentation ?? undefined,
          ),
          ...(input ? { pendingInput: input } : {}),
          ...(presentation ? { pendingInput: input ?? null, presentation } : {}),
        },
        identity,
      );
      const bytes = Buffer.from(canonicalJson(body));
      if (bytes.length > NATIVE_INTERACTION_LIMITS.envelopeBytes) fail();
      const id = hash(bytes);
      const key = `${prefix}interactions/${id}.json`;
      const result = await s3.send(
        new PutObjectCommand({
          ...base,
          Key: key,
          Body: bytes,
          ContentType: 'application/json',
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      return nativeInteractionReceipt(
        {
          id,
          sequence: body.sequence,
          nativeSessionId,
          publicationId,
          object: {
            key,
            versionId: result.VersionId,
            sha256: id,
            bytes: bytes.length,
          },
        },
        identity,
      );
    },
    async read(identity, receipt) {
      const expected = nativeInteractionReceipt(receipt, identity);
      const result = await s3.send(
        new GetObjectCommand({
          ...base,
          Key: expected.object.key,
          VersionId: expected.object.versionId,
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      const parts = [];
      let length = 0;
      try {
        if (
          result.VersionId !== expected.object.versionId ||
          result.ContentLength !== expected.object.bytes
        )
          fail();
        for await (const part of result.Body) {
          const bytes = Buffer.from(part);
          length += bytes.length;
          if (length > expected.object.bytes) fail();
          parts.push(bytes);
        }
      } finally {
        result.Body?.destroy?.();
      }
      const bytes = Buffer.concat(parts);
      if (length !== expected.object.bytes || hash(bytes) !== expected.id) fail();
      let body;
      try {
        body = validate(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          identity,
        );
      } catch {
        fail();
      }
      if (
        body.sequence !== expected.sequence ||
        body.nativeSessionId !== expected.nativeSessionId ||
        body.publicationId !== expected.publicationId
      )
        fail();
      return body;
    },
  });
};

export const nativeInteractionView = (receipt, body) => ({
  id: receipt.id,
  sequence: body.sequence,
  kind: body.kind,
  harness: body.harness,
  publicationId: body.publicationId,
  messages: structuredClone(body.messages),
  pendingInput: body.schemaVersion === 2 ? structuredClone(body.pendingInput) : null,
  ...(body.schemaVersion === 3 ? { presentation: structuredClone(body.presentation) } : {}),
  contentSha256: body.contentSha256,
  createdAt: body.createdAt,
});
