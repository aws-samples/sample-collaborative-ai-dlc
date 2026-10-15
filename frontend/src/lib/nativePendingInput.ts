import type { Question, StructuredAnswer } from '@/services/questions';

// Task-3 structured native questions. Mirrors lambda/shared/native-pending-input.js:
// the controller re-renders a selection with the same algorithm and rejects a
// reply whose text differs, so keep the two implementations identical.

export interface NativePendingOption {
  label: string;
  description: string | null;
}

export interface NativePendingQuestion {
  id: string;
  prompt: string;
  header: string | null;
  multiSelect: boolean;
  options: NativePendingOption[];
}

export interface NativePendingInput {
  schemaVersion: 1 | 2;
  kind: 'approval' | 'choice';
  source: 'engine-gate' | 'rendered-question';
  stage: string | null;
  questions: NativePendingQuestion[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysExactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/u.test(value);

/** Structural check of the server-validated pending input; throws if malformed. */
export function nativePendingInput(value: unknown): NativePendingInput {
  if (
    !record(value) ||
    !keysExactly(value, ['schemaVersion', 'kind', 'source', 'stage', 'questions']) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !['approval', 'choice'].includes(String(value.kind)) ||
    value.source !== (value.kind === 'approval' ? 'engine-gate' : 'rendered-question') ||
    (value.stage !== null && typeof value.stage !== 'string') ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > (value.schemaVersion === 1 ? 4 : 32)
  )
    throw new Error('Invalid native question');
  const questions = value.questions.map((entry: unknown, index: number): NativePendingQuestion => {
    if (
      !record(entry) ||
      !keysExactly(entry, ['id', 'prompt', 'header', 'multiSelect', 'options']) ||
      entry.id !== `q${index + 1}` ||
      typeof entry.prompt !== 'string' ||
      !entry.prompt.trim() ||
      (entry.header !== null && !singleLine(entry.header, 80)) ||
      typeof entry.multiSelect !== 'boolean' ||
      !Array.isArray(entry.options) ||
      (entry.options.length < 2 &&
        !(value.schemaVersion === 2 && entry.options.length === 0 && !entry.multiSelect)) ||
      entry.options.length > 16
    )
      throw new Error('Invalid native question');
    const options = entry.options.map((option: unknown): NativePendingOption => {
      if (
        !record(option) ||
        !keysExactly(option, ['label', 'description']) ||
        !singleLine(option.label, 160) ||
        (option.description !== null && !singleLine(option.description, 500))
      )
        throw new Error('Invalid native question');
      return { label: option.label, description: option.description as string | null };
    });
    return {
      id: entry.id,
      prompt: entry.prompt,
      header: entry.header as string | null,
      multiSelect: entry.multiSelect,
      options,
    };
  });
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind as NativePendingInput['kind'],
    source: value.source as NativePendingInput['source'],
    stage: value.stage as string | null,
    questions,
  };
}

/** Same as the server's canonicalJson (sorted keys, JSON scalars). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** QuestionEditor input for a native pending input (display only). */
export function nativeQuestionForEditor(
  input: NativePendingInput,
  interactionId: string,
  createdAt: string,
): Question {
  return {
    id: interactionId,
    agent: input.kind === 'approval' ? 'Approval' : 'AI-DLC',
    sprintId: '',
    createdAt,
    questions: input.questions.map((entry) => ({
      text: entry.header ? `**${entry.header}**\n\n${entry.prompt}` : entry.prompt,
      type: entry.multiSelect ? 'multi' : 'single',
      options: entry.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    })),
  } as Question;
}

/** The exact reply text for a selection (canonical labels, never numbers). */
export function nativeAnswerText(input: NativePendingInput, selection: StructuredAnswer): string {
  if (selection.answers.length !== input.questions.length) throw new Error('Invalid answer');
  const render = (entry: NativePendingQuestion, answer: StructuredAnswer['answers'][number]) => {
    const selected = [...answer.selectedOptions].sort((a, b) => a - b);
    if (
      selected.some((i) => !Number.isSafeInteger(i) || !entry.options[i]) ||
      new Set(selected).size !== selected.length ||
      (!entry.multiSelect && selected.length > 1)
    )
      throw new Error('Invalid answer');
    const labels = selected.map((i) => entry.options[i].label).join(', ');
    const freeText = answer.freeText?.trim() ? answer.freeText : undefined;
    if (
      freeText &&
      (freeText.length > 4000 ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(freeText))
    )
      throw new Error(
        'Each written answer must be at most 4,000 characters without control characters.',
      );
    if (!labels && !freeText) throw new Error('Invalid answer');
    if (!freeText) return labels;
    return labels ? `${labels}\n\n${freeText}` : freeText;
  };
  if (input.questions.length === 1) return render(input.questions[0], selection.answers[0]);
  return input.questions
    .map((entry, index) => {
      const title = entry.header || entry.prompt.split('\n')[0].trim();
      return `${index + 1}. ${title}: ${render(entry, selection.answers[index]).replace(/\n\n/g, ' — ')}`;
    })
    .join('\n');
}

/** Validate the entire form before freezing one protected response request. */
export function nativeFormError(
  input: NativePendingInput,
  selection: StructuredAnswer,
): string | null {
  try {
    const text = nativeAnswerText(input, nativeSelectionPayload(selection));
    if (new TextEncoder().encode(text).length > 16 * 1024)
      return 'The complete answer must fit within 16 KiB. Shorten the written answers before submitting.';
    return null;
  } catch (error) {
    return error instanceof Error && error.message !== 'Invalid answer'
      ? error.message
      : 'Answer every question before submitting.';
  }
}

/** Selection as the controller validates it: blank free text omitted. */
export function nativeSelectionPayload(selection: StructuredAnswer): StructuredAnswer {
  return {
    answers: selection.answers.map((answer) => ({
      selectedOptions: [...answer.selectedOptions],
      ...(answer.freeText?.trim() ? { freeText: answer.freeText } : {}),
    })),
  };
}
