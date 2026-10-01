// Release-level proof for the checkpoint family:
// which releases resolve a checkpoint policy at all, and therefore which runs can
// ever see `confirm_summary` / `request_plan_approval`.
//
// The 2.3.3-era assertions are the load-bearing ones: that catalog authors no
// policy field, so the plan resolves no policy, so the MCP config carries no
// policy key and the tool list is byte-identical to the pre-checkpoint one. A
// regression here is a silent behaviour change for every legacy intent.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  filesFromCompatibilityFixture,
  analyzeAidlcCompatibility,
} from '../aidlc-compatibility.js';
import { buildFromFiles } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { planApprovalApplies, resolveCapabilities } from '../aidlc-capabilities.js';
import { buildMcpConfig } from '../../agentcore/stage-materializer.js';
import { AUTHOR_TOOLS, toolsForRole } from '../../agentcore/mcp/server.js';

const PLAN_APPROVAL_HOOK = 'core/hooks/aidlc-plan-approval-guard.ts';

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

// Build the plan the runtime would build for one scope of one release, with the
// release-mode provenance flag and the runtime file list the resolver stamps.
const planFor = (profileId, scope) => {
  const files = fixtureFiles(profileId);
  const { blocks, workflow } = buildFromFiles(files);
  const report = analyzeAidlcCompatibility({ profileId, files });
  const library = {
    stagesById: keyById(blocks.filter((block) => block.type === 'STAGE')),
    agentsById: keyById(blocks.filter((block) => block.type === 'AGENT')),
    sensorsById: keyById(blocks.filter((block) => block.type === 'SENSOR')),
    rulesById: keyById(blocks.filter((block) => block.type === 'RULE')),
    artifactsById: keyById(blocks.filter((block) => block.type === 'ARTIFACT')),
    scopesById: keyById(blocks.filter((block) => block.type === 'SCOPE')),
    fromRelease: true,
    runtimeFilePaths: report.fidelity ? runtimeFilePaths(profileId) : [],
  };
  return buildExecutionPlan({ workflow: { ...workflow, version: 1 }, scope, library });
};

const runtimeFilePaths = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  ).runtimeFiles.map((entry) => entry.path);

describe('2.3.3 never sees a checkpoint', () => {
  it('resolves no policy for any scope, so no checkpoint can be required', () => {
    for (const scope of ['feature', 'bugfix', 'mvp']) {
      const { plan, valid } = planFor('current-stable', scope);
      expect(valid).toBe(true);
      expect(plan.stages.length).toBeGreaterThan(0);
      for (const stage of plan.stages) expect(stage.policy).toBeUndefined();
    }
  });

  it('registers exactly the pre-checkpoint author tool list', () => {
    const { plan } = planFor('current-stable', 'feature');
    for (const stage of plan.stages) {
      const tools = toolsForRole('author', stage.stageId, stage.policy ?? null);
      expect(tools).not.toContain('confirm_summary');
      expect(tools).not.toContain('request_plan_approval');
      // Byte-identical, not merely "does not contain": an added or reordered tool
      // would change the CLI's advertised surface for every legacy intent.
      if (stage.stageId !== 'workspace-detection') expect(tools).toEqual(AUTHOR_TOOLS);
    }
  });

  it('writes no policy key into the MCP config', () => {
    const { plan } = planFor('current-stable', 'feature');
    const [stage] = plan.stages;
    const config = buildMcpConfig({
      mcpEntry: '/srv/mcp.js',
      scope: { executionId: 'e1', intentId: 'i1', policy: stage.policy ?? null },
    });

    expect(config.mcpServers.aidlc.env).not.toHaveProperty('V2_STAGE_POLICY');
  });

  it('proves the catalog ships no plan-approval hook, so the capability is inert', () => {
    expect(runtimeFilePaths('current-stable')).not.toContain(PLAN_APPROVAL_HOOK);
    const capabilities = resolveCapabilities({
      runtimeFilePaths: runtimeFilePaths('current-stable'),
    });
    expect(capabilities['PROTOCOL:plan-approval']).toBeUndefined();
    expect(
      planApprovalApplies({ stage: { produces: ['code-generation-plan'] }, capabilities }),
    ).toBe(false);
  });
});

describe('plan approval is gated on the catalog, then on the stage', () => {
  const capabilitiesFor = (profileId) =>
    resolveCapabilities({ runtimeFilePaths: runtimeFilePaths(profileId) });

  it('is present from 2.6.18 onward, because those closures ship the guard hook', () => {
    for (const profileId of ['v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0']) {
      expect(runtimeFilePaths(profileId)).toContain(PLAN_APPROVAL_HOOK);
      expect(capabilitiesFor(profileId)['PROTOCOL:plan-approval']).toBe(true);
    }
  });

  it('applies only to the stages that produce the plan it approves', () => {
    const capabilities = capabilitiesFor('v2.9.0');

    expect(
      planApprovalApplies({ stage: { produces: ['code-generation-plan'] }, capabilities }),
    ).toBe(true);
    expect(
      planApprovalApplies({ stage: { produces: ['requirements-analysis'] }, capabilities }),
    ).toBe(false);
    // Honoured first, so mapping upstream's own key later changes nothing here.
    expect(planApprovalApplies({ stage: { workspaceRequires: true }, capabilities })).toBe(true);
  });

  it('never applies without the capability, whatever the stage declares', () => {
    expect(
      planApprovalApplies({
        stage: { workspaceRequires: true, produces: ['code-generation-plan'] },
        capabilities: {},
      }),
    ).toBe(false);
  });

  it('resolves planApproval on the code-generation stage of a 2.9.0 plan', () => {
    const { plan } = planFor('v2.9.0', 'feature');
    const codeGeneration = plan.stages.find((stage) => stage.stageId === 'code-generation');

    expect(codeGeneration.policy.planApproval).toBe('required');
    const tools = toolsForRole('author', 'code-generation', codeGeneration.policy);
    expect(tools).toContain('request_plan_approval');

    // A stage that does not produce the plan carries no plan-approval requirement.
    const other = plan.stages.find((stage) => stage.stageId !== 'code-generation');
    expect(other.policy.planApproval).toBeNull();
    expect(toolsForRole('author', other.stageId, other.policy)).not.toContain(
      'request_plan_approval',
    );
  });

  it('carries the resolved policy into the MCP config when one exists', () => {
    const { plan } = planFor('v2.9.0', 'feature');
    const codeGeneration = plan.stages.find((stage) => stage.stageId === 'code-generation');
    const config = buildMcpConfig({
      mcpEntry: '/srv/mcp.js',
      scope: { executionId: 'e1', intentId: 'i1', policy: codeGeneration.policy },
    });

    expect(JSON.parse(config.mcpServers.aidlc.env.V2_STAGE_POLICY)).toMatchObject({
      planApproval: 'required',
    });
  });
});
