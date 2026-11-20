import { NATIVE_PENDING_SPEC_PATH } from '../../shared/native-pending-input.js';
import { engineDigest, engineFailure } from '../../shared/native-workflow-protocol.js';

// A member's reply is a decision only as the answer to a question this engine
// recorded when it was presented. The application also accepts a reply to a
// turn that ended without such a question, or whose form was not the engine's
// question. That reply carries no member authority: it is never handed to the
// pinned engine as a person's words and selects no command. It is kept here so
// that the coding process and the member can be told that nothing was decided.
const unapplied = (state) => (state.unappliedReplies ??= []);
const inTurn = (state, identity) =>
  unapplied(state).some(
    (item) =>
      item.sequence === identity.sequence && item.writerGeneration === identity.writerGeneration,
  );

/**
 * The newly accepted reply of this turn with the question it answers, or null
 * when there is none to apply: no reply, one already seen, or one that names no
 * recorded question. A reply record that does not match the turn it is
 * delivered to is refused; `strict: false` leaves it alone instead.
 */
export const bindNativeEngineReply = async (
  { state, row, identity, executionStore },
  { strict = true } = {},
) => {
  const pointer = row.response;
  const seen = (item) => item.commandId === pointer.commandId;
  if (!pointer || state.decisions.some(seen) || unapplied(state).some(seen)) return null;
  const response = await executionStore.response(row, pointer.interactionId);
  if (
    !response ||
    response.commandId !== pointer.commandId ||
    response.interactionId !== pointer.interactionId ||
    response.contentSha256 !== pointer.contentSha256 ||
    response.textSha256 !== pointer.textSha256 ||
    response.actorId !== pointer.actorId ||
    response.sequence !== identity.sequence ||
    (response.publicationId !== undefined &&
      response.publicationId !== row.interaction?.publicationId) ||
    engineDigest(response.text) !== response.textSha256
  ) {
    if (strict) throw engineFailure('NATIVE_ENGINE_DECISION_MISMATCH');
    return null;
  }
  const presented = state.presentations.find(
    (item) =>
      item.interactionId === response.interactionId &&
      item.contentSha256 === response.contentSha256 &&
      item.publicationId === row.interaction?.publicationId &&
      item.sequence + 1 === response.sequence,
  );
  if (presented) return { response, presented };
  unapplied(state).push({
    commandId: response.commandId,
    interactionId: response.interactionId,
    contentSha256: response.contentSha256,
    textSha256: response.textSha256,
    actorId: response.actorId,
    sequence: identity.sequence,
    writerGeneration: identity.writerGeneration,
    reason: 'no_recorded_question',
  });
  return null;
};

/**
 * Keep the stage the pinned engine holds at its approval gate, as last
 * observed. The pinned engine answers `next` at a gate with the stage's work
 * again, not with the gate, so this record is the only place the coding
 * process can read the open approval from.
 */
export const noteNativeEngineOpenGate = (state, observed) => {
  state.awaitingApproval =
    observed.effectivePlan?.stages?.find((stage) => stage.state === 'awaiting-approval')?.id ??
    null;
};

export const nativeEngineUnappliedReplies = (state) =>
  unapplied(state).map(({ commandId, interactionId, actorId, sequence, reason }) => ({
    commandId,
    interactionId,
    actorId,
    sequence,
    reason,
  }));

const HELD_QUESTION_CHARS = 32_768;
/**
 * What the coding process reads on stderr beside every command result of a
 * turn that began with such a reply, whether the command was applied or
 * refused. It never repeats the member's words. Empty for every other turn.
 */
export const nativeEngineReplyNotice = (state, identity) => {
  if (!inTurn(state, identity)) return '';
  const held = state.directive?.kind === 'ask' ? JSON.stringify(state.directive) : null;
  const gate = typeof state.awaitingApproval === 'string' ? state.awaitingApproval : null;
  return [
    'NATIVE_ENGINE_REPLY_NOT_APPLIED',
    "The member's reply that started this turn was not applied as a workflow decision. " +
      'It does not answer a question the workflow engine recorded: the previous turn ended ' +
      "without a structured question, or its form was not the engine's question. " +
      'It answered, approved and selected nothing, and nothing may be inferred from its text.',
    'Commands that need no member decision are applied as usual. A command that records an ' +
      'answer, an approval or a plan selection stays refused until the member answers a ' +
      'recorded question.',
    `Do this now: write the open question to ${NATIVE_PENDING_SPEC_PATH} as your platform ` +
      'instructions describe, say in your response that the reply was not applied as a ' +
      'decision and that the question is shown again as a form, and end this turn.',
    held && held.length <= HELD_QUESTION_CHARS
      ? `The engine holds this open question. Copy it unchanged into {"version":3,"ask":<this object>}:\n${held}`
      : gate
        ? `The engine holds an open approval for stage ${gate}. Present that approval with the ` +
          'options Approve and Request Changes. Do not run the stage again.'
        : 'If you no longer have the open question, run aidlc next to read the current ' +
          'directive again.',
    '',
  ].join('\n');
};
