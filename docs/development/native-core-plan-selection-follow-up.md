# Native AI-DLC initial plan selection: core follow-up

Status: diagnosis and proposed core fix, 2026-09-30. No upstream issue or PR has
been filed by this work. The latest upstream release and any released fix are
**unverified**. This document does not change the platform or its pinned package.

## Problem and pinned inputs

The first native Codex turn offered **1. Compose**. The user's exact reply `1`
reached the same attempt and session, but the next assistant turn contained:

```text
Unknown --result "answered". accepted outcomes: approved, completed, complete, done, awaiting-approval, rejected, revised, resume, resumed, skipped.
```

The pinned package's generic question instructions conflict with its initial
plan-selection route. This is a core routing-contract follow-up, not a reason to
teach the platform that `1` means Compose.

| Input                   | Pinned value                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| Source                  | `github:awslabs/aidlc-workflows`                                          |
| Release / target        | `v2.9.0` / `linux-arm64`                                                  |
| Source commit           | `22f5d1b15a064c9ae80046e5b1761d5877e2f69f`                                |
| Package ID              | `sha256:0399ab50fa7ed00eae5a246159fdb1d594c8fd4946c6aeb72452d9d6e2770ce0` |
| Materialization ID      | `sha256:eed746ebdc9078b8bf9217cebaad743e8f90eded8b299da8b96c99eb81bf9368` |
| Binary SHA-256          | `0863c54bfaccc695097a6e003ea405e7983e080261a327efd91335578f742ee5`        |
| Runtime archive SHA-256 | `e66e864ac4c29f30024c32cab579eea3e0142a303596d2192b1c88b4ad69b25b`        |

The local binary and archive match these protected run pins. The inspected
Codex skill and engine source also match their entries in that archive.

## Observed behavior versus local reproduction

Observed run: `cb6c2fdd-1cf7-46f3-844c-f81d223353b0`, project
`22371643-2db5-42a4-a571-e47fc35745f5`.

- Sequence 1 displayed the initial plan menu, including numbered Compose.
- The protected response ledger records exactly `1`.
- Sequence 2 retained the attempt, epoch, runtime session and native Codex
  session. Its immutable assistant message contains the error above.
- Both publications contain 16 files and no active `aidlc-state.md`. Code
  content is unchanged; only four files under `.aidlc-engine/hooks-health/`
  differ. The error is not evidence of workflow advancement or approval.
- The retained assistant-message record does **not** contain the model's live
  tool-call arguments. That the model chose `report --result answered` is a
  strong inference from the exact error, not an independently observed argv.

Source inspection and a constructed invocation confirm that the bridge passes
`response.text` into `payload.text`, then directly into the resumed harness's
stdin. It does not add `--result` or replace the reply with a lifecycle outcome.
Relevant platform paths are
[`execution-worker.js`](../../lambda/native-runtime-control/execution-worker.js),
[`executor.js`](../../lambda/agentcore/native/executor.js), and
[`execution-prepare.js`](../../lambda/agentcore/native/execution-prepare.js).

The following independent cases used the **unmodified pinned ARM64 binary**,
with networking disabled and the prepared project/package mounted read-only.
No model, composer agent, reply, or stage-advancement operation was executed.
`TASK` below denotes the exact original request passed as one argv value.

| Engine arguments after `aidlc engine orchestrate` | Result                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `next TASK`                                       | `kind: "ask"` with the initial Compose offer; no `ask_type` or `response_route`.                               |
| `report --user-input 1`                           | `kind: "error"`: a `--result` is required.                                                                     |
| `report --result answered --user-input 1`         | The exact observed error above.                                                                                |
| `next compose TASK`                               | `kind: "print"` naming composer dispatch, preserving the task, and requiring later explicit proposal approval. |

All four commands exited 0: the engine communicates these semantic errors in
the JSON directive. A normal process exit does not mean the workflow succeeded.
Separate local verification also found that substituting `completed`
fails because no active workflow state exists; this is not an alternative route.

## Conflicting core guidance

Paths and line numbers below refer to the **pinned runtime archive**, not an
assumed current upstream checkout.

| Pinned source                                                         | Relevant behavior                                                                                                                       |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/codex/.agents/skills/aidlc/SKILL.md:84`                      | The generic `ask` rule sends answers through `report --user-input`, except for named typed routes.                                      |
| `runtime/codex/.agents/skills/aidlc/question-rendering.md:156-169`    | The native renderer maps numbers to displayed options; ordinary asks return through `report`, with a typed new-work-routing exception.  |
| `runtime/codex/.codex/tools/aidlc-orchestrate.ts:1009`                | Ordinary asks contain only `kind` and `question`.                                                                                       |
| `runtime/codex/.codex/tools/aidlc-orchestrate.ts:4724-4787`           | Initial plan selection emits an ordinary ask, although the documented Compose route is `next compose TASK`.                             |
| `runtime/codex/.codex/tools/aidlc-orchestrate.ts:7400-7415,8424-8455` | `report` accepts lifecycle/resume outcomes, not `answered`; stage reporting requires existing workflow state.                           |
| `runtime/codex/.agents/skills/aidlc/SKILL.md:60`                      | A terminal `kind: "error"` must be displayed verbatim and stop. The observed stop follows this rule; it is not a transport-stop defect. |
| `runtime/codex/.agents/skills/aidlc/SKILL.md:162-180`                 | Compose dispatches a proposal, then holds a separate approve/edit/reject gate.                                                          |

The package already has the appropriate convention:
`new-work-routing` uses `response_route: "next"` and carries the original work
description; `unit-claim` uses `response_route: "claim"`. Initial plan selection
needs the same explicit distinction from stage reporting.

## Durable fix proposal in core

1. Add a closed, validated **initial-plan-selection** ask subtype covering both
   the freeform Compose offer and inferred-plan confirmation. Following the
   existing convention, declare `response_route: "next"` and retain the exact
   original task, relevant routing inputs, and any proposed scope.
2. Make core supply the displayed options or its authoritative numbered
   rendering. Core's harness renderer interprets the actual reply against
   those options. The platform retains and forwards the original reply; it
   neither hardcodes menu positions nor rewrites `1` into fabricated user text.
3. Give that subtype an explicit branch before generic ask/report guidance.
   Compose routes through native `next compose`; selecting a named plan uses
   native scope selection. Preserve the original task and applicable
   scope/depth/ceremony inputs, using argv boundaries and the documented `--`
   delimiter where needed. Ambiguous or Other responses require clarification.
4. Keep selection separate from approval. Compose authorizes preparation of a
   proposal only. Present the full proposal and stop at its human approval gate.
   Do not alias `answered` to `approved`, `completed`, or `resumed`; do not
   automatically retry terminal error directives.
5. Update the canonical core schema, engine emission, shared instructions and
   generated rendering guidance for **Claude, Codex, Kiro and OpenCode** together.
   A Codex-only wording patch would leave the same contract gap elsewhere.
6. Distribute the fix as a new, verified package/release, including a separately
   qualified fork if chosen. Do not mutate the installed 2.9.0 package or
   replace an active execution's immutable package pins. The platform remains
   a generic transport and publication layer; runtime-supplied routing metadata
   must not become independent proof of human approval.

## Acceptance tests

- With no active workflow, both initial-offer branches emit the typed route,
  exact task and valid question rendering; they perform no state transition.
- Numeric replies are interpreted against the particular displayed menu.
  Test a menu where `1` is Compose and one where `1` confirms a named plan.
- Compose produces composer dispatch and then a proposal approval stop, with
  no lifecycle report, premature workflow creation, or automatic approval.
- Named-plan, Other, ambiguous, free-text and repeated replies follow their
  documented native semantics. Existing stage gates and resume menus retain
  their own routes.
- Original task text survives newlines, quotes, shell metacharacters and
  flag-like text. Applicable initial routing settings are preserved.
- Schema validation rejects missing/blank task context, malformed rendering,
  unknown keys, an incompatible response route, and mixed stage-approval fields.
  Existing ordinary and typed asks remain compatible.
- `answered` remains invalid; accepting a menu choice does not create an
  approval/completion outcome. Terminal error directives still stop.
- Exercise the actual ask → human answer → next directive across all four
  harnesses, including numbered-prose/headless operation and same-session
  continuation. Mocked assistant text alone is insufficient qualification.
- Platform replay, stale-interaction rejection, cancellation and immutable
  publication tests continue to pass without any plan-selection special case.

## Current workaround and tracking

The user explicitly selected **Continue with explicit Compose**. The verification
agent submitted `$aidlc compose ` followed by the exact original task through the UI.
This is a new, user-authorized native command—not a fabricated replacement for
the earlier reply and not a package fix.

At the 06:53 UTC readback, sequence 3 was accepted but waiting for sequence
2's pending graph projection. The projection completed after the graph fix
was deployed (state 1167). At 07:17 UTC, a status-only check confirmed that a
cold runtime could read the committed result but could not restore an executable
harness session. The user selected
[durable session recovery](native-session-recovery-plan.md) next. Successful
composition from the saved continuation has **not** been independently verified
here. It must still stop at the proposal approval gate.

Development evidence is outside the repository:

- `/tmp/native-composer-reply-diagnosis-20260930/independent-diagnosis.json`
  records exact source lines, hashes, observations and inference limits.
- `pinned-cli-reproduction.json` and `bridge-invocation-proof.json` in that
  directory contain the unmodified-package cases and exact reply transport.
- `upstream-proposal/initial-plan-selection-reference.patch` is an **unreleased
  review prototype** against extracted Codex runtime sources, not a production
  patch or an upstream submission. Four source-level engine cases ran, but its
  schema negative test still accepts a whitespace-only task. It needs that
  correction, canonical-source integration and all-harness qualification.

No claim is made that upstream has received this issue or already released a
fix. Release discovery and any upstream filing remain separate work.
