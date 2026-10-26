// The 2.11.0 `collaborators` switch at the TOPOLOGY seam. Ten of the eleven
// 2.11.0 scopes author `collaborators: off`; only `enterprise` authors `on`.
// `off` must produce a single session in which the lead agent produces every
// declared stage output, and every support persona it withdraws must be named on
// the plan so the downgrade is an audit record rather than a shorter roster.
//
// The scopes are the verbatim upstream 2.11.0 frontmatter
// (fixtures/aidlc-211-scopes.json) carried onto the 2.9.0 stage set, whose stage
// frontmatter 2.11.0 changes in exactly one file (`code-generation.md`, a sensor
// list) — not the `mode` or `support_agents` of any stage. So the topologies
// asserted below are the ones the real authored bytes declare.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  filesFromCompatibilityFixture,
  normalizeAidlcFrontmatter,
} from '../aidlc-compatibility.js';
import { buildFromFiles } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { resolveMethodologyLibrary } from '../release-resolver.js';
import {
  ENSEMBLE_PROTOCOL_FILE,
  resolveEnsembleTopology,
} from '../../agentcore/ensemble-runner.js';

const BASE_PROFILE = 'v2.9.0';
const LIBRARY_TYPES = ['STAGE', 'AGENT', 'SENSOR', 'RULE', 'ARTIFACT', 'KNOWLEDGE', 'SCOPE'];

// The stages the 2.9.0 / 2.11.0 catalog authors as support-bearing sessions:
// `pipeline`, `mob` and a `subagent` that declares supports. Every other stage
// is a single session today, with or without the switch.
const ENSEMBLE_STAGE_IDS = ['reverse-engineering', 'practices-discovery', 'user-stories'];

const SCOPE_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/aidlc-211-scopes.json', import.meta.url), 'utf8'),
);

const baseFixture = JSON.parse(
  readFileSync(
    new URL(`./fixtures/aidlc-compatibility/${BASE_PROFILE}.json`, import.meta.url),
    'utf8',
  ),
);

// The 2.9.0 closure, optionally with its scope files replaced by the real
// 2.11.0 ones. `scopes: 'upstream-base'` keeps the 2.9.0 scopes, which author no
// `collaborators` at all — that is the existing-pin path.
const releaseContext = async ({ scopes = 'upstream-2.11', dropRuntimeFiles = [] } = {}) => {
  const files = filesFromCompatibilityFixture({
    profileId: BASE_PROFILE,
    fixture: baseFixture,
  });
  if (scopes !== 'upstream-base') {
    for (const path of files.keys()) {
      if (path.startsWith('core/scopes/')) files.delete(path);
    }
    for (const [path, entry] of Object.entries(SCOPE_FIXTURE.scopes)) {
      files.set(path, `---\n${entry.frontmatter}\n---\n[BODY OMITTED]\n`);
    }
  }
  const built = buildFromFiles(
    new Map(
      [...files].map(([path, content]) => [
        path,
        normalizeAidlcFrontmatter({ profileId: BASE_PROFILE, path, content }).content,
      ]),
    ),
  );
  const resolved = await resolveMethodologyLibrary({
    closure: {
      releaseId: AIDLC_COMPATIBILITY_PROFILES[BASE_PROFILE].releaseId,
      catalog: {
        workflow: { ...built.workflow, workflowVersion: 1, version: 1 },
      },
      blocksByType: Object.fromEntries(
        LIBRARY_TYPES.map((type) => [
          type,
          built.blocks
            .filter((block) => block.type === type)
            .map((block) => ({ ...block, version: 1 })),
        ]),
      ),
      runtimeFiles: new Map(
        baseFixture.runtimeFiles
          .filter((runtimeFile) => !dropRuntimeFiles.includes(runtimeFile.path))
          .map((runtimeFile) => [runtimeFile.path, runtimeFile]),
      ),
    },
    ddb: {
      send: () => Promise.reject(new Error('unexpected fixture DDB read')),
    },
    tableName: 'synthetic-fixture-table',
    workflowId: built.workflow.id,
    workflowVersion: 1,
  });
  return {
    workflow: { ...resolved.workflow, version: 1 },
    library: resolved.library,
  };
};

const planFor = async ({ scope, ...options }) => {
  const { workflow, library } = await releaseContext(options);
  const { plan, valid, errors } = buildExecutionPlan({
    workflow,
    scope,
    library,
  });
  expect({ scope, valid, errors }).toEqual({ scope, valid: true, errors: [] });
  return { plan, library };
};

const topologyFor = ({ stage, library }) =>
  resolveEnsembleTopology({
    stage,
    library,
    loadBlockBody: async (block) => block.body ?? '',
    methodologyRelease: {
      releaseId: AIDLC_COMPATIBILITY_PROFILES[BASE_PROFILE].releaseId,
    },
  });

const ensembleStagesOf = (plan) =>
  plan.stages.filter((stage) => ENSEMBLE_STAGE_IDS.includes(stage.stageId));

describe('the 2.11.0 collaborators switch', () => {
  it('carries the authored switch onto every stage policy', async () => {
    for (const [scope, expected] of [
      ['enterprise', 'on'],
      ['classic', 'off'],
      ['express', 'off'],
    ]) {
      const { plan } = await planFor({ scope });
      expect(plan.stages.length).toBeGreaterThan(0);
      for (const stage of plan.stages) {
        expect({
          scope,
          stageId: stage.stageId,
          collaborators: stage.policy?.collaborators,
        }).toEqual({ scope, stageId: stage.stageId, collaborators: expected });
      }
    }
  });

  // The defect: `collaborators: off` is authored, the plan still declares the
  // full roster, and the runtime dispatches a separate blind session per support
  // persona. A lead-only topology is `null` — exactly the single-session
  // contract the runtime already has for an `inline` stage.
  it('resolves a lead-only topology for every support-bearing stage of a scope with it off', async () => {
    const { plan, library } = await planFor({ scope: 'classic' });
    const stages = ensembleStagesOf(plan);

    expect(stages.map((stage) => stage.stageId).toSorted()).toEqual(ENSEMBLE_STAGE_IDS.toSorted());
    for (const stage of stages) {
      expect({
        stageId: stage.stageId,
        topology: await topologyFor({ stage, library }),
      }).toEqual({ stageId: stage.stageId, topology: null });
    }
  });

  // The authored topology stays on the plan: a human reading it sees what the
  // methodology declared AND what the policy withdrew. The filter is a policy
  // effect, not a rewrite of the stage.
  it('leaves the authored mode and support roster on the plan', async () => {
    const { plan } = await planFor({ scope: 'classic' });

    expect(
      ensembleStagesOf(plan).map((stage) => ({
        stageId: stage.stageId,
        mode: stage.mode,
        supportAgentRefs: stage.supportAgentRefs,
      })),
    ).toEqual([
      {
        stageId: 'reverse-engineering',
        mode: 'pipeline',
        supportAgentRefs: ['aidlc-architect-agent'],
      },
      {
        stageId: 'practices-discovery',
        mode: 'subagent',
        supportAgentRefs: ['aidlc-quality-agent', 'aidlc-developer-agent', 'aidlc-devsecops-agent'],
      },
      {
        stageId: 'user-stories',
        mode: 'mob',
        supportAgentRefs: ['aidlc-design-agent', 'aidlc-developer-agent', 'aidlc-quality-agent'],
      },
    ]);
  });

  it('keeps the full topology for the one scope that authors collaborators on', async () => {
    const { plan, library } = await planFor({ scope: 'enterprise' });

    for (const stage of ensembleStagesOf(plan)) {
      const topology = await topologyFor({ stage, library });
      expect({
        stageId: stage.stageId,
        mode: topology?.mode ?? null,
        supports: (topology?.supports ?? []).map((support) => support.ref),
      }).toEqual({
        stageId: stage.stageId,
        mode: stage.mode,
        supports: stage.supportAgentRefs,
      });
    }
  });

  // Silence is the failure mode here: a stage that runs with three fewer
  // sessions than its block declares must leave a record naming them.
  it('names every withdrawn support persona on the plan policy effects', async () => {
    const { plan } = await planFor({ scope: 'classic' });

    expect(
      (plan.policyEffects ?? [])
        .filter((effect) => (effect.withdrawnSupportAgents ?? []).length > 0)
        .map((effect) => ({
          stageId: effect.stageId,
          withdrawnSupportAgents: effect.withdrawnSupportAgents,
        })),
    ).toEqual([
      {
        stageId: 'reverse-engineering',
        withdrawnSupportAgents: ['aidlc-architect-agent'],
      },
      {
        stageId: 'practices-discovery',
        withdrawnSupportAgents: [
          'aidlc-quality-agent',
          'aidlc-developer-agent',
          'aidlc-devsecops-agent',
        ],
      },
      {
        stageId: 'user-stories',
        withdrawnSupportAgents: [
          'aidlc-design-agent',
          'aidlc-developer-agent',
          'aidlc-quality-agent',
        ],
      },
    ]);
  });

  // An `inline` stage that declares a support agent gets no separate session
  // today, with or without the switch, so the switch withdraws nothing from it
  // and must claim nothing.
  it('withdraws nothing from a stage that never had a support session', async () => {
    const { plan } = await planFor({ scope: 'classic' });
    const inlineWithSupports = plan.stages.filter(
      (stage) => !ENSEMBLE_STAGE_IDS.includes(stage.stageId) && stage.supportAgentRefs.length > 0,
    );

    expect(inlineWithSupports.length).toBeGreaterThan(0);
    for (const stage of inlineWithSupports) {
      const effect = (plan.policyEffects ?? []).find((item) => item.stageId === stage.stageId);
      expect({
        stageId: stage.stageId,
        withdrawn: effect?.withdrawnSupportAgents ?? [],
      }).toEqual({
        stageId: stage.stageId,
        withdrawn: [],
      });
    }
  });

  // A `subagent` stage gets support SESSIONS only when the closure ships the
  // hub-and-spoke protocol file; without it the delegated subagent is already
  // one session, which is why the topology resolver checks for it. The audit has
  // to share that whole condition, or a fork that imports and promotes cleanly
  // is told the switch removed three sessions the stage never had. The two
  // session modes that do not depend on the protocol still report theirs.
  it('withdraws nothing from a subagent stage whose closure ships no ensemble protocol', async () => {
    const { plan, library } = await planFor({
      scope: 'classic',
      dropRuntimeFiles: [ENSEMBLE_PROTOCOL_FILE],
    });
    const subagentStages = ensembleStagesOf(plan).filter((stage) => stage.mode === 'subagent');
    expect(subagentStages.length).toBeGreaterThan(0);

    for (const stage of subagentStages) {
      expect(await topologyFor({ stage, library }), stage.stageId).toBeNull();
      const effect = (plan.policyEffects ?? []).find((item) => item.stageId === stage.stageId);
      expect({
        stageId: stage.stageId,
        withdrawn: effect?.withdrawnSupportAgents ?? [],
      }).toEqual({ stageId: stage.stageId, withdrawn: [] });
    }
    expect(
      ensembleStagesOf(plan)
        .filter((stage) => stage.mode !== 'subagent')
        .every(
          (stage) =>
            (
              (plan.policyEffects ?? []).find((item) => item.stageId === stage.stageId)
                ?.withdrawnSupportAgents ?? []
            ).length > 0,
        ),
    ).toBe(true);
  });

  // The delta for an existing pin is `none`, asserted rather than argued: a
  // 2.9.0 closure authors no `collaborators`, so the policy key is inert, the
  // topology resolves as declared and no effect is recorded.
  it('leaves a release that authors no collaborators switch resolving exactly as before', async () => {
    const { plan, library } = await planFor({
      scope: 'enterprise',
      scopes: 'upstream-base',
    });

    for (const stage of plan.stages) {
      expect(stage.policy?.collaborators ?? null).toBeNull();
    }
    for (const stage of ensembleStagesOf(plan)) {
      const topology = await topologyFor({ stage, library });
      expect({ stageId: stage.stageId, mode: topology?.mode ?? null }).toEqual({
        stageId: stage.stageId,
        mode: stage.mode,
      });
    }
    expect(
      (plan.policyEffects ?? []).filter(
        (effect) => (effect.withdrawnSupportAgents ?? []).length > 0,
      ),
    ).toEqual([]);
  });
});
