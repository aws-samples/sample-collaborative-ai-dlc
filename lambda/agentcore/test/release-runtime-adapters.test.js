// Per-release adapters at the RUNTIME seams: the stage
// prompt (scope policy + {{INVOKE}} dialect), the OpenCode turn cap, and the
// sensor `fire_on` planes. Each case also pins the legacy shape, because a
// catalog without the new fields must produce byte-identical output.

import { describe, expect, it, vi } from 'vitest';
import { createSensorRunner } from '../sensor-runner.js';
import {
  INVOKE_DIALECT_ANNEX,
  OPENCODE_DEFAULT_AGENT,
  buildOpenCodeConfig,
  buildStagePrompt,
  neutralizeInvoke,
  renderScopePolicy,
} from '../stage-materializer.js';
import { workspaceRelativePath } from '../repo-paths.js';

const STAGE = Object.freeze({
  stageId: 'functional-design',
  phase: 'inception',
  agentRef: 'aidlc-architect-agent',
  inputArtifacts: [{ artifact: 'requirements', required: true }],
  outputArtifacts: [{ artifact: 'business-logic-model' }],
});

const SCOPE = Object.freeze({ executionId: 'e1', intentId: 'i1' });

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: 'strict',
  learnings: 'on',
  skeleton: null,
});

describe('{{INVOKE}} dialect', () => {
  it('neutralizes the token to a clearly runtime-managed marker', () => {
    expect(neutralizeInvoke('run {{INVOKE}} engine gen scope-table')).toBe(
      'run <runtime-managed-engine> engine gen scope-table',
    );
  });

  it('appends the dialect annex only when a prompt part carries the token', () => {
    const legacy = buildStagePrompt({ stage: STAGE, stageBody: '# Design\nDo the work.' });
    expect(legacy).not.toContain(INVOKE_DIALECT_ANNEX);
    expect(legacy).not.toContain('<runtime-managed-engine>');

    const body = '# Design\nRun `{{INVOKE}} engine orchestrate report --stage x --result done`.';
    const adapted = buildStagePrompt({ stage: STAGE, stageBody: body });
    const neutralized = buildStagePrompt({ stage: STAGE, stageBody: neutralizeInvoke(body) });

    expect(adapted).toBe(`${neutralized}\n\n${INVOKE_DIALECT_ANNEX}`);
    expect(adapted).not.toContain('{{INVOKE}}');
    expect(adapted).toContain('<runtime-managed-engine> engine orchestrate report');
  });

  it('detects the token in the conductor as well as the stage body', () => {
    const prompt = buildStagePrompt({
      stage: STAGE,
      stageBody: 'plain',
      conductor: 'Call {{INVOKE}} engine state practices-promote when a practice stabilizes.',
    });
    expect(prompt).toContain(INVOKE_DIALECT_ANNEX);
    expect(prompt).not.toContain('{{INVOKE}}');
  });

  // The annex is gated on the two parts that INSTRUCT the
  // agent. A persona or knowledge doc that merely mentions the token is still
  // neutralized, but must not drag the whole annex into the prompt.
  it('does not append the annex for an incidental mention in a persona or knowledge', () => {
    for (const part of ['agentPersona', 'knowledge', 'compiledContext']) {
      const prompt = buildStagePrompt({
        stage: STAGE,
        stageBody: 'plain',
        [part]: 'Historically this ran {{INVOKE}} engine gen scope-table.',
      });
      expect(prompt).not.toContain(INVOKE_DIALECT_ANNEX);
      expect(prompt).not.toContain('{{INVOKE}}');
      expect(prompt).toContain('<runtime-managed-engine>');
    }
  });

  it('never tells the agent a missing prerequisite is satisfied', () => {
    expect(INVOKE_DIALECT_ANNEX).not.toMatch(/treat that prerequisite as already satisfied/i);
    expect(INVOKE_DIALECT_ANNEX).not.toMatch(/prerequisite as (?:already )?satisfied/i);
    expect(INVOKE_DIALECT_ANNEX).toContain('is a GAP, not a satisfied prerequisite');
  });

  it('forbids fabricating engine-produced values and closes the command list', () => {
    expect(INVOKE_DIALECT_ANNEX).toContain('Never invent a value the engine would have generated');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/no fingerprints/i);
    expect(INVOKE_DIALECT_ANNEX).toContain('closed list');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/do not run anything and do not improvise/i);
  });

  it('makes practices promotion a recommendation, never a durable write', () => {
    expect(INVOKE_DIALECT_ANNEX).toMatch(/Do \*\*not\*\* call `record_learning_rule`/);
    expect(INVOKE_DIALECT_ANNEX).toMatch(/recommendation for the human/i);
  });

  it('says plainly that a human must rewind to recompose', () => {
    expect(INVOKE_DIALECT_ANNEX).toContain('RECOMMENDED STAGE ADDITION');
    expect(INVOKE_DIALECT_ANNEX).toMatch(/human must rewind and recompose/i);
  });

  it('maps every engine command family the annex is responsible for', () => {
    for (const fragment of [
      'orchestrate report',
      'recompose',
      'set-construction-iteration',
      'practices-event',
      'practices-promote',
      'scope-table',
      'codekb-scope-diff',
      'codekb --repo',
    ]) {
      expect(INVOKE_DIALECT_ANNEX).toContain(fragment);
    }
    expect(INVOKE_DIALECT_ANNEX).toContain('record_team_knowledge');
    expect(INVOKE_DIALECT_ANNEX).toContain('record_learning_rule');
    expect(INVOKE_DIALECT_ANNEX).toContain('emit_stage_note');
    expect(INVOKE_DIALECT_ANNEX).toContain('send_output');
  });
});

describe('scope policy in the stage prompt', () => {
  it('renders nothing for a legacy plan or an all-default policy', () => {
    expect(renderScopePolicy(null)).toBe('');
    expect(renderScopePolicy({ ...POLICY, changeControl: null })).toBe('');
    expect(buildStagePrompt({ stage: STAGE, stageBody: 'x' })).not.toContain('## Scope policy');
  });

  it('points at the confirm_summary checkpoint when confirmation is required', () => {
    const rendered = renderScopePolicy({ ...POLICY, summaryConfirmation: 'required' });
    expect(rendered).toContain('Summary confirmation is REQUIRED');
    // The checkpoint is a dedicated tool, not an ask_question the agent shapes:
    // the platform owns the two labels and the receipt they write.
    expect(rendered).toContain('confirm_summary');
    expect(rendered).not.toContain('ask_question');
  });

  it('points at the request_plan_approval checkpoint when plan approval applies', () => {
    const rendered = renderScopePolicy({ ...POLICY, planApproval: 'required' });
    expect(rendered).toContain('Plan approval is REQUIRED');
    expect(rendered).toContain('request_plan_approval');
  });

  it('says nothing about learnings when the scope turns them off', () => {
    // `learnings: off` is enforced by WITHDRAWING the two tools in mcp/server.js,
    // so the prompt must not describe tools the agent cannot see.
    const rendered = renderScopePolicy({ ...POLICY, learnings: 'off' });
    expect(rendered).not.toContain('Learnings capture is OFF');
    expect(rendered).not.toContain('record_learning_rule');
    expect(rendered).not.toContain('record_team_knowledge');
  });

  it('explains both change-control modes', () => {
    expect(renderScopePolicy({ ...POLICY, changeControl: 'relaxed' })).toContain('CHANGE_ACCEPTED');
    expect(renderScopePolicy({ ...POLICY, changeControl: 'strict' })).toContain(
      'Change control is STRICT',
    );
  });

  it('states the skeleton ceremony and the advisory review class', () => {
    expect(renderScopePolicy({ ...POLICY, skeleton: 'on' })).toContain('Walking skeleton is ON');
    expect(renderScopePolicy({ ...POLICY, reviewClass: 'advisory' })).toContain(
      'Review is ADVISORY',
    );
    expect(renderScopePolicy({ ...POLICY, reviewClass: 'none' })).toContain(
      'No independent reviewer runs',
    );
  });

  it('injects the block into the prompt when the plan resolved a policy', () => {
    const prompt = buildStagePrompt({
      stage: { ...STAGE, policy: { ...POLICY, summaryConfirmation: 'required' } },
      stageBody: 'x',
    });
    expect(prompt).toContain('## Scope policy (authoritative for these rituals)');
    expect(prompt).toContain('Summary confirmation is REQUIRED');
  });
});

// A `fire_on: write` sweep reads workspace-relative paths, but
// git reports repo-relative ones. In multi-repo mode the two spaces differ.
describe('write-plane path space (multi-repo)', () => {
  it('leaves a single-repo path untouched', () => {
    expect(workspaceRelativePath({ repo: 'acme/api', file: 'src/a.ts', multi: false })).toBe(
      'src/a.ts',
    );
  });

  it('projects a repo-relative path into the workspace layout when multi-repo', () => {
    expect(workspaceRelativePath({ repo: 'acme/api', file: 'src/a.ts', multi: true })).toBe(
      'acme/api/src/a.ts',
    );
  });

  it('drops a path it cannot project rather than emitting a traversal', () => {
    expect(workspaceRelativePath({ repo: '../escape', file: 'src/a.ts', multi: true })).toBeNull();
    expect(workspaceRelativePath({ repo: 'acme/api', file: '', multi: true })).toBeNull();
    expect(workspaceRelativePath({ repo: 'acme/api', file: undefined, multi: true })).toBeNull();
  });
});

describe('AGENT.maxTurns on the OpenCode driver', () => {
  const base = { mcpEntry: '/srv/mcp.js', scope: SCOPE };

  it('emits no agent block when the block declares no cap', () => {
    expect(buildOpenCodeConfig(base).agent).toBeUndefined();
    expect(buildOpenCodeConfig({ ...base, maxTurns: null }).agent).toBeUndefined();
  });

  it('maps a declared cap onto the run agent step limit', () => {
    expect(buildOpenCodeConfig({ ...base, maxTurns: 60 }).agent).toEqual({
      [OPENCODE_DEFAULT_AGENT]: { steps: 60 },
    });
  });

  it('ignores a value that is not a positive integer rather than emitting junk', () => {
    for (const maxTurns of [0, -1, 12.5, '60', 'lots']) {
      expect(buildOpenCodeConfig({ ...base, maxTurns }).agent).toBeUndefined();
    }
  });

  it('keeps the reserved aidlc MCP entry last so a cap cannot reorder it', () => {
    const config = buildOpenCodeConfig({ ...base, maxTurns: 60 });
    expect(Object.keys(config.mcp).at(-1)).toBe('aidlc');
  });
});

describe('sensor fire_on planes', () => {
  const graph = {
    lookupArtifacts: vi.fn(async () => []),
  };
  const runner = () =>
    createSensorRunner({
      graph,
      loadBlockScript: async () => '',
      workspaceDir: null,
      spawnFn: vi.fn(),
    });

  const scriptSensor = (extra = {}) => ({
    sensorId: 'linter',
    runtime: 'bun',
    command: 'bun run linter',
    matches: '**/*.ts',
    severity: 'advisory',
    ...extra,
  });

  it('records not-applicable for a gate sensor with no matching deliverable', async () => {
    const created = createSensorRunner({
      graph,
      loadBlockScript: async () => 'export default 1;',
      workspaceDir: '/nonexistent-workspace',
      spawnFn: vi.fn(),
    });
    const [verdict] = await created.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'gate' })],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toMatchObject({ notApplicable: true, fireOn: 'gate' });
    expect(verdict.held).toBe(false);
  });

  it('narrows a write-plane sensor to this attempt\u2019s changed files', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('should not spawn: no changed file matches');
    });
    const created = createSensorRunner({
      graph,
      loadBlockScript: async () => 'export default 1;',
      workspaceDir: '/nonexistent-workspace',
      spawnFn,
    });
    const [verdict] = await created.runStageSensors({
      sensors: [scriptSensor({ fireOn: 'write' })],
      stageId: 'code-generation',
      changedFiles: ['README.md', 'docs/guide.md'],
    });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toMatchObject({
      reason: 'no files match',
      fireOn: 'write',
      changedFiles: 2,
    });
    expect(verdict.detail.notApplicable).toBeUndefined();
  });

  it('keeps a sensor without fire_on on the workspace-wide sweep', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [scriptSensor()],
      stageId: 'code-generation',
    });
    expect(verdict.result).toBe('INCONCLUSIVE');
    expect(verdict.detail).toEqual({ reason: 'no workspace' });
  });

  // A gate-plane sensor may only report not-applicable when
  // it found NOTHING to say. A missing REQUIRED deliverable is a finding, and
  // suppressing it behind `notApplicable` was hiding exactly the failure the
  // gate plane exists to catch.
  it('keeps a missing required deliverable as a finding even on the gate plane', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [
        { sensorId: 'required-sections', severity: 'advisory', fireOn: 'gate', category: 'docs' },
      ],
      outputArtifacts: [{ artifact: 'business-logic-model' }],
      stageId: 'functional-design',
    });
    expect(verdict.kind).toBe('graph');
    expect(verdict.detail.notApplicable).toBeUndefined();
    expect(verdict.detail.artifacts).toEqual([
      { artifact: 'business-logic-model', reason: 'not found in graph' },
    ]);
  });

  it('reports a gate graph sensor as not-applicable when nothing was applicable', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [
        { sensorId: 'required-sections', severity: 'advisory', fireOn: 'gate', category: 'docs' },
      ],
      // Only an OPTIONAL output: its absence is by design, so the sensor records
      // no finding and the gate plane genuinely has no deliverable to inspect.
      outputArtifacts: [{ artifact: 'frontend-components', optional: true }],
      stageId: 'functional-design',
    });
    expect(verdict.kind).toBe('graph');
    expect(verdict.detail).toMatchObject({ notApplicable: true, fireOn: 'gate' });
  });

  it('still reports a missing required deliverable when fire_on is absent', async () => {
    const [verdict] = await runner().runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory', category: 'docs' }],
      outputArtifacts: [{ artifact: 'business-logic-model' }],
      stageId: 'functional-design',
    });
    expect(verdict.detail.notApplicable).toBeUndefined();
    expect(verdict.detail.artifacts).toEqual([
      { artifact: 'business-logic-model', reason: 'not found in graph' },
    ]);
  });
});
