import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStageResponsibilities } from '../stage-responsibilities.js';
import {
  DEFAULT_STAGE_PERMISSIONS,
  generateStagePolicies,
} from '../../shared/stage-responsibilities.js';
import { stageInstanceId } from '../../shared/v2-execution-plan.js';
import { withStageResponsibilities } from '../../shared/stage-responsibility-defaults.js';

const loadPlan = vi.hoisted(() => vi.fn());
vi.mock('../../shared/intent-methodology.js', async (original) => ({
  ...(await original()),
  createIntentMethodologyLoader: () => ({ loadPlan }),
}));
const releaseWorkflow = vi.hoisted(() => ({ current: null }));
vi.mock('../../shared/v2-workflow-plan.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    loadWorkflowComposition: (options) =>
      options.methodologyRelease
        ? Promise.resolve(releaseWorkflow.current)
        : actual.loadWorkflowComposition(options),
  };
});

const placement = {
  sk: 'V#3#PLACEMENT#requirements-analysis',
  stageId: 'requirements-analysis',
  permissions: DEFAULT_STAGE_PERMISSIONS['requirements-analysis'],
  scopeMembership: { feature: 'EXECUTE' },
  order: 1,
};
const policies = generateStagePolicies([placement]);
const event = {
  pathParameters: { projectId: 'space' },
  queryStringParameters: { workflowId: 'flow', version: '3' },
};
const g = {
  V: () => ({
    has: () => ({
      valueMap: () => ({
        next: async () => ({ value: new Map([['email', ['person@example.com']]]) }),
      }),
    }),
  }),
};
const ddb = { send: vi.fn() };
const store = { listMembers: vi.fn() };
const resolveRoles = { forUser: vi.fn() };
const load = (request = event) =>
  getStageResponsibilities({ event: request, g, ddb, store, resolveRoles });

beforeEach(() => {
  vi.stubEnv('BLOCKS_TABLE', 'blocks');
  vi.stubEnv('V2_EXECUTIONS_TABLE', 'executions');
  ddb.send.mockReset().mockResolvedValue({
    Items: [{ sk: 'V#3#META', cedarPolicies: policies }, placement],
  });
  store.listMembers.mockReset().mockResolvedValue({
    items: [{ userId: 'owner', membershipRole: 'owner' }],
    nextToken: null,
  });
  resolveRoles.forUser.mockReset().mockResolvedValue([]);
  loadPlan.mockReset();
  releaseWorkflow.current = null;
});

it('shows a section decision only to Owners and members who can decide for all its stages', async () => {
  const stages = ['product-owner', 'business-analyst'].map((role) => ({
    sk: `V#3#PLACEMENT#${role}`,
    stageId: role,
    parallelSection: 1,
    permissions: { decisionMakerRoles: [role], contributorRoles: [] },
  }));
  loadPlan.mockResolvedValue({ valid: true, plan: { stages } });
  ddb.send.mockImplementation(async ({ input }) => {
    if (input.Key)
      return {
        Item:
          input.Key.sk === 'META'
            ? { projectId: 'space', workflowId: 'flow', workflowVersion: 3 }
            : null,
      };
    if (input.ExpressionAttributeValues[':pk'].startsWith('WF#'))
      return {
        Items: [{ sk: 'V#3#META', cedarPolicies: generateStagePolicies(stages) }, ...stages],
      };
    return {
      Items:
        input.ExpressionAttributeValues[':prefix'] === 'HUMAN#'
          ? [{ humanTaskId: 'retry', sectionIndex: 1, stageInstanceId: null }]
          : [],
    };
  });
  store.listMembers.mockResolvedValue({
    items: [
      { userId: 'owner', membershipRole: 'owner' },
      { userId: 'product', membershipRole: 'member', localRoles: ['product-owner'] },
      {
        userId: 'both',
        membershipRole: 'member',
        localRoles: ['product-owner', 'business-analyst'],
      },
    ],
    nextToken: null,
  });
  const result = await load({
    ...event,
    queryStringParameters: { intentId: 'intent', actorAccess: 'true' },
    requestContext: { authorizer: { claims: { sub: 'product' } } },
  });
  expect(result.sectionGates.retry.access).toEqual({ edit: false, decide: false });
  expect(result.sectionGates.retry.decisionMakers.map((m) => m.userId)).toEqual(['owner', 'both']);
});

it.each([
  ['owner', true],
  ['member', true],
  ['viewer', false],
])('uses the %s space rights for an existing intent in advisory mode', async (actorRole, write) => {
  const request = {
    pathParameters: { projectId: 'space' },
    queryStringParameters: { intentId: 'intent', actorAccess: 'true' },
  };
  const meta = { projectId: 'space', workflowId: 'flow', workflowVersion: 1 };
  ddb.send.mockImplementation(async ({ input }) => ({
    Item: input.Key.sk === 'META' ? meta : { enabled: input.Key.pk !== 'SPACE#space' },
  }));
  const loadActor = () =>
    getStageResponsibilities({ event: request, g, ddb, store, resolveRoles, actorRole });
  expect(await loadActor()).toMatchObject({
    enforceStageRoles: false,
    unattributedAccess: { edit: write, decide: write },
  });
  expect(store.listMembers).not.toHaveBeenCalled();
  meta.projectId = 'another-space';
  await expect(loadActor()).rejects.toMatchObject({ statusCode: 404 });
});

describe('release-pinned intents', () => {
  const upstreamWorkflow = {
    id: 'aidlc-v2',
    workflowVersion: 1,
    placements: [{ stageId: 'requirements-analysis', order: 1, scopeMembership: {} }],
  };
  const pinnedMeta = {
    projectId: 'space',
    workflowId: 'aidlc-v2',
    workflowVersion: 1,
    methodologyRelease: { releaseId: 'aidlc-v2.11.3', importerRevision: 5 },
  };
  const request = { ...event, queryStringParameters: { intentId: 'intent' } };
  const actorRequest = {
    ...request,
    queryStringParameters: { ...request.queryStringParameters, actorAccess: 'true' },
    requestContext: { authorizer: { claims: { sub: 'po' } } },
  };
  beforeEach(() => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'artifacts');
    loadPlan.mockResolvedValue({
      valid: true,
      plan: { stages: [{ stageId: 'requirements-analysis', stageInstanceId: 'si-req' }] },
    });
    ddb.send.mockImplementation(async (command) =>
      command.input.Key ? { Item: pinnedMeta } : { Items: [] },
    );
    store.listMembers.mockResolvedValue({
      items: [
        { userId: 'owner', membershipRole: 'owner' },
        { userId: 'po', membershipRole: 'member', localRoles: ['product-owner'] },
      ],
      nextToken: null,
    });
  });

  it('evaluates the responsibilities stored in the release closure', async () => {
    releaseWorkflow.current = withStageResponsibilities({
      workflow: upstreamWorkflow,
      blocks: {},
    }).workflow;
    const preview = await load(request);
    expect(preview.stages).toMatchObject([
      {
        stageInstanceId: 'si-req',
        reason: 'decision-makers',
        decisionMakers: [{ userId: 'po' }],
      },
    ]);
  });

  it('explains that a closure imported before responsibilities defines none', async () => {
    releaseWorkflow.current = upstreamWorkflow;
    await expect(load(request)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('predates stage responsibilities'),
    });
    expect(store.listMembers).not.toHaveBeenCalled();
  });

  it('keeps member access on a draft pinned before responsibilities, without loading a plan', async () => {
    releaseWorkflow.current = upstreamWorkflow;
    ddb.send.mockResolvedValue({ Item: { ...pinnedMeta, status: 'DRAFT' } });
    const result = await load(actorRequest);
    const access = { edit: true, decide: true };
    expect(result).toMatchObject({
      stages: [{ stageInstanceId: null, access }],
      sectionGates: {},
      unattributedAccess: access,
    });
    expect(loadPlan).not.toHaveBeenCalled();
  });

  it('includes past instances and unselected placements only when looking up actor access', async () => {
    releaseWorkflow.current = withStageResponsibilities({
      workflow: {
        ...upstreamWorkflow,
        placements: [...upstreamWorkflow.placements, { stageId: 'extra', order: 2 }],
      },
      blocks: {},
    }).workflow;
    ddb.send.mockImplementation(async ({ input }) => {
      if (input.Key) return { Item: input.Key.sk === 'META' ? pinnedMeta : undefined };
      const rows = {
        'STAGE#': [{ sk: 'STAGE#past', stageId: 'requirements-analysis', unitSlug: 'old-unit' }],
        'HUMAN#': [{ humanTaskId: 'answered', stageInstanceId: 'past' }],
      };
      return { Items: rows[input.ExpressionAttributeValues[':prefix']] };
    });
    const preview = await load(request);
    expect(preview.stages.map((stage) => stage.stageInstanceId)).toEqual(['si-req']);
    expect(preview.stages[0]).not.toHaveProperty('access');
    expect(preview).not.toHaveProperty('sectionGates');
    const actor = await load(actorRequest);
    expect(actor.stages).toMatchObject([
      { stageInstanceId: 'si-req', access: { decide: true } },
      { stageInstanceId: 'past', gateIds: ['answered'], access: { decide: true } },
      { stageId: 'extra', stageInstanceId: null },
    ]);
    expect(actor).not.toHaveProperty('unattributedAccess');
  });
});

describe('responsibilities member reads', () => {
  it.each([3, null])(
    'uses the space configuration without browser workflow overrides (pin: %s)',
    async (pin) => {
      const version = pin ?? 8;
      const configuredGraph = {
        V: () => ({
          has: () => ({
            valueMap: (...fields) => ({
              next: async () => ({
                value: fields.length
                  ? new Map([['email', ['person@example.com']]])
                  : new Map([
                      ['workflow_id', ['configured-flow']],
                      ['workflow_version', [pin]],
                    ]),
              }),
            }),
          }),
        }),
      };
      ddb.send.mockImplementation(async (command) =>
        command.input.Key
          ? { Item: { version: 8 } }
          : {
              Items: [
                { sk: `V#${version}#META`, cedarPolicies: policies },
                { ...placement, sk: `V#${version}#PLACEMENT#requirements-analysis` },
              ],
            },
      );
      const result = await getStageResponsibilities({
        event: { pathParameters: { projectId: 'space' } },
        g: configuredGraph,
        ddb,
        store,
        resolveRoles,
      });
      expect(result).toMatchObject({ workflowId: 'configured-flow', workflowVersion: version });
      expect(ddb.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            ExpressionAttributeValues: {
              ':pk': 'WF#default#configured-flow',
              ':v': `V#${version}#`,
            },
          }),
        }),
      );
    },
  );

  it('omits unit instances the orchestrator skips because no output applies to the unit kind', async () => {
    const stage = {
      sk: 'V#3#PLACEMENT#functional-design',
      stageId: 'functional-design',
      permissions: DEFAULT_STAGE_PERMISSIONS['functional-design'],
      execution: 'ALWAYS',
      parallelSection: 2,
      outputArtifacts: [{ artifact: 'frontend-components' }],
      producesKinds: { 'frontend-components': ['ui'] },
    };
    loadPlan.mockResolvedValue({ valid: true, plan: { namespace: 'flow@3', stages: [stage] } });
    ddb.send.mockImplementation(async (command) => {
      if (command.input.Key)
        return {
          Item:
            command.input.Key.sk === 'UNITPLAN'
              ? {
                  units: [
                    { slug: 'backend', kind: 'service' },
                    { slug: 'web', kind: 'ui' },
                  ],
                }
              : { projectId: 'space', workflowId: 'flow', workflowVersion: 3 },
        };
      if (command.input.ExpressionAttributeValues[':pk'].startsWith('WF#'))
        return {
          Items: [{ sk: 'V#3#META', cedarPolicies: generateStagePolicies([stage]) }, stage],
        };
      return { Items: [] };
    });
    const preview = await load({ ...event, queryStringParameters: { intentId: 'intent' } });
    expect(preview.stages.map((row) => row.stageInstanceId)).toEqual([
      stageInstanceId('flow@3', stage.stageId, 'web', 2),
    ]);
  });

  it.each([
    { execution: 'CONDITIONAL', skipMatrix: { backend: ['functional-design'] }, skipped: true },
    { execution: 'ALWAYS', skipMatrix: { backend: ['functional-design'] }, skipped: false },
    { execution: 'CONDITIONAL', skipMatrix: undefined, skipped: false },
    { execution: 'CONDITIONAL', skipMatrix: { backend: ['code-generation'] }, skipped: false },
  ])(
    'honors per-unit skips only for CONDITIONAL stages ($execution, skipped: $skipped)',
    async ({ execution, skipMatrix, skipped }) => {
      const stage = {
        sk: 'V#3#PLACEMENT#functional-design',
        stageId: 'functional-design',
        permissions: DEFAULT_STAGE_PERMISSIONS['functional-design'],
        execution,
        parallelSection: 2,
      };
      const backendId = stageInstanceId('flow@3', stage.stageId, 'backend', 2);
      const frontendId = stageInstanceId('flow@3', stage.stageId, 'frontend', 2);
      loadPlan.mockResolvedValue({
        valid: true,
        plan: { namespace: 'flow@3', stages: [stage] },
      });
      ddb.send.mockImplementation(async (command) => {
        if (command.input.Key)
          return {
            Item:
              command.input.Key.sk === 'UNITPLAN'
                ? { units: [{ slug: 'backend' }, { slug: 'frontend' }], skipMatrix }
                : { projectId: 'space', workflowId: 'flow', workflowVersion: 3 },
          };
        const values = command.input.ExpressionAttributeValues;
        if (values[':pk'].startsWith('WF#'))
          return {
            Items: [{ sk: 'V#3#META', cedarPolicies: generateStagePolicies([stage]) }, stage],
          };
        if (values[':prefix'] === 'STAGE#')
          return {
            Items: [
              {
                sk: `STAGE#${backendId}`,
                stageId: stage.stageId,
                unitSlug: 'backend',
                sectionIndex: 2,
                state: skipped ? 'SKIPPED' : 'RUNNING',
              },
            ],
          };
        return { Items: [] };
      });
      const request = { ...event, queryStringParameters: { intentId: 'intent' } };
      const preview = await load(request);
      expect(preview.stages.map((row) => row.stageInstanceId)).toEqual(
        skipped ? [frontendId] : [backendId, frontendId],
      );
      expect(preview.stages.every((row) => row.decisionMakers.length > 0)).toBe(true);
      const selected = load({
        ...request,
        queryStringParameters: { intentId: 'intent', stageInstanceId: backendId },
      });
      if (skipped) await expect(selected).rejects.toMatchObject({ statusCode: 400 });
      else expect((await selected).stages[0].stageInstanceId).toBe(backendId);
    },
  );

  it.each([
    { startedCount: 0, legacy: false },
    { startedCount: 1, legacy: false },
    { startedCount: 2, legacy: false },
    { startedCount: 1, legacy: true },
  ])(
    'shows selected units with $startedCount started (legacy: $legacy)',
    async ({ startedCount, legacy }) => {
      const namespace = 'flow@3';
      const unitA = stageInstanceId(namespace, 'code-generation', 'backend', legacy ? null : 2);
      const unitB = stageInstanceId(namespace, 'code-generation', 'frontend', 2);
      const code = {
        sk: 'V#3#PLACEMENT#code-generation',
        stageId: 'code-generation',
        permissions: DEFAULT_STAGE_PERMISSIONS['code-generation'],
      };
      const pinnedMeta = {
        projectId: 'space',
        workflowId: 'flow',
        workflowVersion: 3,
        scope: 'feature',
      };
      let selectedUnitPlan = { units: [{ slug: 'backend' }, { slug: 'frontend' }] };
      loadPlan.mockResolvedValue({
        valid: true,
        plan: {
          namespace,
          stages: [
            { stageId: 'requirements-analysis', stageInstanceId: 'si-req' },
            {
              stageId: 'code-generation',
              stageInstanceId: 'si-code',
              forEach: 'unit-of-work',
              parallelSection: 2,
            },
          ],
        },
      });
      ddb.send.mockImplementation(async (command) => {
        if (command.input.Key)
          return {
            Item: command.input.Key.sk === 'UNITPLAN' ? selectedUnitPlan : pinnedMeta,
          };
        const values = command.input.ExpressionAttributeValues;
        if (values[':pk'].startsWith('WF#'))
          return {
            Items: [
              { sk: 'V#3#META', cedarPolicies: generateStagePolicies([placement, code]) },
              placement,
              code,
            ],
          };
        if (values[':prefix'] === 'STAGE#')
          return {
            Items: [
              { sk: 'STAGE#si-req', stageId: 'requirements-analysis' },
              ...[
                {
                  sk: `STAGE#${unitA}`,
                  stageId: 'code-generation',
                  unitSlug: 'backend',
                  sectionIndex: legacy ? null : 2,
                },
                {
                  sk: `STAGE#${unitB}`,
                  stageId: 'code-generation',
                  unitSlug: 'frontend',
                  sectionIndex: 2,
                },
              ].slice(0, startedCount),
            ],
          };
        return {
          Items: [
            { humanTaskId: 'gate-a', stageInstanceId: unitA },
            { humanTaskId: 'gate-b', stageInstanceId: unitB },
          ].slice(0, startedCount),
        };
      });
      store.listMembers.mockResolvedValue({
        items: [
          { userId: 'po', membershipRole: 'member', localRoles: ['product-owner'] },
          { userId: 'dev', membershipRole: 'member', localRoles: ['developer'] },
        ],
      });
      const preview = await load({
        ...event,
        queryStringParameters: {
          intentId: 'intent',
          workflowId: 'altered',
          version: '999',
        },
      });
      expect(loadPlan).toHaveBeenCalledWith(pinnedMeta);
      expect(preview).toMatchObject({ workflowId: 'flow', workflowVersion: 3 });
      expect(preview.stages).toMatchObject([
        { stageInstanceId: 'si-req', gateIds: [], decisionMakers: [{ userId: 'po' }] },
        {
          stageInstanceId: unitA,
          gateIds: startedCount > 0 ? ['gate-a'] : [],
          decisionMakers: [{ userId: 'dev' }],
        },
        {
          stageInstanceId: unitB,
          gateIds: startedCount > 1 ? ['gate-b'] : [],
          decisionMakers: [{ userId: 'dev' }],
        },
      ]);
      const selected = await load({
        ...event,
        queryStringParameters: {
          intentId: 'intent',
          stageInstanceId: unitB,
        },
      });
      expect(selected.stages).toHaveLength(1);
      expect(selected.stages[0].stageInstanceId).toBe(unitB);
      expect(selected.stages[0].gateIds).toEqual(startedCount > 1 ? ['gate-b'] : []);
      expect(ddb.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Key: { pk: 'EXEC#intent', sk: 'UNITPLAN' },
            ConsistentRead: true,
          }),
        }),
      );
      selectedUnitPlan = { units: [{ slug: 'frontend' }] };
      const afterUnitRemoval = await load({
        ...event,
        queryStringParameters: { intentId: 'intent' },
      });
      expect(afterUnitRemoval.stages.map((stage) => stage.stageInstanceId)).toEqual([
        'si-req',
        unitB,
      ]);
      await expect(
        load({
          ...event,
          queryStringParameters: { intentId: 'intent', stageInstanceId: unitA },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      selectedUnitPlan = undefined;
      const beforePromotion = await load({
        ...event,
        queryStringParameters: { intentId: 'intent' },
      });
      expect(beforePromotion.stages.map((stage) => stage.stageInstanceId)).toEqual([
        'si-req',
        'si-code',
      ]);
    },
  );

  it('a Product Owner on a later page prevents fallback', async () => {
    store.listMembers
      .mockResolvedValueOnce({
        items: [{ userId: 'owner', membershipRole: 'owner' }],
        nextToken: 'page-2',
      })
      .mockResolvedValueOnce({ items: [], nextToken: 'page-3' })
      .mockResolvedValueOnce({
        items: [{ userId: 'po', membershipRole: 'member', localRoles: ['product-owner'] }],
        nextToken: null,
      });
    expect((await load()).stages[0]).toMatchObject({
      reason: 'decision-makers',
      decisionMakers: [{ userId: 'po' }],
    });
    expect(store.listMembers.mock.calls).toEqual([
      ['space', undefined],
      ['space', 'page-2'],
      ['space', 'page-3'],
    ]);
  });

  it('membership and SSO read failures cannot activate fallback', async () => {
    store.listMembers
      .mockResolvedValueOnce({
        items: [{ userId: 'owner', membershipRole: 'owner' }],
        nextToken: 'page-2',
      })
      .mockRejectedValueOnce(new Error('Failed membership page'));
    await expect(load()).rejects.toThrow('Failed membership page');
    resolveRoles.forUser.mockRejectedValue(new Error('Failed identity'));
    await expect(load()).rejects.toThrow('Failed identity');
  });

  it('reflects current role exclusions, Viewer changes, and member removal on every request', async () => {
    resolveRoles.forUser.mockResolvedValue(['product-owner']);
    const po = { userId: 'po', membershipRole: 'member', excludedRoles: [] };
    const owner = { userId: 'owner', membershipRole: 'owner', excludedRoles: ['product-owner'] };
    store.listMembers.mockResolvedValue({ items: [owner, po], nextToken: null });
    expect((await load()).stages[0].reason).toBe('decision-makers');
    po.excludedRoles = ['product-owner'];
    expect((await load()).stages[0].reason).toBe('owners');
    po.localRoles = ['product-owner'];
    expect((await load()).stages[0].reason).toBe('decision-makers');
    po.membershipRole = 'viewer';
    expect((await load()).stages[0].reason).toBe('owners');
    store.listMembers.mockResolvedValue({ items: [owner], nextToken: null });
    expect((await load()).stages[0].decisionMakers.map((p) => p.userId)).toEqual(['owner']);
  });

  it('lists stages in composer order: by phase, then by position within the phase', async () => {
    const at = (stageId, phasePath, order) => ({
      ...placement,
      sk: `V#3#PLACEMENT#${stageId}`,
      stageId,
      phasePath,
      order,
    });
    const placements = [
      at('code-generation', '03', 0),
      at('requirements-analysis', '02', 1),
      at('build-and-test', '03', 1),
      at('workspace-detection', '02', 0),
    ];
    ddb.send.mockResolvedValue({
      Items: [{ sk: 'V#3#META', cedarPolicies: generateStagePolicies(placements) }, ...placements],
    });
    expect((await load()).stages.map((stage) => stage.stageId)).toEqual([
      'workspace-detection',
      'requirements-analysis',
      'code-generation',
      'build-and-test',
    ]);
  });

  it('rejects another space intent, invalid version, unknown scope, and altered stage instance', async () => {
    ddb.send.mockResolvedValueOnce({ Item: { projectId: 'other' } });
    await expect(
      load({ ...event, queryStringParameters: { intentId: 'wrong' } }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      load({ ...event, queryStringParameters: { workflowId: 'flow', version: '-1' } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      load({ ...event, queryStringParameters: { ...event.queryStringParameters, scope: 'bad' } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      load({
        ...event,
        queryStringParameters: { ...event.queryStringParameters, stageInstanceId: 'wrong' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
