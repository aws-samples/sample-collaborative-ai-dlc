// The 2.11.0 scope settings at the PLAN seam: Guard Policy, Plan Approval and
// project type must reach the per-stage policy, and nothing else may move.
//
// The scopes are the verbatim upstream 2.11.0 frontmatter
// (fixtures/aidlc-211-scopes.json) carried onto the 2.9.0 stage set, whose stage
// frontmatter 2.11.0 changes in exactly one file (`code-generation.md`, a sensor
// list) — none of the fields this policy reads. That makes every assertion below
// a statement about real authored bytes rather than a synthetic scope.

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

// The 2.9.0 closure, optionally with its scope files replaced by the real
// 2.11.0 ones, so the settings under test are authored exactly as upstream
// authors them. `scopes` selects which scope bytes the closure carries.
const releaseContext = async ({ scopes = 'upstream-2.11', overlayScope = null } = {}) => {
  const files = filesFromCompatibilityFixture({ profileId: BASE_PROFILE, fixture: baseFixture });
  if (scopes !== 'upstream-base') {
    for (const path of files.keys()) {
      if (path.startsWith('core/scopes/')) files.delete(path);
    }
    for (const [path, entry] of Object.entries(SCOPE_FIXTURE.scopes)) {
      const frontmatter =
        scopes === 'upstream-2.11'
          ? entry.frontmatter
          : entry.frontmatter
              .split('\n')
              .filter(
                (line) => !/^(guard_policy|plan_approval|collaborators|existing_code):/.test(line),
              )
              .join('\n');
      files.set(path, `---\n${frontmatter}\n---\n[BODY OMITTED]\n`);
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
      catalog: { workflow: { ...built.workflow, workflowVersion: 1, version: 1 } },
      blocksByType: Object.fromEntries(
        LIBRARY_TYPES.map((type) => [
          type,
          built.blocks
            .filter((block) => block.type === type)
            .map((block) => ({
              ...block,
              version: 1,
            })),
        ]),
      ),
      runtimeFiles: new Map(
        baseFixture.runtimeFiles.map((runtimeFile) => [runtimeFile.path, runtimeFile]),
      ),
    },
    // A user SCOPE overlay is the one path a scope block reaches the plan on
    // WITHOUT passing through the mapper: the pinned version is read verbatim
    // from the user tenant, so it can carry the new field name alone, or both
    // names disagreeing. `overlayScope` is that row.
    ddb: overlayScope
      ? { send: async () => ({ Item: overlayScope.block }) }
      : { send: () => Promise.reject(new Error('unexpected fixture DDB read')) },
    tableName: 'synthetic-fixture-table',
    workflowId: built.workflow.id,
    workflowVersion: 1,
    ...(overlayScope
      ? {
          methodologyPins: {
            SCOPE: { [overlayScope.blockId]: { tenantId: 'default', version: 7 } },
          },
        }
      : {}),
  });
  return { workflow: { ...resolved.workflow, version: 1 }, library: resolved.library };
};

const plansFor = async (options) => {
  const { workflow, library } = await releaseContext(options);
  const scopes = Object.keys(library.scopesById).toSorted();
  return Object.fromEntries(
    scopes.map((scope) => {
      const { plan, valid, errors } = buildExecutionPlan({ workflow, scope, library });
      expect({ scope, valid, errors }).toEqual({ scope, valid: true, errors: [] });
      return [scope, plan];
    }),
  );
};

const stagesOf = (plan) => plan.stages;

describe('the 2.11.0 scope settings reach the per-stage policy', () => {
  it('resolves strict change control for the enterprise guard policy', async () => {
    const plans = await plansFor();

    for (const stage of stagesOf(plans.enterprise)) {
      expect({ stageId: stage.stageId, changeControl: stage.policy?.changeControl }).toEqual({
        stageId: stage.stageId,
        changeControl: 'strict',
      });
      expect(stage.policy?.guardPolicy).toBe('strict');
    }
  });

  // `off` is a value the platform CAN honour: no reopen and no change-control
  // prose. It resolves to no change control at all, while the authored value
  // stays on the policy so the scope's choice is visible.
  it('resolves no change control for a scope whose guard policy is off', async () => {
    const plans = await plansFor();

    for (const scope of ['classic', 'express', 'bugfix']) {
      for (const stage of stagesOf(plans[scope])) {
        expect({ scope, changeControl: stage.policy?.changeControl }).toEqual({
          scope,
          changeControl: null,
        });
        expect(stage.policy?.guardPolicy).toBe('off');
      }
    }
  });

  it('withdraws the plan gate only where the scope turns plan approval off', async () => {
    const plans = await plansFor();
    const planApprovals = (scope) =>
      stagesOf(plans[scope])
        .filter((stage) => stage.policy?.planApproval === 'required')
        .map((stage) => stage.stageId);

    expect(planApprovals('express')).toEqual([]);
    expect(planApprovals('poc')).toEqual([]);
    expect(planApprovals('enterprise').length).toBeGreaterThan(0);
    expect(planApprovals('classic').length).toBeGreaterThan(0);
  });

  it('carries the authored project type of an existing-code scope', async () => {
    const plans = await plansFor();
    const existingCode = (scope) =>
      new Set(stagesOf(plans[scope]).map((stage) => stage.policy?.existingCode ?? null));

    for (const scope of ['bugfix', 'refactor', 'security-patch']) {
      expect({ scope, existingCode: [...existingCode(scope)] }).toEqual({
        scope,
        existingCode: [true],
      });
    }
    expect([...existingCode('classic')]).toEqual([null]);
  });

  // Guard Policy and Plan Approval are not allowed to lower a human gate.
  // Every stage of every scope must keep the exact
  // `humanValidation` the same plan has with the four settings stripped out.
  it('removes no human gate from any scope', async () => {
    const withSettings = await plansFor();
    const without = await plansFor({ scopes: 'upstream-2.11-stripped' });
    const gates = (plans) =>
      Object.fromEntries(
        Object.entries(plans).map(([scope, plan]) => [
          scope,
          stagesOf(plan).map((stage) => `${stage.stageId}:${stage.humanValidation}`),
        ]),
      );

    expect(Object.keys(withSettings)).toHaveLength(11);
    expect(gates(withSettings)).toEqual(gates(without));
  });

  // The delta for an existing pin is `none`, asserted rather than argued: a
  // 2.9.0 closure authors none of the four fields, so every scope's policy is
  // byte-identical to the one this build already resolves, with the two new keys
  // inert.
  it('leaves a release that authors none of the settings resolving exactly as before', async () => {
    const plans = await plansFor({ scopes: 'upstream-base' });
    const policies = Object.fromEntries(
      Object.entries(plans).map(([scope, plan]) => [
        scope,
        stagesOf(plan).map((stage) => ({ stageId: stage.stageId, ...stage.policy })),
      ]),
    );

    expect(Object.keys(policies)).toHaveLength(11);
    for (const [scope, stages] of Object.entries(policies)) {
      expect(stages.length, scope).toBeGreaterThan(0);
      for (const policy of stages) {
        expect({ scope, ...policy }).toMatchObject({
          scope,
          guardPolicy: null,
          existingCode: null,
        });
      }
    }
    expect(new Set(policies.enterprise.map((policy) => policy.changeControl))).toEqual(
      new Set(['strict']),
    );
    expect(
      policies.express.filter((policy) => policy.planApproval === 'required').length,
    ).toBeGreaterThan(0);
  });
});

// Guard Policy has two authored names and ONE effect. The mapper happens to
// write both for an imported closure, but a user SCOPE overlay never passes
// through the mapper (`release-resolver.js` `loadUserOverlay` stores the pinned
// version verbatim), so the plan has to resolve the effective value itself
// rather than expecting the caller to synchronize an internal alias.
describe('the guard policy a forked scope overlay declares', () => {
  const overlayOf = (attributes) => ({
    blockId: 'classic',
    block: {
      type: 'SCOPE',
      id: 'classic',
      blockId: 'classic',
      name: 'classic',
      version: 7,
      tenantId: 'default',
      depth: 'Standard',
      keywords: [],
      description: 'forked classic',
      body: '[BODY OMITTED]',
      ...attributes,
    },
  });

  const classicPolicies = async (attributes) => {
    const { workflow, library } = await releaseContext({
      scopes: 'upstream-base',
      overlayScope: overlayOf(attributes),
    });
    const { plan, valid, errors } = buildExecutionPlan({ workflow, scope: 'classic', library });
    expect({ valid, errors }).toEqual({ valid: true, errors: [] });
    return plan.stages.map((stage) => stage.policy);
  };

  const singular = (policies, key) => {
    const values = new Set(policies.map((policy) => policy?.[key] ?? null));
    expect(values.size, key).toBe(1);
    return [...values][0];
  };

  it('prefers the new name over a legacy value that disagrees with it', async () => {
    const policies = await classicPolicies({ guardPolicy: 'strict', changeControl: 'relaxed' });

    expect(singular(policies, 'changeControl')).toBe('strict');
    expect(singular(policies, 'guardPolicy')).toBe('strict');
  });

  it('honours the new name on its own', async () => {
    const policies = await classicPolicies({ guardPolicy: 'strict' });

    expect(singular(policies, 'changeControl')).toBe('strict');
  });

  it('turns change control off for the new name alone', async () => {
    const policies = await classicPolicies({ guardPolicy: 'off', changeControl: 'strict' });

    expect(singular(policies, 'changeControl')).toBe(null);
    expect(singular(policies, 'guardPolicy')).toBe('off');
  });

  it('keeps resolving a legacy-only overlay exactly as before', async () => {
    const policies = await classicPolicies({ changeControl: 'relaxed' });

    expect(singular(policies, 'changeControl')).toBe('relaxed');
    expect(singular(policies, 'guardPolicy')).toBe(null);
  });
});
