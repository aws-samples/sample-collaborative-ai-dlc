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
export const NATIVE_TYPED_ASK_TYPES = Object.freeze(['compose-offer', 'scope-confirm']);
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
      header:
        entry.header == null
          ? null
          : typeof entry.header === 'string'
            ? entry.header.trim() || null
            : entry.header,
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
                option.description == null
                  ? null
                  : typeof option.description === 'string'
                    ? option.description.trim() || null
                    : option.description,
            };
          })
        : entry.options,
    };
  });
};

// Typed AI-DLC 2.11 intake asks can be copied unchanged into the existing
// reserved display transport: { version: 3, ask: <engine JSON> }. Commands are
// checked as bounded data, never executed or sent to the browser. The resumed
// harness uses the engine's original request-bound command after a member reply.
const askSpec = (spec) => {
  if (!exact(spec, ['version', 'ask']) || spec.version !== 3) fail();
  const ask = spec.ask;
  if (!object(ask) || ask.kind !== 'ask' || ask.response_route !== 'next') fail();
  if (!prose(ask.question, NATIVE_PENDING_INPUT_LIMITS.promptChars)) fail();
  const command = (value) => line(value, 4096);
  const scopes = ask.scope_commands;
  if (
    !Array.isArray(scopes) ||
    !scopes.length ||
    scopes.length >= NATIVE_PENDING_INPUT_LIMITS.optionsMax
  )
    fail();
  if (
    scopes.some(
      (row) =>
        !object(row) ||
        !line(row.scope, NATIVE_PENDING_INPUT_LIMITS.labelChars) ||
        !command(row.command) ||
        (row.stages !== undefined &&
          !line(row.stages, NATIVE_PENDING_INPUT_LIMITS.descriptionChars)),
    )
  )
    fail();
  if (!command(ask.compose_command)) fail();
  let options;
  if (ask.ask_type === 'compose-offer') {
    options = [
      { label: 'compose' },
      ...scopes.map((row) => ({ label: row.scope, description: row.stages })),
    ];
  } else if (ask.ask_type === 'scope-confirm') {
    const offeredCommands = new Set([
      ask.confirm_command,
      ask.compose_command,
      ...scopes.map((row) => row.command),
    ]);
    if (
      !command(ask.confirm_command) ||
      !line(ask.proposed_scope, NATIVE_PENDING_INPUT_LIMITS.labelChars) ||
      !Array.isArray(ask.choices) ||
      ask.choices.length < 2 ||
      ask.choices.length > NATIVE_PENDING_INPUT_LIMITS.optionsMax ||
      ask.choices.some(
        (choice) =>
          !object(choice) || (choice.command !== undefined && !offeredCommands.has(choice.command)),
      ) ||
      ask.choices[0].command !== ask.confirm_command ||
      ask.choices.at(-1).command !== ask.compose_command
    )
      fail();
    // The engine may offer a choice that asks for more input before it can
    // name a command (2.11.1's alternative-plan branch). Preserve all explicit
    // labels and their order. A member selects a label; the engine owns the
    // subsequent question/command. Nothing here supplies a missing answer.
    options = ask.choices.map((choice) => ({ label: choice.label }));
  } else fail();
  return { version: 2, questions: [{ prompt: ask.question, header: null, options }] };
};

export const NATIVE_PRESENTATION_REASONS = Object.freeze([
  'absent',
  'invalid_json',
  'too_large',
  'invalid_schema',
  'unsupported_ask',
  'stale_spec',
  'read_failed',
]);
/** Closed display condition, hashed with the interaction. No raw rejected data. */
export const nativePresentation = (value) => {
  if (
    !exact(value, ['status', 'reason']) ||
    value.status !== 'degraded' ||
    !NATIVE_PRESENTATION_REASONS.includes(value.reason)
  )
    fail();
  return { status: 'degraded', reason: value.reason };
};

/**
 * The explicit spec is the display source, not corroboration for assistant prose.
 * Its exact bounded bytes are credential-checked by the runtime before upload.
 * A held marker labels only the known gate shape; ordinary/summary questions at
 * that marker remain choices and cannot confer approval or advance the engine.
 */
export const buildNativePendingInput = ({ gate = null, spec = null } = {}) => {
  if (spec === null) return null;
  try {
    const normalized = spec.version === 3 ? askSpec(spec) : spec;
    const questions = normalizeSpec(normalized);
    const choice = {
      schemaVersion: normalized.version,
      kind: 'choice',
      source: 'rendered-question',
      stage: null,
      questions,
    };
    if (gate) {
      try {
        return nativePendingInput({
          ...choice,
          kind: 'approval',
          source: 'engine-gate',
          stage: gate.stage,
        });
      } catch {
        /* A summary or fork's choices are not a platform approval. */
      }
    }
    return nativePendingInput(choice);
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
