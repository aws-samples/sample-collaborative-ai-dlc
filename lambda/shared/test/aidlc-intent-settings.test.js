// Per-intent AI-DLC settings at the PLAN seam: a project member's recorded
// override must beat the pinned scope's default, must change nothing else, and
// must leave the plan of a release that never had the switches untouched.
//
// As in the previous PRs of this stack the scopes are the verbatim upstream
// 2.11.0 frontmatter (fixtures/aidlc-211-scopes.json) carried onto the 2.9.0
// stage set — 2.11.0 changes the stage frontmatter of exactly one file
// (`code-generation.md`, a sensor list) and none of the fields read here — so
// every assertion is about real authored bytes rather than a synthetic scope.

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
import { evaluateGatePreconditions } from '../gate-preconditions.js';
import { toolsForRole } from '../../agentcore/mcp/server.js';
import {
  AIDLC_SETTING_KEYS,
  aidlcSettingField,
  aidlcSettingType,
  aidlcSettingValues,
  scopeAidlcSettings,
} from '../intent-aidlc-settings.js';

const BASE_PROFILE = 'v2.9.0';
const LIBRARY_TYPES = ['STAGE', 'AGENT', 'SENSOR', 'RULE', 'ARTIFACT', 'KNOWLEDGE', 'SCOPE'];

const SCOPE_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/aidlc-211-scopes.json', import.meta.url), 'utf8'),
);

const baseFixture = JSON.parse(
  readFileSync(
    new URL(`./fixtures/aidlc-compatibility/${BASE_PROFILE}.json`, import.meta.url),
    'utf8',
  ),
);

const releaseContext = async ({ scopes = 'upstream-2.11' } = {}) => {
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
        baseFixture.runtimeFiles.map((runtimeFile) => [runtimeFile.path, runtimeFile]),
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

const planFor = async ({ scope, intentSettings = null, ...options }) => {
  const { workflow, library } = await releaseContext(options);
  const { plan, valid, errors } = buildExecutionPlan({
    workflow,
    scope,
    library,
    ...(intentSettings ? { intentSettings } : {}),
  });
  expect({ scope, valid, errors }).toEqual({ scope, valid: true, errors: [] });
  return plan;
};

describe('the setting vocabulary', () => {
  it('reads its legal values from the capability registry, not from a copy', () => {
    expect(AIDLC_SETTING_KEYS).toEqual([
      'guardPolicy',
      'planApproval',
      'collaborators',
      'existingCode',
    ]);
    expect(aidlcSettingValues('guardPolicy')).toEqual(['strict', 'relaxed', 'off']);
    expect(aidlcSettingValues('planApproval')).toEqual(['on', 'off']);
    expect(aidlcSettingValues('collaborators')).toEqual(['on', 'off']);
    expect(aidlcSettingValues('existingCode')).toEqual(['true', 'false']);
  });

  // The stored value keeps the methodology's own type, which makes the TYPE
  // part of the contract: every runtime consumer compares with `===`, so a
  // stored `'true'` is not the boolean a renderer tests for.
  it('names the authored type and the authored field of each setting', () => {
    expect(AIDLC_SETTING_KEYS.map(aidlcSettingType)).toEqual([
      'string',
      'string',
      'string',
      'boolean',
    ]);
    expect(AIDLC_SETTING_KEYS.map(aidlcSettingField)).toEqual([
      'guard_policy',
      'plan_approval',
      'collaborators',
      'existing_code',
    ]);
  });

  // "The release does not author this setting" and "the release authored it
  // off" are different facts, and only the first may hide a control.
  it('reads the authored defaults off a scope block, omitting what it never had', () => {
    expect(scopeAidlcSettings({ guardPolicy: 'off', planApproval: 'on' })).toEqual({
      guardPolicy: 'off',
      planApproval: 'on',
    });
    expect(scopeAidlcSettings({ existingCode: false })).toEqual({
      existingCode: false,
    });
    expect(scopeAidlcSettings(null)).toEqual({});
  });
});

describe('the per-intent AI-DLC settings a member records', () => {
  // The whole point of the feature: a team can run the lightest scope and still
  // demand the strictest guard for one intent.
  it('beats the pinned scope default', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { guardPolicy: 'strict' },
    });

    expect(plan.stages.length).toBeGreaterThan(0);
    for (const stage of plan.stages) {
      expect({
        stageId: stage.stageId,
        changeControl: stage.policy?.changeControl,
      }).toEqual({
        stageId: stage.stageId,
        changeControl: 'strict',
      });
      expect(stage.policy?.guardPolicy).toBe('strict');
    }
  });

  it('can restore the plan gate a scope turned off, and withdraw one it left on', async () => {
    const gatesWith = (plan) =>
      plan.stages.filter((stage) => stage.policy?.planApproval === 'required').length;

    expect(gatesWith(await planFor({ scope: 'express' }))).toBe(0);
    expect(
      gatesWith(
        await planFor({
          scope: 'express',
          intentSettings: { planApproval: 'on' },
        }),
      ),
    ).toBeGreaterThan(0);
    expect(gatesWith(await planFor({ scope: 'classic' }))).toBeGreaterThan(0);
    expect(
      gatesWith(
        await planFor({
          scope: 'classic',
          intentSettings: { planApproval: 'off' },
        }),
      ),
    ).toBe(0);
  });

  it('can put the collaborators back on a scope that switched them off', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { collaborators: 'on' },
    });

    for (const stage of plan.stages) {
      expect(stage.policy?.collaborators).toBe('on');
    }
    expect(plan.policyEffects ?? []).toEqual([]);
  });

  it('can set the project type a scope never authored', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { existingCode: true },
    });

    expect(new Set(plan.stages.map((stage) => stage.policy?.existingCode))).toEqual(
      new Set([true]),
    );
  });

  // An explicit Greenfield choice is a decision, so it reaches the policy as
  // `false` — not as the absence a release that never authored the setting
  // produces. The classification stage reads both.
  it('carries an explicit greenfield choice and says the intent decided it', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { existingCode: false },
    });

    for (const stage of plan.stages) {
      expect({
        stageId: stage.stageId,
        policy: stage.policy?.existingCode,
      }).toEqual({
        stageId: stage.stageId,
        policy: false,
      });
      expect(stage.policy?.existingCodeChoice).toEqual({ source: 'intent' });
    }

    const none = await planFor({ scope: 'classic' });
    for (const stage of none.stages) {
      expect(stage.policy?.existingCode ?? null).toBeNull();
      expect(stage.policy).not.toHaveProperty('existingCodeChoice');
    }
  });

  it('says the scope decided a project type the scope itself authored', async () => {
    const plan = await planFor({ scope: 'bugfix' });

    for (const stage of plan.stages) {
      expect(stage.policy?.existingCodeChoice).toEqual({
        source: 'scope-default',
      });
    }
  });

  // The same invariant A4 asserts for the scope defaults, asserted again for the
  // human overlay: a setting may never remove a human approval gate.
  it('removes no human gate from any scope, whatever a member chooses', async () => {
    const gates = (plan) => plan.stages.map((stage) => `${stage.stageId}:${stage.humanValidation}`);
    const settings = {
      guardPolicy: 'off',
      planApproval: 'off',
      collaborators: 'off',
      existingCode: true,
    };

    for (const scope of ['classic', 'enterprise', 'express', 'bugfix']) {
      expect({
        scope,
        gates: gates(await planFor({ scope, intentSettings: settings })),
      }).toEqual({
        scope,
        gates: gates(await planFor({ scope })),
      });
    }
  });

  it('offers exactly the settings the pinned scope authors', async () => {
    const authored = async (scope) => (await planFor({ scope })).aidlcSettingsAuthored ?? null;

    expect(await authored('enterprise')).toEqual({
      guardPolicy: 'strict',
      planApproval: 'on',
      collaborators: 'on',
    });
    expect(await authored('bugfix')).toEqual({
      guardPolicy: 'off',
      planApproval: 'on',
      collaborators: 'off',
      existingCode: true,
    });
  });

  // The byte-identity claim for every release that predates the switches: a
  // 2.9.0 closure authors none of them, so the plan offers nothing new and an
  // intent on it resolves exactly the policy it resolves today.
  it('offers nothing and changes nothing on a release that authors no settings', async () => {
    const plan = await planFor({
      scope: 'enterprise',
      scopes: 'upstream-base',
    });
    const withSettings = await planFor({
      scope: 'enterprise',
      scopes: 'upstream-base',
      intentSettings: { guardPolicy: 'off' },
    });

    expect(plan).not.toHaveProperty('aidlcSettingsAuthored');
    // The overlay still resolves when it is handed one — the API is what drops
    // a setting the release never authored, and it is tested there. What
    // matters here is that the plan offers the member nothing to choose.
    expect(withSettings).not.toHaveProperty('aidlcSettingsAuthored');
    for (const stage of plan.stages) {
      expect(stage.policy).not.toHaveProperty('planApprovalWithheld');
      expect(stage.policy).not.toHaveProperty('existingCodeChoice');
    }
  });
});

// The marker the gate notice is built from. Two mutually exclusive cases, and
// exhaustive only because a value equal to the authored default is never
// stored — which is what makes the notice unfalsifiable by a later scope
// change.
describe('the marker left on a stage that lost its plan gate', () => {
  const withheld = (plan) => plan.stages.filter((stage) => stage.policy?.planApprovalWithheld);

  it('marks only the stage that would have asked, and names the scope', async () => {
    const withGate =
      (await planFor({ scope: 'classic' })).stages.find(
        (stage) => stage.policy?.planApproval === 'required',
      ) ?? null;
    expect(withGate).not.toBeNull();

    const lost = withheld(await planFor({ scope: 'express' }));
    expect(lost.map((stage) => stage.stageId)).toEqual([withGate.stageId]);
    expect(lost[0].policy.planApprovalWithheld).toEqual({
      source: 'scope-default',
      scope: 'express',
    });
  });

  it('says the intent withheld it when the intent is what differs', async () => {
    const lost = withheld(
      await planFor({
        scope: 'classic',
        intentSettings: { planApproval: 'off' },
      }),
    );

    expect(lost.length).toBe(1);
    expect(lost[0].policy.planApprovalWithheld).toEqual({
      source: 'intent',
      scope: 'classic',
    });
  });

  // An intent that chooses the value the scope already has records no override
  // at all (the API drops it), so this combination is unreachable through the
  // API. Asserted here so the plan still answers truthfully if it ever arrives.
  it('still credits the scope when an override repeats the scope default', async () => {
    const lost = withheld(
      await planFor({
        scope: 'classic',
        intentSettings: { planApproval: 'on' },
      }),
    );

    expect(lost).toEqual([]);
  });
});

// The authority rule, asserted against the real tool surface rather than
// documented: a settings change is refused by name in the dialect annex,
// and the way to keep that true is for no agent-facing tool to exist that could
// write one. A new tool whose name touches these settings fails this test.
describe('no agent can write a setting', () => {
  it('exposes no settings tool on any MCP role', async () => {
    const plan = await planFor({ scope: 'classic' });
    const stage = plan.stages[0];
    const everyTool = [
      ...toolsForRole('author', stage.stageId, stage.policy ?? null),
      ...toolsForRole('reviewer', stage.stageId, stage.policy ?? null),
      ...toolsForRole('reader', stage.stageId, stage.policy ?? null),
    ].map((tool) => tool.name ?? tool);

    expect(everyTool.length).toBeGreaterThan(0);
    expect(
      everyTool.filter((name) => /setting|guard_policy|plan_approval|collaborator/i.test(name)),
    ).toEqual([]);
    for (const key of AIDLC_SETTING_KEYS) {
      expect(everyTool).not.toContain(key);
    }
  });
});

// The notice a human reads at a gate that no plan approval preceded. Two cases,
// and both statements are true for every reachable state: the `scope-default`
// branch is only emitted when the current scope really defaults off, and the
// `intent` branch only when the intent really differs from it.
describe('the gate notice when Plan Approval is off', () => {
  const noticeFor = (stage) =>
    evaluateGatePreconditions({
      stage,
      policy: stage.policy,
      producedArtifacts: null,
    }).findings.find((item) => item.code === 'plan_approval_off') ?? null;

  const planGateStage = (plan) =>
    plan.stages.find((stage) => stage.policy?.planApproval === 'required') ?? null;

  it('names the scope that turns it off by default, on the stage that lost the gate', async () => {
    const withGate = planGateStage(await planFor({ scope: 'classic' }));
    expect(withGate).not.toBeNull();

    const plan = await planFor({ scope: 'express' });
    const lost = plan.stages.filter((stage) => stage.policy?.planApprovalWithheld);

    expect(lost.map((stage) => stage.stageId)).toEqual([withGate.stageId]);
    const notice = noticeFor(lost[0]);
    expect(notice).toMatchObject({
      code: 'plan_approval_off',
      severity: 'advisory',
      title: 'Plan Approval is off for this intent; the build proceeded without a plan approval',
    });
    expect(notice.detail).toMatchObject({ source: 'scope-default', scope: 'express' });
    expect(notice.remediation).toContain('**express** scope turns it off by default');
    expect(notice.remediation).toContain('no project member changed it');
    expect(notice.remediation).toContain('never mid-run');
  });

  it('says the intent turned it off and points at the timeline for who', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { planApproval: 'off' },
    });
    const lost = plan.stages.filter((stage) => stage.policy?.planApprovalWithheld);

    expect(lost.length).toBe(1);
    const notice = noticeFor(lost[0]);
    expect(notice.detail).toMatchObject({ source: 'intent', scope: 'classic' });
    expect(notice.remediation).toContain('turned off for this intent by a project member');
    expect(notice.remediation).toContain("**classic** scope's own default leaves it on");
    expect(notice.remediation).toContain("timeline records which member's save stored it");
    expect(notice.remediation).toContain('never mid-run');
  });

  // No name anywhere in the notice or its detail: attribution lives in the
  // append-only timeline, never in the pinned plan a gate reads.
  it('names nobody', async () => {
    const plan = await planFor({ scope: 'classic', intentSettings: { planApproval: 'off' } });
    const notice = noticeFor(plan.stages.find((stage) => stage.policy?.planApprovalWithheld));

    expect(notice.detail).not.toHaveProperty('actor');
    expect(JSON.stringify(notice)).not.toMatch(/actor/i);
  });

  // The notice belongs to the stage that would have asked for the approval. On
  // every other gate of the run it would be noise about a gate that never
  // applied there.
  it('appears on no other stage of the run', async () => {
    const plan = await planFor({ scope: 'express' });
    const others = plan.stages.filter((stage) => !stage.policy?.planApprovalWithheld);

    expect(others.length).toBeGreaterThan(0);
    for (const stage of others) {
      expect({ stageId: stage.stageId, notice: noticeFor(stage) }).toEqual({
        stageId: stage.stageId,
        notice: null,
      });
    }
  });

  it('says nothing on a release that never had the switch', async () => {
    const plan = await planFor({ scope: 'express', scopes: 'upstream-base' });

    for (const stage of plan.stages) {
      expect(stage.policy).not.toHaveProperty('planApprovalWithheld');
      expect(noticeFor(stage)).toBeNull();
    }
  });
});

// A composed grid's `scope` is a DISPLAY LABEL. `bugfix-custom` names no SCOPE
// block, so the moment a run was customized the whole per-scope policy — and
// every setting a member could choose — silently vanished. The base scope the
// caller records is what carries them.
describe('the policy scope a customized selection runs on', () => {
  const customGrid = async ({ policyScope = null, intentSettings = null } = {}) => {
    const { workflow, library } = await releaseContext();
    const base = buildExecutionPlan({ workflow, scope: 'enterprise', library });
    expect(base.valid).toBe(true);
    const grid = Object.fromEntries(base.plan.stages.map((stage) => [stage.stageId, 'EXECUTE']));
    const { plan, valid, errors } = buildExecutionPlan({
      workflow,
      scope: 'enterprise-custom',
      library,
      composedGrid: grid,
      ...(policyScope ? { policyScope } : {}),
      ...(intentSettings ? { intentSettings } : {}),
    });
    expect({ valid, errors }).toEqual({ valid: true, errors: [] });
    return plan;
  };

  it('offers nothing and resolves no scope policy for a label that names no block', async () => {
    const plan = await customGrid();

    expect(plan).not.toHaveProperty('aidlcSettingsAuthored');
    for (const stage of plan.stages) {
      expect({
        stageId: stage.stageId,
        guardPolicy: stage.policy?.guardPolicy ?? null,
        collaborators: stage.policy?.collaborators ?? null,
      }).toEqual({ stageId: stage.stageId, guardPolicy: null, collaborators: null });
    }
  });

  it('resolves the recorded base scope’s policy and the settings it authors', async () => {
    const plan = await customGrid({ policyScope: 'enterprise' });

    expect(plan.aidlcSettingsAuthored).toEqual({
      guardPolicy: 'strict',
      planApproval: 'on',
      collaborators: 'on',
    });
    for (const stage of plan.stages) {
      expect(stage.policy?.guardPolicy).toBe('strict');
      expect(stage.policy?.collaborators).toBe('on');
    }
  });

  it('lets a per-intent override beat the recorded base scope', async () => {
    const plan = await customGrid({
      policyScope: 'enterprise',
      intentSettings: { guardPolicy: 'off' },
    });

    for (const stage of plan.stages) {
      expect(stage.policy?.guardPolicy).toBe('off');
      expect(stage.policy?.changeControl).toBeNull();
    }
  });

  // The base scope exists so a member who customizes the stages keeps the
  // switches the scope offers. A catalog that offers NONE — every release before
  // 2.11 — has no reason to resolve a policy for a customized grid that
  // resolved none before, so the recorded base is ignored there and the plan of
  // an existing 2.8.2 or 2.9.0 custom grid is byte-for-byte what it was.
  it('ignores a recorded base scope on a catalog that authors no settings', async () => {
    const { workflow, library } = await releaseContext({ scopes: 'upstream-base' });
    const base = buildExecutionPlan({ workflow, scope: 'enterprise', library });
    expect(base.valid).toBe(true);
    expect(base.plan).not.toHaveProperty('aidlcSettingsAuthored');
    const grid = Object.fromEntries(base.plan.stages.map((stage) => [stage.stageId, 'EXECUTE']));

    const withoutBase = buildExecutionPlan({
      workflow,
      scope: 'enterprise-custom',
      library,
      composedGrid: grid,
    });
    const withBase = buildExecutionPlan({
      workflow,
      scope: 'enterprise-custom',
      library,
      composedGrid: grid,
      policyScope: 'enterprise',
    });

    expect(withoutBase.valid).toBe(true);
    expect(JSON.stringify(withBase.plan)).toBe(JSON.stringify(withoutBase.plan));
    expect(withBase.plan).not.toHaveProperty('aidlcSettingsAuthored');
  });

  // A selection that names its scope directly must resolve exactly what it
  // resolved before: the base scope defaults to the scope itself.
  it('changes nothing for a selection that names its scope directly', async () => {
    const { workflow, library } = await releaseContext();
    const direct = buildExecutionPlan({ workflow, scope: 'enterprise', library });
    const withBase = buildExecutionPlan({
      workflow,
      scope: 'enterprise',
      library,
      policyScope: 'enterprise',
    });

    expect(JSON.stringify(withBase.plan)).toBe(JSON.stringify(direct.plan));
  });
});
