import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { nativeRequirementsForm } from '../native/turn-interaction.js';
import { observeNativeMethodOutput } from '../native/method-output.js';
const questions = readFileSync(
  new URL('../../../scripts/test/fixtures/native-game-requirements-questions.md', import.meta.url),
  'utf8',
);
const intent = 'aidlc/spaces/default/intents/game';
const stage = 'requirements-analysis';
const questionPath = `${intent}/inception/${stage}/${stage}-questions.md`;
const mode = {
  prompt: 'How would you like to answer the questions?',
  options: "Guide me,I'll edit the file,Chat",
  questionKind: 'answer-mode',
};
function fixture(decision, content = questions) {
  const audit = `## Decision Recorded\n**Timestamp**: 2026-11-25T10:43:02Z\n**Event**: DECISION_RECORDED\n**Stage**: ${stage}\n**Decision**: ${decision.prompt}\n${decision.options ? `**Options**: ${decision.options}\n` : ''}${decision.questionKind ? `**Question Kind**: ${decision.questionKind}\n` : ''}\n---\n`;
  const files = Object.entries({
    'aidlc/active-space': 'default',
    'aidlc/spaces/default/intents/active-intent': 'game',
    [`${intent}/aidlc-state.md`]: `- **Status**: Running\n- **Current Stage**: ${stage}\n- [-] ${stage} — EXECUTE`,
    [`${intent}/.aidlc-engine/active-directive.json`]: JSON.stringify({
      version: 2,
      kind: 'run-stage',
      stage,
      cursor_harness: 'codex',
      active_attempt: { status: 'settled' },
    }),
    [questionPath]: content,
    [`${intent}/audit/localhost-fixture.md`]: audit,
  }).map(([path, text]) => ({
    path,
    content: Buffer.from(text),
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    role: path === questionPath ? 'question' : 'artifact',
  }));
  return {
    snapshot: { files },
    beforeFiles: [],
    harness: 'codex',
    method: { decision: { stage, ...decision } },
  };
}
it('uses only the fresh mode decision from the settled active intent, even for indirect CLI output', () => {
  const input = fixture(mode);
  expect(input.snapshot.files.find((f) => f.path === questionPath).sha256).toBe(
    'ea3f884a9f1d36174b7f8e0663b679af6b5c9f6680995b0d6a0806a15e5a2958',
  );
  const o = observeNativeMethodOutput('codex');
  o.write({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      id: '1',
      command: 'cd /workspace && aidlc engine log decision ...',
      aggregated_output: JSON.stringify({ stage, emitted: 'DECISION_RECORDED' }),
      exit_code: 0,
    },
  });
  for (const method of [input.method, o.result()])
    expect(
      nativeRequirementsForm({ ...input, method }).spec.questions[0].options.map(
        (option) => option.label,
      ),
    ).toEqual(mode.options.split(','));
  for (const patch of [
    { beforeFiles: input.snapshot.files },
    { method: { rejection: 'refused' } },
    { method: { uncertain: true } },
    { method: { terminal: 'complete' } },
    { harness: 'opencode' },
  ])
    expect(nativeRequirementsForm({ ...input, ...patch })).toBeNull();
});
it('retains an open decision across the installed Claude session-end hook but suppresses an answered decision', () => {
  const input = fixture(mode);
  const audit = input.snapshot.files.at(-1);
  const append = (event) => {
    audit.content = Buffer.concat([
      audit.content,
      Buffer.from(`\n## Session event\n**Event**: ${event}\n\n---\n`),
    ]);
    audit.sha256 = createHash('sha256').update(audit.content).digest('hex');
  };
  append('SESSION_ENDED');
  expect(nativeRequirementsForm(input)?.answerMode).toBe(true);
  append('QUESTION_ANSWERED');
  expect(nativeRequirementsForm(input)).toBeNull();
});
it('renders the exact unanswered members of a guided batch and never mixes in a held summary or approval', () => {
  const prior = nativeRequirementsForm(fixture(mode));
  const guidedQuestions = prior.questionFile;
  const all = fixture({ prompt: 'Q1-Q8' });
  const form = nativeRequirementsForm({ ...all, guidedQuestions });
  expect(form.spec.questions.map((q) => q.options.length)).toEqual([6, 5, 6, 6, 6, 5, 6, 5]);
  const partial = questions.replace('[Answer]:', '[Answer]:\nUse the current project.');
  expect(
    nativeRequirementsForm({ ...fixture({ prompt: 'Q2-Q8' }, partial), guidedQuestions }).spec
      .questions,
  ).toEqual(form.spec.questions.slice(1));
  for (const args of [
    { ...all, guidedQuestions: null },
    { ...all, guidedQuestions: { ...guidedQuestions, directive: 'other' } },
    { ...fixture({ prompt: 'Approve this stage' }), guidedQuestions },
    { ...fixture({ prompt: 'Q1-Q8' }, partial), guidedQuestions },
    {
      ...fixture(
        { prompt: 'Q1-Q8' },
        questions.replace('Quality target', 'Consolidated Summary Confirmation'),
      ),
      guidedQuestions,
    },
  ])
    expect(nativeRequirementsForm(args)).toBeNull();
});

it('binds current unit output and the logged subset, withholding a replaced or foreign unit', () => {
  const slug = 'functional-design',
    unit = 'checkout';
  const input = fixture({ prompt: 'Q2, Q5' });
  input.method = {
    decision: { stage: slug, unit, prompt: 'Q2, Q5' },
    stageFile: {
      stage: slug,
      unit,
      mode: 'guide',
      path: `${intent}/construction/${unit}/${slug}/${slug}-questions.md`,
    },
  };
  input.snapshot.files = input.snapshot.files.map((f) => {
    const path = f.path === questionPath ? input.method.stageFile.path : f.path;
    let content = f.content.toString().replaceAll(stage, slug);
    if (path.includes('/audit/'))
      content = content.replace(`**Stage**: ${slug}`, `**Stage**: ${slug}\n**Unit**: ${unit}`);
    if (path.endsWith('active-directive.json'))
      content = JSON.stringify({ ...JSON.parse(content), unit });
    return {
      ...f,
      path,
      content: Buffer.from(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  const result = nativeRequirementsForm(input);
  expect(result.ids).toEqual(['Q2', 'Q5']);
  expect(result.questionFile.path).toBe(input.method.stageFile.path);
  const other = { ...input.method, stageFile: { ...input.method.stageFile, unit: 'billing' } };
  expect(nativeRequirementsForm({ ...input, method: other })).toBeNull();
});

it('presents the separately recorded summary only after ordinary slots are filled and the engine names that file', () => {
  const prompt = 'Does this all look correct before I generate the requirements artifact?',
    options = 'Looks correct,Request changes';
  const content =
    questions.replaceAll('[Answer]:', '[Answer]: B') +
    `\n## Consolidated Summary Confirmation\n- Camera follows the player.\n\n${prompt}\n- Looks correct\n- Request changes\n\n[Answer]:\n`;
  const input = fixture({ prompt, options }, content);
  const file = { path: questionPath, stage, unit: null, mode: 'guide' };
  input.method.stageFile = file;
  Object.assign(input.method.decision, { checkpoint: 'summary-confirmation', path: questionPath });
  const audit = input.snapshot.files.at(-1);
  audit.content = Buffer.from(
    audit.content
      .toString()
      .replace(
        '**Options**:',
        `**Checkpoint**: Consolidated Summary Confirmation\n**Questions File**: ${questionPath}\n**Options**:`,
      ),
  );
  audit.sha256 = createHash('sha256').update(audit.content).digest('hex');
  const held = nativeRequirementsForm(input);
  expect(held.checkpoint).toBe('Consolidated Summary Confirmation');
  expect(held.spec.questions[0].prompt).toContain('Camera follows the player');
  expect(held.spec.questions[0].options.map((o) => o.label)).toEqual(options.split(','));
  input.method.decision.path = 'other';
  expect(nativeRequirementsForm(input)).toBeNull();
});
