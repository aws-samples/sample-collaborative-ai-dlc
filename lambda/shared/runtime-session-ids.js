// Every AgentCore runtime session id the platform derives deterministically,
// in ONE place. Producers (orchestrator, intents, discussions) and the teardown
// that must find them again (intent deletion) import from here, so an id
// convention cannot drift between the session's creator and its cleanup owner.
//
// AgentCore requires session ids of at least 33 characters; short ids are
// right-padded with '0'.

const pad = (id) => id.padEnd(33, '0');

// The intent's main session (stages, init-ws, derive, compose-free commands).
export const intentSessionIdFor = (intentId) => pad(`aidlc-intent-${intentId}`);

// One per parallel unit lane.
export const laneSessionIdFor = (intentId, sectionIndex, slug) =>
  pad(`aidlc-intent-${intentId}-s${sectionIndex}-${slug}`);

// One per composer request (fresh, so a compose never boots the intent's own
// session on stale code).
export const composeSessionIdFor = (composeId) => pad(`aidlc-compose-${composeId}`);

// One per intent discussion thread (Quorum discussion assist).
export const discussionSessionIdFor = (intentId, discussionId) =>
  pad(`aidlc-discuss-${intentId}-${discussionId}`);

// One per intent, reused by every Quorum artifact edit of that intent.
export const quorumEditSessionIdFor = (intentId) => pad(`aidlc-qedit-${intentId}`);

export default {
  intentSessionIdFor,
  laneSessionIdFor,
  composeSessionIdFor,
  discussionSessionIdFor,
  quorumEditSessionIdFor,
};
