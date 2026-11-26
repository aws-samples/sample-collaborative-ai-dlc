import expectedRows from './fixtures/stage-responsibilities.json' with { type: 'json' };
import { describe, expect, it, vi } from 'vitest';
import { BUSINESS_ROLES, combineMemberRoles } from '../business-roles.js';
import {
  DEFAULT_STAGE_PERMISSIONS,
  generateStagePolicies,
  resolveStageResponsibilities,
  previewStageResponsibilities,
  assertWorkflowItemSize,
  normalizeStagePermissions,
} from '../stage-responsibilities.js';
import { createSsoRoleResolver } from '../member-role-resolver.js';
import { loadWorkflowComposition } from '../v2-workflow-plan.js';
import { assembleWorkflow as assembleRuntimeWorkflow } from '../engine-catalog.js';

const member = (userId, effectiveRoles = [], membershipRole = 'member') => ({
  userId,
  effectiveRoles,
  membershipRole,
});
const makeWorkflow = (placements) => ({
  workflowId: 'flow',
  workflowVersion: 7,
  placements,
  cedarPolicies: generateStagePolicies(placements),
});
const requirements = {
  stageId: 'requirements-analysis',
  permissions: DEFAULT_STAGE_PERMISSIONS['requirements-analysis'],
};

describe('stage responsibilities through stored Cedar policies', () => {
  it('exposes the same resolver to enforcement without preview response metadata', () => {
    const options = {
      workflow: makeWorkflow([requirements]),
      members: [member('po', ['product-owner'])],
    };
    const resolved = resolveStageResponsibilities(options);
    expect(resolved).not.toHaveProperty('previewOnly');
    expect(previewStageResponsibilities(options)).toEqual({
      ...resolved,
      previewOnly: true,
      roles: BUSINESS_ROLES,
    });
  });

  it.each(expectedRows.map(({ stageId, ...permissions }) => [stageId, permissions]))(
    'evaluates every catalog role for %s',
    (stageId, expectedPermissions) => {
      const permissions = DEFAULT_STAGE_PERMISSIONS[stageId];
      expect(permissions.decisionMakerRoles.toSorted()).toEqual(
        expectedPermissions.decisionMakerRoles.toSorted(),
      );
      expect(permissions.contributorRoles.toSorted()).toEqual(
        expectedPermissions.contributorRoles.toSorted(),
      );
      expect(Boolean(permissions.automatic)).toBe(Boolean(expectedPermissions.automatic));
      const workflow = makeWorkflow([{ stageId, permissions }]);
      const members = BUSINESS_ROLES.map(({ id }) => member(id, [id]));
      const [stage] = previewStageResponsibilities({ workflow, members }).stages;
      expect(stage.decisionMakers.map((p) => p.userId).toSorted()).toEqual(
        permissions.decisionMakerRoles.toSorted(),
      );
      expect(stage.contributors.map((p) => p.userId).toSorted()).toEqual(
        permissions.contributorRoles.toSorted(),
      );
      expect(stage.reason).toBe(permissions.automatic ? 'automatic' : 'decision-makers');
    },
  );

  it('selects both Product Owners and does not include Viewers or unrelated members', () => {
    const workflow = makeWorkflow([requirements]);
    const result = previewStageResponsibilities({
      workflow,
      members: [
        member('po1', ['product-owner', 'business-analyst']),
        member('po2', ['product-owner']),
        member('viewer', ['product-owner'], 'viewer'),
        member('owner', [], 'owner'),
        member('unrelated', ['developer']),
      ],
    });
    expect(result.stages[0].decisionMakers.map((p) => p.userId)).toEqual(['po1', 'po2']);
    expect(result.stages[0].contributors.map((p) => p.userId)).toEqual(['po1']);
    expect(result.stages[0].decisionMakers).toMatchObject([
      { userId: 'po1', roles: ['product-owner', 'business-analyst'] },
      { userId: 'po2', roles: ['product-owner'] },
    ]);
    expect(result.stages[0].contributors).toMatchObject([
      { userId: 'po1', roles: ['product-owner', 'business-analyst'] },
    ]);
    expect(result).toMatchObject({ workflowVersion: 7, previewOnly: true });
  });

  it('uses only listed Contributors, then Owners when both groups are absent', () => {
    const workflow = makeWorkflow([requirements]);
    const members = [
      member('ba', ['business-analyst']),
      member('owner', [], 'owner'),
      member('dev', ['developer']),
    ];
    expect(previewStageResponsibilities({ workflow, members }).stages[0]).toMatchObject({
      reason: 'contributors',
      decisionMakers: [{ userId: 'ba', roles: ['business-analyst'] }],
    });
    members[0].membershipRole = 'viewer';
    expect(previewStageResponsibilities({ workflow, members }).stages[0]).toMatchObject({
      reason: 'owners',
      decisionMakers: [{ userId: 'owner', roles: [] }],
      contributors: [],
    });
    expect(
      previewStageResponsibilities({ workflow, members: [] }).stages[0].decisionMakers,
    ).toEqual([]);
  });

  it('keeps exclusions independent of local assignments', () => {
    const effectiveRoles = combineMemberRoles({
      ssoRoles: ['product-owner', 'architect'],
      excludedRoles: ['product-owner'],
      localRoles: ['product-owner'],
    });
    expect(
      previewStageResponsibilities({
        workflow: makeWorkflow([requirements]),
        members: [member('po', effectiveRoles)],
      }).stages[0].reason,
    ).toBe('decision-makers');
  });

  it('keeps repeated stage instances distinct and never infers a custom mapping from names', () => {
    const workflow = makeWorkflow([requirements, { stageId: 'custom' }]);
    const result = previewStageResponsibilities({
      workflow,
      members: [member('po', ['product-owner'])],
      stages: [
        { stageId: 'requirements-analysis', stageInstanceId: 'si-unit-a' },
        { stageId: 'requirements-analysis', stageInstanceId: 'si-unit-b' },
        { stageId: 'custom', name: 'Requirements Analysis' },
      ],
    });
    expect(result.stages.map((s) => s.stageInstanceId)).toEqual(['si-unit-a', 'si-unit-b', null]);
    expect(result.stages[2]).toMatchObject({
      reason: 'unmapped',
      decisionMakers: [],
    });
  });

  it('evaluates saved policy bytes even when a later generator would select other people', () => {
    const workflow = makeWorkflow([
      {
        stageId: requirements.stageId,
        permissions: {
          decisionMakerRoles: ['architect'],
          contributorRoles: [],
        },
      },
    ]);
    // Editing the input mapping cannot regenerate the stored policy on read/restart.
    workflow.placements = [requirements];
    const members = [member('architect', ['architect']), member('po', ['product-owner'])];
    expect(previewStageResponsibilities({ workflow, members }).stages[0].decisionMakers).toEqual([
      { userId: 'architect', name: undefined, email: undefined, roles: ['architect'] },
    ]);
  });

  it.each([
    null,
    '',
    'permit broken syntax',
    'permit(principal,action,resource) when { principal.unknown };',
  ])('refuses missing or invalid stored policies (%s)', (cedarPolicies) => {
    expect(() =>
      previewStageResponsibilities({
        workflow: { ...makeWorkflow([requirements]), cedarPolicies },
        members: [member('owner', [], 'owner')],
      }),
    ).toThrow();
  });

  it('rejects invalid role lists and oversized metadata before writing', () => {
    expect(() =>
      normalizeStagePermissions({
        decisionMakerRoles: ['made-up'],
        contributorRoles: [],
      }),
    ).toThrow();
    expect(() => assertWorkflowItemSize({ cedarPolicies: 'x'.repeat(350_001) })).toThrow();
  });

  it('loads every workflow version page and carries policies through both runtime assemblers', async () => {
    const workflow = makeWorkflow([requirements]);
    const rows = [
      { sk: 'V#7#META', cedarPolicies: workflow.cedarPolicies },
      { sk: 'V#7#PLACEMENT#requirements-analysis', ...requirements },
    ];
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: rows.slice(0, 1),
          LastEvaluatedKey: { pk: 'WF#default#flow', sk: 'V#7#META' },
        })
        .mockResolvedValueOnce({ Items: rows.slice(1) }),
    };
    const loaded = await loadWorkflowComposition({
      ddb,
      tableName: 'blocks',
      workflowId: 'flow',
      workflowVersion: 7,
    });
    expect(loaded).toMatchObject({
      cedarPolicies: workflow.cedarPolicies,
      placements: [requirements],
    });
    expect(ddb.send.mock.calls.every(([command]) => command.input.ConsistentRead)).toBe(true);
    expect(assembleRuntimeWorkflow(rows, { workflowId: 'flow', workflowVersion: 7 })).toMatchObject(
      {
        cedarPolicies: workflow.cedarPolicies,
        placements: [requirements],
      },
    );
  });
});

describe('request-scoped SSO resolution for offline members', () => {
  it('reuses the trusted provider mapping and propagates failed reads', async () => {
    vi.stubEnv(
      'SSO_ROLE_CONFIG',
      JSON.stringify({
        providers: { Entra: { roleClaim: 'groups', roleMappings: { architect: ['baseline'] } } },
      }),
    );
    const store = {
      getSsoClaims: vi.fn(async () => ({
        providerName: 'Entra',
        sourceAttribute: 'groups',
        claimValues: ['group', 'baseline'],
      })),
      getRoleMappings: vi.fn().mockResolvedValue({ 'product-owner': ['group'] }),
    };
    try {
      const resolver = createSsoRoleResolver({ store });
      expect(
        await Promise.all([resolver.forUser('offline-a'), resolver.forUser('offline-b')]),
      ).toEqual([
        ['architect', 'product-owner'],
        ['architect', 'product-owner'],
      ]);
      expect(store.getRoleMappings).toHaveBeenCalledTimes(1);
      store.getRoleMappings.mockRejectedValue(new Error('Unavailable'));
      await expect(createSsoRoleResolver({ store }).forUser('offline')).rejects.toThrow(
        'Unavailable',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
