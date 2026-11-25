import { it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  issuedQuestionFile,
  parseQuestionFile,
  ordinaryFileForm,
  fillQuestionFile,
  fillQuestionCheckpoint,
  persistQuestionFile,
} from '../native/question-file.js';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const record = 'aidlc/spaces/demo/intents/game';
const slug = 'functional-design',
  stageDir = `${record}/construction/cart/${slug}`,
  path = `${stageDir}/${slug}-questions.md`;
const issued = {
  kind: 'run-stage',
  stage: slug,
  phase: 'construction',
  unit: 'cart',
  answer_mode: { ask: false, mode: 'guide' },
  stage_file: `.codex/aidlc-common/stages/construction/${slug}.md`,
  memory_path: `${stageDir}/memory.md`,
  produces: [`${stageDir}/components.md`],
};
it('uses the pinned diary directory, declared output or explicit kept-question path inside the active unit', () => {
  for (const d of [
    issued,
    { ...issued, produces: [path] },
    { ...issued, questions_answered: { path } },
  ])
    expect(issuedQuestionFile(d)?.path).toBe(path);
  for (const patch of [
    { unit: 'other' },
    { single: true },
    { gate_only: true },
    { stage: 'code-generation' },
    { unit: '../cart' },
    { kept_replies: { replies: ['yes'] } },
    { questions_answered: { path: path.replace('/cart/', '/other/') } },
  ])
    expect(issuedQuestionFile({ ...issued, ...patch })).toBeNull();
});
const source =
  '# Interview\r\n\r\n## Q4. [Product] Channels (select all that apply)\r\nPick channels\r\n- C) Chat\r\n- A) Email\r\n- X) Other (please specify)\r\n\r\n[Answer]: ____\r\n\r\n---\r\n\r\n## Q7. Constraints\r\nDescribe the constraints.\r\n[Answer]:\r\n\r\n## Notes\r\nKeep *verbatim*.\r\n';
it('maps question-local source letters and preserves whitespace, literal words and unfilled slots', () => {
  const parsed = parseQuestionFile(Buffer.from(source)),
    form = ordinaryFileForm(parsed);
  expect(form.ids).toEqual(['Q4', 'Q7']);
  const partial = fillQuestionFile(
    parsed,
    form.ids,
    { answers: [{ selectedOptions: [0, 1] }, { selectedOptions: [] }] },
    true,
  );
  expect(partial.bytes.toString()).toBe(source.replace('[Answer]: ____', '[Answer]: C, A'));
  const open = parseQuestionFile(partial.bytes);
  expect(ordinaryFileForm(open).ids).toEqual(['Q7']);
  const words = 'A\n\n`literal` $HOME & **bold**';
  expect(
    fillQuestionFile(open, ['Q7'], {
      answers: [{ selectedOptions: [], freeText: words }],
    }).bytes.toString(),
  ).toBe(partial.bytes.toString().replace('[Answer]:\r', '[Answer]: ' + words + '\r'));
  expect(
    fillQuestionFile(parsed, form.ids, {
      answers: [{ selectedOptions: [2] }, { selectedOptions: [], freeText: 'ok' }],
    }),
  ).toBeNull();
  const mixed =
    source +
    '## Consolidated Summary Confirmation\n- Looks correct\n- Request changes\n[Answer]:\n';
  expect(ordinaryFileForm(parseQuestionFile(Buffer.from(mixed)))).toBeNull();
  expect(parseQuestionFile(Buffer.from('```md\n' + source + '\n```'))).toBeNull();
});
it('checks the published bytes again before rename and rejects links, a changed slot and a second write', async () => {
  const project = await fs.mkdtemp(join(tmpdir(), 'native-question-edit-'));
  try {
    await fs.mkdir(join(project, stageDir), { recursive: true });
    const target = join(project, path);
    await fs.writeFile(target, source);
    const parsed = parseQuestionFile(Buffer.from(source)),
      result = fillQuestionFile(parsed, ['Q7'], {
        answers: [{ selectedOptions: [], freeText: 'literal' }],
      });
    const binding = { path, sha256: hash(source) };
    let checks = 0;
    await expect(
      persistQuestionFile(project, binding, result, async () => {
        if (++checks === 2) await fs.appendFile(target, 'changed');
      }),
    ).rejects.toMatchObject({ code: 'native_execution_reply_conflict' });
    expect(await fs.readFile(target, 'utf8')).toBe(source + 'changed');
    await fs.writeFile(target, source);
    await fs.link(target, join(project, 'copy'));
    await expect(persistQuestionFile(project, binding, result, async () => {})).rejects.toThrow();
    await fs.unlink(join(project, 'copy'));
    await persistQuestionFile(project, binding, result, async () => {});
    expect(await fs.readFile(target)).toEqual(result.bytes);
    await expect(
      persistQuestionFile(project, binding, result, async () => {}),
    ).rejects.toMatchObject({ code: 'native_execution_reply_conflict' });
    await fs.rename(target, join(project, 'original'));
    await fs.symlink(join(project, 'original'), target);
    await expect(persistQuestionFile(project, binding, result, async () => {})).rejects.toThrow();
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

it('resolves the stage-level diary for a concrete unit only with a matching issued output', () => {
  const actualDiary = `${record}/construction/${slug}/memory.md`;
  expect(issuedQuestionFile({ ...issued, memory_path: actualDiary })?.path).toBe(path);
  expect(issuedQuestionFile({ ...issued, memory_path: actualDiary, unit: 'billing' })).toBeNull();
});

it('preserves separate confirmation, assumption and repeated feedback slots and appends only scoped follow-ups', () => {
  const original = '## Q1. Language\nA. English\nX. Other\n[Answer]: A\n';
  for (const [heading, body, choice, written, details] of [
    [
      'Q2. Consolidated Summary Confirmation',
      '- Looks correct\n- Request changes',
      { selectedOptions: [1], freeText: 'Keep **both** languages.' },
      'Request changes',
      'Request changes: Keep **both** languages.',
    ],
    [
      'Assumption Confirmation',
      'A. Accept assumptions\nB. Convert to follow-up questions',
      { selectedOptions: [1] },
      'B. Convert to follow-up questions',
      'Convert to follow-up questions',
    ],
    [
      'Requested Changes Feedback',
      'What should change?',
      { selectedOptions: [], freeText: 'Add Japanese.\nKeep English.' },
      'Add Japanese.\nKeep English.',
      'Add Japanese.\nKeep English.',
    ],
  ]) {
    const text = `${original}\n## Requested Changes Feedback\nEarlier feedback\n[Answer]: Earlier.\n\n## ${heading}\n${body}\n[Answer]:\n`;
    const parsed = parseQuestionFile(Buffer.from(text));
    expect(ordinaryFileForm(parsed)).toBeNull();
    const result = fillQuestionCheckpoint(parsed, heading.replace(/^Q2\. /, ''), choice);
    expect(result.details).toBe(details);
    expect(result.bytes.toString()).toBe(text.slice(0, -1) + ' ' + written + '\n');
    const follow = parseQuestionFile(
      Buffer.concat([
        result.bytes,
        Buffer.from('\n## Q3. [Design] Locale\nA. Japanese\nX. Other\n[Answer]:\n'),
      ]),
    );
    expect(ordinaryFileForm(follow).ids).toEqual(['Q3']);
  }
});
