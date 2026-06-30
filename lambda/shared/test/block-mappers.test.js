import { describe, it, expect } from 'vitest';
import { buildFromFiles, isRuntimeFile, sensorScriptPath } from '../block-mappers.js';
import { CORE_FILES } from './fixtures/repo-files.js';

const byType = (blocks, type) => blocks.filter((b) => b.type === type);
const byId = (blocks, type, id) => blocks.find((b) => b.type === type && b.id === id);

describe('buildFromFiles', () => {
  const { blocks, workflow, sensorScripts, runtimeFiles } = buildFromFiles(CORE_FILES);

  it('maps stages with V2 frontmatter flattened, carrying the body', () => {
    const stage = byId(blocks, 'STAGE', 'application-design');
    expect(stage.phase).toBe('inception');
    expect(stage.execution).toBe('CONDITIONAL');
    expect(stage.leadAgent).toBe('aidlc-architect-agent');
    expect(stage.supportAgents).toEqual(['aidlc-aws-platform-agent']);
    expect(stage.reviewer).toBe('aidlc-architecture-reviewer-agent');
    expect(stage.reviewerMaxIterations).toBe(2);
    expect(stage.requires).toEqual(['requirements-analysis']);
    expect(stage.humanValidation).toBe('required');
    expect(stage.body).toContain('# Application Design');
    // scopes are NOT persisted on the stage (they live on the placement).
    expect(stage.scopes).toBeUndefined();
  });

  it('maps consumes edges, surfacing conditional_on as conditionalOn', () => {
    const stage = byId(blocks, 'STAGE', 'application-design');
    const req = stage.consumes.find((c) => c.artifact === 'requirements');
    const arch = stage.consumes.find((c) => c.artifact === 'architecture');
    expect(req).toEqual({ artifact: 'requirements', required: true });
    expect(arch).toEqual({
      artifact: 'architecture',
      required: false,
      conditionalOn: 'brownfield',
    });
  });

  it('carries for_each onto the stage forEach field', () => {
    expect(byId(blocks, 'STAGE', 'functional-design').forEach).toBe('unit-of-work');
  });

  it('sets humanValidation none only for initialization stages', () => {
    expect(byId(blocks, 'STAGE', 'intent-capture').humanValidation).toBe('required');
  });

  it('maps agents with examples + model override and body', () => {
    const agent = byId(blocks, 'AGENT', 'aidlc-product-agent');
    expect(agent.displayName).toBe('Product Agent');
    expect(agent.examples).toEqual(['roadmap.md', 'personas.md']);
    expect(agent.modelOverride).toBe('opus');
    expect(agent.body).toContain('# Product Agent');
  });

  it('maps scopes, defaulting testStrategy to depth unless overridden', () => {
    expect(byId(blocks, 'SCOPE', 'feature').testStrategy).toBe('Standard');
    expect(byId(blocks, 'SCOPE', 'workshop').testStrategy).toBe('Minimal');
  });

  it('maps sensors with command + nested schema and manifest body', () => {
    const sensor = byId(blocks, 'SENSOR', 'linter');
    expect(sensor.command).toContain('aidlc-sensor-linter.ts');
    expect(sensor.category).toBe('code-quality');
    expect(sensor.inputSchema).toEqual({ file_path: 'string' });
    expect(sensor.body).toContain('# linter sensor');
  });

  it('derives rule layer/phase from the filename (no frontmatter)', () => {
    const org = byId(blocks, 'RULE', 'aidlc-org');
    expect(org.layer).toBe('org');
    expect(org.phase).toBeNull();
    expect(org.body).toContain('# Org-Level Rules');
    const phase = byId(blocks, 'RULE', 'aidlc-phase-ideation');
    expect(phase.layer).toBe('phase');
    expect(phase.phase).toBe('ideation');
  });

  it('derives knowledge agentRef + namespaced id from the path', () => {
    const guide = byId(blocks, 'KNOWLEDGE', 'product-agent-requirements-guide');
    expect(guide.agentRef).toBe('aidlc-product-agent');
    expect(guide.tier).toBe('methodology');
    const shared = byId(blocks, 'KNOWLEDGE', 'shared-ai-dlc-principles');
    expect(shared.agentRef).toBe('shared');
  });

  it('maps skills with the invocation contract + body', () => {
    const skill = byId(blocks, 'SKILL', 'aidlc-replay');
    expect(skill.userInvocable).toBe(true);
    expect(skill.classification).toBe('read-only');
    expect(skill.body).toContain('# AI-DLC Session Replay');
  });

  it('maps templates (body carries the slots)', () => {
    const tmpl = byId(blocks, 'TEMPLATE', 'onboarding');
    expect(tmpl.body).toContain('{{SLOT:title_block}}');
  });

  it('derives the ARTIFACT vocabulary from produced names, flagging terminals', () => {
    const artifacts = byType(blocks, 'ARTIFACT');
    const ids = artifacts.map((a) => a.id);
    // One ARTIFACT per distinct PRODUCED name (consume-only names like
    // `requirements` are not artifacts — they're produced by stages absent here).
    expect(ids).toContain('components'); // produced, never consumed → terminal
    expect(ids).not.toContain('requirements');
    const components = artifacts.find((a) => a.id === 'components');
    expect(components.terminal).toBe(true);
  });

  it('builds the aidlc-v2 workflow: 5 phases, one placement per stage, rule refs', () => {
    expect(workflow.id).toBe('aidlc-v2');
    expect(workflow.phases).toHaveLength(5);
    expect(workflow.placements).toHaveLength(byType(blocks, 'STAGE').length);
    // The placement's scopeMembership transposes the stage's scopes list.
    const p = workflow.placements.find((x) => x.stageId === 'intent-capture');
    expect(p.scopeMembership).toEqual({ feature: 'EXECUTE', mvp: 'EXECUTE' });
    // Scope refs are the deduped union of every scope named in a placement — the
    // compiled scopeGrid (hence the create-project scope picker) is built from them.
    expect(workflow.scopeRefs.map((s) => s.scopeId)).toEqual(['feature', 'mvp']);
    // Rule refs cover every rule.
    expect(workflow.ruleRefs.map((r) => r.ruleId).sort()).toEqual([
      'aidlc-org',
      'aidlc-phase-ideation',
    ]);
  });

  it('pairs each sensor with its tools/aidlc-sensor-<id>.ts script', () => {
    expect(sensorScripts.get('linter').path).toBe('core/tools/aidlc-sensor-linter.ts');
    expect(sensorScripts.get('linter').content).toContain('linter sensor script');
    expect(sensorScripts.get('required-sections')).toBeTruthy();
  });

  it('collects internal runtime files (tools/hooks/protocols/conductor), not blocks', () => {
    expect(runtimeFiles.has('core/tools/aidlc-orchestrate.ts')).toBe(true);
    expect(runtimeFiles.has('core/hooks/aidlc-session-start.ts')).toBe(true);
    expect(runtimeFiles.has('core/aidlc-common/protocols/stage-protocol.md')).toBe(true);
    expect(runtimeFiles.has('core/aidlc-common/conductor.md')).toBe(true);
    // Sensor scripts are tools too — they appear in the runtime snapshot AND as
    // scriptRef on their sensor block.
    expect(runtimeFiles.has('core/tools/aidlc-sensor-linter.ts')).toBe(true);
    // No editable block leaked into the runtime set.
    expect(runtimeFiles.has('core/agents/aidlc-product-agent.md')).toBe(false);
  });
});

describe('isRuntimeFile', () => {
  it('classes engine tools, hooks, protocols, and conductor as runtime', () => {
    expect(isRuntimeFile('core/tools/aidlc-orchestrate.ts')).toBe(true);
    expect(isRuntimeFile('core/hooks/aidlc-stop.ts')).toBe(true);
    expect(isRuntimeFile('core/aidlc-common/protocols/stage-protocol.md')).toBe(true);
    expect(isRuntimeFile('core/aidlc-common/conductor.md')).toBe(true);
  });

  it('does not class editable blocks as runtime', () => {
    expect(isRuntimeFile('core/agents/aidlc-product-agent.md')).toBe(false);
    expect(isRuntimeFile('core/skills/aidlc-replay/SKILL.md')).toBe(false);
    expect(isRuntimeFile('core/templates/onboarding.md')).toBe(false);
  });
});

describe('sensorScriptPath', () => {
  it('follows the core/tools/aidlc-sensor-<id>.ts convention', () => {
    expect(sensorScriptPath('linter')).toBe('core/tools/aidlc-sensor-linter.ts');
  });
});
