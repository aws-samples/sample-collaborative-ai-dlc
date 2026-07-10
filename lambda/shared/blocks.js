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

import { createHash } from 'node:crypto';

// The block types that form the reusable library, named to match the AI-DLC
// V2 source (awslabs/aidlc-workflows): a STAGE is the atomic unit of work, a
// SENSOR is a deterministic check, a RULE is a layered guardrail, an ARTIFACT
// is a named output that wires stages together (V2's artifact vocabulary), and
// KNOWLEDGE is the two-tier (methodology/team) per-agent expertise corpus.
// SKILL is a user-invocable runner pack (V2's SKILL.md) and TEMPLATE is an
// authored scaffold (V2's core/templates) — both editable so users can author
// their own. Phases are NOT a block type — they are defined inline in each
// workflow's grouping tree (V2 treats a phase as an organizing label, not a
// standalone object). Workflows are modeled separately and are not in this set.
const BLOCK_TYPES = [
  'STAGE',
  'AGENT',
  'SCOPE',
  'RULE',
  'SENSOR',
  'ARTIFACT',
  'KNOWLEDGE',
  'SKILL',
  'TEMPLATE',
];

// Knowledge tiers: the methodology tier ships in the SYSTEM baseline (authored,
// forkable); the team tier is accumulated per-project at execution time (the
// learning-loop / team-knowledge write-back seam) and is not seeded.
const KNOWLEDGE_TIERS = ['methodology', 'team'];

// V2's work-shaped agent model classes (≥2.3.1), ordered high→low: `judgment`
// gets the strongest model, `balanced` a mid model, `templated` the cheapest.
// An agent's tier picks the row in the admin/project tier-model tables; the
// concrete model per CLI is deployment configuration, never authored upstream.
const AGENT_TIERS = ['judgment', 'balanced', 'templated'];

// V2's unit-of-work kinds (≥2.2.18). A stage's `producesKinds` map narrows an
// artifact to units of these kinds; a unit's `kind` rides in the
// unit-of-work-dependency DAG block. An untagged unit gets the full artifact
// matrix; an unlisted artifact applies to every kind.
const UNIT_KINDS = ['service', 'spec', 'ui', 'packaging', 'library'];

// The one structured activation predicate V2 admits on a stage's `when`
// (plugin-era, parsed-not-yet-evaluated upstream): the stage activates only
// when the named artifact has an in-plan producer.
const WHEN_PREDICATE_KEYS = ['producer-in-plan'];

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

// The script sibling of bodyRef: a SENSOR's executable check rides here (the
// .ts the sensor `command` runs), kept separate from the markdown body (the
// sensor's manifest prose) so a sensor can carry both.
const scriptS3Key = (hash) => `blocks/scripts/sha256/${hash}`;
const buildScriptRef = (script) => {
  const bytes = Buffer.byteLength(script, 'utf8');
  const hash = sha256(script);
  return { s3Key: scriptS3Key(hash), sha256: hash, bytes };
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
  if (input.script != null) {
    if (typeof input.script !== 'string') {
      errors.push('script must be a string');
    } else if (Buffer.byteLength(input.script, 'utf8') > MAX_BODY_BYTES) {
      errors.push(`script exceeds ${MAX_BODY_BYTES} bytes`);
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
    // The reviewer is V2's LLM-judged verification: a clean-room sub-agent
    // (a reviewer AGENT id) that returns a READY/NOT-READY verdict, looping up
    // to reviewerMaxIterations. It is the third, orthogonal verification axis
    // alongside deterministic sensors and the human gate — a flat stage field,
    // matching V2 frontmatter, not a sensor.
    if (input.reviewer != null && typeof input.reviewer !== 'string') {
      errors.push('stage reviewer must be a string (a reviewer agent id)');
    }
    if (
      input.reviewerMaxIterations != null &&
      (!Number.isInteger(input.reviewerMaxIterations) || input.reviewerMaxIterations < 1)
    ) {
      errors.push('stage reviewerMaxIterations must be a positive integer');
    }
    // `number` is display-only ordering (V2 2.3.0): `<int>.<int>`, so a plugin
    // stage can slot between core stages without renumbering them.
    if (input.number != null && !/^\d+\.\d+$/.test(String(input.number))) {
      errors.push('stage number must be "<int>.<int>" (display ordering, e.g. "3.85")');
    }
    if (input.bundle != null && typeof input.bundle !== 'string') {
      errors.push('stage bundle must be a string (the contributing plugin name)');
    }
    // `when` is a structured activation predicate: exactly one known key with
    // a non-empty artifact slug value.
    if (input.when != null) {
      const keys =
        typeof input.when === 'object' && !Array.isArray(input.when)
          ? Object.keys(input.when)
          : null;
      if (
        !keys ||
        keys.length !== 1 ||
        !WHEN_PREDICATE_KEYS.includes(keys[0]) ||
        typeof input.when[keys[0]] !== 'string' ||
        input.when[keys[0]].trim() === ''
      ) {
        errors.push(
          `stage when must be an object with exactly one of ${WHEN_PREDICATE_KEYS.join(', ')} naming an artifact`,
        );
      }
    }
    if (
      input.requiredSections != null &&
      (!Array.isArray(input.requiredSections) ||
        input.requiredSections.some((s) => typeof s !== 'string' || s.trim() === ''))
    ) {
      errors.push('stage requiredSections must be an array of non-empty strings');
    }
    if (
      input.optionalProduces != null &&
      (!Array.isArray(input.optionalProduces) ||
        input.optionalProduces.some((a) => typeof a !== 'string' || a.trim() === ''))
    ) {
      errors.push('stage optionalProduces must be an array of artifact names');
    }
    // `producesKinds` narrows artifacts to unit kinds: every key must name a
    // declared output (produces ∪ optionalProduces — an orphan key is a typo
    // that would silently never prune) and every value a non-empty list of
    // known kinds.
    if (input.producesKinds != null) {
      if (
        typeof input.producesKinds !== 'object' ||
        Array.isArray(input.producesKinds) ||
        Object.keys(input.producesKinds).length === 0
      ) {
        errors.push('stage producesKinds must be a non-empty object of artifact → kinds[]');
      } else {
        const declared = new Set([
          ...(Array.isArray(input.produces) ? input.produces : []),
          ...(Array.isArray(input.optionalProduces) ? input.optionalProduces : []),
        ]);
        for (const [artifact, kinds] of Object.entries(input.producesKinds)) {
          if (!declared.has(artifact)) {
            errors.push(
              `producesKinds names "${artifact}" which is not in produces/optionalProduces`,
            );
          }
          if (
            !Array.isArray(kinds) ||
            kinds.length === 0 ||
            kinds.some((k) => !UNIT_KINDS.includes(k))
          ) {
            errors.push(
              `producesKinds["${artifact}"] must be a non-empty array of ${UNIT_KINDS.join(', ')}`,
            );
          }
        }
      }
    }
  }
  if (type === 'SENSOR') {
    // Sensors are deterministic-only (V2 reserves `llm` and rejects it at
    // parse). The LLM-judged half of verification is the stage `reviewer` field,
    // not a sensor mode. `mode` is optional on input; if present it must be
    // 'deterministic'.
    if (input.mode != null && input.mode !== 'deterministic') {
      errors.push("sensor mode must be 'deterministic'");
    }
    // A deterministic sensor is an executable check — it needs a command.
    // (The script itself rides in the body; the command is how it's run.)
    if (typeof input.command !== 'string' || !input.command) {
      errors.push('a sensor requires a command');
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
    // The tier is optional (pre-2.3.1 baselines and user forks may carry a raw
    // modelOverride pin instead), but a present value must be a known class.
    if (input.tier != null && !AGENT_TIERS.includes(input.tier)) {
      errors.push(`agent tier must be one of ${AGENT_TIERS.join(', ')}`);
    }
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
  if (type === 'SKILL') {
    // A user-invocable runner pack. The invocation contract is optional on
    // input; if present it must be the right shape.
    if (input.userInvocable != null && typeof input.userInvocable !== 'boolean') {
      errors.push('skill userInvocable must be a boolean');
    }
    if (input.classification != null && typeof input.classification !== 'string') {
      errors.push('skill classification must be a string');
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

export {
  BLOCK_TYPES,
  KNOWLEDGE_TIERS,
  AGENT_TIERS,
  UNIT_KINDS,
  WHEN_PREDICATE_KEYS,
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
  scriptS3Key,
  buildScriptRef,
  validateBlockInput,
  validateId,
};
export default {
  BLOCK_TYPES,
  KNOWLEDGE_TIERS,
  AGENT_TIERS,
  UNIT_KINDS,
  WHEN_PREDICATE_KEYS,
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
  scriptS3Key,
  buildScriptRef,
  validateBlockInput,
  validateId,
};
