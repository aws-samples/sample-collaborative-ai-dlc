import { normalizeStagePermissions } from './business-roles.js';

// Platform default responsibilities and Cedar policy text generation. This
// module has no Cedar dependency: the release builder is bundled into most
// workspaces, so policy validation stays in stage-responsibilities.js.

// Stable upstream stage IDs, never display numbers or stage names.
const PO = 'product-owner';
const BA = 'business-analyst';
const A = 'architect';
const UX = 'ux-ui-designer';
const D = 'developer';
const QA = 'qa-tester';
const S = 'security-compliance';
const O = 'operations-devops';
const DM = 'delivery-manager';
const rows = [
  ['workspace-scaffold', [], []],
  ['workspace-detection', [], []],
  ['state-init', [], []],
  ['intent-capture', [PO], [BA, A]],
  ['market-research', [PO], [BA]],
  ['feasibility', [A], [PO, BA, D, O, S]],
  ['scope-definition', [PO], [BA, A, DM]],
  ['team-formation', [DM], [PO, A, D, O]],
  ['rough-mockups', [UX, PO], [BA, D]],
  ['approval-handoff', [PO], [DM, BA, A]],
  ['reverse-engineering', [D], [A]],
  ['practices-discovery', [D], [O, QA, S, A]],
  ['requirements-analysis', [PO], [BA, A, QA, S]],
  ['user-stories', [PO], [BA, UX, D, QA]],
  ['refined-mockups', [UX, PO], [BA, A, D, QA]],
  ['application-design', [A], [BA, UX, D, O, S]],
  ['domain-design', [A], [BA, UX, D, O, S]],
  ['units-generation', [A], [DM, D, QA, O]],
  ['contract-design', [A], [D, O, S, QA]],
  ['delivery-planning', [DM], [PO, A, D, O, QA]],
  ['functional-design', [A], [BA, UX, D, QA, S]],
  ['nfr-requirements', [A, S, O], [PO, D, QA]],
  ['nfr-design', [A, S, O], [PO, D, QA]],
  ['infrastructure-design', [O], [A, D, S]],
  ['code-generation', [D], [A, QA, S]],
  ['build-and-test', [QA, D], [A, S, O]],
  ['ci-pipeline', [O, D], [QA, S]],
  ['deployment-pipeline', [O], [D, A, S, QA]],
  ['environment-provisioning', [O], [A, S, D]],
  ['deployment-execution', [O], [D, QA, S, DM]],
  ['observability-setup', [O], [D, QA, S]],
  ['incident-response', [O], [D, S, A]],
  ['performance-validation', [QA], [D, A, O]],
  ['feedback-optimization', [O], [PO, A, D, QA]],
];

export const DEFAULT_STAGE_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    rows.map(([id, decisionMakerRoles, contributorRoles], index) => [
      id,
      Object.freeze({
        decisionMakerRoles: Object.freeze(decisionMakerRoles),
        contributorRoles: Object.freeze(contributorRoles),
        ...(index < 3 ? { automatic: true } : {}),
      }),
    ]),
  ),
);

const literal = (value) => JSON.stringify(value);
const roleCondition = (roles) =>
  roles.length ? `[${roles.map(literal).join(',')}].containsAny(principal.roles)` : 'false';

// Deterministic policy text for a complete placement list. Callers that can
// load Cedar validate the result (generateStagePolicies).
export const buildStagePolicies = (placements) => {
  const policies = [
    'forbid(principal, action, resource) when { !["owner","member"].contains(principal.membershipRole) };',
  ];
  for (const placement of placements) {
    if (!placement.permissions) continue;
    const p = normalizeStagePermissions(placement.permissions);
    if (p.automatic) continue;
    const resource = `resource == Stage::${literal(placement.stageId)}`;
    const dm = roleCondition(p.decisionMakerRoles);
    const contributors = roleCondition(p.contributorRoles);
    policies.push(
      `permit(principal, action == Action::"decision-maker", ${resource}) when { ${dm} };`,
      `permit(principal, action == Action::"contribute", ${resource}) when { ${contributors} };`,
      `permit(principal, action == Action::"decide", ${resource}) when {
        (context.fallback == "decision-makers" && ${dm}) ||
        (context.fallback == "contributors" && ${contributors}) ||
        (context.fallback == "owners" && principal.membershipRole == "owner")
      };`,
    );
  }
  return policies.join('\n');
};

const defaultPermissions = (stageId) => {
  const defaults = DEFAULT_STAGE_PERMISSIONS[stageId];
  return defaults
    ? {
        decisionMakerRoles: [...defaults.decisionMakerRoles],
        contributorRoles: [...defaults.contributorRoles],
        ...(defaults.automatic ? { automatic: true } : {}),
      }
    : null;
};

/**
 * Adds the platform default responsibilities to a release catalog: each STAGE
 * block and workflow placement gets its stable-ID mapping (null when the stage
 * has none), and the workflow gets the policy text generated from those
 * placements. Applied once at import, so the closure digest covers the result.
 */
export const withStageResponsibilities = (catalog) => {
  const placements = (catalog.workflow.placements ?? []).map((placement) => ({
    ...placement,
    permissions: placement.permissions ?? defaultPermissions(placement.stageId),
  }));
  return {
    ...catalog,
    workflow: {
      ...catalog.workflow,
      placements,
      cedarPolicies: buildStagePolicies(placements),
    },
    blocks: {
      ...catalog.blocks,
      ...(catalog.blocks.STAGE
        ? {
            STAGE: catalog.blocks.STAGE.map((stage) => ({
              ...stage,
              permissions: stage.permissions ?? defaultPermissions(stage.blockId ?? stage.id),
            })),
          }
        : {}),
    },
  };
};
