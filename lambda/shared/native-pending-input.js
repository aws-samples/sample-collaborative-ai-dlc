// Structured pending input for the selected AI-DLC 2.11.1 interaction contract.
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
  // The selected package offers compose plus eleven plans before an intent exists.
  optionsMax: 16,
  promptChars: 2000,
  headerChars: 80,
  labelChars: 160,
  descriptionChars: 500,
  freeTextChars: 4000,
  specBytes: 64 * 1024,
});

export const NATIVE_AIDLC_INTERACTION_CONTRACT = 'aidlc-2.11.1';
// Select only after the package loader verifies this pinned identity and bytes.
// A version string or a structurally similar fork does not establish support.
export const nativeMethodologyInteractionContract = (identity) =>
  identity?.version === '2.11.1' &&
  identity.source?.provider === 'github' &&
  identity.source.repository === 'awslabs/aidlc-workflows' &&
  identity.source.release === 'v2.11.1' &&
  identity.source.commit === '895a35d86d20336d9b7bc4aedc9440e4a12c83ab' &&
  identity.assets?.runtime?.sha256 ===
    '9f213c8254e646123b3f4bcefe347a61c95c72fee9fda4bf9afab42ccb20f44a'
    ? NATIVE_AIDLC_INTERACTION_CONTRACT
    : null;

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

const question = (value, index) => {
  if (!exact(value, ['id', 'prompt', 'header', 'multiSelect', 'options'])) fail();
  if (value.id !== `q${index + 1}`) fail();
  if (!prose(value.prompt, NATIVE_PENDING_INPUT_LIMITS.promptChars)) fail();
  if (value.header !== null && !line(value.header, NATIVE_PENDING_INPUT_LIMITS.headerChars)) fail();
  if (typeof value.multiSelect !== 'boolean') fail();
  const { options } = value;
  if (
    !Array.isArray(options) ||
    (options.length < NATIVE_PENDING_INPUT_LIMITS.optionsMin &&
      !(options.length === 0 && !value.multiSelect)) ||
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

const approvalQuestions = (questions) => {
  if (questions.length !== 1 || questions[0].multiSelect) return false;
  const labels = questions[0].options.map((option) => option.label);
  return (
    NATIVE_GATE_LABELS.every((label) => labels.includes(label)) &&
    labels.every(
      (label) =>
        NATIVE_GATE_LABELS.includes(label) ||
        GATE_OPTIONAL_LABELS.has(label) ||
        /^Add [A-Za-z0-9][A-Za-z0-9 -]{0,80}$/.test(label),
    )
  );
};

/** Validate a stored pending input. Returns a deep copy. */
export const nativePendingInput = (value) => {
  if (!exact(value, ['schemaVersion', 'kind', 'source', 'stage', 'questions'])) fail();
  if (value.schemaVersion !== 2) fail();
  if (!['approval', 'choice'].includes(value.kind)) fail();
  if (value.source !== (value.kind === 'approval' ? 'engine-gate' : 'rendered-question')) fail();
  if (
    value.stage !== null &&
    (typeof value.stage !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(value.stage))
  )
    fail();
  if (value.kind === 'approval' && value.stage === null) fail();
  if (
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > NATIVE_PENDING_INPUT_LIMITS.questions
  )
    fail();
  value.questions.forEach(question);
  if (value.kind === 'approval' && !approvalQuestions(value.questions)) fail();
  return structuredClone(value);
};

// Agent-written spec (from the runtime transport instruction):
// { version: 2, questions: [{ prompt, header?, multiSelect?, options: [{ label, description? }] }] }
// Complete current-step forms; options:[] requires a written answer.
const normalizeSpec = (spec) => {
  if (
    !exact(spec, ['version', 'questions']) ||
    spec.version !== 2 ||
    !Array.isArray(spec.questions) ||
    spec.questions.length < 1 ||
    spec.questions.length > NATIVE_PENDING_INPUT_LIMITS.questions
  )
    fail();
  return spec.questions.map((entry, index) => {
    if (!object(entry)) fail();
    const allowed = ['prompt', 'header', 'multiSelect', 'options'];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) fail();
    return {
      id: `q${index + 1}`,
      prompt: entry.prompt,
      header: entry.header ?? null,
      multiSelect: entry.multiSelect === undefined ? false : entry.multiSelect,
      options: Array.isArray(entry.options)
        ? entry.options.map((option) => {
            if (
              !object(option) ||
              Object.keys(option).some((k) => !['label', 'description'].includes(k))
            )
              fail();
            return {
              label: option.label,
              description: option.description ?? null,
            };
          })
        : entry.options,
    };
  });
};

// Typed AI-DLC 2.11.1 intake asks are copied unchanged into the existing
// reserved display transport: { version: 3, ask: <engine JSON> }. Commands are
// checked as bounded data, never executed or sent to the browser. The resumed
// harness uses the engine's original request-bound command after a member reply.
const askSpec = (spec) => {
  if (!exact(spec, ['version', 'ask']) || spec.version !== 3) fail();
  const ask = spec.ask;
  if (!object(ask) || ask.kind !== 'ask' || ask.response_route !== 'next') fail();
  // Unknown ask metadata can be prose, but conflicting form fields must not
  // silently replace or supplement the selected typed question.
  if (['questions', 'options', 'multiSelect', 'prompt'].some((key) => Object.hasOwn(ask, key)))
    fail();
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
    if (['choices', 'confirm_command', 'proposed_scope'].some((key) => Object.hasOwn(ask, key)))
      fail();
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

// The protected adapter uses the same typed intake mapping as display. A
// command is returned only when the pinned engine supplied it for that option;
// choices requesting another question deliberately have no executable command.
export const nativeTypedChoiceCommands = (ask) => {
  const spec = askSpec({ version: 3, ask });
  return spec.questions[0].options.map((option, index) => ({
    label: option.label,
    command:
      ask.ask_type === 'compose-offer'
        ? index === 0
          ? ask.compose_command
          : ask.scope_commands[index - 1].command
        : (ask.choices[index].command ?? null),
  }));
};

export const NATIVE_PRESENTATION_REASONS = Object.freeze([
  'absent',
  'invalid_json',
  'too_large',
  'invalid_schema',
  'unsupported_ask',
  'unsupported_methodology',
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
    let questions;
    switch (spec.version) {
      case 2:
        questions = normalizeSpec(spec);
        break;
      case 3:
        questions = normalizeSpec(askSpec(spec));
        break;
      default:
        return null;
    }
    // Validate before classifying a known gate. No speculative approval parse
    // followed by a choice fallback; summary confirmations remain choices.
    questions.forEach(question);
    const approval = gate !== null && approvalQuestions(questions);
    return nativePendingInput({
      schemaVersion: 2,
      kind: approval ? 'approval' : 'choice',
      source: approval ? 'engine-gate' : 'rendered-question',
      stage: approval ? gate.stage : null,
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
