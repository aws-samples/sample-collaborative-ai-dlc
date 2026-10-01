// How a gate answer is read, shared by the intents API (which validates the
// answer before recording it) and the orchestrator (which acts on it), so the
// two can never disagree about which option a human chose or how long an
// override reason may be.

// The longest override reason kept on the receipt and the audit event.
export const OVERRIDE_REASON_MAX = 300;

// Every option an engine-opened gate can offer.
export const GATE_CHOICES = Object.freeze([
  'approve',
  'request-changes',
  'override-and-approve',
  'accept-as-is',
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

export default { GATE_CHOICES, OVERRIDE_REASON_MAX, parseChoice };
