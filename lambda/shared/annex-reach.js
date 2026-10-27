// ONE definition of which authored bodies reach a prompt that carries the
// {{INVOKE}} dialect annex.
//
// Two consumers read it, and they MUST agree:
//   - the promotion guard (`aidlc-release.js`), which marks an engine command
//     found in such a body `annexed` and therefore stops blocking promotion;
//   - the prompt builders, which append the annex when a part a release authors
//     to INSTRUCT the agent carries the token — the stage body, the conductor,
//     the persona and the reference knowledge in a stage prompt
//     (`agentcore/stage-materializer.js`), the persona and the reference
//     knowledge in a reviewer or ensemble brief (`agentcore/persona-dispatch.js`
//     `composePersonaPrompt`), and the composer persona and its knowledge in the
//     compose prompt (`agentcore/commands/compose-plan-start.js`).
//
// If the guard claimed reach the builders do not deliver, a release would be
// promoted with an authored step neither performed nor answered. Deriving both
// from this module is what makes that impossible.
//
// Reach is a claim about EVERY session that renders a body, not about the lead:
// a persona and the knowledge of its agent are rendered into the stage prompt of
// a stage it leads, into the reviewer brief and into every ensemble persona
// brief (`commands/run-stage.js` `loadMethodologyKnowledge`), and an agent that
// leads one stage is frequently a support persona in another. All three builders
// therefore gate on the same two parts, which is what lets this module name the
// block types rather than the roles.

/**
 * The blocks of one mapped catalog whose bodies reach a prompt carrying the
 * annex: the stage instructions, the personas and the reference knowledge.
 *
 * Deliberately ABSENT: RULE, SCOPE, ARTIFACT and SENSOR bodies. A rule body is
 * rendered into a stage prompt's steering doc and a scope body into the compose
 * grounding, but neither is a part a builder gates on — gating on a guardrail
 * would append the whole annex for an incidental quote — so a command invoked
 * from one of them reaches a session with no answer and keeps blocking
 * promotion.
 *
 * The conductor is not a block and is handled by its caller: it is rendered into
 * every stage prompt and gated on there, so it always reaches.
 */
const annexReachingBlocks = ({ blocks = {} } = {}) => [
  ...(blocks.STAGE ?? []),
  ...(blocks.AGENT ?? []),
  ...(blocks.KNOWLEDGE ?? []),
];

export { annexReachingBlocks };

export default { annexReachingBlocks };
