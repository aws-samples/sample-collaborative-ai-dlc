// Structured pending input for a native assistant turn (task-3).
//
// A pending input is DISPLAY DATA, never authority: it lets members select the
// exact option labels the workflow presented instead of typing numbers. It is
// captured by the native runtime at turn end from deterministic workflow state
// and the question spec the agent rendered this turn, written to a
// runtime-reserved file. Options are never inferred from assistant prose or a
// stage marker alone. The engine still validates every recorded answer, and
// only a member's protected reply can carry the selection back.
//
// The selection shape is QuestionEditor's StructuredAnswer:
//   { answers: [{ selectedOptions: number[], freeText?: string }] }
// nativeAnswerText() renders it into the exact reply text the harness receives:
// the canonical option label(s), never numbers, letters or descriptions. The
// frontend mirror (frontend/src/lib/nativePendingInput.ts) must stay identical;
// the controller re-renders and compares before accepting a selection.

export const NATIVE_PENDING_INPUT_LIMITS = Object.freeze({
  questions: 32,
  optionsMin: 2,
  // AI-DLC 2.11.0 offers compose plus eleven ready-made plans before an intent exists.
  optionsMax: 16,
  promptChars: 2000,
  headerChars: 80,
  labelChars: 160,
  descriptionChars: 500,
  freeTextChars: 4000,
  specBytes: 64 * 1024,
});

// Protocol-fixed stage gate labels (pinned AI-DLC stage-protocol.md).
export const NATIVE_GATE_LABELS = Object.freeze(['Approve', 'Request Changes']);
const GATE_OPTIONAL_LABELS = new Set(['Accept as-is']);

const fail = () => {
  throw Object.assign(new Error('Native pending input is invalid'), {
    code: 'NATIVE_PENDING_INPUT_INVALID',
  });
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) =>
  object(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
// One line of plain text: no controls, no newlines.
const line = (value, max) =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  // oxlint-disable-next-line no-control-regex -- Reject controls and line breaks.
  !/[\u0000-\u001f\u007f]/u.test(value);
// Multi-line text (prompts, free text): no terminal controls.
const prose = (value, max) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  // oxlint-disable-next-line no-control-regex -- Preserve tabs and line endings only.
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

const question = (value, index, version) => {
  if (!exact(value, ['id', 'prompt', 'header', 'multiSelect', 'options'])) fail();
  if (value.id !== `q${index + 1}`) fail();
  if (!prose(value.prompt, NATIVE_PENDING_INPUT_LIMITS.promptChars)) fail();
  if (value.header !== null && !line(value.header, NATIVE_PENDING_INPUT_LIMITS.headerChars)) fail();
  if (typeof value.multiSelect !== 'boolean') fail();
  const { options } = value;
  if (
    !Array.isArray(options) ||
    (options.length < NATIVE_PENDING_INPUT_LIMITS.optionsMin &&
      !(version === 2 && options.length === 0 && !value.multiSelect)) ||
    options.length > NATIVE_PENDING_INPUT_LIMITS.optionsMax
  )
    fail();
  const labels = new Set();
  for (const option of options) {
    if (!exact(option, ['label', 'description'])) fail();
    if (!line(option.label, NATIVE_PENDING_INPUT_LIMITS.labelChars)) fail();
    if (
      option.description !== null &&
      !line(option.description, NATIVE_PENDING_INPUT_LIMITS.descriptionChars)
    )
      fail();
    if (labels.has(option.label)) fail();
    labels.add(option.label);
  }
  return value;
};

/** Validate a stored pending input. Returns a deep copy. */
export const nativePendingInput = (value) => {
  if (!exact(value, ['schemaVersion', 'kind', 'source', 'stage', 'questions'])) fail();
  if (![1, 2].includes(value.schemaVersion)) fail();
  if (!['approval', 'choice'].includes(value.kind)) fail();
  if (value.source !== (value.kind === 'approval' ? 'engine-gate' : 'rendered-question')) fail();
  if (value.stage !== null && !/^[a-z][a-z0-9-]{0,127}$/.test(value.stage)) fail();
  if (value.kind === 'approval' && value.stage === null) fail();
  if (
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > (value.schemaVersion === 1 ? 4 : NATIVE_PENDING_INPUT_LIMITS.questions)
  )
    fail();
  value.questions.forEach((entry, index) => question(entry, index, value.schemaVersion));
  if (value.kind === 'approval') {
    const [gate] = value.questions;
    const labels = gate.options.map((option) => option.label);
    if (
      value.questions.length !== 1 ||
      gate.multiSelect ||
      !NATIVE_GATE_LABELS.every((label) => labels.includes(label)) ||
      labels.some(
        (label) =>
          !NATIVE_GATE_LABELS.includes(label) &&
          !GATE_OPTIONAL_LABELS.has(label) &&
          !/^Add [A-Za-z0-9][A-Za-z0-9 -]{0,80}$/.test(label),
      )
    )
      fail();
  }
  return structuredClone(value);
};

// Agent-written spec (from the runtime transport instruction):
// { version: 1|2, questions: [{ prompt, header?, multiSelect?, options: [{ label, description? }] }] }
// Version 1 retains its original four-question, choice-only contract. Version 2
// supports complete current-step forms and options:[] for a written answer.
const normalizeSpec = (spec) => {
  if (
    !exact(spec, ['version', 'questions']) ||
    ![1, 2].includes(spec.version) ||
    !Array.isArray(spec.questions)
  )
    fail();
  return spec.questions.map((entry, index) => {
    if (!object(entry)) fail();
    const allowed = ['prompt', 'header', 'multiSelect', 'options'];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) fail();
    return {
      id: `q${index + 1}`,
      prompt: typeof entry.prompt === 'string' ? entry.prompt.trim() : entry.prompt,
      header: entry.header == null ? null : String(entry.header).trim() || null,
      multiSelect: entry.multiSelect === undefined ? false : entry.multiSelect,
      options: Array.isArray(entry.options)
        ? entry.options.map((option) => {
            if (
              !object(option) ||
              Object.keys(option).some((k) => !['label', 'description'].includes(k))
            )
              fail();
            return {
              label:
                typeof option.label === 'string'
                  ? option.label.replace(/\s*\(Recommended\)\s*$/i, '').trim()
                  : option.label,
              description:
                option.description == null ? null : String(option.description).trim() || null,
            };
          })
        : entry.options,
    };
  });
};

/**
 * Build the pending input for a completed turn. Returns null (free-text reply)
 * whenever nothing structured can be established safely.
 *
 * - gate: { stage } when engine state shows that stage held at `[?]`. Only a
 *   complete rendered spec matching the supported gate protocol is classified
 *   as approval. A marker alone does not identify a fork's decision protocol.
 * - spec: the agent-written rendered question spec (already JSON-parsed), or null.
 * - messagesText: the turn's assistant text. Every rendered option label and
 *   (in version 2) prompt must appear in it. A single non-gate choice may instead
 *   appear under its exact heading with all its labels. Its complete spec prompt
 *   is rendered by the form. No prose-derived options or inferred approvals.
 */
export const buildNativePendingInput = ({ gate = null, spec = null, messagesText = '' }) => {
  let questions = null;
  if (spec !== null) {
    try {
      questions = normalizeSpec(spec);
      const headedChoice =
        !gate &&
        questions.length === 1 &&
        questions[0].options?.length >= 2 &&
        questions[0].header &&
        messagesText
          .split(/\r?\n/)
          .some((line) =>
            [questions[0].header, `**${questions[0].header}**`].includes(line.trim()),
          );
      if (
        questions.some(
          (entry) =>
            (spec.version === 2 && !messagesText.includes(entry.prompt) && !headedChoice) ||
            entry.options?.some?.(
              (option) => typeof option.label !== 'string' || !messagesText.includes(option.label),
            ),
        )
      )
        questions = null;
    } catch {
      questions = null;
    }
  }
  if (!questions) return null;
  try {
    return nativePendingInput({
      schemaVersion: spec.version,
      kind: gate ? 'approval' : 'choice',
      source: gate ? 'engine-gate' : 'rendered-question',
      stage: gate ? gate.stage : null,
      questions,
    });
  } catch {
    return null;
  }
};

/** Validate a member selection against the pending input. Returns a copy. */
export const nativeSelection = (pendingInput, selection) => {
  const input = nativePendingInput(pendingInput);
  if (!exact(selection, ['answers']) || !Array.isArray(selection.answers)) fail();
  if (selection.answers.length !== input.questions.length) fail();
  return {
    answers: selection.answers.map((answer, index) => {
      const entry = input.questions[index];
      const keys = Object.keys(answer ?? {});
      if (
        !object(answer) ||
        keys.some((key) => !['selectedOptions', 'freeText'].includes(key)) ||
        !Array.isArray(answer.selectedOptions)
      )
        fail();
      const selected = answer.selectedOptions;
      if (
        selected.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= entry.options.length) ||
        new Set(selected).size !== selected.length ||
        (!entry.multiSelect && selected.length > 1)
      )
        fail();
      const freeText = answer.freeText === undefined ? undefined : answer.freeText;
      if (freeText !== undefined && !prose(freeText, NATIVE_PENDING_INPUT_LIMITS.freeTextChars))
        fail();
      if (!selected.length && freeText === undefined) fail();
      return {
        selectedOptions: [...selected].sort((a, b) => a - b),
        ...(freeText !== undefined ? { freeText } : {}),
      };
    }),
  };
};

/**
 * The exact reply text for a selection: canonical option label(s), with any
 * free text after a blank line. One question → the bare label(s), so engine
 * checks that compare the human turn to an exact choice can match. Several
 * questions → one line per question, in order.
 */
export const nativeAnswerText = (pendingInput, selection) => {
  const input = nativePendingInput(pendingInput);
  const { answers } = nativeSelection(input, selection);
  const render = (entry, answer) => {
    const labels = answer.selectedOptions.map((i) => entry.options[i].label).join(', ');
    if (!answer.freeText) return labels;
    return labels ? `${labels}\n\n${answer.freeText}` : answer.freeText;
  };
  if (input.questions.length === 1) return render(input.questions[0], answers[0]);
  return input.questions
    .map((entry, index) => {
      const title = entry.header || entry.prompt.split('\n')[0].trim();
      return `${index + 1}. ${title}: ${render(entry, answers[index]).replace(/\n\n/g, ' — ')}`;
    })
    .join('\n');
};
