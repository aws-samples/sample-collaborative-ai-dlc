// The capability registry is the ONE table the analyzer and
// the plan resolver both derive from. These tests assert the three things that
// make a single table safer than three copies — the derived tables still match
// what the consumers expect, a value outside the vocabulary is rejected at BOTH
// boundaries, and a capability the catalog does not prove it has stays inert.

import { describe, expect, it } from 'vitest';
import {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  POLICY_ENUMS,
  RUNTIME_HANDLERS,
  SCOPE_POLICY_KEYS,
  STAGE_POLICY_KEYS,
  capabilityFor,
  defaultWhenAbsent,
  resolveCapabilities,
  unhonouredValues,
  unhandledCapabilities,
} from '../aidlc-capabilities.js';
import { STAGE_MODES } from '../blocks.js';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  analyzeAidlcCompatibility,
  filesFromCompatibilityFixture,
  fidelityGapsFromCatalog,
} from '../aidlc-compatibility.js';
import { mapScope, mapStage } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { readFileSync } from 'node:fs';

const fixture = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );

const filesFor = (profileId) =>
  filesFromCompatibilityFixture({ profileId, fixture: fixture(profileId) });

const expectedUnhonoured = (gaps) =>
  gaps.filter((gap) => {
    const entry = AIDLC_CAPABILITIES.find(
      (candidate) => candidate.blockType === gap.blockType && candidate.field === gap.field,
    );
    if (!entry) return true;
    const classification =
      (typeof gap.value === 'string' ? entry.values?.[gap.value] : null) ?? entry;
    return (
      classification.handling === 'unsupported' ||
      classification.handler == null ||
      !RUNTIME_HANDLERS.has(classification.handler)
    );
  });

const STAGE_FM = Object.freeze({
  slug: 'demo',
  phase: 'inception',
  execution: 'ALWAYS',
  produces: ['design'],
  reviewer: 'reviewer-agent',
});

const planFor = ({ scopeFm = {}, stageFm = STAGE_FM, extraScopes = {}, library: extra = {} }) => {
  const scope = 'feature';
  return buildExecutionPlan({
    workflow: {
      id: 'wf',
      version: 1,
      placements: [{ stageId: 'demo', order: 0, scopeMembership: { [scope]: 'EXECUTE' } }],
      scopeRefs: [{ scopeId: scope }],
    },
    scope,
    library: {
      stagesById: { demo: { ...mapStage(stageFm, 'body'), version: 1 } },
      agentsById: { 'reviewer-agent': { id: 'reviewer-agent', version: 1 } },
      sensorsById: {},
      rulesById: {},
      artifactsById: {},
      scopesById: {
        [scope]: {
          ...mapScope({ name: scope, depth: 'standard', ...scopeFm }, '', scope),
          version: 1,
        },
        ...extraScopes,
      },
      ...extra,
    },
    releaseMode: true,
  });
};

describe('aidlc capability registry', () => {
  it('keys every entry uniquely as <BLOCK_TYPE>:<field>', () => {
    const keys = AIDLC_CAPABILITIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of AIDLC_CAPABILITIES) {
      expect(entry.key).toBe(`${entry.blockType}:${entry.field}`);
      expect(capabilityFor(entry.key)).toBe(entry);
    }
    expect(capabilityFor('SCOPE:nope')).toBeNull();
  });

  it('names a runtime handler for every value it claims to reproduce, and none for a gap', () => {
    for (const entry of AIDLC_CAPABILITIES) {
      const classifications = [
        { handling: entry.handling, handler: entry.handler },
        ...Object.values(entry.values ?? {}),
      ];
      for (const { handling, handler } of classifications) {
        if (handling === 'native' || handling === 'approximated') {
          expect(RUNTIME_HANDLERS.has(handler)).toBe(true);
        } else {
          expect(handler).toBeNull();
        }
      }
    }
  });

  it('derives the stage-mode enum from the block validator, not a second list', () => {
    expect(FRONTMATTER_ENUMS.STAGE.mode).toEqual([...STAGE_MODES]);
    expect(Object.keys(capabilityFor('STAGE:mode').values)).toEqual([...STAGE_MODES]);
  });

  it('classifies mode values against the handlers registered in this build', () => {
    expect(RUNTIME_HANDLERS).toContain('stage.mode.single-session@v1');
    expect(RUNTIME_HANDLERS).toContain('workspace.always-restored@v1');
    const modes = AIDLC_CAPABILITIES.find((entry) => entry.key === 'STAGE:mode');
    for (const mode of STAGE_MODES) {
      const classification = modes.values[mode];
      const implemented = Boolean(
        classification.handler && RUNTIME_HANDLERS.has(classification.handler),
      );
      expect(['native', 'approximated'].includes(classification.handling)).toBe(implemented);
    }
  });

  it('registers the plan-approval outcome checkpoint as a protocol handler', () => {
    const capability = capabilityFor('PROTOCOL:plan-approval');
    const gap = { blockType: 'PROTOCOL', field: 'plan-approval', value: 'present' };

    expect(capability).toMatchObject({
      handling: 'approximated',
      handler: 'protocol.plan-approval.outcome-gate@v1',
    });
    expect(RUNTIME_HANDLERS.has(capability.handler)).toBe(true);
    expect(unhonouredValues({ fidelityGaps: [gap] })).toEqual([]);

    const handlersWithoutOutcomeGate = new Set(RUNTIME_HANDLERS);
    handlersWithoutOutcomeGate.delete(capability.handler);
    expect(unhonouredValues({ fidelityGaps: [gap], handlers: handlersWithoutOutcomeGate })).toEqual(
      [gap],
    );
  });

  it('preserves authored fidelity gaps and reevaluates them against this build', () => {
    const gaps = [
      { blockType: 'STAGE', field: 'mode', value: 'pipeline' },
      { blockType: 'STAGE', field: 'mode', value: 'inline' },
      { blockType: 'UNKNOWN', field: 'future', value: 'value' },
    ];
    expect(unhonouredValues({ fidelityGaps: gaps })).toEqual(expectedUnhonoured(gaps));
  });

  it('derives the policy tables the plan resolver consumes, scope rows before stage rows', () => {
    expect(POLICY_ENUMS.map(([owner]) => owner)).toEqual([
      'scope',
      'scope',
      'scope',
      'scope',
      'scope',
      'scope',
      'stage',
      'stage',
    ]);
    expect(SCOPE_POLICY_KEYS).toEqual([
      'sensorsPolicy',
      'reviewCap',
      'summaryConfirmation',
      'changeControl',
      'learnings',
      'skeleton',
    ]);
    expect(STAGE_POLICY_KEYS).toEqual(['reviewClass', 'reviewArtifact', 'summaryConfirmation']);
    // Every policy row's enum is the registry's own value set for that field.
    for (const [owner, , field, allowed] of POLICY_ENUMS) {
      const blockType = owner === 'scope' ? 'SCOPE' : 'STAGE';
      expect(allowed).toEqual(Object.keys(capabilityFor(`${blockType}:${field}`).values));
    }
  });

  it('keeps the fidelity table the analyzer reads in its historical shape', () => {
    const fireOn = FIELD_FIDELITY.find((entry) => entry.field === 'fire_on');
    expect(fireOn).toMatchObject({
      blockType: 'SENSOR',
      handling: 'approximated',
      // Value-level, and the two values differ: no per-write hook exists, so
      // `write` stays an approximation, while `gate` runs as its own pass.
      values: { write: 'approximated', gate: 'native' },
    });
    // A protocol capability is not a frontmatter field and must never appear in
    // the frontmatter vocabulary.
    expect(FRONTMATTER_ENUMS).not.toHaveProperty('PROTOCOL');
  });
});

describe('capability presence and release defaults', () => {
  it('is inert when no block in the catalog authors the field', () => {
    expect(resolveCapabilities({ scopesById: { feature: { id: 'feature' } } })).toEqual({});
    expect(defaultWhenAbsent('SCOPE:change_control', {})).toBeNull();
  });

  it('resolves anyBlockAuthorsField from the catalog, never a version string', () => {
    const capabilities = resolveCapabilities({
      scopesById: {
        feature: { id: 'feature' },
        classic: { id: 'classic', changeControl: 'relaxed' },
      },
    });
    expect(capabilities).toEqual({ 'SCOPE:change_control': true });
    expect(defaultWhenAbsent('SCOPE:change_control', capabilities)).toBe('strict');
  });

  it('resolves runtimeFilePresent from a path list or a Map, and is absent without one', () => {
    const path = 'core/hooks/aidlc-plan-approval-guard.ts';
    expect(resolveCapabilities({ runtimeFilePaths: [path] })).toEqual({
      'PROTOCOL:plan-approval': true,
    });
    expect(resolveCapabilities({ runtimeFilePaths: new Map([[path, 'x']]) })).toEqual({
      'PROTOCOL:plan-approval': true,
    });
    expect(resolveCapabilities({ runtimeFilePaths: ['core/tools/other.ts'] })).toEqual({});
    expect(resolveCapabilities({})).toEqual({});
  });

  it('defaults an omitted change_control to strict ONLY when the capability is present', () => {
    const withCapability = planFor({
      scopeFm: { learnings: 'on' },
      extraScopes: { classic: { id: 'classic', changeControl: 'relaxed', version: 1 } },
    });
    expect(withCapability.plan.capabilities).toEqual({ 'SCOPE:change_control': true });
    expect(withCapability.plan.stages[0].policy.changeControl).toBe('strict');

    // Same authored scope, no other scope proving the capability: inert.
    const withoutCapability = planFor({ scopeFm: { learnings: 'on' } });
    expect(withoutCapability.plan.capabilities).toBeUndefined();
    expect(withoutCapability.plan.stages[0].policy.changeControl).toBeNull();
  });

  it('records no capabilities on the plan outside release mode', () => {
    const legacy = buildExecutionPlan({
      workflow: {
        id: 'wf',
        version: 1,
        placements: [{ stageId: 'demo', order: 0, scopeMembership: { feature: 'EXECUTE' } }],
        scopeRefs: [{ scopeId: 'feature' }],
      },
      scope: 'feature',
      library: {
        stagesById: { demo: { ...mapStage(STAGE_FM, 'body'), version: 1 } },
        agentsById: { 'reviewer-agent': { id: 'reviewer-agent', version: 1 } },
        sensorsById: {},
        rulesById: {},
        artifactsById: {},
        scopesById: { classic: { id: 'classic', changeControl: 'relaxed', version: 1 } },
        runtimeFilePaths: ['core/hooks/aidlc-plan-approval-guard.ts'],
      },
      releaseMode: false,
    });
    expect(legacy.plan.capabilities).toBeUndefined();
    expect(legacy.plan.stages[0].policy).toBeUndefined();
  });
});

describe('unhandled capabilities', () => {
  it('reports a resolved capability whose handler this build does not implement', () => {
    const registry = [
      {
        key: 'SCOPE:invented',
        blockType: 'SCOPE',
        field: 'invented',
        planKey: 'invented',
        policy: 'scope',
        handling: 'native',
        handler: 'policy.invented@v99',
        values: null,
        defaultWhenAbsent: null,
        capabilityPresentIf: 'anyBlockAuthorsField',
        note: '',
      },
    ];
    expect(
      unhandledCapabilities({
        capabilities: { 'SCOPE:invented': true },
        registry,
        handlers: RUNTIME_HANDLERS,
      }),
    ).toEqual(['SCOPE:invented']);
    // A capability that names no seam at all is a STATED gap, not an unhandled
    // one — reporting it would fail every pinned 2.9.0 run on a known deviation.
    expect(unhandledCapabilities({ capabilities: { 'PROTOCOL:plan-approval': true } })).toEqual([]);
  });

  it('fails the plan with capability_unhandled when this build implements no seam for it', () => {
    const args = {
      workflow: {
        id: 'wf',
        version: 1,
        placements: [{ stageId: 'demo', order: 0, scopeMembership: { feature: 'EXECUTE' } }],
        scopeRefs: [{ scopeId: 'feature' }],
      },
      scope: 'feature',
      library: {
        stagesById: { demo: { ...mapStage(STAGE_FM, 'body'), version: 1 } },
        agentsById: { 'reviewer-agent': { id: 'reviewer-agent', version: 1 } },
        sensorsById: {},
        rulesById: {},
        artifactsById: {},
        scopesById: { classic: { id: 'classic', changeControl: 'relaxed', version: 1 } },
      },
      releaseMode: true,
    };
    // The shipped build implements every seam the shipped registry names.
    expect(buildExecutionPlan(args).valid).toBe(true);

    // A build that lost the change-control seam (the hand-edited-pin scenario)
    // fails the plan instead of running the stage with the semantic missing.
    const drifted = buildExecutionPlan({ ...args, capabilityHandlers: new Set() });
    expect(drifted.valid).toBe(false);
    expect(drifted.errors).toContainEqual(
      expect.objectContaining({ code: 'capability_unhandled', ref: 'SCOPE:change_control' }),
    );
  });
});

describe('enum rejection at both boundaries', () => {
  it('rejects a value outside the registry vocabulary at import', () => {
    const files = filesFor('v2.9.0');
    const [scopePath, scopeBody] = [...files].find(([path]) => path.startsWith('core/scopes/'));
    files.set(scopePath, scopeBody.replace('---\n', '---\nsensors: sometimes\n'));
    const report = analyzeAidlcCompatibility({ profileId: 'v2.9.0', files });
    expect(report.importable).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'frontmatter_enum_invalid', field: 'sensors' }),
    );
    // No plan is produced for a catalog that does not import.
    expect(report.scopePlans).toBeUndefined();
  });

  it('rejects the same value at plan resolution and resolves no policy', () => {
    const result = planFor({ scopeFm: { sensors: 'sometimes' } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'policy_enum_invalid', ref: 'sensors' }),
    );
    expect(result.plan.stages[0].policy).toBeUndefined();
  });
});

describe('registry notes state only what the runtime does', () => {
  it('classifies `learnings: off` native, because the MCP server withdraws the writers', () => {
    const entry = capabilityFor('SCOPE:learnings');
    expect(entry.values.off).toEqual({ handling: 'native', handler: 'policy.learnings.off@v1' });
    expect(RUNTIME_HANDLERS.has('policy.learnings.off@v1')).toBe(true);
    // `on` is still the in-gate ritual, so the row's worst-case rollup stays approximated.
    expect(entry.values.on.handling).toBe('approximated');
    expect(entry.note).not.toMatch(/not withdrawn/);
  });

  it('names the real adversarial residual, not a landed dependency', () => {
    const { note } = capabilityFor('STAGE:review_class');
    expect(note).toContain('gets no repair turn, so its next round re-reviews the same revision');
    expect(note).toMatch(/codex/);
    expect(note).toMatch(/resumable/);
  });
});

describe('release promotion evidence', () => {
  it('re-evaluates frontmatter and engine gaps through the analyzer', () => {
    expect(
      fidelityGapsFromCatalog({
        catalog: { blocks: { STAGE: [{ blockId: 'unsupported-stage', mode: 'agent-team' }] } },
        bodies: ['{{INVOKE}} engine state set'],
      }),
    ).toEqual([
      { blockType: 'BODY', field: '{{INVOKE}}', value: 'engine state' },
      { blockType: 'STAGE', field: 'mode', value: 'agent-team' },
    ]);
  });

  it('reports only values that are unsupported or lack a runtime handler', () => {
    const fidelityGaps = [
      { blockType: 'STAGE', field: 'mode', value: 'agent-team' },
      { blockType: 'STAGE', field: 'mode', value: 'pipeline' },
      { blockType: 'UNKNOWN', field: 'value', value: 'new' },
    ];

    expect(unhonouredValues({ fidelityGaps })).toEqual([
      fidelityGaps[0],
      fidelityGaps[1],
      fidelityGaps[2],
    ]);
  });

  it('makes promotion availability depend on registered handlers', () => {
    for (const profileId of Object.keys(AIDLC_COMPATIBILITY_PROFILES)) {
      const report = analyzeAidlcCompatibility({ profileId, files: filesFor(profileId) });
      const fidelityGaps = report.fidelity.gaps.map(({ blockType, field, value }) => ({
        blockType,
        field,
        value,
      }));
      const expected = expectedUnhonoured(fidelityGaps);

      expect(unhonouredValues({ fidelityGaps }), profileId).toEqual(expected);
      expect(report.readyForCertification, profileId).toBe(expected.length === 0);
    }
  });
});
