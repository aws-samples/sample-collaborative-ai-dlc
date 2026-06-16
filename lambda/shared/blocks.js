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

// The block types that form the reusable library, named to match the AI-DLC
// V2 source (awslabs/aidlc-workflows): a STAGE is the atomic unit of work, a
// SENSOR is a deterministic check, a RULE is a layered guardrail, an ARTIFACT
// is a named output that wires stages together (V2's artifact vocabulary), and
// KNOWLEDGE is the two-tier (methodology/team) per-agent expertise corpus.
// Phases are NOT a block type — they are defined inline in each workflow's
// grouping tree (V2 treats a phase as an organizing label, not a standalone
// object). Workflows are modeled separately and are not in this set.
const BLOCK_TYPES = ['STAGE', 'AGENT', 'SCOPE', 'RULE', 'SENSOR', 'ARTIFACT', 'KNOWLEDGE'];

// Knowledge tiers: the methodology tier ships in the SYSTEM baseline (authored,
// forkable); the team tier is accumulated per-project at execution time (the
// learning-loop / team-knowledge write-back seam) and is not seeded.
const KNOWLEDGE_TIERS = ['methodology', 'team'];

// V2's rule resolution chain. The three universal layers (org/team/project)
// apply to every stage; `phase`/`stage` attach by matching the stage's phase /
// slug. `team-learnings` + `project-learnings` are the two learnings tiers V2's
// resolver interleaves (priorities 1.5 / 2.5, between team→project): they are
// universal-style layers accrued by the runtime learning loop, seeded empty
// like the team-knowledge tier. RULE_LAYER_PRIORITY drives the resolved order.
const RULE_LAYERS = [
  'org',
  'team',
  'team-learnings',
  'project',
  'project-learnings',
  'phase',
  'stage',
];
const RULE_LAYER_PRIORITY = {
  org: 0,
  team: 1,
  'team-learnings': 1.5,
  project: 2,
  'project-learnings': 2.5,
  phase: 3,
  stage: 4,
};

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
  errors.push(...validateTypeFields(type, input));
  return errors;
};

const DEPTHS = ['Minimal', 'Standard', 'Comprehensive'];

// V2's stage execution modes. `inline` and `subagent` are active; `agent-team`
// is reserved (no stage declares it yet, but the value must round-trip as known
// so a future consumer isn't surprised by an "unknown mode").
const STAGE_MODES = ['inline', 'subagent', 'agent-team'];

// Per-type required/shape checks. Kept small and explicit — only the fields
// whose absence would make a block unusable are enforced.
const validateTypeFields = (type, input) => {
  const errors = [];
  if (type === 'STAGE') {
    // mode is optional on input (the editor may omit it), but if present it
    // must be one of V2's three values — guards the reserved `agent-team`.
    if (input.mode != null && !STAGE_MODES.includes(input.mode)) {
      errors.push(`stage mode must be one of ${STAGE_MODES.join(', ')}`);
    }
  }
  if (type === 'SENSOR') {
    // A sensor's mode decides whether it can self-halt; it is mandatory.
    if (input.mode !== 'deterministic' && input.mode !== 'llm-judged') {
      errors.push("sensor mode must be 'deterministic' or 'llm-judged'");
    }
    // A deterministic sensor is an executable check — it needs a command.
    // (The script itself rides in the body; the command is how it's run.)
    if (input.mode === 'deterministic' && (typeof input.command !== 'string' || !input.command)) {
      errors.push('a deterministic sensor requires a command');
    }
    // An llm-judged sensor is the V2 Reviewer: a clean-room sub-agent. It is
    // bound to a reviewer agent and runs zero or more validation tools. The
    // reviewerAgent is what makes the check runnable (the analogue of a
    // deterministic sensor's command), so it is mandatory in this mode.
    if (input.mode === 'llm-judged') {
      if (typeof input.reviewerAgent !== 'string' || !input.reviewerAgent) {
        errors.push('an llm-judged sensor requires a reviewerAgent');
      }
      if (
        input.maxIterations != null &&
        (!Number.isInteger(input.maxIterations) || input.maxIterations < 1)
      ) {
        errors.push('sensor maxIterations must be a positive integer');
      }
      if (input.validationTools != null && !Array.isArray(input.validationTools)) {
        errors.push('sensor validationTools must be an array');
      }
    }
  }
  if (type === 'RULE') {
    // The five-layer chain plus the two interleaved learnings tiers V2's
    // resolver admits (team-learnings, project-learnings). Optional on input.
    if (input.layer != null && !RULE_LAYERS.includes(input.layer)) {
      errors.push(`rule layer must be one of ${RULE_LAYERS.join(', ')}`);
    }
    // pairing binds the feedforward (rule) half to a feedback (sensor) half, or
    // the sentinel 'feedforward-only' for a rule that needs no sensor.
    if (input.pairing != null && typeof input.pairing !== 'string') {
      errors.push("rule pairing must be a string (a sensor id or 'feedforward-only')");
    }
  }
  if (type === 'AGENT') {
    if (input.examples != null && !Array.isArray(input.examples)) {
      errors.push('agent examples must be an array');
    }
    if (input.tools != null && !Array.isArray(input.tools)) {
      errors.push('agent tools must be an array');
    }
  }
  if (type === 'SCOPE') {
    // depth is the V2 scope's core dimension; testStrategy is an optional
    // override (defaults to depth when absent). Both share the depth enum.
    if (input.depth != null && !DEPTHS.includes(input.depth)) {
      errors.push(`scope depth must be one of ${DEPTHS.join(', ')}`);
    }
    if (input.testStrategy != null && !DEPTHS.includes(input.testStrategy)) {
      errors.push(`scope testStrategy must be one of ${DEPTHS.join(', ')}`);
    }
  }
  if (type === 'KNOWLEDGE') {
    // Knowledge attaches to an agent (or the shared corpus) and belongs to a
    // tier; the tier decides whether it ships in the baseline or is accrued.
    if (input.tier != null && !KNOWLEDGE_TIERS.includes(input.tier)) {
      errors.push(`knowledge tier must be one of ${KNOWLEDGE_TIERS.join(', ')}`);
    }
    if (input.agentRef != null && typeof input.agentRef !== 'string') {
      errors.push('knowledge agentRef must be a string (an agent id or "shared")');
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
  KNOWLEDGE_TIERS,
  RULE_LAYERS,
  RULE_LAYER_PRIORITY,
  STAGE_MODES,
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
