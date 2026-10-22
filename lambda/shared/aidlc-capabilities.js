// The AI-DLC capability registry — the ONE place that says, for every authored
// methodology field this platform adapts: which values are legal, how faithfully
// each value is honoured, which runtime seam honours it, and
// what the platform does when a release-mode catalog OMITS the field.
//
// The analyzer's enum vocabulary (FRONTMATTER_ENUMS) and fidelity classification
// (FIELD_FIDELITY) and the plan resolver's policy enums (POLICY_ENUMS) are all
// DERIVED from the entries below, so they cannot drift apart: a release can never
// import cleanly and then plan with a value the runtime does not model.
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
//   authoredType        the typeof the PARSED frontmatter value, 'string' unless
//                       stated. The enum keys are always text, so a field whose
//                       YAML value is a boolean declares it here and the
//                       analyzer compares the real type rather than assuming a
//                       string (aidlc-compatibility.js).
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
    'policy.collaborators.off@v1',
    'policy.guard-policy.off@v1',
    'policy.learnings.off@v1',
    'policy.plan-approval.switch@v1',
    'policy.project-type.default@v1',
    'policy.learnings.ritual@v1',
    'policy.skeleton.switch@v1',
    'policy.summary-confirmation.off@v1',
    'prompt.learnings@v1',
    'protocol.construction-autonomy.gate-waiver@v1',
    'protocol.loopback.gate-offered@v1',
    'protocol.plan-approval.outcome-gate@v1',
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

// A `{{INVOKE}} engine <family>` gap is not an authored frontmatter value and
// never reaches `plan.capabilities`: it is prompt text, and the seam that answers
// it is the engine-command annex the stage and compose prompts append
// (agentcore/prompts/invoke-dialect-annex.md). The annex is a CLOSED list, so a
// family it names BY NAME has a defined platform answer — for a state-mutating
// family, recording a recommendation for the human instead of performing the
// action — and must not block promotion where the annex reaches the prompt (the
// gap carries `annexed` only then). A family the annex does not name gets
// only its catch-all ("say it is unavailable, never improvise"), which keeps the
// authored step unperformed and unrecorded, so it keeps blocking promotion.
//
// This is deliberately NOT the same axis as the fidelity report, which keeps
// classifying these families `unsupported`: that is the admin-facing statement
// "the platform does not reproduce these semantics", not "this build has no
// handler". `release_capability_unhandled` means the latter.
const ANNEX_HANDLED_ENGINE_COMMANDS = Object.freeze(
  new Set([
    'engine graph ars',
    'engine orchestrate',
    'engine recompose',
    'engine state',
    // AI-DLC 2.11. Every name here is answered BY NAME in the annex with an
    // answer that forbids fabricating a result, and
    // `aidlc-release-adapters.test.js` asserts the row exists for each — a name
    // with no row is a test failure, not a silent pass.
    //
    // Only the REFUSED commands are listed. The three the platform has a real
    // seam for (`audit append-raw`, `config get`, `now`) are classified
    // `approximated` with `annexed: true` in `aidlc-compatibility.js`, and that
    // flag is what makes their answer's REACH checkable. This set is consulted
    // only for a gap that already carries `annexed`, and an approximated family
    // never produces one, so naming them here would decide nothing. The four
    // pre-2.11 approximated families (`gen`, `workspace`, `worktree`,
    // `graph validate-grid`) are absent for the same reason, and the annex row
    // of every approximated family is asserted from those entries rather than
    // from this set.
    'engine config set',
    'engine log answer',
    'engine log decision',
    'engine orchestrate next',
    'engine state set-construction-execution',
    'engine state set-construction-verification-command',
    'engine testing-posture restore',
    'engine worktree discard',
    'engine worktree list',
    'engine worktree purge',
    'engine worktree restore',
  ]),
);

const ENGINE_COMMAND_GAP_FIELD = '{{INVOKE}}';
const isEngineCommandGap = (gap) =>
  gap?.blockType === 'BODY' && gap?.field === ENGINE_COMMAND_GAP_FIELD;

// An authored field no entry below covers has no legal values, no handler and no
// absent-default — the platform does not know what it means, so a release that
// authors one would run with a setting silently dropped. The analyzer already
// withholds certification for it (`certificationGaps`); promotion reads the same
// names off the closure (`compatibility.executionRelevantUnmappedFields`) through
// this constructor, so one list produces both answers. `unhonouredValues` treats
// this value as unconditionally unhonoured: it is a statement about what the
// importer DROPPED, which no later handler can recover.
const UNMAPPED_FIELD_GAP_VALUE = 'unmapped';
const unmappedFieldGaps = (executionRelevantUnmappedFields = []) =>
  executionRelevantUnmappedFields.map((key) => {
    const separator = String(key).indexOf(':');
    return {
      blockType: String(key).slice(0, separator),
      field: String(key).slice(separator + 1),
      value: UNMAPPED_FIELD_GAP_VALUE,
    };
  });

// The version-agnostic marker for the stages Plan Approval governs — see
// `planApprovalApplies`.
const PLAN_APPROVAL_ARTIFACT = 'code-generation-plan';

// The version-agnostic marker for the ONE stage that may recommend a
// Build-and-Test loop-back — see `isLoopBackRecommenderStage` in stage-loopback.js.
// Upstream names that stage in construction-protocol prose, which no frontmatter
// field carries, so the authored `build-test-results` output stands in for it: it is
// produced by build-and-test and by no other stage in every release the registry
// covers, and reading an authored output needs no version string and no new
// stage-block field.
const LOOP_BACK_RESULTS_ARTIFACT = 'build-test-results';

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
    note: '`inline`/`subagent`-without-supports run natively in one session. `pipeline`/`mob` and `subagent`-with-supports run as REAL separate sessions per persona in release mode, for a stage whose plan resolved a policy (lambda/agentcore/ensemble-runner.js). `subagent` qualifies ONLY when the release closure ships `core/aidlc-common/protocols/stage-protocol-ensemble.md`; without it a `subagent` stage with a support stays one delegated session (2.3.3 `reverse-engineering`). In a separate-session run: each support receives only the lead draft, contributions carry the server-owned collaborator identity plus AGREE/OBJECT positions, pipeline links carry per-link receipts, and mob dissent is triaged over at most two rounds. The markdown **Collaborator:** line is display text, not evidence identity. Residual deviations keep the classification `approximated`: personas run serially (upstream \u00a73.7 permits this \u2014 concurrency is not the invariant), contributions are graph artifacts rather than `.aidlc-engine/**` files, and blindness is enforced by brief content rather than by a read hook. `agent-team` needs real concurrent sessions and fails fast as not_implemented.',
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
    note: 'The plan pins an advisory reviewer to one terminal pass and NOT-READY neither fails the stage nor triggers repair. Its findings are carried into the approval prompt\u2019s findings section AND the structured gate row, which is upstream\u2019s at-the-gate presentation; the timeline note remains as the durable record. `adversarial` resumes the lead for one repair turn between NOT-READY rounds, bounded by the stage wall-clock budget. An adversarial verdict still NOT-READY after that loop is surfaced at a gated stage\u2019s approval gate as an advisory finding (`review_advisory_findings`) and `approve` remains, as upstream lets a post-cap NOT-READY be approved like any other gate. On a gate a construction autonomy grant would waive, the same verdict \u2014 or a reviewer that recorded none \u2014 is instead a BLOCKING overridable finding (`review_not_ready`): the gate opens for a human, plain `approve` is withheld and accepting the objection is recorded. That is deliberately stricter than upstream, which lets a post-cap NOT-READY be approved like any other gate. Residual: a codex lead, or any lead with no resumable CLI session, gets no repair turn, so its next round re-reviews the same revision.',
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
      // 2.11's third value, reaching this key through `guard_policy`: no reopen
      // and no change-control prose, which is exactly "no change control".
      off: Object.freeze({ handling: 'approximated', handler: 'policy.guard-policy.off@v1' }),
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
  // 2.11 renames `change_control` to `guard_policy` and adds an `off` value, and
  // adds `plan_approval`, `collaborators` and `existing_code`. The importer maps
  // all four onto the SCOPE block, so the analyzer stops calling them unmapped —
  // and an authored value must therefore have SOMETHING here to judge it, or
  // mapping alone would silently open promotion for a setting the runtime still
  // drops. Each is classified `unsupported` with no handler until the PR that
  // resolves it onto the per-stage policy flips the classification and names its
  // seam. The enum is the real contribution of these entries meanwhile: an
  // illegal value is refused at import instead of reaching the plan.
  Object.freeze({
    key: 'SCOPE:guard_policy',
    blockType: 'SCOPE',
    field: 'guard_policy',
    planKey: 'guardPolicy',
    policy: 'scope',
    handling: 'approximated',
    handler: 'policy.change-control@v1',
    values: Object.freeze({
      strict: Object.freeze({ handling: 'approximated', handler: 'policy.change-control@v1' }),
      relaxed: Object.freeze({ handling: 'approximated', handler: 'policy.change-control@v1' }),
      off: Object.freeze({ handling: 'approximated', handler: 'policy.guard-policy.off@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'Upstream\u2019s rename of `change_control`, with a third value `off`. The plan resolves ONE effective guard value from this field first and the legacy name second, so a scope carrying only the new name \u2014 which a user SCOPE overlay can, because an overlay never passes through the mapper \u2014 is honoured, and a 2.8.2/2.9.0 closure resolves exactly as before. `strict` and `relaxed` are the change-control gate unchanged. `off` is a removal the platform performs natively \u2014 no reopen and no change-control prose \u2014 but stays `approximated` because upstream\u2019s `off` ALSO lowers execution fences (pre-write guards, hook trust) this platform never had, and supports per-fence `Guards Off`/`Guards On` overrides with a provenance and kill-switch chain that have no surface here. The platform sentence is exact: Guard Policy off means no change-control reopen; it never removes a human approval gate.',
  }),
  Object.freeze({
    key: 'SCOPE:plan_approval',
    blockType: 'SCOPE',
    field: 'plan_approval',
    planKey: 'planApproval',
    policy: 'scope',
    handling: 'approximated',
    handler: 'protocol.plan-approval.outcome-gate@v1',
    values: Object.freeze({
      on: Object.freeze({
        handling: 'approximated',
        handler: 'protocol.plan-approval.outcome-gate@v1',
      }),
      off: Object.freeze({ handling: 'approximated', handler: 'policy.plan-approval.switch@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`off` sets `policy.planApproval` to null: `request_plan_approval` is not registered for the stage and the completion ladder requires no plan receipt. It changes NOTHING else \u2014 the stage\u2019s `humanValidation` is untouched, which the plan suite asserts for every scope and stage. `on` keeps the existing approximation (A07): the platform checks the outcome rather than guarding each write. Refused and named in the annex: upstream\u2019s engine-owned three-choice ask, its fingerprint/receipt minting, `--units` subsets, edit-while-waiting protection and strict-reopen-on-change.',
  }),
  // Upstream's collaborator switch, resolved onto the ensemble topology by this
  // PR. `on` is the platform's existing per-persona session approximation; `off`
  // withdraws the support roster so the lead alone produces the declared outputs.
  Object.freeze({
    key: 'SCOPE:collaborators',
    blockType: 'SCOPE',
    field: 'collaborators',
    planKey: 'collaborators',
    policy: 'scope',
    handling: 'approximated',
    handler: 'stage.mode.ensemble-sessions@v1',
    values: Object.freeze({
      on: Object.freeze({
        handling: 'approximated',
        handler: 'stage.mode.ensemble-sessions@v1',
      }),
      off: Object.freeze({ handling: 'native', handler: 'policy.collaborators.off@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: '`off` resolves no ensemble topology at all, which is this runtime\u2019s existing single-session contract: the lead agent produces every declared stage output itself, with no pipeline link, no mob round and no support brief. That is upstream\u2019s own lead-only contract, so `off` is honoured natively. Each withdrawn persona is named on the plan\u2019s policy effects, so the downgrade reaches the timeline instead of being a silently shorter roster. `on` keeps the existing approximation (A02): the support personas get real separate blind sessions and their contributions are graph artifacts, not an engine-owned collaboration ledger.',
  }),
  // The one authored setting that is a YAML BOOLEAN rather than a string, which
  // is why the entry declares its authored type: the enum check at the analyzer
  // boundary compares the real parsed value, so upstream\u2019s `existing_code: true`
  // imports and a quoted `"true"` \u2014 which would reach the prompt renderer as a
  // string and be dropped \u2014 is refused.
  Object.freeze({
    key: 'SCOPE:existing_code',
    blockType: 'SCOPE',
    field: 'existing_code',
    planKey: 'existingCode',
    policy: 'scope',
    authoredType: 'boolean',
    handling: 'approximated',
    handler: 'policy.project-type.default@v1',
    values: Object.freeze({
      true: Object.freeze({ handling: 'approximated', handler: 'policy.project-type.default@v1' }),
      false: Object.freeze({ handling: 'approximated', handler: 'policy.project-type.default@v1' }),
    }),
    defaultWhenAbsent: null,
    capabilityPresentIf: null,
    note: 'The authored value reaches `policy.existingCode` and the stage prompt states the project type it implies, so the scope\u2019s own classification steers the run instead of being dropped. `approximated`, not native: upstream additionally rescans, reintroduces Reverse Engineering behind the cursor and returns to the interrupted stage when the type changes mid-run. That transaction is refused by name in the annex (`engine orchestrate next`) \u2014 a human rewinds and recomposes.',
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
    // Upstream's scope switch defaults to `on`, but only releases that have the
    // switch run the ritual at all (2.9.0 on: classic authors `learnings: on`
    // and the learnings protocol module ships with it). Before that no scope
    // authors the field and no gate asks the question, so an omitted field stays
    // inert unless the catalog proves the capability, exactly as for
    // change_control.
    defaultWhenAbsent: 'on',
    capabilityPresentIf: 'anyBlockAuthorsField',
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
    // Neither end of the jump is a stage id. The RECOMMENDER is the stage that
    // authors `build-test-results` (see `isLoopBackRecommenderStage`); the TARGET
    // is the code generation stage immediately before it (see `stage-loopback.js`,
    // which reads the same output slug as PLAN_APPROVAL).
    appliesTo: `recommender: stage.produces includes ${LOOP_BACK_RESULTS_ARTIFACT}; target: in-scope stage immediately before it, with workspaceRequires === true || produces includes ${PLAN_APPROVAL_ARTIFACT}`,
    note: 'Upstream loops build-and-test back to code generation AUTONOMOUSLY, up to three times per intent. The platform reproduces the bound and the routing, and takes the jump itself only under `PROTOCOL:construction-autonomy`, where it is stored as build-and-test\u2019s validation gate row, already answered `loop-back` with the protocol\u2019s `Autonomous loop-back N` marker under a run-scoped id, so code generation resumes from it exactly as from a human answer, under a new attempt that asks for Plan Approval again and stops at code generation\u2019s own validation gate, which the grant never waives; a gated run still OFFERS it to the human at the validation gate build-and-test already has: the agent records a recommendation through `emit_stage_note`\u2019s `loopBackRecommended` field (written by the platform onto the stage row, never parsed from prose), and the gate then carries a third `loop-back` option naming the code-generation stage immediately before. Choosing it resets both stage rows, which bumps their attempt and makes every prior plan-approval and review receipt invisible, and re-runs code generation with the reason and the reviewer\u2019s feedback. At three recorded loop-backs the option is withheld and the gate says so. `approximated`, not `native`: the bound and the routing are faithful, and an autonomous intent takes the jump, but a gated intent still decides each jump by hand and an autonomous one halts to the human gate on any blocking finding or at the cap. Residual: in scopes that run code generation per unit (classic, enterprise, feature, mvp, workshop) build-and-test has no linear target, so the gate shows the recommendation as a note and those scopes keep the rewind API. Residual: like upstream, the autonomous jump depends on the agent\u2019s recommendation, so a build-and-test stage that succeeds with failing tests but records none and raises no finding is approved under autonomy; a blocking results sensor is what halts it.',
  }),
  // Construction Autonomy Mode is protocol prose plus a state field upstream, not
  // a frontmatter field, so like the two entries above it is keyed on the closure
  // shipping the construction protocol at all and never appears in the
  // frontmatter fidelity report.
  Object.freeze({
    key: 'PROTOCOL:construction-autonomy',
    blockType: 'PROTOCOL',
    field: 'construction-autonomy',
    planKey: null,
    policy: null,
    handling: 'native',
    handler: 'protocol.construction-autonomy.gate-waiver@v1',
    values: null,
    defaultWhenAbsent: null,
    capabilityPresentIf:
      'runtimeFilePresent:core/aidlc-common/protocols/stage-protocol-construction.md',
    appliesTo:
      'construction-phase stages other than the plan\u2019s first non-skipped construction stage with a sequential gate (a per-unit stage inside a parallel section is never that anchor), excluding a gate that carries a fan-out approval or a Plan Approval',
    note: 'Upstream records the human\u2019s grant in `Construction Autonomy Mode` (`unset`/`gated`/`autonomous`, only the exact `autonomous` truthy) and waives the remaining construction stage gates. The platform freezes the same two-valued grant onto the intent at create, or escalates it from the one construction gate that always stays human through a `grant-autonomy` answer (`v2.autonomy.mode_set`). The grant is written by value inside a durable step, so a replay records it once. A waived gate still runs the full gate-precondition evaluation; only an EMPTY findings list over OBSERVED outputs auto-approves (outputs the runner could not observe halt, because the evaluator never reports them missing), writing the same attempt-scoped `stage-approval` receipt with the protocol\u2019s marker input plus `v2.gate.auto_approved`, and anything else \u2014 a blocking sensor, a terminal adversarial NOT-READY, a missing required artifact, learning candidates waiting for the learnings ritual, or an evaluation error \u2014 opens the ordinary human gate with its findings. The first construction stage, every Plan Approval, every fan-out approval, a stage failure, and any loop-back recommendation remain human, which is upstream\u2019s halt-and-ask set. The one exception is an offered loop-back with no blocking finding, which takes the autonomous jump (`PROTOCOL:build-and-test-loopback`) instead of being approved; a recommendation at the bound or with no target opens the gate. `native`: the grant, its scope, the anchor carve-out and the halt-and-ask set are all reproduced. Residuals: (1) upstream additionally refuses a blocking-sensor override under autonomy \u2014 here an autonomous gate never overrides at all (it halts), so the refusal has nothing to refuse; (2) the grant governs only the once-per-workflow sequential gates. Per-unit stages inside a parallel section keep their own ceremony \u2014 the skeleton gate and the section ladder (`v2.units.autonomy_set`, whose `UNITPLAN.autonomyMode` is a SEPARATE decision from this grant), so a scope with a unit DAG still batches its lane approvals there. In those scopes the anchor is the first sequential construction gate after the lanes (for example build-and-test): that gate stays human and is where `grant-autonomy` is offered; (3) a terminal adversarial NOT-READY halts a waived gate instead of being auto-approved, which is stricter than upstream; (4) once given, the grant holds for the rest of the intent, rewinds included, until the intent is cancelled: cancel clears it and records the withdrawal on the grant\u2019s provenance, so a rewind after a cancel relaunches gated. Cancel is only accepted while the intent is parked or failed; a waived gate never parks, so an autonomous run can be cancelled once it halts at a human gate, a question or a failure; (5) a waived gate judges the stage\u2019s evidence, not its test results: a build-and-test stage that succeeds with failing tests but raises no finding and records no loop-back recommendation is approved under autonomy, and a blocking results sensor is what halts it.',
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

// The typeof each enum field's PARSED frontmatter value. Derived from the same
// entries, so the analyzer can never disagree with the registry about whether a
// field is authored as text or as a YAML boolean.
const FRONTMATTER_ENUM_TYPES = Object.freeze(
  Object.fromEntries(
    Object.keys(FRONTMATTER_ENUMS).map((blockType) => [
      blockType,
      Object.freeze(
        Object.fromEntries(
          AIDLC_CAPABILITIES.filter((entry) => entry.blockType === blockType && entry.values).map(
            (entry) => [entry.field, entry.authoredType ?? 'string'],
          ),
        ),
      ),
    ]),
  ),
);

const isHandled = (entry) => entry.handling !== 'unsupported';

// The plan's policy vocabulary: [owner, planKey, authored field, allowed values,
// authored type, uninterpreted values]. Scope-owned rows first, then
// stage-owned, so a catalog with several invalid policy values reports them in
// the order the pre-registry table did. The authored type rides along because
// the plan boundary also sees blocks the import analyzer never judged (a user
// SCOPE overlay is stored verbatim), so it must check the parsed type against
// the same single declaration.
//
// The last member is the subset of the field's own legal values whose handling
// is still `unsupported`, and it is only ever nonempty for a field that HAS a
// consumer: a fully unsupported field activates no policy at all, so none of its
// values reaches a handler, while a handled field's unsupported value reaches
// one that implements no branch for it.
const uninterpretedValues = (entry) =>
  Object.freeze(
    isHandled(entry)
      ? Object.entries(entry.values)
          .filter(([, value]) => value?.handling === 'unsupported')
          .map(([name]) => name)
      : [],
  );
const policyRows = (owner) =>
  AIDLC_CAPABILITIES.filter((entry) => entry.policy === owner && entry.values).map((entry) =>
    Object.freeze([
      owner,
      entry.planKey,
      entry.field,
      Object.keys(entry.values),
      entry.authoredType ?? 'string',
      uninterpretedValues(entry),
    ]),
  );
const POLICY_ENUMS = Object.freeze([...policyRows('scope'), ...policyRows('stage')]);

// Two different questions, two different lists.
//
// `*_POLICY_KEYS` is the vocabulary the plan KNOWS: every policy field the
// registry names, so an authored value of any of them is type- and enum-checked
// even before a handler exists.
//
// `*_RUNTIME_POLICY_KEYS` is the subset whose handling is no longer
// `unsupported` — the fields that actually have a consumer. Only those may
// ACTIVATE a resolved `stage.policy`, because activation also switches on every
// other policy key's default (change control, loop-back, the review lattice) and
// is the enablement gate the ensemble topology reads. A field that is merely
// mapped-and-validated must leave the plan exactly as policy-free as it was
// before its entry existed, or classifying it would ship its neighbours' effects
// to a release whose own setting is still dropped.
const policyKeys = (owner, predicate = () => true) =>
  Object.freeze(
    AIDLC_CAPABILITIES.filter(
      (entry) => entry.policy === owner && entry.planKey && predicate(entry),
    ).map((entry) => entry.planKey),
  );
const SCOPE_POLICY_KEYS = policyKeys('scope');
const STAGE_POLICY_KEYS = policyKeys('stage');
const SCOPE_RUNTIME_POLICY_KEYS = policyKeys('scope', isHandled);
const STAGE_RUNTIME_POLICY_KEYS = policyKeys('stage', isHandled);

// The point query of the fact the policy rows carry per field: is THIS authored
// value of THIS policy field one the platform has no interpretation for? The
// plan refuses such a value from a user overlay, and the runtime consumer of a
// field with several outcomes asks again before acting — so a value that
// reached a `stage.policy` by another route still cannot run as one of the
// outcomes it is not.
const POLICY_VALUES_UNINTERPRETED = Object.freeze(
  Object.fromEntries(
    POLICY_ENUMS.filter(([, , , , , uninterpreted]) => uninterpreted.length > 0).map(
      ([, planKey, , , , uninterpreted]) => [planKey, uninterpreted],
    ),
  ),
);
const policyValueUninterpreted = (planKey, value) =>
  value != null && (POLICY_VALUES_UNINTERPRETED[planKey] ?? []).includes(String(value));

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
 * The protocol capabilities a release record's stored evidence proves, for a
 * reader that has the record but not the closure (the release listing).
 *
 * The evidence names each PROTOCOL capability the closure ships, and each is
 * keyed on one runtime file. Those files are recovered and resolved again, so a
 * capability registered after the evidence was computed is still reported when
 * it is keyed on a file the evidence already proves. No evidence proves nothing.
 */
const protocolCapabilitiesFromEvidence = (fidelityGaps) => {
  const present = new Set(
    (Array.isArray(fidelityGaps) ? fidelityGaps : [])
      .filter((gap) => gap?.blockType === 'PROTOCOL' && gap.value === 'present')
      .map((gap) => gap.field),
  );
  const runtimeFilePaths = AIDLC_CAPABILITIES.filter(
    (entry) =>
      entry.blockType === 'PROTOCOL' &&
      present.has(entry.field) &&
      String(entry.capabilityPresentIf).startsWith('runtimeFilePresent:'),
  ).map((entry) => entry.capabilityPresentIf.slice('runtimeFilePresent:'.length));
  return resolveCapabilities({ runtimeFilePaths });
};

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
  annexedEngineCommands = ANNEX_HANDLED_ENGINE_COMMANDS,
} = {}) =>
  fidelityGaps.filter((gap) => {
    if (isEngineCommandGap(gap)) {
      return !(gap.annexed === true && annexedEngineCommands.has(gap.value));
    }
    // An `unmapped` gap records that the IMPORTER of that closure stored no
    // value for the field — the information is gone from the catalog, not merely
    // unhandled by this build. A later build adding a handler cannot recover it,
    // so the gap can only be cleared by re-importing the source under the newer
    // revision (`upgradeReleaseClosure`). Were it matched against the registry
    // like an authored value, adding an entry would clear an old closure's
    // blocker and promote it as though it carried the setting.
    if (gap.value === UNMAPPED_FIELD_GAP_VALUE) return true;
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
  ANNEX_HANDLED_ENGINE_COMMANDS,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  FRONTMATTER_ENUM_TYPES,
  LOOP_BACK_RESULTS_ARTIFACT,
  PLAN_APPROVAL_ARTIFACT,
  POLICY_ENUMS,
  QUESTION_CHANNEL_OUTPUT_SUFFIX,
  RUNTIME_HANDLERS,
  SCOPE_POLICY_KEYS,
  SCOPE_RUNTIME_POLICY_KEYS,
  STAGE_POLICY_KEYS,
  STAGE_RUNTIME_POLICY_KEYS,
  UNMAPPED_FIELD_GAP_VALUE,
  capabilityFor,
  defaultWhenAbsent,
  isQuestionChannelOutput,
  planApprovalApplies,
  policyValueUninterpreted,
  protocolCapabilitiesFromEvidence,
  resolveCapabilities,
  unhandledCapabilities,
  unhonouredValues,
  unmappedFieldGaps,
};

export default {
  AIDLC_CAPABILITIES,
  ANNEX_HANDLED_ENGINE_COMMANDS,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  FRONTMATTER_ENUM_TYPES,
  LOOP_BACK_RESULTS_ARTIFACT,
  PLAN_APPROVAL_ARTIFACT,
  POLICY_ENUMS,
  QUESTION_CHANNEL_OUTPUT_SUFFIX,
  RUNTIME_HANDLERS,
  SCOPE_POLICY_KEYS,
  SCOPE_RUNTIME_POLICY_KEYS,
  STAGE_POLICY_KEYS,
  STAGE_RUNTIME_POLICY_KEYS,
  UNMAPPED_FIELD_GAP_VALUE,
  capabilityFor,
  defaultWhenAbsent,
  isQuestionChannelOutput,
  planApprovalApplies,
  policyValueUninterpreted,
  protocolCapabilitiesFromEvidence,
  resolveCapabilities,
  unhandledCapabilities,
  unhonouredValues,
  unmappedFieldGaps,
};
