'use strict';

// Shared data-layer helpers for workflows — the composition roots that
// reference and arrange library blocks. Workflows share the blocks table:
//   PK = WF#<tenant>#<workflowId>
//   SK = META                              workflow header
//   SK = GROUPING#<path>#<groupingId>      ordered, nestable grouping ref
//   SK = PLACEMENT#<skillId>               a placed skill (workflow × skill join)
//   SK = SCOPEREF#<scopeId>                a scope available in this workflow
//   SK = GUARDRAILREF#<layer>#<id>         a guardrail layered into this workflow
// One Query(PK = WF#…) loads the whole composition. Listing reuses the blocks
// catalog index: GSI1PK = TENANT#<tenant>#WORKFLOW on the META item.

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab-case
const PATH_RE = /^[0-9]{2}(?:\.[0-9]{2})*$/; // 01 | 01.02 | 01.02.03

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;

const WORKFLOW = 'WORKFLOW';
const META = 'META';

const workflowPk = (tenant, workflowId) => `WF#${tenant}#${workflowId}`;
const groupingSk = (path, groupingId) => `GROUPING#${path}#${groupingId}`;
const placementSk = (skillId) => `PLACEMENT#${skillId}`;
const scopeRefSk = (scopeId) => `SCOPEREF#${scopeId}`;
const guardrailRefSk = (layer, id) => `GUARDRAILREF#${layer}#${id}`;
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

// Validates a grouping-tree node ref as posted by the editor.
const validateGroupingNode = (node) => {
  if (!node || typeof node !== 'object') return 'grouping node must be an object';
  if (typeof node.groupingId !== 'string' || !ID_RE.test(node.groupingId)) {
    return 'grouping node groupingId must be kebab-case';
  }
  if (typeof node.path !== 'string' || !PATH_RE.test(node.path)) {
    return 'grouping node path must look like 01 or 01.02';
  }
  return null;
};

module.exports = {
  WORKFLOW,
  META,
  workflowPk,
  groupingSk,
  placementSk,
  scopeRefSk,
  guardrailRefSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validateGroupingNode,
};
