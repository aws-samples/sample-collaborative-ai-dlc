// Per-release adapters define mapper keys and effective per-stage policy. The
// 2.3.3 golden digests live in aidlc-release-adapters.test.js; this file checks
// that release mode leaves that baseline unchanged and covers the policy each
// newer authored field resolves to.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import { buildFromFiles, mapAgent, mapScope, mapSensor, mapStage } from '../block-mappers.js';
import { buildExecutionPlan, resolveStagePolicy } from '../v2-execution-plan.js';
import { resolveCapabilities } from '../aidlc-capabilities.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const fixtureFiles = (profileId) =>
  filesFromCompatibilityFixture({
    profileId,
    fixture: JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });

const keyById = (items) =>
  Object.fromEntries(
    items.filter((item) => item.id).map((item) => [item.id, { ...item, version: 1 }]),
  );

const libraryFrom = (blocks) => ({
  stagesById: keyById(blocks.filter((b) => b.type === 'STAGE')),
  agentsById: keyById(blocks.filter((b) => b.type === 'AGENT')),
  sensorsById: keyById(blocks.filter((b) => b.type === 'SENSOR')),
  rulesById: keyById(blocks.filter((b) => b.type === 'RULE')),
  artifactsById: keyById(blocks.filter((b) => b.type === 'ARTIFACT')),
  scopesById: keyById(blocks.filter((b) => b.type === 'SCOPE')),
});

const STAGE_FM = Object.freeze({
  slug: 'demo',
  phase: 'inception',
  execution: 'ALWAYS',
  produces: ['design'],
  reviewer: 'reviewer-agent',
  reviewer_max_iterations: 3,
});

// `releaseMode` defaults to true here: the authored policy only applies to a
// library resolved from a verified release closure, so a
// policy test must say it is in release mode. The legacy-mode counterpart is
// asserted explicitly below.
const planFor = ({
  stageFm = STAGE_FM,
  scopeFm = {},
  sensorFm = null,
  scope = 'feature',
  releaseMode = true,
}) => {
  const stage = { ...mapStage(stageFm, 'body'), version: 1 };
  const scopeBlock = {
    ...mapScope({ name: scope, depth: 'standard', ...scopeFm }, '', scope),
    version: 1,
  };
  const sensors = sensorFm
    ? { [sensorFm.id]: { ...mapSensor(sensorFm, '', sensorFm.id), version: 1 } }
    : {};
  return buildExecutionPlan({
    workflow: {
      id: 'wf',
      version: 1,
      placements: [{ stageId: 'demo', order: 0, scopeMembership: { [scope]: 'EXECUTE' } }],
      scopeRefs: [{ scopeId: scope }],
    },
    scope,
    library: {
      stagesById: { demo: stage },
      agentsById: { 'reviewer-agent': { id: 'reviewer-agent', version: 1 } },
      sensorsById: sensors,
      rulesById: {},
      artifactsById: {},
      scopesById: { [scope]: scopeBlock },
    },
    releaseMode,
  });
};

describe('Per-release adapters: release mode on the legacy baseline', () => {
  it('plans the 2.3.3-era baseline identically in release mode and legacy mode', () => {
    const { blocks, workflow } = buildFromFiles(fixtureFiles('current-stable'));
    const library = libraryFrom(blocks);
    const scopes = [
      ...new Set(
        (workflow.placements ?? []).flatMap((placement) =>
          Object.keys(placement.scopeMembership ?? {}),
        ),
      ),
    ];
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      const [legacy, release] = [false, true].map((releaseMode) =>
        buildExecutionPlan({ workflow: { ...workflow, version: 1 }, scope, library, releaseMode }),
      );
      expect(release.valid).toBe(true);
      expect(sha256(canonicalJson(release.plan))).toBe(sha256(canonicalJson(legacy.plan)));
      for (const stage of release.plan.stages) expect(stage.policy).toBeUndefined();
      expect(release.plan.policyEffects).toBeUndefined();
    }
  });

  it('adds no key to a block whose frontmatter lacks the adapter fields', () => {
    expect(Object.keys(mapStage(STAGE_FM, ''))).not.toContain('reviewClass');
    expect(Object.keys(mapStage(STAGE_FM, ''))).not.toContain('reviewArtifact');
    expect(Object.keys(mapStage(STAGE_FM, ''))).not.toContain('summaryConfirmation');
    expect(Object.keys(mapAgent({ name: 'a' }, '', 'a'))).not.toContain('maxTurns');
    expect(Object.keys(mapSensor({ id: 's' }, '', 's'))).not.toContain('fireOn');
    const scope = mapScope({ name: 'feature', depth: 'standard' }, '', 'feature');
    for (const key of [
      'sensorsPolicy',
      'reviewCap',
      'summaryConfirmation',
      'changeControl',
      'learnings',
      'skeleton',
      'runner',
    ]) {
      expect(Object.keys(scope)).not.toContain(key);
    }
  });
});

describe('Per-release adapters: mapper keys', () => {
  it('maps the stage review and confirmation fields', () => {
    const stage = mapStage(
      {
        ...STAGE_FM,
        review_class: 'advisory',
        review_artifact: 'design',
        summary_confirmation: 'required',
      },
      '',
    );
    expect(stage).toMatchObject({
      reviewClass: 'advisory',
      reviewArtifact: 'design',
      summaryConfirmation: 'required',
    });
  });

  it('maps the sensor fire_on plane', () => {
    expect(mapSensor({ id: 'linter', fire_on: 'gate' }, '', 'linter').fireOn).toBe('gate');
  });

  // The mapper carried `fireOn` but the PLAN dropped it, so
  // the runner never saw a plane and both `write` and `gate` behaved like a
  // plain workspace sweep. It has to survive plan resolution — and only when
  // authored, or every legacy plan's sensor list changes shape.
  it('carries fire_on through plan resolution, and only when authored', () => {
    const sensorFm = { id: 'linter', kind: 'deterministic', command: 'bun x', matches: '**/*.ts' };
    const withPlane = planFor({
      stageFm: { ...STAGE_FM, sensors: ['linter'] },
      sensorFm: { ...sensorFm, fire_on: 'gate' },
    });
    expect(withPlane.plan.stages[0].sensors[0]).toMatchObject({
      sensorId: 'linter',
      fireOn: 'gate',
    });

    const withoutPlane = planFor({ stageFm: { ...STAGE_FM, sensors: ['linter'] }, sensorFm });
    expect(Object.keys(withoutPlane.plan.stages[0].sensors[0])).not.toContain('fireOn');
  });

  it('keeps pipeline and mob runnable while agent-team stays not implemented', () => {
    for (const mode of ['inline', 'subagent', 'pipeline', 'mob']) {
      const { plan } = planFor({ stageFm: { ...STAGE_FM, mode } });
      expect(plan.stages[0].mode).toBe(mode);
      expect(plan.stages[0].notImplemented).toBeUndefined();
      expect(plan.stages[0].runtimeError).toBeUndefined();
    }
    const { plan } = planFor({ stageFm: { ...STAGE_FM, mode: 'agent-team' } });
    expect(plan.stages[0]).toMatchObject({
      notImplemented: true,
      runtimeError: 'not_implemented',
    });
  });

  // Persona sessions exist only for a pinned release; an unpinned plan keeps
  // failing these modes fast, exactly as before they could run.
  it('keeps pipeline and mob not implemented outside release mode', () => {
    for (const mode of ['pipeline', 'mob']) {
      const { plan } = planFor({ stageFm: { ...STAGE_FM, mode }, releaseMode: false });
      expect(plan.stages[0]).toMatchObject({
        notImplemented: true,
        runtimeError: 'not_implemented',
      });
    }
  });

  it('maps maxTurns as an integer and leaves a non-integer verbatim for the analyzer', () => {
    expect(mapAgent({ name: 'r', maxTurns: 60 }, '', 'r').maxTurns).toBe(60);
    expect(mapAgent({ name: 'r', maxTurns: '60' }, '', 'r').maxTurns).toBe(60);
    expect(mapAgent({ name: 'r', maxTurns: 'lots' }, '', 'r').maxTurns).toBe('lots');
  });

  it('maps the scope policy, renaming SCOPE.sensors to sensorsPolicy', () => {
    expect(
      mapScope(
        {
          name: 'classic',
          depth: 'deep',
          sensors: 'off',
          review_cap: 'advisory',
          summary_confirmation: 'off',
          change_control: 'relaxed',
          learnings: 'off',
          skeleton: 'on',
          runner: false,
        },
        '',
        'classic',
      ),
    ).toMatchObject({
      sensorsPolicy: 'off',
      reviewCap: 'advisory',
      summaryConfirmation: 'off',
      changeControl: 'relaxed',
      learnings: 'off',
      skeleton: 'on',
      runner: false,
    });
  });
});

describe('Per-release adapters: effective per-stage policy', () => {
  it('lowers an adversarial stage to advisory under a scope cap and pins one round', () => {
    const { plan } = planFor({ scopeFm: { review_cap: 'advisory' } });
    expect(plan.stages[0].policy).toMatchObject({ reviewClass: 'advisory' });
    expect(plan.stages[0].reviewer).toMatchObject({
      reviewerAgent: 'reviewer-agent',
      maxIterations: 1,
      advisory: true,
    });
  });

  it('never raises a stage above its own declared class', () => {
    const { plan } = planFor({
      stageFm: { ...STAGE_FM, review_class: 'advisory' },
      scopeFm: { review_cap: 'adversarial' },
    });
    expect(plan.stages[0].policy.reviewClass).toBe('advisory');
    expect(plan.stages[0].reviewer.maxIterations).toBe(1);
  });

  it('removes the reviewer entirely at review_cap none', () => {
    const { plan } = planFor({ scopeFm: { review_cap: 'none' } });
    expect(plan.stages[0].policy.reviewClass).toBe('none');
    expect(plan.stages[0].reviewer).toBeNull();
  });

  it('keeps an adversarial stage on its authored iteration budget', () => {
    const { plan } = planFor({ scopeFm: { change_control: 'relaxed' } });
    expect(plan.stages[0].policy.reviewClass).toBe('adversarial');
    expect(plan.stages[0].reviewer).toMatchObject({ maxIterations: 3 });
    expect(plan.stages[0].reviewer.advisory).toBeUndefined();
  });

  it('carries review_artifact onto the resolved reviewer', () => {
    const { plan } = planFor({ stageFm: { ...STAGE_FM, review_artifact: 'design' } });
    expect(plan.stages[0].reviewer.artifact).toBe('design');
  });

  it('empties the stage sensor list when the scope turns sensors off', () => {
    const sensorFm = { id: 'linter', kind: 'deterministic', command: 'bun x', matches: '**/*.ts' };
    const on = planFor({ stageFm: { ...STAGE_FM, sensors: ['linter'] }, sensorFm });
    expect(on.plan.stages[0].sensors).toHaveLength(1);

    const off = planFor({
      stageFm: { ...STAGE_FM, sensors: ['linter'] },
      sensorFm,
      scopeFm: { sensors: 'off' },
    });
    expect(off.plan.stages[0].policy.sensorsEnabled).toBe(false);
    expect(off.plan.stages[0].sensors).toEqual([]);
  });

  it('lets a scope bypass a stage summary-confirmation requirement', () => {
    const required = planFor({ stageFm: { ...STAGE_FM, summary_confirmation: 'required' } });
    expect(required.plan.stages[0].policy.summaryConfirmation).toBe('required');

    const bypassed = planFor({
      stageFm: { ...STAGE_FM, summary_confirmation: 'required' },
      scopeFm: { summary_confirmation: 'off' },
    });
    expect(bypassed.plan.stages[0].policy.summaryConfirmation).toBe('none');
  });

  it('defaults the remaining switches to the behavior of a release without them', () => {
    const { plan } = planFor({ stageFm: { ...STAGE_FM, review_class: 'adversarial' } });
    expect(plan.stages[0].policy).toMatchObject({
      sensorsEnabled: true,
      // change_control is NOT defaulted to 'strict' just because another
      // policy key is present — 'strict' carries an active prompt instruction,
      // so it stays null until a scope declares it.
      changeControl: null,
      // Likewise learnings: no block authors it here, so the release proves no
      // learnings switch and the ritual stays off.
      learnings: null,
      skeleton: null,
      summaryConfirmation: 'none',
      reviewArtifact: null,
    });
  });

  it('sets changeControl only when the scope actually declares it', () => {
    expect(
      planFor({ scopeFm: { change_control: 'strict' } }).plan.stages[0].policy.changeControl,
    ).toBe('strict');
    expect(
      planFor({ scopeFm: { change_control: 'relaxed' } }).plan.stages[0].policy.changeControl,
    ).toBe('relaxed');
    expect(
      planFor({ scopeFm: { learnings: 'off' } }).plan.stages[0].policy.changeControl,
    ).toBeNull();
  });

  it('never applies the policy outside release mode, even with release-policy fields present', () => {
    const legacy = planFor({
      stageFm: { ...STAGE_FM, review_class: 'advisory', summary_confirmation: 'required' },
      scopeFm: { review_cap: 'none', sensors: 'off', change_control: 'relaxed' },
      releaseMode: false,
    });
    expect(legacy.valid).toBe(true);
    expect(legacy.plan.stages[0].policy).toBeUndefined();
    // The reviewer survives untouched: an unpinned, user-edited SCOPE row must
    // not be able to strip verification from a legacy intent.
    expect(legacy.plan.stages[0].reviewer).toMatchObject({
      reviewerAgent: 'reviewer-agent',
      maxIterations: 3,
    });
  });

  it('honours library.fromRelease as the provenance flag when releaseMode is unset', () => {
    const stage = { ...mapStage({ ...STAGE_FM, review_class: 'advisory' }, 'body'), version: 1 };
    const workflow = {
      id: 'wf',
      version: 1,
      placements: [{ stageId: 'demo', order: 0, scopeMembership: { feature: 'EXECUTE' } }],
      scopeRefs: [{ scopeId: 'feature' }],
    };
    const library = {
      stagesById: { demo: stage },
      agentsById: { 'reviewer-agent': { id: 'reviewer-agent', version: 1 } },
      sensorsById: {},
      rulesById: {},
      artifactsById: {},
      scopesById: {},
    };
    expect(
      buildExecutionPlan({ workflow, scope: 'feature', library }).plan.stages[0].policy,
    ).toBeUndefined();
    expect(
      buildExecutionPlan({
        workflow,
        scope: 'feature',
        library: { ...library, fromRelease: true },
      }).plan.stages[0].policy,
    ).toMatchObject({ reviewClass: 'advisory' });
  });

  it('records removed reviewers and sensors on plan.policyEffects for the audit event', () => {
    const sensorFm = { id: 'linter', kind: 'deterministic', command: 'bun x', matches: '**/*.ts' };
    const { plan } = planFor({
      stageFm: { ...STAGE_FM, sensors: ['linter'] },
      sensorFm,
      scopeFm: { review_cap: 'none', sensors: 'off' },
    });
    expect(plan.policyEffects).toEqual([
      expect.objectContaining({
        stageId: 'demo',
        removedReviewer: 'reviewer-agent',
        removedSensors: ['linter'],
        reviewClass: 'none',
      }),
    ]);
  });

  it('fails the plan closed on a policy value outside the adapter vocabulary', () => {
    const result = planFor({ scopeFm: { review_cap: 'paranoid' } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'policy_enum_invalid', ref: 'review_cap' }),
    );
    expect(result.plan.stages[0].policy).toBeUndefined();
  });

  it('resolves no policy at all when neither block carries a release-policy field', () => {
    expect(
      resolveStagePolicy({
        scopeBlock: mapScope({ name: 'feature', depth: 'standard' }, '', 'feature'),
        stage: mapStage(STAGE_FM, ''),
        stageId: 'demo',
        errors: [],
      }),
    ).toBeNull();
  });
});

describe('Per-release adapters: learnings default', () => {
  const fixture = (profileId) =>
    JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
        'utf8',
      ),
    );
  // The policy every stage of `scope` resolves to, from the release's own SCOPE
  // block and the capabilities its closure proves.
  const learningsFor = (profileId, scope) => {
    const { blocks } = buildFromFiles(fixtureFiles(profileId));
    const library = {
      ...libraryFrom(blocks),
      runtimeFilePaths: fixture(profileId).runtimeFiles.map((file) => file.path),
    };
    const capabilities = resolveCapabilities(library);
    const scopeBlock = library.scopesById[scope];
    return [
      ...new Set(
        Object.entries(library.stagesById).map(
          ([stageId, stage]) =>
            resolveStagePolicy({ scopeBlock, stage, stageId, errors: [], capabilities })
              ?.learnings ?? null,
        ),
      ),
    ];
  };

  // The loop-back capability is closure-wide, so resolving it into every stage's
  // policy told every stage's agent it could recommend a jump back and let any
  // stage that happened to follow code generation open the gate option. The
  // recommender is the stage that authors `build-test-results`.
  it.each(['v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0'])(
    'resolves the loop-back policy for %s on the recommending stage alone',
    (profileId) => {
      const { blocks } = buildFromFiles(fixtureFiles(profileId));
      const library = {
        ...libraryFrom(blocks),
        runtimeFilePaths: fixture(profileId).runtimeFiles.map((file) => file.path),
      };
      const capabilities = resolveCapabilities(library);
      expect(capabilities['PROTOCOL:build-and-test-loopback']).toBe(true);
      const scopeBlock = library.scopesById.bugfix;
      const offered = Object.entries(library.stagesById)
        .filter(
          ([stageId, stage]) =>
            resolveStagePolicy({ scopeBlock, stage, stageId, errors: [], capabilities })
              ?.loopBack === 'human-offered',
        )
        .map(([stageId]) => stageId);
      expect(offered).toEqual(['build-and-test']);
    },
  );

  it('resolves no loop-back policy at all for a release without the construction protocol', () => {
    const profileId = 'current-stable';
    const { blocks } = buildFromFiles(fixtureFiles(profileId));
    const library = {
      ...libraryFrom(blocks),
      runtimeFilePaths: fixture(profileId).runtimeFiles.map((file) => file.path),
    };
    const capabilities = resolveCapabilities(library);
    expect(capabilities['PROTOCOL:build-and-test-loopback']).not.toBe(true);
    const scopeBlock = library.scopesById.bugfix;
    const loopBacks = [
      ...new Set(
        Object.entries(library.stagesById).map(
          ([stageId, stage]) =>
            resolveStagePolicy({ scopeBlock, stage, stageId, errors: [], capabilities })
              ?.loopBack ?? null,
        ),
      ),
    ];
    expect(loopBacks).toEqual([null]);
  });

  it.each(['v2.6.18', 'v2.7.0', 'v2.8.2'])(
    'does not turn the learnings ritual on for %s, which has no learnings switch',
    (profileId) => {
      expect(learningsFor(profileId, 'feature')).toEqual([null]);
    },
  );

  it('applies the upstream default to a 2.9.0 scope that omits the field', () => {
    expect(learningsFor('v2.9.0', 'feature')).toEqual(['on']);
  });

  it('keeps the value a 2.9.0 scope authors', () => {
    expect(learningsFor('v2.9.0', 'classic')).toEqual(['on']);
  });
});
