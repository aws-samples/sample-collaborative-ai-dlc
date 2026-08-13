import { describe, expect, it } from 'vitest';
import { projectNativeWorkspace } from '../native-workspace-projector.js';

const input = () => ({
  intent: {
    projectId: 'project-1',
    intentId: 'intent-1',
    title: 'Payment service',
    prompt: 'Add payments',
    scope: 'feature',
    branch: 'aidlc/intent-1',
    workflowId: 'aidlc-v2',
    workflowVersion: 4,
    createdAt: '2026-08-11T10:00:00.000Z',
  },
  upstreamRef: 'abc123',
  harness: 'codex',
  now: '2026-08-11T12:00:00.000Z',
  stages: [
    {
      stageId: 'intent-capture',
      phase: 'ideation',
      number: '1.1',
      leadAgent: 'aidlc-product-agent',
      produces: ['intent'],
    },
    {
      stageId: 'requirements-analysis',
      phase: 'inception',
      number: '2.2',
      leadAgent: 'aidlc-product-agent',
      produces: ['requirements'],
    },
    {
      stageId: 'code-generation',
      phase: 'construction',
      number: '3.5',
      leadAgent: 'aidlc-developer-agent',
      produces: ['code-generation-plan', 'code-summary'],
    },
  ],
  stageRows: [
    { stageInstanceId: 'si-intent', stageId: 'intent-capture', state: 'SUCCEEDED' },
    {
      stageInstanceId: 'si-requirements',
      stageId: 'requirements-analysis',
      phase: 'inception',
      state: 'FAILED',
    },
  ],
  repositories: [
    {
      name: 'checkout-api',
      url: 'git@github.com:example/checkout-api.git',
      branch: 'aidlc/intent-1',
    },
    {
      name: 'checkout-web',
      url: 'git@github.com:example/checkout-web.git',
      branch: 'aidlc/intent-1',
    },
  ],
  artifacts: [
    {
      id: 'artifact-1',
      artifactType: 'requirements',
      stageId: 'requirements-analysis',
      phase: 'inception',
      content: '# Requirements\n',
    },
    {
      id: 'artifact-2',
      artifactType: 'code-summary',
      stageId: 'code-generation',
      phase: 'construction',
      unitSlug: 'payment-api',
      content: '# Summary\n',
    },
  ],
});

describe('projectNativeWorkspace', () => {
  it('builds a resumable native multi-repository workspace', () => {
    const result = projectNativeWorkspace(input());
    expect(result.recordDir).toBe('260811-payment-service');
    expect(result.files.get('aidlc/active-space')).toBe('default\n');
    expect(result.files.get('repos.json')).toContain('"checkout-api"');
    expect(
      result.files.get(
        'aidlc/spaces/default/intents/260811-payment-service/inception/requirements-analysis/requirements.md',
      ),
    ).toBe('# Requirements\n');
    expect(
      result.files.get(
        'aidlc/spaces/default/intents/260811-payment-service/construction/payment-api/code-generation/code-summary.md',
      ),
    ).toBe('# Summary\n');
    const state = result.files.get(
      'aidlc/spaces/default/intents/260811-payment-service/aidlc-state.md',
    );
    expect(state).toContain('- **State Version**: 7');
    expect(state).toContain('- [x] intent-capture — EXECUTE');
    expect(state).toContain('- [-] requirements-analysis — EXECUTE');
    expect(state).toContain('- [ ] code-generation — EXECUTE');
    expect(state).toContain('- **Current Stage**: requirements-analysis');
    expect(state).toContain('- **Project Type**: Unknown');
    expect(result.manifest.source.projectType).toBe('Unknown');
    const root = 'aidlc/spaces/default/intents/260811-payment-service';
    expect(JSON.parse(result.files.get(`${root}/runtime-graph.json`)).stages).toEqual([
      expect.objectContaining({
        stage_slug: 'intent-capture',
        completed_at: expect.any(String),
        agent: 'aidlc-product-agent',
        outcome: 'approved',
      }),
      expect.objectContaining({
        stage_slug: 'requirements-analysis',
        completed_at: null,
        agent: 'aidlc-product-agent',
        outcome: 'pending',
      }),
    ]);
    const audit = result.files.get(`${root}/audit/export.md`);
    expect(audit).toContain(`**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent`);
    expect(audit).toContain(`**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: Imported from Collaborative AI-DLC checkpoint`);
    expect(audit).toContain(`**Event**: STAGE_STARTED
**Stage**: requirements-analysis
**Agent**: aidlc-product-agent`);
    expect(audit).not.toContain('**Stage**: code-generation');
  });

  it('reads an explicit project type from canonical work products', () => {
    const value = input();
    value.artifacts[0].content =
      '# Requirements\n\n| Field | Value |\n| --- | --- |\n| **Request Type** | New Project (Greenfield) |\n';
    const result = projectNativeWorkspace(value);
    const state = result.files.get(
      'aidlc/spaces/default/intents/260811-payment-service/aidlc-state.md',
    );
    expect(state).toContain('- **Project Type**: Greenfield');
  });

  it('uses the recorded workspace classification ahead of fallback evidence', () => {
    const value = input();
    value.intent.projectType = 'brownfield';
    value.artifacts[0].content = '- **Project Type**: Greenfield\n';
    const result = projectNativeWorkspace(value);
    const state = result.files.get(
      'aidlc/spaces/default/intents/260811-payment-service/aidlc-state.md',
    );
    expect(state).toContain('- **Project Type**: Brownfield');
    expect(result.manifest.source.projectType).toBe('Brownfield');
  });

  it('aggregates per-unit rows and reruns a partially successful stage', () => {
    const value = input();
    value.stageRows = [
      { stageId: 'intent-capture', state: 'SUCCEEDED' },
      { stageId: 'requirements-analysis', state: 'SUCCEEDED', unitSlug: 'a' },
      { stageId: 'requirements-analysis', state: 'FAILED', unitSlug: 'b' },
    ];
    const result = projectNativeWorkspace(value);
    expect(result.stages.find((stage) => stage.stageId === 'requirements-analysis').marker).toBe(
      '-',
    );
  });

  it('projects a partial Construction checkpoint with the complete Bolt DAG', () => {
    const value = input();
    value.stages[2].forEach = 'unit-of-work';
    value.stageRows = [
      { stageId: 'intent-capture', state: 'SUCCEEDED' },
      { stageId: 'requirements-analysis', state: 'SUCCEEDED' },
      {
        stageId: 'code-generation',
        unitSlug: 'upload-image',
        state: 'SUCCEEDED',
      },
    ];
    value.unitPlan = {
      units: [
        { slug: 'upload-image', dependsOn: [] },
        { slug: 'identify-plant', dependsOn: ['upload-image'] },
        { slug: 'display-result', dependsOn: ['identify-plant'] },
      ],
      batches: [['upload-image'], ['identify-plant'], ['display-result']],
      walkingSkeleton: 'upload-image',
      autonomyMode: 'gated',
    };
    value.unitRows = [
      {
        slug: 'upload-image',
        sectionIndex: 1,
        state: 'MERGED',
        updatedAt: '2026-08-11T10:00:00.000Z',
      },
      { slug: 'identify-plant', sectionIndex: 1, state: 'PENDING' },
      { slug: 'display-result', sectionIndex: 1, state: 'PENDING' },
    ];

    const result = projectNativeWorkspace(value);
    const root = 'aidlc/spaces/default/intents/260811-payment-service';
    expect(result.files.get(`${root}/aidlc-state.md`)).toContain(
      '- **Construction Autonomy Mode**: gated',
    );
    expect(result.files.get(`${root}/aidlc-state.md`)).toContain('- **Skeleton Stance**: on');
    expect(result.files.get(`${root}/aidlc-state.md`)).toContain('- [-] code-generation — EXECUTE');
    expect(result.files.get(`${root}/aidlc-state.md`)).toContain(
      '- **Last Completed Stage**: code-generation for unit upload-image',
    );
    expect(result.files.get(`${root}/aidlc-state.md`)).toContain(
      '- **Next Action**: Execute code-generation for unit identify-plant',
    );
    expect(result.files.get(`${root}/inception/units-generation/unit-of-work-dependency.md`))
      .toContain(`units:
  - name: upload-image
    depends_on: []
  - name: identify-plant
    depends_on: [upload-image]
  - name: display-result
    depends_on: [identify-plant]`);
    expect(JSON.parse(result.files.get(`${root}/runtime-graph.json`)).bolt_dag).toEqual({
      units: [
        { name: 'upload-image', depends_on: [] },
        { name: 'identify-plant', depends_on: ['upload-image'] },
        { name: 'display-result', depends_on: ['identify-plant'] },
      ],
      batches: [['upload-image'], ['identify-plant'], ['display-result']],
    });
    const audit = result.files.get(`${root}/audit/export.md`);
    expect(audit).toContain('**Event**: WORKFLOW_STARTED');
    expect(audit).toContain(`## Bolt Completed
**Timestamp**: 2026-08-11T10:00:00.000Z
**Event**: BOLT_COMPLETED
**Bolt names**: upload-image
**Batch number**: 1
**Bolt slug**: upload-image`);
    expect(audit).toContain(`## Autonomy Mode Set
**Timestamp**: 2026-08-11T10:00:00.000Z
**Event**: AUTONOMY_MODE_SET
**Mode**: gated`);
    expect(result.manifest.construction).toMatchObject({
      completedUnits: ['upload-image'],
      remainingUnits: ['identify-plant', 'display-result'],
      readyUnits: ['identify-plant'],
      nextUnit: 'identify-plant',
      autonomyMode: 'gated',
      autonomyModeSource: 'cloud',
    });
  });

  it('selects the next dependency-ready unit after multiple merged units', () => {
    const value = input();
    value.unitPlan = {
      units: [
        { slug: 'upload-image', dependsOn: [] },
        { slug: 'identify-plant', dependsOn: ['upload-image'] },
        { slug: 'display-result', dependsOn: ['identify-plant'] },
      ],
      walkingSkeleton: 'upload-image',
    };
    value.unitRows = [
      { slug: 'upload-image', state: 'MERGED' },
      { slug: 'identify-plant', state: 'MERGED' },
      { slug: 'display-result', state: 'PENDING' },
    ];

    const result = projectNativeWorkspace(value);
    expect(result.manifest.construction).toMatchObject({
      completedUnits: ['upload-image', 'identify-plant'],
      readyUnits: ['display-result'],
      nextUnit: 'display-result',
      autonomyMode: 'gated',
      autonomyModeSource: 'export-default',
    });
    const audit = result.files.get(
      'aidlc/spaces/default/intents/260811-payment-service/audit/export.md',
    );
    expect(audit.match(/\*\*Event\*\*: BOLT_COMPLETED/g)).toHaveLength(2);
    expect(audit).toContain(`**Event**: AUTONOMY_MODE_SET
**Mode**: gated`);
    expect(
      result.files.get('aidlc/spaces/default/intents/260811-payment-service/aidlc-state.md'),
    ).toContain('- **Construction Autonomy Mode**: gated');
  });

  it('projects legacy distributions into aidlc-docs', () => {
    const value = input();
    value.workspaceLayout = 'flat';
    value.intent.scope = 'feature-custom';
    value.nativeScope = 'feature-custom';
    value.repositories = [value.repositories[0]];
    const result = projectNativeWorkspace(value);
    expect(result.files.has('aidlc/active-space')).toBe(false);
    expect(result.files.has('repos.json')).toBe(false);
    expect(result.files.get('aidlc-docs/aidlc-state.md')).toContain(
      '- **Current Stage**: requirements-analysis',
    );
    expect(result.files.get('aidlc-docs/aidlc-state.md')).toContain('- **Scope**: feature-custom');
    expect(result.files.get('aidlc-docs/inception/requirements-analysis/requirements.md')).toBe(
      '# Requirements\n',
    );
    expect(
      result.files.get('aidlc-docs/construction/payment-api/code-generation/code-summary.md'),
    ).toBe('# Summary\n');
    expect(result.manifest.native.workspaceLayout).toBe('flat');
    expect(result.manifest.native.scope).toBe('feature-custom');
    expect(result.manifest.source.scope).toBe('feature-custom');
  });

  it('writes the Bolt DAG and audit to legacy flat paths', () => {
    const value = input();
    value.workspaceLayout = 'flat';
    value.repositories = [value.repositories[0]];
    value.unitPlan = {
      units: [
        { slug: 'upload-image', dependsOn: [] },
        { slug: 'identify-plant', dependsOn: ['upload-image'] },
      ],
      batches: [['upload-image'], ['identify-plant']],
    };
    value.unitRows = [
      { slug: 'upload-image', state: 'MERGED' },
      { slug: 'identify-plant', state: 'PENDING' },
    ];

    const result = projectNativeWorkspace(value);
    expect(result.files.get('aidlc-docs/audit.md')).toContain('WORKFLOW_STARTED');
    expect(JSON.parse(result.files.get('aidlc-docs/runtime-graph.json')).bolt_dag.batches).toEqual([
      ['upload-image'],
      ['identify-plant'],
    ]);
    expect(
      result.files.get('aidlc-docs/inception/units-generation/unit-of-work-dependency.md'),
    ).toContain('depends_on: [upload-image]');
  });

  it('reconstructs a pending native question file from a human gate', () => {
    const value = input();
    value.stages.splice(2, 0, {
      stageId: 'units-generation',
      phase: 'inception',
      number: '2.7',
      leadAgent: 'aidlc-architect-agent',
      produces: ['unit-of-work'],
    });
    value.stageRows.push({
      stageInstanceId: 'si-units',
      stageId: 'units-generation',
      phase: 'inception',
      state: 'WAITING_FOR_HUMAN',
    });
    value.humanTasks = [
      {
        humanTaskId: 'q-units',
        stageInstanceId: 'si-units',
        kind: 'question',
        status: 'pending',
        createdAt: '2026-08-11T11:00:00.000Z',
        questions: JSON.stringify([
          {
            text: 'How should units be divided?',
            type: 'single',
            options: [
              { label: 'By service', description: 'One unit per service' },
              { label: 'By feature' },
            ],
          },
        ]),
      },
    ];

    const result = projectNativeWorkspace(value);
    expect(
      result.files.get(
        'aidlc/spaces/default/intents/260811-payment-service/inception/units-generation/units-generation-questions.md',
      ),
    ).toBe(`# Units Generation Questions

## Q1. How should units be divided?

A. By service — One unit per service
B. By feature
X. Other (please specify)

[Answer]:
`);
  });

  it('writes selected labels and free text into reconstructed answers', () => {
    const value = input();
    value.humanTasks = [
      {
        humanTaskId: 'q-requirements',
        stageInstanceId: 'si-requirements',
        kind: 'question',
        status: 'answered',
        questions: [
          {
            text: 'Which interfaces are required?',
            type: 'multi',
            options: [{ label: 'REST' }, { label: 'Events' }],
          },
        ],
        answer: {
          answers: [{ selectedOptions: [0, 1], freeText: 'Webhooks later' }],
        },
      },
    ];

    const result = projectNativeWorkspace(value);
    const questions = result.files.get(
      'aidlc/spaces/default/intents/260811-payment-service/inception/requirements-analysis/requirements-analysis-questions.md',
    );
    expect(questions).toContain('## Q1. Which interfaces are required? (select all that apply)');
    expect(questions).toContain('[Answer]: A. REST, B. Events; Webhooks later');
  });

  it('keeps an existing question artifact authoritative', () => {
    const value = input();
    value.artifacts.push({
      id: 'requirements-questions',
      artifactType: 'requirements-analysis-questions',
      stageId: 'requirements-analysis',
      phase: 'inception',
      content: '# Existing Questions\n',
    });
    value.humanTasks = [
      {
        humanTaskId: 'q-requirements',
        stageInstanceId: 'si-requirements',
        kind: 'question',
        status: 'pending',
        questions: [{ text: 'A newer gate?', type: 'single', options: [] }],
      },
    ];

    const result = projectNativeWorkspace(value);
    expect(
      result.files.get(
        'aidlc/spaces/default/intents/260811-payment-service/inception/requirements-analysis/requirements-analysis-questions.md',
      ),
    ).toBe('# Existing Questions\n');
  });

  it('rejects multi-repository projection for legacy flat distributions', () => {
    const value = input();
    value.workspaceLayout = 'flat';
    expect(() => projectNativeWorkspace(value)).toThrow(/do not support multiple repositories/);
  });

  it('fails instead of inventing a path for an unmappable artifact', () => {
    const value = input();
    value.artifacts.push({
      id: 'broken',
      artifactType: 'mystery',
      stageId: null,
      content: 'x',
    });
    expect(() => projectNativeWorkspace(value)).toThrow(/no native producer stage/);
  });

  it('requires repository attribution for multi-repo reverse engineering', () => {
    const value = input();
    value.artifacts.push({
      id: 'architecture',
      artifactType: 'architecture',
      stageId: 'reverse-engineering',
      phase: 'inception',
      content: '# Architecture',
    });
    expect(() => projectNativeWorkspace(value)).toThrow(/has no repository/);
  });
});
