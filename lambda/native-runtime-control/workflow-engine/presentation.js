import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import { buildNativePendingInput } from '../../shared/native-pending-input.js';
import { engineDigest, engineFailure } from '../../shared/native-workflow-protocol.js';

const fail = () => {
  throw engineFailure('NATIVE_ENGINE_PRESENTATION_MISMATCH');
};
const questionMatches = (pending, question) =>
  pending.questions.length === 1 &&
  !pending.questions[0].multiSelect &&
  engineDigest(pending.questions[0].prompt) === question.promptDigest &&
  isDeepStrictEqual(
    pending.questions[0].options.map((option) => option.label),
    question.options,
  );

// The engine keeps the full intake offer across turns, including its request-
// bound commands. Only the existing bounded form travels to the renderer.
export const nativeEngineAskInput = (directive) =>
  directive?.kind === 'ask'
    ? buildNativePendingInput({ spec: { version: 3, ask: directive } })
    : null;

// A picker is display data. Bind it to the actual protected question before
// the genuine member hook may see a reply; matching option labels alone would
// let a reply to one proposal approve a different policy or plan.
export const nativeEnginePresentation = (state, observed, interaction) => {
  if (!interaction.pendingInput) return null;
  let directive = state.directive;
  let expected;
  const question = observed.protectedQuestion ?? null;
  if (question) {
    if (!questionMatches(interaction.pendingInput, question)) fail();
    directive = {
      kind: 'protected-question',
      stage: observed.workflow?.currentStage,
      unit: state.directive?.unit ?? null,
    };
    expected = interaction.pendingInput;
  } else if (directive?.kind === 'ask') {
    expected = nativeEngineAskInput(directive);
  } else if (interaction.pendingInput.kind === 'approval') {
    const stage = observed.effectivePlan?.stages.find(
      (stage) => stage.id === interaction.pendingInput.stage && stage.state === 'awaiting-approval',
    );
    const requirement = state.requirements.findLast(
      (item) => item.stage === stage?.id && item.gate === true,
    );
    if (!stage || !requirement) fail();
    // The shared pending-input validator admits the pinned protocol's
    // Approve/Request Changes and optional Add/Accept as-is offers. Only the
    // two ordinary gate choices map to a gate report; optional choices still
    // need the engine's own command and validation.
    directive = { kind: 'present-gate', stage: stage.id, unit: requirement.unit };
    expected = interaction.pendingInput;
  } else {
    if (!directive?.stage || observed.workflow?.currentStage !== directive.stage) fail();
    expected = interaction.pendingInput;
  }
  if (!expected || !isDeepStrictEqual(expected, interaction.pendingInput)) fail();
  return {
    interactionId: interaction.id,
    contentSha256: interaction.contentSha256,
    sequence: interaction.sequence,
    publicationId: interaction.publicationId,
    pendingInput: expected,
    directive,
    question,
    sha256: engineDigest(
      canonicalJson({
        directive,
        question,
        pendingInput: expected,
        contentSha256: interaction.contentSha256,
        publicationId: interaction.publicationId,
      }),
    ),
  };
};

export const assertNativeEnginePresentedQuestion = (state, observed, presented) => {
  if (!isDeepStrictEqual(observed.protectedQuestion ?? null, presented.question ?? null)) fail();
  if (
    presented.directive?.kind === 'ask' &&
    !isDeepStrictEqual(state.directive, presented.directive)
  )
    fail();
};

// The package's "Use a different plan" choice delegates the next question
// to its host. Its scope_commands already carry the request, plan and settings.
// A written reply also needs an explicit named selection before it can run one.
export const openNativePlanPicker = (state, observed, bound, selectedCommand) => {
  const offer = bound?.presented.directive;
  if (
    selectedCommand ||
    offer?.kind !== 'ask' ||
    !['scope-confirm', 'compose-offer'].includes(offer.ask_type)
  )
    return;
  assertNativeEnginePresentedQuestion(state, observed, bound.presented);
  const menu = {
    kind: 'ask',
    ask_type: 'compose-offer',
    response_route: 'next',
    question: 'Which plan would you like to use?',
    scope_commands: offer.scope_commands,
    compose_command: offer.compose_command,
  };
  if (!nativeEngineAskInput(menu)) fail();
  state.directive = menu;
  state.planPickerReplyId = bound.response.commandId;
};
