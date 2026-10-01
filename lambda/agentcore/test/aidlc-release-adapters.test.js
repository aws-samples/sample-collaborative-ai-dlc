import { describe, expect, it } from 'vitest';
import { INVOKE_DIALECT_ANNEX, buildStagePrompt, neutralizeInvoke } from '../stage-materializer.js';

const STAGE = Object.freeze({
  stageId: 'functional-design',
  phase: 'inception',
  agentRef: 'aidlc-architect-agent',
  inputArtifacts: [{ artifact: 'requirements', required: true }],
  outputArtifacts: [{ artifact: 'business-logic-model' }],
});

describe('{{INVOKE}} dialect', () => {
  it('neutralizes the token to a clearly runtime-managed marker', () => {
    expect(neutralizeInvoke('run {{INVOKE}} engine gen scope-table')).toBe(
      'run <runtime-managed-engine> engine gen scope-table',
    );
  });

  it('appends the dialect annex only when the stage body carries the token', () => {
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

  it('does not append the annex for incidental mentions in other prompt parts', () => {
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
