// How a gate answer is read, shared by the intents API (which validates the
// answer before recording it) and the orchestrator (which acts on it), so the
// two can never disagree about which option a human chose or how long an
// override reason may be.

// The longest override reason kept on the receipt and the audit event.
export const OVERRIDE_REASON_MAX = 300;

// The build-and-test loop-back gate option. The frontend keys its button off the
// same string, so it is spelled once.
export const LOOP_BACK_OPTION = 'loop-back';

// Every option an engine-opened gate can offer.
export const GATE_CHOICES = Object.freeze([
  'approve',
  'request-changes',
  'override-and-approve',
  'accept-as-is',
  LOOP_BACK_OPTION,
  // The construction-autonomy escalation. Spelled literally rather than imported
  // from construction-autonomy.js so this module stays dependency-free, and listed
  // here so the answer endpoint's `gate_choice_not_offered` check can REJECT it on
  // a gate that never offered it — an option missing from this list parses as null
  // there, which silently skips that check.
  'grant-autonomy',
]);

// Parse a gate answer into one of `allowed`, tolerating the shapes the answer
// endpoint stores ({ decision }, { mode }, a raw string, { freeText }).
// Anything unrecognized returns null — the CALLER picks the deterministic
// fallback and records what was interpreted.
export const parseChoice = (answer, allowed) => {
  const candidates = [
    answer?.decision,
    answer?.mode,
    answer?.choice,
    typeof answer === 'string' ? answer : null,
    typeof answer?.freeText === 'string' ? answer.freeText : null,
  ];
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim().toLowerCase() : null;
    if (v && allowed.includes(v)) return v;
  }
  return null;
};

// A build-and-test gate answered `loop-back` sends the run back to the
// code-generation stage `stageId`. The gate belongs to another stage, whose reset
// left the target row with no session, so the target runs fresh with the answer
// in its prompt.
//
// Keyed on the ENGINE's offer, never on what the human typed: `loopBackTarget` is
// written only by `awaitEngineGate`/`createHumanTask`, and only when the gate
// actually offered the jump, and it names the stage the walk rewound to. Requiring
// it to name the target stage is what stops a `loop-back` string in any answer
// field of any other gate — a `question` gate's `freeText`, for instance — from
// skipping the stage runner's `resume_no_session` guard and re-entering a stage as
// a fresh run.
export const isLoopBackAnswer = (gate, stageId) =>
  typeof gate?.loopBackTarget === 'string' &&
  gate.loopBackTarget === stageId &&
  parseChoice(gate?.answer, [LOOP_BACK_OPTION]) !== null;

export default {
  GATE_CHOICES,
  LOOP_BACK_OPTION,
  OVERRIDE_REASON_MAX,
  isLoopBackAnswer,
  parseChoice,
};
