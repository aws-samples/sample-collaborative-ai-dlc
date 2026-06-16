'use strict';

// Shared data-layer helpers for the reusable building-blocks library.
// Used by both the building-blocks CRUD lambda and the one-shot seed lambda so
// the key scheme, validation, and content-addressed body storage live in one
// place.
//
// Storage shape (single table):
//   PK = BLOCK#<tenant>#<TYPE>#<id>   SK = V#latest | V#<n> (immutable)
//   GSI1PK = TENANT#<tenant>#<TYPE>   GSI1SK = <name>   (catalog browse)
// Large bodies/scripts are NOT stored inline; they live in the artifacts S3
// bucket under blocks/bodies/sha256/<hash>, referenced by a `bodyRef` pointer.

const { createHash } = require('node:crypto');

// The block types that form the reusable library. Workflows and artifacts are
// modeled separately and are not part of this set.
const BLOCK_TYPES = [
  'SKILL',
  'GROUPING',
  'AGENT',
  'SCOPE',
  'GUARDRAIL',
  'POSTCONDITION',
  'KNOWLEDGE',
];

const LATEST = 'V#latest';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab-case
const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — bodies belong in S3, not unbounded

const isBlockType = (type) => BLOCK_TYPES.includes(type);

// Normalizes a `{type}` path part (case-insensitive) to its canonical form, or
// null if it is not a known block type.
const normalizeType = (raw) => {
  const upper = String(raw || '').toUpperCase();
  return isBlockType(upper) ? upper : null;
};

const blockPk = (tenant, type, id) => `BLOCK#${tenant}#${type}#${id}`;
const versionSk = (n) => `V#${n}`;
const catalogGsi1Pk = (tenant, type) => `TENANT#${tenant}#${type}`;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Builds the content-addressed S3 key + pointer for a block body. Bodies are
// immutable by hash, so identical content reuses the same object.
const bodyS3Key = (hash) => `blocks/bodies/sha256/${hash}`;
const buildBodyRef = (body) => {
  const bytes = Buffer.byteLength(body, 'utf8');
  const hash = sha256(body);
  return { s3Key: bodyS3Key(hash), sha256: hash, bytes };
};

// Validates the create/update payload for a block. Returns an array of error
// strings (empty = valid). Hand-rolled, matching the codebase convention of
// inline validation over a schema library.
const validateBlockInput = (type, input) => {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return ['body must be a JSON object'];
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.push('name is required');
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (
    input.description != null &&
    (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    errors.push(`description must be a string up to ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (input.body != null) {
    if (typeof input.body !== 'string') {
      errors.push('body must be a string');
    } else if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
      errors.push(`body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  }
  return errors;
};

// Validates a block id supplied by the caller (on create).
const validateId = (id) => {
  if (typeof id !== 'string' || id === '') return 'id is required';
  if (id.length > MAX_ID_LENGTH) return `id exceeds ${MAX_ID_LENGTH} characters`;
  if (!ID_RE.test(id)) return 'id must be kebab-case (lowercase letters, digits, hyphens)';
  return null;
};

module.exports = {
  BLOCK_TYPES,
  LATEST,
  MAX_BODY_BYTES,
  isBlockType,
  normalizeType,
  blockPk,
  versionSk,
  catalogGsi1Pk,
  sha256,
  bodyS3Key,
  buildBodyRef,
  validateBlockInput,
  validateId,
};
