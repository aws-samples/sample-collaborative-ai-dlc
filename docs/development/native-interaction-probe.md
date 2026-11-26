# Native interaction experiment

Updated 25 September 2026 — `feat/native-aidlc-execution`.

**Kiro's bounded interaction loop passed; shared native UI is next.**
Runtime 110 completed the first question, same-session replay, title-only Blue Lake
answer and next-question delivery. The test session is stopped. No further
backend deployment is needed for this Kiro correction. The full native pilot
remains incomplete; the next UI slice and pending isolation/rollout decisions
are described in [the UI plan](native-ui-first-slice.md).

## Runtime 110 — current Kiro verification

The user applied `/tmp/aidlc-native-kiro-prompt-dev.tfplan`. Runtime **110 READY**,
Terraform state **1118**, image tag **`15c34685dcbc7627`** and digest
`sha256:e94288d20697036bffb1668ae36d042f823635ac3e31220cee7947916c070b72`
are verified. **54 independent deployment checks passed**, including deployed
Lambda ZIP/bundle hashes, actual runtime sources, CLI versions, Tini, UID 1000,
launcher and EFS. Role, filesystem and network configuration are unchanged.
Computed runtime-version metadata remains 109; control API/source bytes identify
110. The separate source-check runtime was stopped with HTTP 200.

Probe **`996b26a8-a4ad-419e-850e-df936d2fa588`** passed four native setup commands
and **17 filesystem checks**. The first turn returned three native questions and
left all three answer fields blank. It captured the expected expanded user
prompt before Kiro started. The answer explicitly loaded the original session:
**`a038e1d3-f27e-4538-9c84-ba13d11d92f7`**, also present in both native session
stamps and intent bindings.

Both complete replay comparisons passed before the answer was sent:

- User text: **`0fa4559194bed987ecc0977d7a058ba0567462a314971aca9a48f7a2330ad13b`**
  matched the retained first-turn expectation.
- Assistant text: **`126aad37dd44076aaaf99b50a6e2d1e8cb2dc7b07fcfad763316b600b30998b5`**
  matched the first captured response.
- `session/load` acknowledged the original session, and both turns acknowledged
  the configured **`auto`** routing mode.

The question file changed only from Q1's blank field to **`[Answer]: X. Blue Lake`**.
Q2 (page purpose) and Q3 (scope confirmation) stayed blank. Kiro delivered Q2's
numbered choices and stopped for the response. Native workflow state and active
directive contents were unchanged. Both turns reached `end_turn`, exited **0**
and confirmed process cleanup. Parent first-turn review passed **15/15**;
parent and independent two-turn reviews each passed **21/21**, with no findings.
The runtime session stopped with **HTTP 200 at 06:56:50Z on 25 September**.

This closes the bounded Kiro question/answer/resume correction. It does not
qualify shared UI, authenticated approvals, execution fencing, project isolation
or cold recovery. `auto` is not a concrete underlying model identity. Native
Kiro directives still use a `sessionless` owner, and the resumed native audit
says `SESSION_STARTED` / `Source: startup` despite the explicit ACP load. Its
`HUMAN_TURN` and `QUESTION_ANSWERED` entries are synthetic bookkeeping, not
protected human authority. A first-response comment about a `question-rendering.md`
lookup fallback is an observation, not a verified missing-file diagnosis.

Evidence: [verification summary](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/verification-summary.md),
[deployment review](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/deployment-independent-review.json),
[two-turn report](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-two-turns.json),
[questions before](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-questions-before-answer.md)
and [after](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-questions-after-answer.md),
[parent review](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-two-turn-parent-review.json),
[independent review](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-two-turn-independent-review.json)
and [session stop](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-session-stop.json).

## Runtime 109 — historical Kiro ACP diagnosis

The user applied `/tmp/aidlc-native-kiro-acp-dev.tfplan`. Runtime **109 READY**,
state **1116**, tag **`97fa87bdaa1fc0d3`**, and image digest
`sha256:b5226e0ac6e823497b6c5ef9ac216637ae39405338c3e2ad47570aaf87b868b1`
are verified. **58 independent deployment checks** passed, including actual
source hashes, Kiro 2.19.2, five Lambda configurations, Tini, UID 1000 and EFS.
Terraform's computed runtime version and downstream metadata still report 108;
the control API and running source bytes identify 109. The source-check runtime
session was stopped with HTTP 200.

Probe **`6a62cf29-6368-4c51-880b-844d572963dd`** passed four setup commands
and **17 filesystem checks**. Its first turn returned the exact-title question
and wrote eight blank answer fields on EFS. ACP and the native session stamp
both identify **`e1b19d23-9254-472b-9a62-1092f4caafe6`**. Kiro acknowledged
`auto` through `session/new.models`; this proves the routing mode, not a
concrete underlying model. The turn exited 0 with confirmed cleanup.

The answer attempt explicitly loaded that same session and acknowledged `auto`
again. Eight assistant replay chunks exactly reproduced the first assistant
text (canonical SHA-256 **`a300b3ad702cef80dd60bb6a1242399ac1b7ef9cd76e68cd1b6469768e997c18`**).
The wrapper stopped at history verification with
`native_kiro_acp_history_unverified`, before `session/prompt`. It exited 1 with
confirmed cleanup. **Blue Lake was not delivered; all native artifact snapshot
contents remained unchanged, and the transcript still had only one Prompt.**

A bounded read of that exact synthetic transcript proved why: Kiro stored a
64,066-byte expanded skill. Removing the installed skill's frontmatter,
substituting both `$ARGUMENTS` slots with the original arguments and trimming
exactly reproduces the stored user text. Its canonical SHA-256 is
**`0fa4559194bed987ecc0977d7a058ba0567462a314971aca9a48f7a2330ad13b`**.
Thus the literal-command expectation is incorrect; this result does not
indicate missing conversation history. Parent reviews passed **15 first-turn
checks** and **16 failure/diagnosis checks**. The runtime session was stopped
with **HTTP 200 at 06:06:00Z on 25 September**.

The native directive still uses a `sessionless` owner. No authenticated
approval, execution fencing, cold recovery or completed two-turn loop is
qualified by this probe.

Evidence: [deployment review](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/deployment-independent-review.json),
[first turn](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-first-turn.json),
[two attempts](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-two-turns.json),
[questions](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-questions-before-answer.md),
[exact expansion comparison](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-prompt-expansion.json),
[failure review](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-failure-parent-review.json)
and [session stop](/tmp/aidlc-plan-tools/native-kiro-acp-applied-20260925/kiro-session-stop.json).

## Kiro expanded-prompt correction — applied and verified (historical plan)

The correction captures the canonical SHA-256 of the expected expanded skill
before the first model turn. The runtime retains it with the original session
and assistant hash. Resume compares the complete user replay against that
retained value; it never rereads the skill after the agent has run. Changed
instructions or extra user text fail even if they contain the same task.
Session identity, assistant replay, model acknowledgement and process cleanup
remain required. Unsupported slash forms and unsafe, oversized or changing
skill files fail before a model turn.

**385 tests across eight suites**, lint and formatting passed. The operator API
compiles. **12 independent source checks** passed. The complete ARM64 image
built and passed its checks with the actual packaged skill: its expected prompt
hash exactly matches the deployed observation. Synthetic replay succeeds despite
a later skill-file edit, and corrupted replay fails before prompting. The pinned
Kiro CLI without credentials/network fails cleanly during initialization; HTTP
health passes. These are local checks, not an authenticated answer-turn pass.

Applied plan: `/tmp/aidlc-native-kiro-prompt-dev.tfplan`, generated **25 September
at 06:12:50Z**, against state **1116**, selecting image tag **`15c34685dcbc7627`**.
It has **6 updates and 8 build-resource replacements**, with no IAM, EFS,
network or persistent-data configuration changes. All 30 inputs and Terraform
configuration match the applied ACP plan. The worker's compiled code is unchanged;
the operator API includes the three new prompt-evidence fields. Both new ZIPs
are produced during apply. Three complete Lambda environment maps are deferred
for computed image metadata, not deleted. The destruction guard, **9 parent
plan checks** and **38 independent plan checks** passed.

Plan SHA-256: `52eb620ff27eac0e4d99d922928b0bcc367b5c5fe6c81429a79185729091e2be`.
This plan has been applied and verified on runtime 110. It is historical, not
a current apply target. The completed two-turn result is recorded above;
shared native UI is the next implementation slice.

Evidence: [verification summary](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/verification-summary.md),
[source freeze](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/source-freeze.json),
[source review](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/independent-source-review.json),
[full-image checks](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/image-smoke.json),
[parent plan review](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/plan-parent-review.json)
and [independent plan review](/tmp/aidlc-plan-tools/native-kiro-prompt-20260925/independent-plan-review.json).

## Kiro ACP deployment — applied and verified (historical plan)

The native operator probe now uses Kiro 2.19.2's ACP server. It explicitly calls
`session/new` or `session/load`, verifies the acknowledged selected model, and
only then sends the fixed synthetic prompt. A failed load never falls back to
creating a new conversation. Before an answer, replay must contain the original
prompt and assistant text matching the first turn's canonical SHA-256. A replay
encoding mismatch is **unverified history**, not proof that load failed.

The original session binding, curated credential environment, EFS/local-harness
split, outer process-group cleanup and 600-second turn deadline are preserved.
Malformed protocol output, missing model acknowledgement, changed session
identity, absent history and blank assistant output fail closed. Tool permission
replies are limited to the active synthetic prompt/session; they are not human
workflow approvals. Other harness invocation arguments and the existing
project execution backend remain unchanged.

**335 tests across seven suites**, lint, formatting and **18 independent source
review checks** passed. The full ARM64 image built with the signed AI-DLC 2.9.0
fixture. An actual wrapper/process-group test completed two synthetic ACP turns
and cleaned up ordinary descendants. With no credentials/network, the actual
pinned Kiro CLI failed cleanly at initialization without prompting. HTTP health
passed. **Neither local test qualifies authenticated Kiro behavior.**

Prepared plan: `/tmp/aidlc-native-kiro-acp-dev.tfplan`, generated at
**15:14:18Z** against state **1113**, selecting image tag **`97fa87bdaa1fc0d3`**.
Plan SHA-256:

```text
b250568d76bf3db0c659b359cb30caaa580e9fca4531162eca06e0ef08b6db2d
```

The plan has **6 updates and 8 build-resource replacements**, with no IAM, EFS,
network or persistent-data changes. All 30 inputs and Terraform configuration
match the previously applied plan. The native package-worker's rebuilt code is
byte-identical to its deployed bundle. Three Lambda environment maps are
deferred for computed image metadata; they are not planned deletions.
The destruction guard, nine parent plan checks and **36 independent plan checks**
passed. Both affected Lambda bundles compile. The selected plan was regenerated
after compiling the agents API so its archive hash reflects the current bundle;
the earlier 15:04:16 candidate is superseded.

This plan has already been applied. It is historical, not a current apply target.

This is a backend deployment. Shared native UI work follows the Kiro interaction
verification.

The planned verification was to check the exact image/source/API, then run one fresh
Kiro question → title-only Blue Lake answer → follow-up loop. Require original
session load, prior prompt/assistant replay and matching model acknowledgement
before sending the answer. Inspect actual EFS artifacts and stop the runtime
session afterward. Keep the missing-session negative test in a separate ACP
process so it cannot interfere with first-session settings. No approval or real
project execution is part of this experiment.

Evidence: [verification summary](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/verification-summary.md),
[source diff](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/change.diff),
[source review](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/independent-source-review.json),
[image checks](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/image-smoke.json)
and [parent plan review](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/plan-parent-review.json),
[independent plan review](/tmp/aidlc-plan-tools/native-kiro-acp-20260924/independent-plan-review.json).

## Kiro resume identity guard — included in runtime 109 (historical checkpoint)

This earlier local checkpoint was subsequently deployed within the runtime-109 ACP adapter.

A local correction closes a probe acceptance gap: an answer could previously
return a different Kiro session ID without failing the resumed turn. Each Kiro
turn now records redacted `requestedSessionId`, `observedSessionId` and
`identitySource` evidence. Missing or mismatched answer-session identity produces
`FAILED` and `resumable: false`, while retaining the original session ID and raw
turn evidence. The operator API forwards these fields and specific failures.

The runtime/operator suites passed **192 tests**, plus lint and formatting.
Independent review passed **12 checks with no blockers**, including cancellation,
cleanup, redaction and preservation of other harness behavior. Invocation flags,
model configuration and authentication were not changed. **Matching IDs alone
still do not prove conversation-history restoration.** Kiro's requested `auto`
setting also remains distinct from observed model selection.

The pinned CLI's help and bundled V2 client expose a candidate explicit ACP
session-load path with model acknowledgement. Logged-out local experiments did
not establish an authenticated handshake or a fix. At this earlier checkpoint,
no new live Kiro execution, AWS operation or deployment had been performed. Runtime 108 did
not include it; the later runtime-109 ACP deployment does. All four harnesses
remain required for the complete pilot.

See the [verification summary](/tmp/aidlc-plan-tools/native-kiro-resume-20260924/verification-summary.md),
[source diff](/tmp/aidlc-plan-tools/native-kiro-resume-20260924/reporting-guard/change.diff)
and [independent review](/tmp/aidlc-plan-tools/native-kiro-resume-20260924/reporting-guard/independent-review.json).

## Runtime 108 — historical verification

The user applied `/tmp/aidlc-native-sessionend-dev.tfplan`. Saved evidence confirms
**108 READY**, Terraform state **1113**, image tag **`b8093b6cda50899e`**, and digest
`sha256:5625e1b29ba228593851f2ca90b763a6c2084ca970bfad5bf7b658445e54e780`.
Independent deployment review passed **25/25 checks**. Actual source hashes
match the frozen SessionEnd correction (`interaction-probe.js`: `b95f3916...`).
Claude **2.1.257**, Codex **0.145.0**, both Codex start/resume overrides, Tini,
UID 1000, the launcher and `/mnt/native` NFS were verified. All four affected
Lambda code/environment comparisons passed; IAM, EFS, network configuration
and the existing `/mnt/workspace` mount remain unchanged.

**Metadata caveat:** Terraform's computed runtime version and
intents/environment-control `CORE_RUNTIME_VERSION` remain **107**, while the
control API reports **108 READY**. Image metadata matches the deployed image;
do not infer that version-pinned consumers select 108 from those records.

Claude probe **`f4b6d405-4e6e-4430-8716-b925d31f6383`** passed **four setup
commands/16 checks**, and the exact generated SessionEnd **`timeout: 30`** was
observed. Both turns passed the scoped question → answer → follow-up experiment:
the first title question left Q1–Q4 blank; the answer recorded only
**`[Answer]: X. Other - Blue Lake`** in Q1, left Q2–Q4 blank and returned the
choice of how to answer the remaining questions. Both structured and native
records identify session **`677c3f28-eb23-4027-b809-20154cdcb0e9`**, bound to
intent UUID **`01a0d366-41e9-7684-8d54-2148e9b09920`**.

Both turns exited **0** with confirmed cleanup. Native `session-end.last`
advanced from **12:37:18Z** to **12:39:45Z**, and `SESSION_ENDED` records in the
bound intent's audit increased from **1 to 2**. No end-hook cancellation or
drop was recorded. `SESSION_RESUMED` at **12:38:30Z** records `Source: resume`
and the same session ID. The end records themselves have no session field;
their attribution follows the matching native session stamp and intent binding.
The runtime session was stopped with **HTTP 200 at
12:40:53Z**. This supersedes runtime 107's cancelled SessionEnd result.
The parent evidence review passed **16/16 assertions**; independent two-turn
review passed **37/37 checks**, with no high-priority findings. It confirmed the
title-only question-file change and unchanged native state/active directive.
Separate `continue-workflow.drops` entries record expected pending-question
handling; they are not SessionEnd failures.

The warning about **nine ignored permission-allow entries persists on both
turns**. CLI-reported turn durations of **393,779 ms** and **70,366 ms** are
observations from this run, not performance qualification or an isolated
measurement of filesystem overhead.
Shared native UI/start/answer routing, isolated authenticated approvals,
execution checkpoints/cold recovery and project isolation remain open.
Kiro conversation-history resume/exact model fidelity and full all-four
qualification remain open. No approval, shared UI or cold recovery is claimed.
Native `HUMAN_TURN` bookkeeping does not prove authenticated human approval.

Evidence is under `/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/`:
[verification summary](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/verification-summary.md),
[two-turn report](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-two-turns.json),
[extracted evidence](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-two-turns-extracted.json),
[parent evidence review](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-parent-review.json),
[independent two-turn review](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-independent-review.json),
[questions before](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-title-question-before-answer.md)
and [after](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-title-question-after-answer.md),
[audit before](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-native-audit-before-answer.md)
and [after](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-native-audit-after-answer.md),
[session stop](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/claude-session-stop.json),
[independent deployment review](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/deployment-independent-review.json),
`live-source-and-mount.json`, `live-source-review.json`, `runtime.json`,
`state.json`, `image.json` and the four Lambda configuration files.
Raw state/runtime evidence contains private environment data.

## Runtime 107 — historical interaction results

The user applied `/tmp/aidlc-native-cli-compat-dev.tfplan`. Saved control API
evidence confirms **107 READY**, Terraform state **1111**, and image tag
**`7020eeb9b852efb2`**, digest
`sha256:08e84b0951075fb7e1e9fb0fed44c80232f6e7c210dd5a4eb3b135b60340a43c`.
Independent deployment review passed **25/25 checks**. Actual runtime hashes
match the CLI compatibility image's sources; Claude **2.1.257**, Codex **0.145.0**, both Codex
question-tool overrides on start/resume, Tini, UID 1000 and `/mnt/native` NFS
were verified. All four affected Lambda configurations/code hashes match state
and local archives. `/mnt/workspace`, IAM, EFS and network configuration remain
unchanged.

At that deployment, Terraform's computed runtime version and
`CORE_RUNTIME_VERSION` in intents/environment-control remained **106**, while
the control API reported **107 READY** with the correct image digest.

### Claude/Codex verification — historical runtime-107 snapshot

| Harness | Observation on runtime 107 | Qualification remaining |
| --- | --- | --- |
| Claude | Four setup commands/16 checks passed; title question, Blue Lake answer and follow-up choice returned in the same structured/native session. Both turns exit 0 with cleanup; Q2–Q4 blank | SessionEnd cancellation subsequently resolved on runtime 108; ignored permission entries and broader pilot qualification remain open |
| Codex | Four setup commands/18 checks passed; title question, Blue Lake answer and follow-up choice returned in the same structured/native session. Both turns exit 0 with cleanup; Q2–Q5 blank; prior unsupported-tool error absent | Broader native integration, approval and recovery qualification |

Claude's first question returned at **11:35:34Z** with Q1–Q4 blank. Both turns'
structured events and native session identify
**`d3b99e9d-c611-4ef2-b691-6eab363a64fe`**. The answer records only **Blue Lake**
in Q1, leaves Q2–Q4 blank and returns the choice of how to answer the remaining
questions. Both turns exit 0 with confirmed cleanup. This passes the scoped
question → answer → follow-up experiment and resolves the API version blocker.
The runtime session was stopped with HTTP 200 at **11:38:29Z**.
Independent Claude evidence review passed **20/20 checks**.

Nine ignored project permission-allow entries and a cancelled SessionEnd hook
were recorded in **both runtime-107 turns'** diagnostics. Runtime 108 subsequently
verified native SessionEnd completion without cancellation; the permission
warning and broader Claude qualification remain open.

Claude evidence:
[two-turn report](/tmp/aidlc-plan-tools/native-compat-live-20260924/claude-two-turns.json),
[review](/tmp/aidlc-plan-tools/native-compat-live-20260924/claude-two-turn-review.json),
[native questions before](/tmp/aidlc-plan-tools/native-compat-live-20260924/claude-title-question-before-answer.md)
and [after the answer](/tmp/aidlc-plan-tools/native-compat-live-20260924/claude-title-question-after-answer.md).

Codex probe **`44b42576-67bc-4f79-856c-a0280671ada1`** started at **11:38:34Z**
and completed its answer turn by the **11:57:34Z** poll. It first returned the
title question with Q1 blank, then recorded **`[Answer]: Blue Lake`**, added
Q2–Q5 with blank answers, and returned the native follow-up choice. Both turns
exited 0 with confirmed cleanup. Full retained CLI output contains
`thread.started` with **`01a0d338-cc30-7150-ae9b-62b1fd1470ac`** on both turns;
the native current-session and Codex hook records agree. The previous
unsupported `request_user_input` error is absent. Existing project-provider
configuration and hook-trust notices remain recorded. The runtime session was
stopped with HTTP 200 at **11:58:50Z**. Both runtime-107 model sessions are stopped.
Independent Codex evidence review passed **24/24 checks**.

Runtime-107 initialization totals **8 commands/34 filesystem checks**. Codex
command timing samples span roughly **25–48 seconds**; this is observed
command/hook overhead, not a measurement isolating EFS as its cause.

Codex evidence:
[two-turn review](/tmp/aidlc-plan-tools/native-compat-live-20260924/codex-two-turn-review.json),
[native questions before](/tmp/aidlc-plan-tools/native-compat-live-20260924/codex-title-question-before-answer.md),
[after the answer](/tmp/aidlc-plan-tools/native-compat-live-20260924/codex-title-question-after-answer.md)
and `codex-lifecycle-evidence.json`.

Shared native UI/start/answer routing, isolated authenticated approvals,
execution checkpoints/cold recovery, and project isolation remain open.
Kiro conversation-history resume and exact model fidelity remain unqualified;
its flags are unchanged. Recovery needs the V2 session metadata `.json` files
alongside `.jsonl` logs and compaction records; the legacy SQLite-only helper
does not cover this store. Earlier metadata scans omitted UUID-named `.json`
files, so their absence was not established.

Evidence under `/tmp/aidlc-plan-tools/native-compat-live-20260924/`:
[independent deployment review](/tmp/aidlc-plan-tools/native-compat-live-20260924/deployment-independent-review.json),
`runtime.json`, `state.json`, `image.json`, the four Lambda configuration files,
`live-source-and-mount.json` and `live-source-review.json`.
Raw state/runtime evidence contains private environment data.

## SessionEnd timeout correction — applied and verified (historical)

The user applied **`/tmp/aidlc-native-sessionend-dev.tfplan`**, generated at
**11:54:35Z** against state **1111**, selecting image tag **`b8093b6cda50899e`**.
Runtime **108 READY** and state **1113** passed **25/25 independent deployment
checks**. This plan is historical; there is no current apply target. Plan SHA-256:

```text
0d5d2ecb6c34d3c953e63b4e81ea2864dafa9c856add8ea289f03d9f78a4958d
```

The correction sets `timeout: 30` only when the exact existing
`aidlc engine hook session-end` command lacks a timeout in the generated
Claude project settings. Explicit timeouts, other settings, signed package
files, trust, models and the model-turn deadline are preserved. Missing or
ambiguous hooks and unsafe settings paths fail before Claude starts.

The pinned CLI's default 1,500 ms timeout and a credential-free slow-hook
reproduction support the cancellation diagnosis. An outer environment timeout
alone did not fix it. The full new ARM64 image passed real native initialization
for both default/explicit cases, then actual Claude `--init-only` completed
seven-second synthetic SessionEnd hooks without cancellation. The default became
30 seconds; explicit 10 seconds remained byte-for-byte unchanged. UID 1000,
Tini, HTTP health, frozen source hashes, signed assets and cleanup passed.
That local smoke did not verify real native SessionEnd audit writes on EFS;
the subsequent runtime-108 two-turn test now supplies that evidence.

All **130 runtime tests**, Terraform validation, the destruction guard,
**18 independent code-review checks** and **9 parent plan checks** passed.
The plan has **5 updates and 5 build-resource replacements** (Terraform:
5 add, 5 change, 5 destroy), with no IAM, EFS, networking or persistent
application resource changes. All 30 inputs and Terraform configuration match
the applied compatibility plan. The fresh package-worker bundle is byte-identical
to the deployed bundle. Existing superseded registry-image cleanup is retained.
Independent plan review passed **23/23 checks**, including binary-plan/JSON
agreement, expected resource scope and preserved configuration.

The runtime correction required no frontend deployment. Actual image/source
verification and the Claude two-turn/native end-hook test are complete; see the
[historical checkpoint](#runtime-108--historical-verification). No further deployment
is required for this correction.
The separate trust warning and other pilot gaps remain open.

Evidence:
[offline full-image smoke](/tmp/aidlc-plan-tools/native-sessionend-smoke-20260924/result.json),
[timeout diagnosis](/tmp/aidlc-plan-tools/native-compat-live-20260924/claude-sessionend-offline-review.json),
[code review](/tmp/aidlc-plan-tools/native-compat-live-20260924/sessionend-code-independent-review.json),
[parent plan review](/tmp/aidlc-plan-tools/native-compat-live-20260924/sessionend-plan-review.json),
[independent plan review](/tmp/aidlc-plan-tools/native-compat-live-20260924/sessionend-plan-independent-review.json)
and `sessionend-worker-bundle-review.json`.

## Runtime 106 — historical interaction results

Verification at **10:01:12Z** on 24 September confirmed runtime **106 READY**,
Terraform state **1108**, and image
`sha256:59d8f47b1f0a4bc11668b90cf5bf254c2dc4ad4178904c29ba1d1d27910c8d29`.
All deployment checks passed, including actual source hashes, Tini/user identity,
local-home placement, launcher, EFS mount and dependent Lambda updates.

All four runtime-106 probes passed initialization: **16 commands and 67
filesystem checks** (Codex 18, Claude 16, Kiro 17, OpenCode 16). Each probe ran
its own four setup commands; the earlier shared-install diagnostic used 13.

| Harness | Live result | Qualification still open |
| --- | --- | --- |
| Codex | Title question returned; Blue Lake recorded in the same native session; both turns exit 0 with cleanup | Next-question delivery failed on runtime 106; runtime-107 overrides subsequently passed the scoped interaction experiment |
| Claude | Four setup commands/16 checks passed; API 400 rejects CLI 2.1.246; exit 1 with cleanup, no model response | Runtime-107 upgrade/scoped interaction and runtime-108 SessionEnd completion subsequently passed; permission warnings and broader qualification remain |
| Kiro | Title question, Blue Lake answer and next Q2/Q3 returned through the same native question file; both turns exit 0 with cleanup | Conversation-history resume and exact model fidelity |
| OpenCode | Title question returned; Blue Lake recorded; follow-up question returned in the same native and structured-event session; both turns exit 0 with cleanup and empty diagnostics | Shared application integration, human approval and cold recovery |

Codex probe `ca7072b4-5d4a-4011-90a7-2e6123a984d1` returned the ordinary title
question with a blank native Q1. The separately submitted answer resumed the
same native session and recorded **`[Answer]: X. Blue Lake`**. It added Q2–Q4
with blank answers, but `request_user_input` was unsupported in exec mode:
the next questions were not successfully delivered. `ANSWER_TURN_FINISHED`,
exit 0 and `cleanupComplete=true` on both turns therefore establish only this
partial result, not full Codex qualification, human approval or cold recovery.
The runtime session was stopped with HTTP 200 at **10:20:50Z**.

After both turns ended, the credential-free diagnostic measured **6.918 ms**
for the direct login shell versus **6,534.280 ms** for the bind-hook path.
Session/pin metadata stayed unchanged and the diagnostic cache/home were removed.
This isolates substantial hook-path overhead, not EFS causality. Its first
attempt failed during module loading and produced no measurements; the successful
retry used a `file:///` import for data-URL transport. Storage placement is unchanged.

Kiro recorded **`[Answer]: A. Blue Lake`**, left Q2/Q3 blank and returned those
questions. However, native session IDs changed from `ad2d4ad5...` to `e96470cc...`;
two separate `.kiro/sessions/cli/*.jsonl` conversation logs exist, while the
legacy SQLite store is empty. This qualifies file-based continuation, not loaded
conversation history. The requested `auto` model selection logged
`MethodNotFound`; exact model fidelity is unqualified. The session was stopped
with HTTP 200 at **10:48:49Z**. Independent review found no evidence that adding
`--resume` to `--resume-id` would fix this; Kiro flags remain unchanged.

Claude's API required version **2.1.255 or newer**. The compatibility image pins
**2.1.257**, the smallest published npm release meeting that minimum; 2.1.255
is unavailable. Its live diagnostics also recorded nine ignored project
permission-allow entries and a cancelled SessionEnd hook. Offline startup hooks
passed with and without a fixture trust entry, so the warning alone does not
establish a hook blocker. The version fix and both Codex overrides were
subsequently deployed and verified on runtime 107, as recorded above.

OpenCode probe `130630fd-735e-4ea9-a4ba-a165bd74f356` completed its answer turn
by the **11:06:09Z** poll. It asked the title question, recorded
**`[Answer]: X. Other: Blue Lake`**, left Q2–Q4 blank, and returned the native
choice of how to answer the remaining questions. Both turns exited 0 with
confirmed cleanup and empty diagnostics. Their structured stdout events and
native `.current-session` all identify **`ses_f2cf455cdffenpsQK2rQuqQHVQ`**.
Independent evidence review passed **20/20 checks**; the binding retained the
same space and intent while its `boundAt` timestamp refreshed for the answer turn.
This passes the scoped question → answer → follow-up experiment. The runtime
session was stopped with HTTP 200 at **11:06:54Z**; all four runtime-106 disposable
sessions were stopped. No human approval, full all-four qualification or cold recovery
is claimed.

Evidence under `/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/`:
`deployment-review.json`, `codex-two-turns.json`,
`codex-title-question-before-answer.md`, `codex-title-question-after-answer.md`,
`codex-session-stop.json`, `latency-diagnostic-result-2.json` and `latency-review.json`.
The native question artifacts are directly reviewable:
[Codex before](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/codex-title-question-before-answer.md),
[Codex after](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/codex-title-question-after-answer.md),
[Kiro before](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/kiro-title-question-before-answer.md),
[Kiro after](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/kiro-title-question-after-answer.md),
[OpenCode before](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/opencode-title-question-before-answer.md)
and [OpenCode after](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/opencode-title-question-after-answer.md).
Additional reviews: `kiro-two-turn-review.json`, `kiro-resume-independent-review.json`,
`kiro-session-stop.json`, `claude-latest.json`, `claude-upgrade-review.json`,
`opencode-two-turns.json`, `opencode-two-turn-review.json`, `opencode-independent-review.json`
and `opencode-session-stop.json`. Raw runtime evidence remains private.

## Scope

The user selected the existing dev AgentCore. Model credentials stay in AWS.
The experiment uses the existing agents Lambda's direct IAM invocation, with
no API Gateway route or simulated Cognito/member identity. A distinct
`native-probe` grant authorizes one platform credential for a UUID-scoped
disposable run. Status and cancel require no model credential, broker call or
SSM read. The runtime never receives the grant in its command handler or child
environment.

The fixture is the exact public `awslabs/aidlc-workflows` v2.9.0 package from the
successful import, commit `22f5d1b15a064c9ae80046e5b1761d5877e2f69f`.
The image build verifies all five original files against their pinned sizes
and SHA-256 hashes, verifies the GitHub attestation, and includes the package.
This is a fixed diagnostic fixture, separate from the application's configurable
workflow-source selection. It adds no AgentCore package-bucket permissions.

`enable_native_interaction_probe` defaults false and is restricted to dev.
Managed runtime environments explicitly disable it and reject recipe overrides.
No project execution, real approval, repository push, deployment or production
native backend is created by these commands.

## What to observe

1. Start one harness using a fresh UUID. The runtime installs/configures the real
   native files in its disposable workspace and launches the fixed task.
2. Poll status. Inspect the actual assistant question, native intent files,
   hook-health/audit records and session-binding records. A successful process
   exit alone is not a successful native interaction.
3. Only after observing the title question, submit `answer`. It sends the fixed
   text choosing **Blue Lake**, explicitly without approving a plan or gate.
4. Inspect the second turn: same native harness session, updated native intent
   artifact and the next question/gate. Repeat serially for Claude, Codex, Kiro
   and OpenCode.

The first fixture requests a free-text clarification. Structured question
callbacks, authenticated collaborative approval authority, cold recovery,
private/provider qualification and product UI integration remain separate work.
Native audit events from this synthetic fixture do not prove a human approved
anything.

## Operator commands

For a fresh, approved serial experiment, from the repository root:

```sh
node scripts/native-interaction-probe.mjs \
  --profile solution --expected-account 746558295630 \
  --action start --harness codex
```

Retain the returned `probeId`. Use the same profile/account/harness and
`--probe-id <returned UUID>` with `--action status`, `--action answer`, or
`--action cancel`. Each invocation writes its full returned evidence to a
private temporary file and prints its path. The script never polls, answers or
deploys automatically.

`FIRST_TURN_FINISHED` permits the single answer only after evidence has been
saved. `ANSWER_TURN_FINISHED` means the second CLI invocation ended; it does not
mean the native workflow is complete. An unconfirmed process cleanup makes the
runtime unusable for further work and stops all filesystem inspection/writes.
Discard that disposable runtime rather than attempting recovery.

Native artifacts and redacted CLI evidence remain under
`<native-workspace>/native-interaction-probes/<UUID>/`. The default is
`/mnt/workspace`; the optional dev EFS test configures `/mnt/native` and requires
a verified writable NFS mount there. CLI homes are ephemeral.
A cold process deliberately refuses to resume from these diagnostic files;
production checkpoint recovery is not implemented by this probe.

The attended test has a ten-minute maximum per model turn, bounded captured
output, one active turn per session, and at most one submitted answer. Claude's
test invocation additionally stops after twelve agent turns. These are
diagnostic settings, not the native pilot's eventual execution policy.

## Local evidence

- All four harnesses passed the real image's native setup: four commands per
  harness and filesystem validation. Model commands were intentionally withheld.
  The Kiro recheck distinguishes its session-list command from a model call.
- The final Linux ARM64 image built successfully with real package signature
  verification. Its actual HTTP server returned healthy and served the probe's
  credential-free status contract with networking disabled.
- 212 focused control/auth/runtime/broker tests pass, including duplicate-start
  races, credential rotation/redaction, linked artifact rejection, uncertain
  cleanup, evidence-finalization races and oversized serialized responses.
- Another 53 managed-environment tests pass, including nine new cases blocking
  the probe flag in recipes, published tools and inherited base snapshots.
- Backend workspace builds, targeted lint/format checks and Terraform validation
  passed. Terraform reported the two existing DynamoDB key deprecation warnings.

Evidence is under `/tmp/aidlc-plan-tools/`, particularly:

- `native-interaction-local-20260923/`
- `native-interaction-final-tests-20260923.log`
- `native-interaction-final-image-20260923.log`
- `native-interaction-image-contract-20260923.json`

## Partial deployment and recovery

The 23 September plan `/tmp/aidlc-native-interaction-dev.tfplan` must not be
reused. The user applied it on 24 September. Its embedded AgentCore registry
token expired at `2026-09-24T00:47:29Z`; the image push failed after other
resources had completed. The subsequent retry correctly failed with
`Saved plan is stale`.

Read-only state inspection found serial **1095**, **18 completed Lambda
updates**, both new local configuration guards, and the new locally built image.
AgentCore still pointed at runtime version **102** and the previous image;
the operator Lambda had not yet received its new code or probe flag.
No model-driven native run was attempted against this mixed deployment.

The repository now configures all three Docker providers with a registry-specific
`ecr-login` credential helper instead of `aws_ecr_authorization_token` data.
The provider resolves credentials separately in the plan and apply processes.
Explicit empty `username`/`password` suppress generic
`DOCKER_REGISTRY_USER`/`DOCKER_REGISTRY_PASS` overrides, which provider 3.9.0
otherwise prioritizes over the helper. This does not change user Docker config,
image tags, IAM permissions, Terraform's minimum version, or resource addresses.
The deployment scripts check that the helper exists; the managed installer and
CI deployment prerequisites also include it.

Verification on 24 September:

- **47 deployment-tool tests passed**, including missing-helper checks before
  any Terraform or AWS calls.
- Terraform validation passed with zero errors and the two existing DynamoDB
  attribute deprecation warnings.
- The installed ECR helper obtained credentials using the verified `solution`
  Admin profile in account `746558295630`, with its disk cache disabled. No
  credential was printed or registry image pushed.
- A local Terraform 1.16.3 / Docker provider 3.9.0 saved-plan experiment invoked
  the helper once during planning and again during application of the exact
  unchanged plan. Different canary credentials were absent from the plan's raw
  bytes, ZIP members and rendered JSON. The only managed object was a local
  `terraform_data` record; a filtering Docker socket allowed local image reads.
  There were no AWS calls or registry/build/push operations.
- A negative control reproduced generic registry environment variables bypassing
  the helper. Explicit empty credentials restored both helper invocations even
  with stale generic environment values present.

The applied recovery plan was `/tmp/aidlc-native-interaction-recovery-dev.tfplan`.
It was regenerated on 24 September at **06:35:22Z** with Terraform 1.16.3 and
the `solution` profile, against state serial **1095**. All **16 recovery review
checks passed**, including the original variable selections, exact agreement
with the reviewed remaining resource changes, and all seven Lambda bundle hashes.
Its SHA-256 is:

```text
58882b8a0ff7c42b639719a665f93401e37a60308910acd1a17adb1513c314b1
```

It completes the seven remaining Lambda updates, AgentCore image publication and
runtime update, and the orchestrator alias. Cleanup removes the superseded local
image, old registry image and deposed packaging records. It does not delete
persistent application resources, add IAM grants or expose public routes.

The core runtime and operator Lambda enable the probe; managed runtimes disable
it. New image digests, runtime versions and dependent environment maps need
deployed verification afterward. The original 23 September review remains
historical evidence, not an apply target.

Historical deployment command (already applied; do not rerun):

```sh
AWS_PROFILE=solution terraform -chdir=terraform apply /tmp/aidlc-native-interaction-recovery-dev.tfplan
```

No frontend deployment or workflow-baseline reseed was part of this step.
The resulting runtime/image/Lambda verification is recorded below.

Recovery evidence is under `/tmp/aidlc-plan-tools/`:

- `native-interaction-partial-state-20260924.json` (private)
- `ecr-auth-release-tests-20260924.log`
- `ecr-auth-terraform-validate-20260924.json`
- `ecr-auth-terraform-final-validate-20260924.json`
- `ecr-auth-lifecycle-20260924/evidence/summary.json`
- `ecr-auth-lifecycle-20260924/env-empty/evidence/summary.json`
- `ecr-auth-lifecycle-20260924/env-omit/evidence/summary.json`
- `native-interaction-recovery-plan-review-20260924.json`
- `native-interaction-recovery-final-plan-20260924.json` (private)

The credential resolution behavior was checked against
[Docker provider 3.9.0 source](https://github.com/kreuzwerker/terraform-provider-docker/blob/v3.9.0/internal/provider/provider.go)
and the [AWS ECR credential helper documentation](https://github.com/awslabs/amazon-ecr-credential-helper).
Credentials are held for one Terraform invocation; an individual apply lasting
beyond the ECR token's 12-hour lifetime can still require replanning and retry.
An expired underlying AWS login must also be renewed.

## Live verification and filesystem result — 24 September

The user applied the recovery plan. Independent reads verified:

- AgentCore runtime **103** is **READY**, with probe flag `true` and image digest
  `sha256:d4427009746b9f7246cda03cfc728e5c4c5e7d09092e0fc7d73a404d21e6777c`.
  The ECR tag `66cc61c434545530` resolves to the same digest.
- All seven remaining Lambda functions are active, have successful updates, and
  have code hashes matching the reviewed plan. The operator Lambda enables the
  probe; managed-runtime configuration sets the flag to `false`.
- Terraform state is serial **1098** with no remaining deposed records.

The first operator invocation used Codex, probe
`3436ab4f-3002-4692-8cfb-8e053c053d0a`. It was accepted and initialized, then
failed in `aidlc use` before the model command. The native installer creates its
transaction lock with a hard link. AgentCore's `/mnt/workspace` session mount
rejected that operation with errno `-524`.

The existing runtime command API allowed direct, bounded diagnostics in that
disposable session without deploying changes or accessing model credentials.
Synthetic filesystem checks verified hard-link, symlink and rename operations
under `/tmp`; the persistent mount supported symlink and rename but rejected
hard links. Synthetic filesystem-check files were removed after the check.

The actual signed v2.9.0 package was then tested in two layouts, rechecking all
five package assets against the pinned byte sizes and SHA-256 hashes:

| Layout | Observed result |
| --- | --- |
| Installation and project on the persistent mount | Original operator probe fails in `aidlc use` |
| Installation on local disk, project on the persistent mount | `aidlc use` succeeds; project `config --pin` fails on the same hard-link lock for all four harnesses |
| Installation and projects on local disk | Shared installation plus all four harness initializations succeed: 13 commands and 67 filesystem checks |

The successful configuration counts are Codex **18**, Claude **16**, Kiro **17**
and OpenCode **16** filesystem checks. These are actual AgentCore results, not
local Docker simulations. Generated harness files and native project state are
normal filesystem files. **No model command, real question, answer, approval or
cold recovery has run.** The runtime PATH warning still requires verification
when the actual harness starts.

**D19 update:** the user explicitly excluded EC2 and proposed keeping harnesses
on AgentCore local disk while moving native AI-DLC installation, workflow files
and code to an EFS working directory. The
[persistent storage assessment](native-storage-options.md) now follows that
split. Active harness homes/databases remain local, avoiding the SQLite WAL/NFS
conflict; consistent recovery exports go to durable storage. Existing store
helpers provide a starting point, but this native probe does not yet use them
for cold recovery.

The user deployed the EFS retry. Runtime **104** is READY with both mounts and
the existing scoped discovery policy. Live EFS hard links, symlinks, rename,
executable permissions and a **1 GiB + 8 MiB** write/sync/readback passed with
matching checksums and cleanup. Our guard rejected AgentCore's valid backing
overlay plus EFS mount at the same path; the correction identifies the active
mount using the path's device ID. Signed native setup also passed on EFS for
all four harnesses (13 commands, 67 checks). Installation took 137 seconds,
so setup commands now have 300 seconds while model-turn limits stay unchanged.
Both corrections were deployed and verified at runtime **105**. See the
[EFS verification checkpoint](native-efs-probe-checkpoint.md), the runtime-105
history below and the current runtime-106 result above. Full two-turn interaction
and stop/resume across the four harnesses remain open. Project isolation and
one-writer ownership must be qualified before using real project data. Complete
recovery inventory and protected human actions remain required before claiming
pilot recovery; an artifact-only export is insufficient.

Evidence is under `/tmp/aidlc-plan-tools/native-interaction-live-20260924/`:

- `deployment-verification.json`
- `codex-first-status.json`
- `filesystem-capabilities-command.json`
- `ephemeral-machine-setup-result.json`
- `ephemeral-workspace-setup-result.json`
- `filesystem-investigation-summary.json`

## First native Codex model run — runtime 105

The deployment was independently verified at **09:02:15Z** on 24 September:
runtime **105 READY**, Terraform state **1105**, image tag `c5bcef5101df9be9`,
digest `sha256:59714fd45d9cf7e7f2aa85b68b558b532a4a95adf2ee3101c54a1589549064ae`.
All four updated Lambda functions had successful updates and matching code
hashes/environment maps. The actual container contained both reviewed source
hashes and its EFS mount check passed.

Codex probe `092774ba-48fe-4834-abe0-772701c38204` used the configured
`openai.gpt-5.6-sol` model. All four setup commands and 18 filesystem checks
passed. The harness then ran the native POC workflow, created an intent, wrote
hook-health/session records and authored
`aidlc/spaces/default/intents/260924-local-html-page/ideation/intent-capture/intent-capture-questions.md`.
Its first question asks for the exact page title; all answer fields remain blank.

The model turn reached its **600-second deadline** while finishing native
records. It did not return a final question response. The runner sent SIGKILL;
the report marked cleanup incomplete and refused continuation. A process-only
inspection found the Codex process and two `aidlc` children in state **Z**,
adopted by the application's PID 1. No live CLI worker was present in that
inspection. The application was not reaping those orphaned children, so the
process-group absence check could not succeed.

The failed disposable session was terminated with `StopRuntimeSession`
(HTTP 200 at **09:17:43Z**, request
`190042ae-c34a-4f33-9703-170eb1c6551d`). A fresh credential-free diagnostic session
read the EFS artifacts without resuming the run and was also terminated.
The native questions, state and audit files persisted. This proves file
persistence across session termination; it does not prove native cold recovery.
No answer or approval was submitted.

### Corrections based on observed behavior

- **Shell lookup:** the live transcript reports `aidlc` missing from PATH.
  A Linux test reproduced Bash `-lc` dropping the runtime's custom PATH prefix.
  A dev-only `/usr/local/bin/aidlc` launcher delegates to the installation selected
  by `AIDLC_BIN_DIR`. Tests verify lookup, argument preservation and rejection
  of missing, relative or self-referencing targets.
- **Local harness home:** Codex refused to create its helper binaries beneath
  `/tmp`. Active homes now use `/home/node/.native-probe-homes`, still on local
  disk. The pinned Codex binary reproduced the warning under `/tmp` and omitted
  it under the new path; both checks ran without networking and stopped at an
  intentionally invalid provider before any model request.
- **Process reaping:** Tini now starts the application and reaps orphaned
  descendants. The previous image reproduced incomplete cleanup after normal
  exit and timeout; the new image passed both cases with the process group gone.
  The runner's strict process-group cleanup check remains.
- **Evidence filtering:** native AI-DLC places an internal `steering-token-key`
  beside intent records. Its content is omitted from snapshots while ordinary
  intent artifacts remain available. The post-termination diagnostic exported
  only metadata for non-Markdown files.

The model deadline remains ten minutes. These fixes address observed failures;
they do not establish that the next turn will finish within that deadline.
Sample transcript events show shell calls taking roughly 24–25 seconds, but the
cause of that latency had not been isolated. At this checkpoint, question return
and answer continuation still needed live evidence. The runtime-106 result above
records subsequent progress and the remaining delivery limitation.

Evidence is under `/tmp/aidlc-plan-tools/native-model-verify-20260924/`:
`deployment-review.json`, `live-source-and-mount.json`, `codex-failed.json`,
`codex-command-evidence.json`, `codex-processes-after-timeout.json`,
`codex-stop-session.json`, `codex-durable-artifacts.json`,
`codex-intent-capture-questions.md`, `path-launcher-proof.json` and
`codex-home-proof.json`.

### Runtime correction plan — applied (historical)

The user applied `/tmp/aidlc-native-shell-reaper-dev.tfplan`; do not reuse it.
The historical plan was generated with a full AWS refresh at **09:35:02Z**
on 24 September, against state serial **1105**.
Its SHA-256 is:

```text
1b505d34341bb1d8ccf55c7d7ac2e5739fe7996c5a43b90b211694025898a251
```

The review found **5 additions, 5 in-place changes and 5 replacement deletions**:

- Replace the local Docker image and its registry image, then update AgentCore
  to the new image. The source tag is `9b9680da0344656e`.
- Update dependent image/runtime metadata in the intents, environment-control
  and tool-control Lambda functions.
- Rebuild the native-package-worker archive and update its Lambda. The fresh
  compiled bundle is byte-for-byte identical to the deployed archive; the
  shared native source fingerprint triggers this packaging work.
- Replace three local worker packaging records. Together with the two Docker
  replacements, these account for all five deletions.

There are no planned IAM, EFS, network or persistent application resource
changes. Input selections and Terraform configuration match the previous
applied plan. The refresh records EFS usage, runtime version/timestamp and
Docker option default normalization; these are not additional deployment
actions. Existing `keep_remotely=false` behavior still removes the superseded
registry image. The new image digest, runtime version and dependent Lambda
environment maps were subsequently verified at runtime 106.

Validation completed before application:

- **116 focused tests passed**, covering the native probe, EFS guard, strict
  process cleanup and HTTP server. Targeted lint/format and whitespace checks
  passed.
- The full Linux ARM64 image built with the signed AI-DLC fixture. Its actual
  entrypoint returned HTTP 200 Healthy as UID 1000, forwarded termination,
  and reaped child processes after both normal exit and timeout.
- The installed launcher ran the pinned **AI-DLC 2.9.0** binary through a Bash
  login shell. The image's four relevant source hashes matched the tested
  files. These container checks used no model calls.
- Terraform validation passed. The plan's destruction guard, all nine focused
  plan/bundle checks and all 23 independent review checks passed. Existing
  warnings remain for the stale `yjs_scaling` input and two DynamoDB key
  deprecations.

Historical deployment command (already applied; do not rerun):

```sh
AWS_PROFILE=solution terraform -chdir=terraform apply /tmp/aidlc-native-shell-reaper-dev.tfplan
```

This plan and the older recovery/EFS plans are applied historical evidence.
No frontend deployment was required. The runtime-106 section above records the
verified deployment and two-turn Codex result. Both the runtime-105 and
runtime-106 Codex sessions were terminated and must not be resumed.

Additional evidence in the same directory:
`runtime-tests-final.log`, `reaper-summary.json`,
`runtime-fix-image-build.log`, `runtime-fix-image-smoke.json`,
`runtime-fix-source-launcher-check.json`, `runtime-fix-plan-review.json`
and `runtime-fix-independent-review.json`, plus `runtime-fix-plan.json`
(private full plan).

## CLI compatibility deployment — applied and verified (historical)

The user applied `/tmp/aidlc-native-cli-compat-dev.tfplan`,
generated on 24 September at **10:33:57Z** against state serial **1108**.
It selected image tag **`7020eeb9b852efb2`** and is now historical evidence,
not an apply target. Plan SHA-256:

```text
f815b7a725d7572a76c3a1b135e30d6e3fe526f489587b5d9997c76cb0ee6a57
```

The frozen source disables Codex's unsupported question tool with
`features.default_mode_request_user_input=false` and
`tools.experimental_request_user_input.enabled=false` on both start and resume.
Ten offline checks against the actual pinned CLI passed, including removal of
the offered tool and preserved resume identity. Claude moved to **2.1.257**;
official npm tarball integrity and credential-free ARM64 version/help/settings
checks passed. Configured models and signed package files are unchanged.
Both corrections are deployed and verified in the actual runtime. Fresh
model-driven qualification is tracked in the runtime-107 section above.

The reviewed plan reported **5 additions, 5 changes and 5 deletions**: five in-place
updates (AgentCore, native package worker and three dependent metadata Lambdas),
plus replacement of two Docker records and three local worker-build records.
There are no IAM, EFS, networking or persistent application resource changes.
All **30 inputs** and Terraform configuration match the prior applied plan.
Existing `keep_remotely=false` cleanup can remove the superseded registry image.

All **9 parent and 23 independent review checks passed**, along with **116
runtime tests** and Terraform validation. The full ARM64 image built and passed
actual CLI-version, source-hash, invocation-argument, HTTP health, UID, reaping
and termination-signal checks. The fresh worker bundle is byte-identical to the
deployed bundle, SHA-256
`d4ae7a7cd42af8f8c6f2853b6fe1d53986af2cebef29ba618175508d431701f8`.
Post-deployment verification passed **25/25 independent checks**: runtime
**107 READY**, state **1111**, the expected image, actual source/version/mount
checks and all four affected Lambda code/environment checks. The computed
runtime-version metadata caveat is recorded in the current verification section.

Historical deployment command (already applied; do not rerun):

```sh
AWS_PROFILE=solution terraform -chdir=terraform apply /tmp/aidlc-native-cli-compat-dev.tfplan
```

No frontend deployment or storage architecture change is part of this plan.
Evidence under `/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/`:
[plan review](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/compat-plan-review.json),
[independent review](/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/compat-plan-independent-review.json),
`compat-image-sources-versions.json`, `compat-image-smoke.json`,
`runtime-compat-tests.log`, `terraform-validate.log`, `worker-bundle-hash.json`,
`codex-input-tool-review.json` and `claude-upgrade-review.json`.
