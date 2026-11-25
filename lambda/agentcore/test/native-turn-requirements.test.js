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
