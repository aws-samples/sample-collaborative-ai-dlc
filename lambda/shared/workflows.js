// Shared data-layer helpers for workflows — the composition roots that
// reference and arrange library blocks. Workflows share the blocks table:
//   PK = WF#<tenant>#<workflowId>
//   SK = META                              workflow header
//   SK = PHASE#<path>#<phaseId>            ordered, nestable inline phase
//   SK = PLACEMENT#<stageId>               a placed stage (workflow × stage join)
//   SK = SCOPEREF#<scopeId>                a scope available in this workflow
//   SK = RULEREF#<layer>#<id>              a rule layered into this workflow
//   SK = V#<n>#<live-sk>                   immutable workflow version snapshot
// One Query(PK = WF#…) loads the whole composition. Listing reuses the blocks
// catalog index: GSI1PK = TENANT#<tenant>#WORKFLOW on the META item.

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab-case
const PATH_RE = /^[0-9]{2}(?:\.[0-9]{2})*$/; // 01 | 01.02 | 01.02.03

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;

const WORKFLOW = 'WORKFLOW';
const META = 'META';

const workflowPk = (tenant, workflowId) => `WF#${tenant}#${workflowId}`;
const workflowVersionPrefix = (version) => `V#${version}#`;
const workflowVersionSk = (version, liveSk) => `${workflowVersionPrefix(version)}${liveSk}`;
const isWorkflowVersionSk = (sk) => /^V#[1-9][0-9]*#/.test(sk);
const liveSkFromVersionSk = (sk) => sk.replace(/^V#[1-9][0-9]*#/, '');
// A phase is the workflow's organizing tier, defined INLINE in the tree (V2
// treats a phase as a label, not a standalone library object). Order + nesting
// are encoded in the path (01, 01.02), so the same shape expresses phase ▸
// stage ▸ … without a separate "grouping" block type.
const phaseSk = (path, phaseId) => `PHASE#${path}#${phaseId}`;
const placementSk = (stageId) => `PLACEMENT#${stageId}`;
const scopeRefSk = (scopeId) => `SCOPEREF#${scopeId}`;
const ruleRefSk = (layer, id) => `RULEREF#${layer}#${id}`;
const workflowGsi1Pk = (tenant) => `TENANT#${tenant}#${WORKFLOW}`;

const validateId = (id) => {
  if (typeof id !== 'string' || id === '') return 'id is required';
  if (id.length > MAX_ID_LENGTH) return `id exceeds ${MAX_ID_LENGTH} characters`;
  if (!ID_RE.test(id)) return 'id must be kebab-case (lowercase letters, digits, hyphens)';
  return null;
};

const validateName = (name) => {
  if (typeof name !== 'string' || name.trim() === '') return 'name is required';
  if (name.length > MAX_NAME_LENGTH) return `name exceeds ${MAX_NAME_LENGTH} characters`;
  return null;
};

// Validates a phase node as posted by the editor. The phase is defined inline:
// an id + path + free-text name + kind label — no reference to a library block.
const validatePhaseNode = (node) => {
  if (!node || typeof node !== 'object') return 'phase node must be an object';
  if (typeof node.phaseId !== 'string' || !ID_RE.test(node.phaseId)) {
    return 'phase node phaseId must be kebab-case';
  }
  if (typeof node.path !== 'string' || !PATH_RE.test(node.path)) {
    return 'phase node path must look like 01 or 01.02';
  }
  return null;
};

export {
  WORKFLOW,
  META,
  workflowPk,
  workflowVersionPrefix,
  workflowVersionSk,
  isWorkflowVersionSk,
  liveSkFromVersionSk,
  phaseSk,
  placementSk,
  scopeRefSk,
  ruleRefSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validatePhaseNode,
};
export default {
  WORKFLOW,
  META,
  workflowPk,
  workflowVersionPrefix,
  workflowVersionSk,
  isWorkflowVersionSk,
  liveSkFromVersionSk,
  phaseSk,
  placementSk,
  scopeRefSk,
  ruleRefSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validatePhaseNode,
};
