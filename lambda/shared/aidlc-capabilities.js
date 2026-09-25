// The AI-DLC capability registry — the ONE place that says, for every authored
// methodology field this platform adapts: which values are legal, how faithfully
// each value is honoured, which runtime seam honours it, and
// what the platform does when a release-mode catalog OMITS the field.
//
// It exists because the same three facts were previously stated in three files:
// the enum vocabulary in `aidlc-compatibility.js` (FRONTMATTER_ENUMS), the same
// vocabulary again in `v2-execution-plan.js` (POLICY_ENUMS), and the fidelity
// classification in `aidlc-compatibility.js` (FIELD_FIDELITY). Three copies of
// one vocabulary drift silently; a release can then import cleanly and plan with
// a value the runtime never modelled. Both consumers now DERIVE their tables
// from the entries below.
//
// Entry shape:
//   key                 `<BLOCK_TYPE>:<authored field>` — the registry identity.
//   blockType/field     the authored frontmatter location.
//   planKey             the camelCase key the mapper writes on the block (null
//                       when the field is not part of the per-stage policy).
//   policy              'scope' | 'stage' | null — whether `resolveStagePolicy`
//                       reads it, and from which block.
//   handling            field-level fidelity when a value carries no override.
//   handler             field-level runtime seam id (see RUNTIME_HANDLERS).
//   values              per-authored-value { handling, handler }. Present ⇒ the
//                       keys ARE the closed enum for this field.
//   defaultWhenAbsent   release-mode value applied when the field is ABSENT and
//                       `capabilityPresentIf` holds. null = inert when absent
//                       (the default rule for every field).
//   capabilityPresentIf version-agnostic presence test over the RELEASE CATALOG
//                       (never a version string), evaluated once at plan load:
//                         'anyBlockAuthorsField'      — ≥1 block of this type in
//                                                       this catalog authors the
//                                                       field;
//                         'runtimeFilePresent:<path>' — the closure ships that
//                                                       runtime engine file.
//
// Fidelity vocabulary (unchanged, see `aidlc-compatibility.js` for the full
// rationale): native | approximated | unsupported | packaging-only. Fidelity is
// a property of the (field, VALUE) pair, which is why `values` overrides
// `handling` per value.

import { STAGE_MODES } from './blocks.js';

// Every runtime seam a registry entry may name. A value classified `native` or
// `approximated` MUST name one, and the named handler MUST be in this set — so
// "the registry claims we honour this" and "the runtime actually does" cannot
// drift. A new seam's id is added here with its implementation.
const RUNTIME_HANDLERS = Object.freeze(
  new Set([
    'agent.max-turns@v1',
    'checkpoint.summary-confirmation@v1',
    'policy.review-cap@v1',
    'policy.sensors@v1',
    'policy.change-control@v1',
    'policy.learnings.off@v1',
    'policy.learnings.ritual@v1',
    'policy.skeleton.switch@v1',
    'policy.summary-confirmation.off@v1',
    'prompt.learnings@v1',
    'protocol.plan-approval.outcome-gate@v1',
    'protocol.loopback.gate-offered@v1',
    'review.adversarial@v1',
    'review.advisory-findings@v1',
    'review.artifact-focus@v1',
    'sensor.plane.gate@v1',
    'sensor.plane.write@v1',
    'stage.mode.ensemble-sessions@v1',
    'stage.mode.single-session@v1',
    'workspace.always-restored@v1',
  ]),
);

// A value the platform does not reproduce names no seam. Spelled once so the
// invariant check below reads as the rule it enforces.
const UNHANDLED = Object.freeze({ handling: 'unsupported', handler: null });

// The version-agnostic marker for the stages Plan Approval governs — see
// `planApprovalApplies`.
const PLAN_APPROVAL_ARTIFACT = 'code-generation-plan';

// Upstream's per-stage questions file (`<stage>-questions`, listed in `produces:`
// from 2.9.0 on). Upstream asks a stage's clarifying questions by writing that
// file and reading the answers back from it; the platform asks the same
// questions through `ask_question` / `confirm_summary`, whose questions and
// answers live in the HUMAN# task rows and on the timeline. The output is
// therefore satisfied by the platform question channel, never by a graph
// artifact, and must never be reported as a missing deliverable. The rule is the
// upstream naming convention itself, so it needs no version string.
const QUESTION_CHANNEL_OUTPUT_SUFFIX = '-questions';
const isQuestionChannelOutput = (artifact) =>
  typeof artifact === 'string' &&
  artifact.length > QUESTION_CHANNEL_OUTPUT_SUFFIX.length &&
  artifact.endsWith(QUESTION_CHANNEL_OUTPUT_SUFFIX);

// `STAGE.mode`'s enum is owned by the block validator (blocks.js STAGE_MODES);
// the registry only classifies each mode. Building `values` FROM that list keeps
// the two in lockstep and makes a newly added mode a loud registry failure
// instead of a silently unclassified one.
//
// `pipeline`/`mob` name the SESSIONS seam (ensemble-runner.js): in release mode
// each persona gets its own session with its own brief, which is upstream's
// actual invariant — who sees whose work. Personas run serially (upstream §3.7
// permits it) and contributions are graph artifacts on the timeline rather than
// `.aidlc-engine/**` files; both are stated in
// docs/concepts/aidlc-release-compatibility.md.
const MODE_HANDLING = Object.freeze({
  inline: { handling: 'native', handler: 'stage.mode.single-session@v1' },
  subagent: { handling: 'native', handler: 'stage.mode.single-session@v1' },
  pipeline: { handling: 'approximated', handler: 'stage.mode.ensemble-sessions@v1' },
  mob: { handling: 'approximated', handler: 'stage.mode.ensemble-sessions@v1' },
  'agent-team': UNHANDLED,
});
const modeValues = () =>
  Object.freeze(
    Object.fromEntries(
      STAGE_MODES.map((mode) => {
        const classification = MODE_HANDLING[mode];
        if (!classification) {
          throw new Error(
            `aidlc-capabilities: STAGE.mode "${mode}" has no fidelity classification`,
          );
        }
        return [mode, classification];
      }),
    ),
  );

// Entry order is the contract for the DERIVED policy tables: the scope block's
// keys resolve in this order, then the stage block's, so a catalog with several
// invalid policy values reports them in a stable sequence.
const AIDLC_CAPABILITIES = Object.freeze([
  Object.freeze({
    key: 'SENSOR:fire_on',
    blockType: 'SENSOR',
    field: 'fire_on',
    planKey: 'fireOn',
    policy: null,
    handling: 'approximated',
    handler: 'sensor.plane.write@v1',
    values: Object.freeze({
      write: Object.freeze({ handling: 'approximated', handler: 'sensor.plane.write@v1' }),
      gate: Object.freeze({ handling: 'native', handler: 'sensor.plane.gate@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'No per-write hook exists: `write` narrows the post-agent sweep to this attempt\u2019s changed files (approximation). `gate` runs as its OWN pass after the reviewer loop resolves \u2014 once per existing declared deliverable, on the final bytes, with a blocking verdict holding the stage\u2019s human gate (overridable on the record) and halting an ungated stage exactly as upstream\u2019s autonomous path does.',
  }),
  Object.freeze({
    key: 'STAGE:mode',
    blockType: 'STAGE',
    field: 'mode',
    planKey: 'mode',
    policy: null,
    handling: 'native',
    handler: 'stage.mode.single-session@v1',
    values: modeValues(),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`inline`/`subagent`-without-supports run natively in one session. `pipeline`/`mob`/`subagent`-with-supports run as REAL separate sessions per persona in release mode (lambda/agentcore/ensemble-runner.js): each support receives only the lead draft, contributions carry the server-owned collaborator identity plus AGREE/OBJECT positions, pipeline links carry per-link receipts, and mob dissent is triaged over at most two rounds. The markdown **Collaborator:** line is display text, not evidence identity. Residual deviations keep the classification `approximated`: personas run serially (upstream \u00a73.7 permits this \u2014 concurrency is not the invariant), contributions are graph artifacts rather than `.aidlc-engine/**` files, and blindness is enforced by brief content rather than by a read hook. `V2_ENSEMBLE_SESSIONS=off` reverts to the single-session ensemble prompt. `agent-team` needs real concurrent sessions and fails fast as not_implemented.',
  }),
  Object.freeze({
    key: 'STAGE:workspace_requires',
    blockType: 'STAGE',
    field: 'workspace_requires',
    planKey: null,
    policy: null,
    handling: 'approximated',
    handler: 'workspace.always-restored@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'The runtime clones and self-heals the repo checkout before every stage, so the workspace precondition holds architecturally rather than as a per-stage assertion \u2014 an approximation, not native enforcement. Residual: a project with NO repositories is not refused \u2014 there is no checkout to require, and the stage runs against graph artifacts only.',
  }),
  Object.freeze({
    key: 'STAGE:review_class',
    blockType: 'STAGE',
    field: 'review_class',
    planKey: 'reviewClass',
    policy: 'stage',
    handling: 'native',
    handler: 'review.adversarial@v1',
    values: Object.freeze({
      adversarial: Object.freeze({ handling: 'native', handler: 'review.adversarial@v1' }),
      advisory: Object.freeze({ handling: 'native', handler: 'review.advisory-findings@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'The plan pins an advisory reviewer to one terminal pass and NOT-READY neither fails the stage nor triggers repair. Its findings are carried into the approval prompt\u2019s findings section AND the structured gate row, which is upstream\u2019s at-the-gate presentation; the timeline note remains as the durable record. `adversarial` resumes the lead for one repair turn between NOT-READY rounds, bounded by the stage wall-clock budget. Residual: a codex lead, or any lead with no resumable CLI session, gets no repair turn, so its next round re-reviews the same revision.',
  }),
  Object.freeze({
    key: 'STAGE:review_artifact',
    blockType: 'STAGE',
    field: 'review_artifact',
    planKey: 'reviewArtifact',
    policy: 'stage',
    handling: 'native',
    handler: 'review.artifact-focus@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'The reviewer prompt names the single artifact under review and lists the rest as context.',
  }),
  Object.freeze({
    key: 'STAGE:summary_confirmation',
    blockType: 'STAGE',
    field: 'summary_confirmation',
    planKey: 'summaryConfirmation',
    policy: 'stage',
    handling: 'native',
    handler: 'checkpoint.summary-confirmation@v1',
    values: Object.freeze({
      required: Object.freeze({
        handling: 'native',
        handler: 'checkpoint.summary-confirmation@v1',
      }),
      'if-present': Object.freeze({
        handling: 'native',
        handler: 'checkpoint.summary-confirmation@v1',
      }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'A `confirm_summary` checkpoint tool (registered only when the policy needs it) writes an attempt-bound receipt; stage outputs must carry its authorization stamp. A non-compliant stage gets one repair turn, then a blocking overridable finding at its gate (or a rewind-able failure without a gate). Residual shared with upstream: an artifact drafted before confirmation and re-saved after it passes the lineage check.',
  }),
  Object.freeze({
    key: 'AGENT:maxTurns',
    blockType: 'AGENT',
    field: 'maxTurns',
    planKey: 'maxTurns',
    policy: null,
    handling: 'approximated',
    handler: 'agent.max-turns@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'Enforced natively on OpenCode as agent.build.steps and by Claude\u2019s own cap; Kiro exposes no equivalent and the value is inert there, matching upstream.',
  }),
  Object.freeze({
    key: 'SCOPE:sensors',
    blockType: 'SCOPE',
    field: 'sensors',
    planKey: 'sensorsPolicy',
    policy: 'scope',
    handling: 'native',
    handler: 'policy.sensors@v1',
    values: Object.freeze({
      on: Object.freeze({ handling: 'native', handler: 'policy.sensors@v1' }),
      off: Object.freeze({ handling: 'native', handler: 'policy.sensors@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`off` removes every stage sensor from the plan, so none can run.',
  }),
  Object.freeze({
    key: 'SCOPE:review_cap',
    blockType: 'SCOPE',
    field: 'review_cap',
    planKey: 'reviewCap',
    policy: 'scope',
    handling: 'native',
    handler: 'policy.review-cap@v1',
    values: Object.freeze({
      none: Object.freeze({ handling: 'native', handler: 'policy.review-cap@v1' }),
      advisory: Object.freeze({ handling: 'native', handler: 'policy.review-cap@v1' }),
      adversarial: Object.freeze({ handling: 'native', handler: 'policy.review-cap@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'Effective class is min(stage class, cap); `none` removes the reviewer from the plan.',
  }),
  Object.freeze({
    key: 'SCOPE:summary_confirmation',
    blockType: 'SCOPE',
    field: 'summary_confirmation',
    planKey: 'summaryConfirmation',
    policy: 'scope',
    handling: 'native',
    handler: 'checkpoint.summary-confirmation@v1',
    values: Object.freeze({
      on: Object.freeze({ handling: 'native', handler: 'checkpoint.summary-confirmation@v1' }),
      off: Object.freeze({ handling: 'native', handler: 'policy.summary-confirmation.off@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`off` removes the stage-level requirement from the plan and the prompt outright (native \u2014 removal is something the platform CAN do). `on` leaves the stage-level checkpoint in force.',
  }),
  Object.freeze({
    key: 'SCOPE:change_control',
    blockType: 'SCOPE',
    field: 'change_control',
    planKey: 'changeControl',
    policy: 'scope',
    handling: 'approximated',
    handler: 'policy.change-control@v1',
    values: Object.freeze({
      strict: Object.freeze({ handling: 'approximated', handler: 'policy.change-control@v1' }),
      relaxed: Object.freeze({ handling: 'approximated', handler: 'policy.change-control@v1' }),
    }),
    // Upstream treats an omitted `change_control` as `strict`. Defaulting it
    // unconditionally would inject a change-control ritual into 2.6.18/2.7.0,
    // which have no change control at all — so the default applies only where
    // the CATALOG proves the capability exists by authoring the field somewhere
    // (2.9.0: classic and express author `relaxed`). No version string anywhere.
    defaultWhenAbsent: 'strict',
    capabilityPresentIf: 'anyBlockAuthorsField',
    note: 'A stage approval records the content fingerprints of what it produced; the next stage compares its required inputs against them BEFORE the agent runs. `relaxed` appends a deduplicated v2.change.accepted and continues; `strict` opens a two-option question gate (reconfirm / stop and rewind) whose halt is a rewind-eligible failure. Classified `approximated`, not `native`: this reproduces only the input-fingerprint half of upstream\u2019s mechanism \u2014 compare-before-run plus the strict/relaxed gate. Upstream\u2019s reviewer-request and completion-refusal halves (a reviewer that can itself request re-confirmation, and a human that can refuse the completion outright on a changed input) are not reproduced. Residual: an input no approval ever recorded has no fingerprint to differ from and is therefore not reported as changed.',
  }),
  Object.freeze({
    key: 'SCOPE:learnings',
    blockType: 'SCOPE',
    field: 'learnings',
    planKey: 'learnings',
    policy: 'scope',
    handling: 'approximated',
    handler: 'prompt.learnings@v1',
    values: Object.freeze({
      on: Object.freeze({ handling: 'approximated', handler: 'policy.learnings.ritual@v1' }),
      off: Object.freeze({ handling: 'native', handler: 'policy.learnings.off@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`on` runs the ritual INSIDE the existing approval gate (the prompt asks \u201cAnything to add for next time?\u201d and a non-empty answer writes a durable project learning) rather than as upstream\u2019s separate pre-gate turn \u2014 approximated deliberately, because a second mandatory human turn per stage across 18\u201333 stages is friction without decision value. `off` is native: the MCP server withdraws record_team_knowledge and record_learning_rule from the session outright (mcp/server.js), so no learning can be written, and the prompt says so.',
  }),
  Object.freeze({
    key: 'SCOPE:skeleton',
    blockType: 'SCOPE',
    field: 'skeleton',
    planKey: 'skeleton',
    policy: 'scope',
    handling: 'approximated',
    handler: 'policy.skeleton.switch@v1',
    values: Object.freeze({
      on: Object.freeze({ handling: 'approximated', handler: 'policy.skeleton.switch@v1' }),
      off: Object.freeze({ handling: 'native', handler: 'policy.skeleton.switch@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`off` is a full removal the platform enforces natively: the unit runs with the other lanes and the first construction stage keeps its ordinary approval gate, which is upstream\u2019s own reading of skeleton-off. `on` keeps the walking-skeleton ceremony (the picked unit runs solo first behind its own gate) but is classified `approximated`: upstream\u2019s conductor additionally classifies a project/team/org skeleton STANCE from `## Walking Skeleton` memory-file statements and can override the authored value with it. This platform has no memory file of that shape \u2014 there is no stance classification here, so the scope field alone decides.',
  }),
  Object.freeze({
    key: 'SCOPE:runner',
    blockType: 'SCOPE',
    field: 'runner',
    planKey: 'runner',
    policy: null,
    handling: 'packaging-only',
    handler: null,
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'Upstream generates a convenience runner script; there is no execution effect to reproduce.',
  }),
  // Plan Approval is protocol prose plus a PreToolUse guard upstream, not a
  // frontmatter field — so it cannot be keyed on (field, value) and never
  // appears in the frontmatter fidelity report. Its presence test is the
  // release closure's runtime file list: 2.3.3 ships no such hook (inert),
  // 2.6.18+ do. Recorded on the plan for the checkpoint stream to consume.
  Object.freeze({
    key: 'PROTOCOL:plan-approval',
    blockType: 'PROTOCOL',
    field: 'plan-approval',
    planKey: null,
    policy: null,
    handling: 'approximated',
    handler: 'protocol.plan-approval.outcome-gate@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf: 'runtimeFilePresent:core/hooks/aidlc-plan-approval-guard.ts',
    // The stage predicate, evaluated by `planApprovalApplies` (which explains why
    // the authored output slug stands in for upstream's `workspace_requires`).
    appliesTo: `stage.workspaceRequires === true || stage.produces includes ${PLAN_APPROVAL_ARTIFACT}`,
    note: 'Upstream prevents pre-approval writes with a PreToolUse guard. The platform has no per-write hook; instead, `request_plan_approval` records an attempt-bound authorization and the completion ladder blocks outputs whose stage commit does not follow that approval. This checks the outcome, not each write.',
  }),
  // The Build-and-Test loop-back is construction-protocol prose upstream, not a
  // frontmatter field, so it is keyed on the closure shipping that protocol at
  // all: 2.3.3 has no construction protocol (inert), 2.6.18+ do. Like
  // PROTOCOL:plan-approval it never appears in the frontmatter fidelity report.
  Object.freeze({
    key: 'PROTOCOL:build-and-test-loopback',
    blockType: 'PROTOCOL',
    field: 'build-and-test-loopback',
    planKey: null,
    policy: null,
    handling: 'approximated',
    handler: 'protocol.loopback.gate-offered@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf:
      'runtimeFilePresent:core/aidlc-common/protocols/stage-protocol-construction.md',
    // The target is derived from the plan, never from a stage id: the nearest
    // preceding in-scope stage the release marks as code generation (see
    // `stage-loopback.js`, which reads the same output slug as PLAN_APPROVAL).
    appliesTo: `nearest preceding in-scope stage with workspaceRequires === true || produces includes ${PLAN_APPROVAL_ARTIFACT}`,
    note: 'Upstream loops build-and-test back to code generation AUTONOMOUSLY, up to three times per intent. The platform reproduces the bound and the routing but OFFERS the jump to the human at the validation gate build-and-test already has: the agent records a recommendation through `emit_stage_note`\u2019s `loopBackRecommended` field (a typed `v2.loopback.recommended` event, never parsed prose), and the gate then carries a third `loop-back` option naming the computed target verbatim. Choosing it resets the STAGE# rows from the target through the current stage, which bumps their attempt and makes every prior plan-approval and review receipt invisible \u2014 upstream\u2019s jump invalidation, for free. At three recorded loop-backs the option is withheld and the gate says so. `approximated`, not `native`: the bound is faithful, the autonomy is deliberately not. Residual: a target inside a parallel section (a per-unit code-generation lane) is not offered \u2014 re-entering a fan-out would have to re-derive the approved unit plan, so those scopes keep the rewind API.',
  }),
]);

// Registry invariants, checked once at import: a claim of fidelity that names no
// seam — or names a seam the runtime does not implement — is exactly the silent
// divergence this module exists to prevent, so it fails loudly at load rather
// than at the first pinned run.
for (const entry of AIDLC_CAPABILITIES) {
  const classifications = [
    { label: entry.field, handling: entry.handling, handler: entry.handler },
    ...Object.entries(entry.values ?? {}).map(([value, classification]) => ({
      label: `${entry.field}=${value}`,
      ...classification,
    })),
  ];
  for (const { label, handling, handler } of classifications) {
    const reproduced = handling === 'native' || handling === 'approximated';
    if (reproduced && handler == null) {
      throw new Error(
        `aidlc-capabilities: ${entry.key} ${label} is ${handling} but names no handler`,
      );
    }
    if (!reproduced && handler != null) {
      throw new Error(
        `aidlc-capabilities: ${entry.key} ${label} is ${handling} but names a handler`,
      );
    }
    if (handler != null && !RUNTIME_HANDLERS.has(handler)) {
      throw new Error(
        `aidlc-capabilities: ${entry.key} ${label} names unknown handler "${handler}"`,
      );
    }
  }
}

const CAPABILITY_BY_KEY = new Map(AIDLC_CAPABILITIES.map((entry) => [entry.key, entry]));

const capabilityFor = (key) => CAPABILITY_BY_KEY.get(key) ?? null;

// ── Derived tables ──────────────────────────────────────────────────────────
// The analyzer's fidelity table. Identical in shape to the constant it replaces,
// so `fidelityReport` keeps reading `handling` / `values[value]` / `note`.
const FIELD_FIDELITY = Object.freeze(
  AIDLC_CAPABILITIES.map((entry) =>
    Object.freeze({
      blockType: entry.blockType,
      field: entry.field,
      handling: entry.handling,
      ...(entry.values
        ? {
            values: Object.freeze(
              Object.fromEntries(
                Object.entries(entry.values).map(([value, classification]) => [
                  value,
                  classification.handling,
                ]),
              ),
            ),
          }
        : {}),
      note: entry.note,
    }),
  ),
);

// The analyzer's closed frontmatter vocabulary: every entry whose `values` map
// declares one, grouped by block type. PROTOCOL entries are excluded — they name
// no frontmatter key.
const FRONTMATTER_ENUMS = Object.freeze(
  Object.fromEntries(
    [...new Set(AIDLC_CAPABILITIES.map((entry) => entry.blockType))]
      .filter((blockType) => blockType !== 'PROTOCOL')
      .map((blockType) => [
        blockType,
        Object.freeze(
          Object.fromEntries(
            AIDLC_CAPABILITIES.filter((entry) => entry.blockType === blockType && entry.values).map(
              (entry) => [entry.field, Object.freeze(Object.keys(entry.values))],
            ),
          ),
        ),
      ])
      .filter(([, byField]) => Object.keys(byField).length > 0),
  ),
);

// The plan's policy vocabulary: [owner, planKey, authored field, allowed values].
// Scope-owned rows first, then stage-owned, so a catalog with several invalid
// policy values reports them in the order the pre-registry table did.
const policyRows = (owner) =>
  AIDLC_CAPABILITIES.filter((entry) => entry.policy === owner && entry.values).map((entry) =>
    Object.freeze([owner, entry.planKey, entry.field, Object.keys(entry.values)]),
  );
const POLICY_ENUMS = Object.freeze([...policyRows('scope'), ...policyRows('stage')]);

const policyKeys = (owner) =>
  Object.freeze(
    AIDLC_CAPABILITIES.filter((entry) => entry.policy === owner && entry.planKey).map(
      (entry) => entry.planKey,
    ),
  );
const SCOPE_POLICY_KEYS = policyKeys('scope');
const STAGE_POLICY_KEYS = policyKeys('stage');

// ── Capability presence ─────────────────────────────────────────────────────
// Version-agnostic presence tests over the resolved release catalog. Evaluated
// ONCE per plan (release mode only) and recorded on `plan.capabilities`, so the
// runtime never re-derives it and never inspects a version string.
const BLOCK_BAG_KEY = Object.freeze({
  SCOPE: 'scopesById',
  STAGE: 'stagesById',
  SENSOR: 'sensorsById',
  AGENT: 'agentsById',
});

const anyBlockAuthorsField = (entry, library) => {
  const bag = library?.[BLOCK_BAG_KEY[entry.blockType]] ?? null;
  if (!bag || !entry.planKey) return false;
  return Object.values(bag).some((block) => block?.[entry.planKey] != null);
};

const capabilityPresent = (entry, library) => {
  const test = entry.capabilityPresentIf;
  if (!test) return false;
  if (test === 'anyBlockAuthorsField') return anyBlockAuthorsField(entry, library);
  if (test.startsWith('runtimeFilePresent:')) {
    const path = test.slice('runtimeFilePresent:'.length);
    const paths = library?.runtimeFilePaths;
    if (Array.isArray(paths)) return paths.includes(path);
    // A closure may hand the runtime-file bag as a Map (release-resolver) rather
    // than a path list; both are read, neither is required.
    return typeof paths?.has === 'function' ? paths.has(path) : false;
  }
  throw new Error(
    `aidlc-capabilities: ${entry.key} declares unknown capabilityPresentIf "${test}"`,
  );
};

/**
 * The capabilities THIS catalog proves it has. Returns a sparse map keyed by
 * registry key — absent means inert, so a catalog with no capability at all
 * yields `{}` and every consumer keeps its pre-Phase-6 behaviour.
 */
const resolveCapabilities = (library = {}) =>
  Object.freeze(
    Object.fromEntries(
      AIDLC_CAPABILITIES.filter(
        (entry) => entry.capabilityPresentIf && capabilityPresent(entry, library),
      ).map((entry) => [entry.key, true]),
    ),
  );

/**
 * The release-mode default for a field the catalog OMITS: the registry's
 * `defaultWhenAbsent`, but only where the capability is present. `null` means
 * "stay inert", which is what every field but SCOPE.change_control does.
 */
const defaultWhenAbsent = (key, capabilities = {}) => {
  const entry = capabilityFor(key);
  if (!entry?.defaultWhenAbsent) return null;
  return capabilities[key] === true ? entry.defaultWhenAbsent : null;
};

/**
 * Defence in depth against a hand-edited `methodologyRelease` pin: every
 * capability the plan resolved must name a seam this runtime implements. In a
 * normal flow this is unreachable — the analyzer rejects an unknown value at
 * import — so a hit means the pinned catalog and this build disagree, and the
 * stage must fail before any agent work rather than run with the semantic
 * missing. `handlers` and `registry` are injectable for tests.
 */
const unhandledCapabilities = ({
  capabilities = {},
  registry = AIDLC_CAPABILITIES,
  handlers = RUNTIME_HANDLERS,
} = {}) =>
  registry
    .filter((entry) => capabilities[entry.key] === true)
    .filter((entry) => {
      const named = [
        entry.handler,
        ...Object.values(entry.values ?? {}).map((classification) => classification.handler),
      ].filter(Boolean);
      // A capability whose values are all classified `unsupported` names no
      // handler by design — that is a stated gap, not an unhandled capability.
      return named.length > 0 && !named.every((handler) => handlers.has(handler));
    })
    .map((entry) => entry.key);

// A published release may contain authored values the current build cannot
// reproduce. Preserve those source values and report only gaps that remain
// unsupported or have no runtime handler in this build.
const unhonouredValues = ({
  fidelityGaps = [],
  registry = AIDLC_CAPABILITIES,
  handlers = RUNTIME_HANDLERS,
} = {}) =>
  fidelityGaps.filter((gap) => {
    const entry = registry.find(
      (candidate) => candidate.blockType === gap.blockType && candidate.field === gap.field,
    );
    if (!entry) return true;
    const classification =
      (typeof gap.value === 'string' ? entry.values?.[gap.value] : null) ?? entry;
    return (
      classification.handling === 'unsupported' ||
      classification.handler == null ||
      !handlers.has(classification.handler)
    );
  });

/**
 * Whether the Code Generation Plan Approval checkpoint applies to one stage.
 *
 * Two independent conditions, both version-agnostic:
 *   1. the CATALOG proves the capability exists (the closure ships the upstream
 *      PreToolUse guard file) — `capabilities['PROTOCOL:plan-approval']`;
 *   2. this STAGE is one the protocol governs.
 *
 * Upstream scopes (2) with `workspace_requires: true`. That key is deliberately
 * NOT mapped onto the stage block — mapping it would change the 2.3.3 block
 * digest, which is this coexistence contract's byte-identity proof — so the
 * authored `code-generation-plan` output is read as the equivalent marker: it is
 * the artifact the protocol approves, it is authored by the same stages in every
 * release, and it needs no version string. `workspaceRequires` is still honoured
 * first so that mapping it later needs no change here.
 */
const planApprovalApplies = ({ stage, capabilities = {} } = {}) => {
  if (capabilities['PROTOCOL:plan-approval'] !== true) return false;
  if (stage?.workspaceRequires === true) return true;
  return (stage?.produces ?? []).includes(PLAN_APPROVAL_ARTIFACT);
};

export {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  PLAN_APPROVAL_ARTIFACT,
  POLICY_ENUMS,
  QUESTION_CHANNEL_OUTPUT_SUFFIX,
  RUNTIME_HANDLERS,
  SCOPE_POLICY_KEYS,
  STAGE_POLICY_KEYS,
  capabilityFor,
  defaultWhenAbsent,
  isQuestionChannelOutput,
  planApprovalApplies,
  resolveCapabilities,
  unhandledCapabilities,
  unhonouredValues,
};

export default {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  PLAN_APPROVAL_ARTIFACT,
  POLICY_ENUMS,
  QUESTION_CHANNEL_OUTPUT_SUFFIX,
  RUNTIME_HANDLERS,
  SCOPE_POLICY_KEYS,
  STAGE_POLICY_KEYS,
  capabilityFor,
  defaultWhenAbsent,
  isQuestionChannelOutput,
  planApprovalApplies,
  resolveCapabilities,
  unhandledCapabilities,
  unhonouredValues,
};
