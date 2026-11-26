# Native execution delivery status

Updated 30 September 2026. Branch: `feat/native-aidlc-execution`.

For the proposed next milestones, see
[the collaborative integration plan](native-collaboration-integration-plan.md).
It covers reuse of the existing intent UI, parsing and persistent activity
history, artifact-level Quorum, shared questions, approvals, latency and the
remaining pilot acceptance tests.

**Codex cold-session recovery now passes through the real UI and graph.**
The user-authorized clarification resumed the same Codex conversation and
produced turn 2 in intent `9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831`.
Independent verification passed **37 checks**: prior rollout bytes are
preserved, the accepted reply appears once, and all **439** new checkpoint
files match their recorded S3 versions and hashes. The plan remains unapproved.
The new response survives reopening; Files and the **18-node/17-relationship**
graph work, including graph-to-response navigation.

Reply to restored-session readiness took **4m 7s**, and reply to the new
response plus graph took **5m 30s**. Latency remains a limitation.
The attempted test Stop returned HTTP 404; the normal reply path then proved
cold ownership and successful recovery. This qualifies that observed recovery,
not the cause of expiry or a separately successful forced Stop. Other harnesses,
in-flight recovery and a live failed-status retry remain unqualified.
The [recovery checkpoint](native-session-recovery-plan.md#current-live-checkpoint)
records exact timings, evidence and limits. No new deployment is required for
this verified result.

### Earlier first-question result

**The fresh native run reached its first question, and its checkpoint and UI
projection are verified.** Execution
`9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831` retains Codex, AI-DLC v2.9.0 and the
approved pipe-visualization Compose prompt. Its real response proposes a plan
and awaits the user's choice. Overview preserves the response after reopening,
Files shows **16** published files, and Graph shows **18 nodes and 17
relationships** with working graph-to-file navigation.

Independent verification passed **29 checks**, including exact S3 versions,
hashes and lengths for all **439 private checkpoint files** (7,825,265 bytes).
The public files match the allowed checkpoint subset. No reply, plan approval,
continuation or runtime restart was submitted.

Start to the saved question took **11m 22s**, or **11m 29s** including graph
projection. Workspace READY was reached 121.466 seconds after draft creation;
that measurement includes the delay before clicking Prepare. The complete
controller timeline recorded **108 successful status reads and zero retries**.
At this first checkpoint, restart recovery and a live status-read failure were
still unverified; the subsequent Codex recovery result is recorded above. The response also
notes that the pinned scaffold branch has no pipe implementation.

The user-applied retry/diagnostics deployment passed **56/56 independent plan
checks** and **36/36 applied checks**, advancing state **1177 → 1178** with the
exact reviewed Lambda hash. Runtime **117**, its image and credentials code
remain unchanged. Local verification includes **991 controller tests** and
independent SDK failure/recovery tests. Status retries cannot resend a prompt;
confirmed ownership conflicts and revoked access retain their safeguards.

The previous draft `b484ecf5-8cd9-42dd-875c-f1fa0c7678f3` remains stopped at
`RECOVERY_REQUIRED` without a checkpoint. Its original status failure remains
unexplained and has not been replayed. Follow the
[current recovery checkpoint](native-session-recovery-plan.md#current-live-checkpoint)
for the full measured timeline and subsequent authorized recovery test.

The legacy composer run is preserved but failed during the image update;
that [compatibility defect](native-pinned-runtime-compatibility-follow-up.md)
is tracked separately.

The following checkpoints retain the earlier history; the entry above is the
current deployment and live-test status.

**The first real native composer question is now visible and durable.**
Deployment state **1164**, shared runtime **116**, all 32 referenced Lambda
hashes and the published image are verified. Fresh draft
`cb6c2fdd-1cf7-46f3-844c-f81d223353b0` uses the unchanged pipe-visualization
request and reaches `AWAITING_USER`. Its actual plan-selection question appears
in Overview with a reply field, survives reopening, and accompanies 16
published files. Files and graph file navigation work. No answer was submitted
during the initial question check.
Preparation took **1:37**; Start to saved question took **6:07**, including
about four minutes before model execution.

**The response graph connection is now deployed and verified.** State **1166**
matches all three reviewed Lambda archives and configurations; runtime **116**
and its image remain unchanged. The live graph shows the response node, and
clicking it opens the same saved question in Overview. The user then submitted
`1` to select Compose. The existing attempt entered turn 2 about **4.8 seconds**
after accepting the reply. That turn's immutable response and files are verified,
but its response is an AI-DLC command error; composer continuation has not passed.
The [composer checkpoint](native-composer-checkpoint.md) records the evidence
and remaining continuation and recovery limits. M1 is not complete yet.

**Graph ingestion is fixed; durable harness-session recovery is next.**
The user authorized this workaround for the pinned core's initial plan-selection
defect, which is [tracked separately](native-core-plan-selection-follow-up.md).
The exact request is accepted as sequence 3 in the same attempt and must not
be resubmitted. Ingestion of publication 2 is now complete. Local inspection
found that the graph client's deletion helper emits a `discard` operation
unsupported by the deployed Neptune version; the earlier in-memory tests
missed this. The deployed repair uses `toList()` to consume the deletion
without adding that operation.

The correction is locally verified by **98 focused tests** and a real
TinkerPop server reproduction with both supported serializers. Saved plan
`/tmp/aidlc-native-graph-cleanup-dev.tfplan` contains the worker fix and a
byte-identical credentials dependency; it has no runtime or persistent-resource
changes. The [deployment handoff](native-composer-checkpoint.md#graph-cleanup-deployment-handoff)
records its checksum and deployment evidence. The user applied it; state
**1167**, both Lambda hashes and unchanged runtime/image pins are verified.
The worker completed the pending projection in **4.08 seconds**.

A status-only check at **07:17:13 UTC** then confirmed a cold runtime:
it recovered the saved sequence-2 result from EFS, but did not reconstruct the
Codex conversation or an executable owner. The explicit Compose reply remains
saved. Its `pending` marker alone does not prove that replay is safe.

The user selected **durable session recovery** as the next milestone and
**automatic recovery at verified waiting points**. Required private recovery
data remains independent of optional debug archives, which stay off.
Recovery must preserve the exact session, accepted reply, package/model/source
pins and committed Files/Graph. Ambiguous in-flight execution must stop for
review. The implementation and local verification are now complete for the
recovery pilot: 5,008 native/backend tests and 333 frontend tests pass, and the
new image passes offline CLI restoration checks for Codex, Claude and OpenCode.
Kiro's actual CLI restoration and all live recovery remain unqualified.
The [reviewed recovery deployment](native-session-recovery-plan.md#deployment-handoff)
is ready for the user to apply. Its 42 Lambda archives are verified, with no
persistent-resource destruction. The deliberate restart test follows deployed
hash/configuration verification and the user's test-draft decision.

## Earlier checkpoints

The following entries preserve the earlier delivery history. The 30 September
composer checkpoint above supersedes their first-question blockage.

**Active direction:** the preparation timeout repair is deployed and verified;
deliver native execution through the **existing Intent UI and graph**.
Pre-provisioning is deferred. The [active delivery sequence](native-ui-first-slice.md#active-delivery-sequence)
defines the remaining visible checkpoints; a real first question/files/graph
result is the next feature milestone.

**M1b now publishes files, but the first native question is still blocked.**
Start/Cancel, the first native question, exact Files and generic Graph links are
connected through the protected execution controller. Recovery state **1157**,
all eight referenced Lambda hashes and the published image are verified.
The observed shared runtime and both version consumers agree on **115**.

Fresh draft `4344f624-aa8b-4e5e-a393-0dc04133ce9b` prepared in **1:47**,
passed EFS initialization, then returned a Codex session and committed
**16 files**. Independent verification passes **128 manifest/file checks**,
and the files open in the existing UI. The result is `STOPPED`, with no active
intent, question file or published source change. Initialization itself took
another **3:15**; provisioning and initialization are separate measurements.

Two integration gaps are reproduced locally with the exact package/request.
Codex needs `$aidlc` to explicitly load the installed skill; our common prompt
used `/aidlc`. AI-DLC also asks for the workflow plan **before an intent exists**,
whereas our classifier only recognizes questions inside an intent. The earlier
test's explicit `poc` scope bypassed this choice. The original request is
present and its hash matches. The live transcript was not retained, so its
exact tool sequence is not claimed.

Graph ingestion remains pending. Its trusted worker lacks the Neptune
`DeleteDataViaQuery` permission required for property upserts; the agent runtime
must keep no graph access. The next correction addresses explicit skill
invocation, native initial-question transport and this scoped ingestion
permission. The user has now selected the native intent page for the actual
composer conversation. Completed assistant messages are required run content;
they are not treated as proof that a native gate or the workflow completed.
The [first-turn checkpoint](native-first-turn-checkpoint.md) records current
evidence and remaining limits. The first-question milestone is not complete.

The Codex marker and trusted-worker permission fixes are now implemented locally.
The composed backend run passes **367 tests**, the focused marker suite passes
**112**, and **15 IAM/wiring checks** plus Terraform validation pass. The files
remain readable after the producing runtime session is stopped. No new deploy
has been requested. The [composer interaction plan](native-initial-question-plan.md)
now covers the actual ordered assistant messages, protected member replies and
serial continuation in the same native session. A one-time engine preflight
would not cover composer questions and is no longer the primary approach.

**The composer interaction slice is now locally verified.** The native Overview
shows ordered assistant messages/tables and lets a member reply through the
protected controller. Graph response nodes open that interaction. A composed
two-turn test preserves the same session through a lost acknowledgement without
duplicating the turn. **4,639 regression tests**, **251 frontend tests**,
typecheck/build and the final ARM64 image's **10 source checks** pass. Independent
collector review is closed. The actual page's local fixture passes display,
reply/retry and graph navigation checks. The saved plan
`/tmp/aidlc-native-composer-dev.tfplan` is ready, with all 32 archives verified
and no persistent-resource destruction. The
[deployment handoff](native-initial-question-plan.md#deployment-handoff) records
its exact hash and apply command. The next live check still stops at the first
real question. Cold harness-session
recovery and full conversation-history navigation remain unqualified.

**Earlier initialization recovery:** state 1155 preceded the verified run above.
The fresh same-task draft `b255dd02-b500-4218-9616-aa3671d0b4f8` prepared in
about **1:42**, passing 25 preparation and 12 attempt/IAM checks. It failed in
the new baseline check before model execution. We reproduced a concrete bug
using Node's actual stat conversion: valid high-bit 64-bit filesystem IDs can
appear signed, but our check accepted only positive values. The actual live
EFS ID was not observed. The correction preserves exact ID bits and adds fixed
diagnostic reasons. **396 composed backend tests**, independent review and the
ARM64 image checks pass. Both ordinary and simulated signed-ID initialization
pass all **18 checks** against the exact package/application commit, preserving
all **20 `.kiro` files**. This image correction is now deployed. The previous
frontend run passed 184 tests; the earlier complete native regression run passed
4,367 tests.
Those earlier results did not establish native file publication or graph
ingestion; the current publication proof is recorded above.

**Native discovery is deployed and verified in the existing UI.**
M1a adds protected native summary listing and normal project/sidebar/dashboard
navigation to the native status page. State **1144** matches the reviewed API
ZIP, configuration, permission and ACTIVE index. Independent checks pass
**28 deployment checks and 13 discovery checks**, including all ten existing
native fixtures. The authenticated local frontend opens native entries from
the project list, sidebar and both dashboard layouts, retaining saved URLs and
disabled unsupported controls. Local validation passed 365 backend and 262
frontend tests, typechecking/builds and independent review. The
[discovery checkpoint](native-discovery-checkpoint.md) records the proof and
remaining live authorization/pagination limits. M1b connects the first real
turn, exact files, question and graph; M1 is not complete until those work
together.

**Preserve both real-task drafts and their failed attempts.**
The user selected **“Fix the pipe visualization”** as a separate native draft:
`e0d2836d-c794-48d0-8b77-52550cf3c65a`, Codex, official AI-DLC v2.9.0.
Its exact prompt and separate identity are verified, and the normal project
list distinguishes it from the existing platform draft with the same title.
The first draft joined ten preparation fixtures; the recovery test added the
second same-task draft noted above.
Backend timing for the new draft is **about 1m45s** from the correlated Prepare
request to protected READY; the independent readiness review passes 15 checks.
No project-native model has started. The deployed controller successfully
upgraded this draft's isolated runtime from preparation version **1** to a
separate execution endpoint pinned to version **2**, preserving the original
preparation pins. Attempt `4222fe9f-4ce5-4743-b52f-d008b75aea3b` is now `FAILED`
after initialization. The second attempt
`bbab0dae-c34f-423e-ae04-cc76e54f7dc1` is also `FAILED`, with zero committed
publications. Following the filesystem identity correction deployment, use a fresh draft with
the same authorized prompt; the existing attempt and workspace stay immutable.
The first execution verification stops at the workflow's first question.

**Historical preparation evidence for the ten fixtures follows.**
The initial A/B verification used state **1139**, including the directory-tagging
repair. Run A now has its
own runtime/version-pinned endpoint, role and EFS access point. The provisioner
reached **READY at 11:41:41Z on 28 September**, after one 10-second diagnostic
abort recovered on the next automatic retry. A fresh independent session also
passed NFS4 write/readback, hard-link, atomic-rename and cleanup checks, then
stopped with HTTP 200. All **16 independent configuration checks** passed.
Run B reached **READY at 12:00:49Z** and passed its own fresh-session filesystem
check. Runtime/role/AP/root identities differ between the runs. Both runtimes
rejected six mismatched/unsupported requests between successful filesystem
controls. IAM principal-policy simulations deny cross-AP/root access, and an
unauthenticated API read returns 401. These checks do not prove physical
cross-mount denial or authenticated nonmember isolation. All diagnostic sessions
were stopped. The [preparation checkpoint](native-workspace-preparation-checkpoint.md)
records the proof and a worker-only fix for the new-role validation delay that
required a manual retry for B. Model and human-action controls stay disabled.

**The new-role recovery fix is deployed and verified on two fresh runs.**
State **1140** and the actual deployed worker ZIP/bundle match the reviewed
bytes. C and D each encountered the exact role-validation error, stayed
PREPARING, and created their runtimes on the next automatic attempt with
identical request parameters. Both reached READY without manual retries in
about **12 minutes**, including the current three-minute queue intervals.
Each passed a fresh-session EFS write/readback/hard-link/rename/cleanup check
and stopped with HTTP 200. C's independent configuration review passed **21/21**.
D's duplicate Create and repeated Prepare after READY both returned **200**
and left the complete protected row unchanged. Four preparation fixtures are
now READY. No further deployment correction was needed for this loop.

**Preparation timeout repair is now verified; earlier timing experiments follow.**
The [latency investigation](native-workspace-latency.md) traces both 12-minute
runs to four approximately 180-second readiness retry intervals. The worker
spent only 8.57–9.54 seconds in its five invocations per run; asynchronous AWS
work overlaps the idle intervals. The user selected this improvement before
the first agent-turn milestone. Short readiness retries with guarded lease
release are deployed at **1141**; all 19 deployed checks pass. Two fresh
member-created runs reached READY in **4:22 and 4:16**, approximately **64%
faster**. All eight short retries were confirmed. Both first diagnostic
invocations nevertheless hit the ten-second deadline and recovered on the
conservative three-minute retry. Fresh independent EFS proofs passed and both
sessions stopped. The 20-second diagnostic follow-up is deployed at **1142**;
its 293 tests, builds and 16 deployment checks pass. Fresh G/H preparations
take **4:18 and 4:14**, but both still abort the first invocation and recover
on the three-minute retry. Independent filesystem checks pass and sessions
stop with HTTP 200. The extra ten seconds did not solve the delay. The
time-correlated AWS latency samples are **51.833 and 50.470 seconds**, beyond
the entire 30-second worker window; startup versus EFS time is not yet separated.
The user selected only the worker timeout repair on 29 September.
The reviewed plan increases the worker to 90 seconds, its fixed diagnostic to
80 seconds and conservative queue visibility to 540 seconds; readiness backoff
stays short. All 294 tests, builds and both 21-check plan reviews pass.
The user applied state **1143**. Exact deployed bytes/settings pass 15 parent
and 18 independent checks. Fresh I/J runs reach READY in **1:39 and 1:41**
without the first-invocation timeout or recovery cycle; independent EFS proofs
pass and both sessions stop with HTTP 200. The agreed timeout check is complete.
No project-native agent has started; the existing UI/graph slice is next.

**Authenticated nonmember reads are denied.** A separate test account receives
403 for the original run A, run C and the native draft capability route. The
UI exposes no run details or creation form. A related frontend correction
clears previously loaded details on a later 401/403/404 and invalidates late
responses; its 29 focused / 48 related tests, TypeScript/production build and
independent 10-check review pass. The local denial path is verified. Direct
unauthorized POSTs, live membership revocation and another enabled project's
boundary remain unqualified. No AWS backend deployment is needed for this
frontend correction.

**Debug preferences are deployed and verified through the authenticated UI.**
The card saved on/eight days, retained the values after reload, then was restored
to off/seven days with independent SSM readback. Required recovery remains
independent. That settings checkpoint used runtime **111 READY**, state **1122**; deployed Lambda bytes,
retained prior image and unchanged runtime isolation configuration passed
**40 independent live checks**. The
[settings checkpoint](native-debug-settings-checkpoint.md) records the proof.
No model was invoked during that verification.

The latest Kiro interaction qualification remains the historical runtime
**110 READY**, state **1118**, image tag **`15c34685dcbc7627`**. Its actual
sources/CLI/EFS checks and **54 independent deployment checks** passed.

Kiro completed the real first question → Blue Lake title answer → next question
loop in the same ACP/native session. Full user and assistant replay hashes
matched before the answer was sent, and both turns acknowledged configured
`auto`. The native file changed only at Q1; Q2 and scope confirmation stayed
blank. State/directive contents were unchanged. Both turns exited 0 with cleanup;
parent and independent two-turn review each passed **21/21 checks**. The session
was stopped with HTTP 200 at **06:56:50Z on 25 September**. See the
[current checkpoint](native-interaction-probe.md#runtime-110--current-kiro-verification)
and [actual answered file](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/kiro-questions-after-answer.md).
No further backend deployment is required for this Kiro correction.

## Current position

The pilot remains incomplete. The four harnesses now each have a bounded
question/answer/follow-up result: Kiro on runtime 110, Claude on 108, Codex on
107 and OpenCode on 106. This is not one all-four production acceptance run.
Their test sessions are stopped. Nine ignored Claude permission entries remain;
Kiro's `auto` is a routing mode, its native directive owner is `sessionless`, and
native startup/HUMAN_TURN events do not establish protected human authority.

The next visible result is a real native intent whose first question and files
are published durably and visible to two members. [The UI slice plan](native-ui-first-slice.md)
records the implementation sequence and confirmed decisions. On 25 September
the user selected per-run isolation, native opt-in with the current backend
remaining default, and the **flappy-bird** project in **dev**. The user also
confirmed conditional approval re-presentation after uncertain recovery, no
application time/token/spending cutoffs, and platform debug archive settings
defaulting off with seven-day retention when enabled. Required recovery state
is independent of debug retention. Native answer/approval controls and their submission handlers
are now guarded in the frontend. The 132 focused tests and full typecheck passed;
the affected 18 tests also passed after a fixture typing correction. Lint and
formatting passed. Browser verification is outstanding. The first-slice
decisions are settled; real-project model execution and shared publication remain to qualify live.

The settings API/UI and native routing foundations passed 139 backend and 38
frontend tests, frontend typecheck/build and affected Lambda builds. An ARM64
image smoke passed. The settings deployment includes its existing runtime-image
dependency and preserves the previous remote image through a non-destructive
Terraform ownership migration. It does not enable archive capture, native
intent start or the protected binding provisioner. Those remain part of the
first real intent and recovery work. Preference persistence is now verified.
The current implementation loop adds an opt-in native draft and a dedicated
runtime, role and EFS access point per run. Two
**draft → preparing → workspace ready** paths now pass, including separate
resources, fresh-session filesystem checks and request-scope rejection. Run A
recovered automatically from a diagnostic abort; Run B needed an explicit retry
after newly created role validation failed. The deployed worker fix retries
that exact same-role error automatically within a ten-minute propagation window,
after fully validating the role on every attempt. The 195 native-control tests pass;
the automatic-retry branch now passes live on C and D. Duplicate Create and
fully allocated Prepare retry acceptance also pass on D.
Model dispatch, file publication and protected human actions remain closed.
The [workspace preparation checkpoint](native-workspace-preparation-checkpoint.md)
records the implementation, wider API dependency review, applied deployment
and each repair. Runtime and identity creation now pass live; the worker then
checks the actual role/AP/runtime/endpoint and filesystem before publishing
readiness. The trusted controller has direct creation/retag authority for native
identities and tagging authority on the shared default identity directory.
These grants are not per-run IAM ownership boundaries; agent roles do not
inherit them. Preparation proof does not establish native workflow installation,
model execution, artifact publication or checkpoint recovery.

For the historical shared runtime, computed metadata remains 111 while the
control-plane evidence identifies 112. Run A instead uses its dedicated runtime
version 1. Shared file/question UI, protected answers/approvals, execution fencing,
project isolation and cold recovery remain unqualified.

| Part of the agreed outcome                                   | Evidence today                                                                                                                                                                                                                                                                                                                                                                                    | Remaining                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow repository configuration                            | Official public GitHub source saved through the authenticated UI; latest import and Download preview exercised                                                                                                                                                                                                                                                                                    | Private GitHub, GitLab and Bitbucket live cases; broader release selection                                                                                                         |
| Immutable workflow packages                                  | Official public UI import succeeded through normal Pipe/SQS in one attempt; receipt and all six object versions match the verified archive                                                                                                                                                                                                                                                        | Broader provider, retry and recovery acceptance                                                                                                                                    |
| Two execution backends                                       | Backend identity and capability guards implemented; unsupported native edits/PR actions disabled in UI/API                                                                                                                                                                                                                                                                                        | Native configuration/start/answer/cancel/recover routing                                                                                                                           |
| Four native harnesses                                        | Scoped question/answer/follow-up passes: Kiro runtime 110 with full user/assistant replay and auto acknowledgement; Claude 108 with native SessionEnd; Codex 107; OpenCode 106. All test sessions stopped                                                                                                                                                                                         | End-to-end all-four acceptance, native hook/permission observations and recovery qualification                                                                                     |
| Native filesystem artifacts in the collaborative application | A fresh read-only session confirmed the Codex native artifacts persisted on EFS after the failed session was stopped                                                                                                                                                                                                                                                                              | Execution-workspace snapshots, durable publication, ingestion and shared native views; persistence alone is not cold recovery                                                      |
| Isolated human approvals                                     | Permission boundary and membership policy agreed                                                                                                                                                                                                                                                                                                                                                  | Protected action store, authenticated acceptance, native delivery and replay reconciliation                                                                                        |
| Native recovery and serial supervision                       | Package-job leases/recovery implemented; this is not execution recovery                                                                                                                                                                                                                                                                                                                           | Execution supervisor, checkpoints, stop/resume/cancel and cold recovery                                                                                                            |
| Usable pilot                                                 | Ten drafts reach Workspace ready; I/J take 1:39/1:41 with no invocation abort/recovery wait. C/D recover automatically; duplicate requests preserve D. Fresh-session NFS4 checks, earlier runtime-scope rejection, 18 IAM simulations, unauthenticated denial and authenticated nonmember read/draft-entry denial pass. UI denial handling passes 48 related tests; model/actions remain disabled | Direct unauthorized POSTs, live revocation, another enabled project and physical isolation; integrated native file/question UI and graph, all-four acceptance and rollout decision |

In the detailed plan, P1 is substantially implemented with live package-byte
evidence and verified normal dispatch for the official public source. Broader
provider, retry and recovery coverage remain unqualified. P2, P4 and P8 have
partial foundations. P3 and the native integration work in
P5–P7 remain to be built. P9 acceptance and P10 rollout have not started.

## The next user-visible milestones

These organize the existing plan; they do not reduce the confirmed feature,
provider, harness or approval-boundary requirements.

The user requested short implementation/verification loops on 22 September.
For each loop, identify one observable result, make the smallest required
change, run its relevant local checks, and exercise it live before expanding
that slice. Report actual output or the concrete failure. Do not substitute
additional mocks, documentation, or infrastructure deployment for execution.

The storage probe, normal public UI import, immutable receipt comparison and
local four-harness initialization are complete. The
[initialization checkpoint](native-initialization-probe.md) records the real
signature verification, generated files, two compatibility fixes and remaining
doctor warnings. The completed harness loop used a tiny model-driven question →
answer → continuation test on each harness. Runtime-106 Codex recorded its answer but did
not deliver the next questions. Kiro passed file-based continuation; separate
conversation logs leave history resumption unqualified.
Runtime-106 OpenCode completed the same-session question/answer/follow-up loop, with the
answer recorded in the native artifact on EFS and both turns clean.
On historical runtime 107, Claude's configured
model completed the title question/Blue Lake answer/follow-up loop in the same
structured/native session, with Q2–Q4 blank and both turns clean. It was stopped
with HTTP 200 at **11:38:29Z**. Nine ignored permission entries and a cancelled
SessionEnd hook were recorded in both runtime-107 turns. Runtime 108 subsequently
verified the native end hook on both turns; the permission warning remains.
Codex's runtime-107 probe also passed: the prior input-tool error is absent, the
native title answer is recorded, and the follow-up is delivered in the same
structured/native session. It was stopped at **11:58:50Z**.

The user selected existing dev AgentCore, keeping credentials in AWS. The
[operator interaction experiment](native-interaction-probe.md) is now implemented
and locally checked: fixed public package, disposable filesystem, all-four native
setup, separate test-answer action, session resumption and bounded evidence.
Its first deployment partially applied on 24 September before a plan-time ECR
token expired. Credential-helper authentication corrected that issue; the user
deployed the recovery plan, and runtime **103**, image and all seven remaining
Lambda bundles were independently verified.

The first real operator invocation then failed before the model started:
native AI-DLC uses hard-link transaction locks, unsupported on AgentCore's
persistent `/mnt/workspace` mount. Live diagnostics proved the limitation for
both installation and project pinning. Moving both to local disk passed native
setup and filesystem checks for all four harnesses inside AgentCore. The user
requested persistent-filesystem investigation first (D19), including the
existing 1-GB capacity constraint, then explicitly excluded EC2 and proposed an
EFS working directory with harnesses kept on AgentCore local disk. The
[storage assessment](native-storage-options.md) now follows that split: AI-DLC
installation, workflow files and code on EFS; active harness homes/databases
local, with durable recovery exports. Existing Kiro, OpenCode and Codex store
helpers provide a starting point. EFS integration is supported by the current
compute model and locked provider. Project isolation and native cold recovery
remain unqualified. The user deployed the EFS retry successfully:
runtime **104** is READY and state is serial **1103**. The exact scoped discovery
policy is unchanged. Live EFS hard links, symlinks, rename, executable permissions
and a **1,082,130,432-byte** write/sync/readback passed with matching checksums
and cleanup. Testing also found that our mount check rejected AgentCore's valid
backing-overlay/EFS mount stack. Signed installation and all-four configuration
then passed on EFS (13 commands, 67 checks). Installation took 137 seconds,
exceeding the launcher's old 120-second setup budget. The mount-check and
300-second setup-timeout corrections were subsequently deployed and verified
on runtime **105**, state serial **1105**.
The investigation is recorded in the
[EFS verification checkpoint](native-efs-probe-checkpoint.md).
The [interaction checkpoint](native-interaction-probe.md) records the evidence.

The first runtime-105 Codex attempt passed **four setup commands and 18
filesystem checks**, started the model and created a native
`intent-capture-questions.md` file. The **600-second model deadline** ended the
turn with `SIGKILL`; cleanup reported false, with Codex and AI-DLC zombies
adopted by PID 1. The failed session was stopped with HTTP 200 at **09:17:43Z**.
A fresh read-only session confirmed the native artifacts remained on EFS;
that diagnostic session was also stopped. No answer or approval was submitted.
Artifact creation and persistence do not qualify question return, continuation
or native cold recovery.

Runtime corrections address native launcher PATH forwarding, a local
Codex HOME outside `/tmp` so its helpers are accepted, PID-1 child reaping with
Tini, and exclusion of the sensitive native steering-token key from snapshots.
All 116 focused tests and the actual new ARM64 image checks passed. The user
applied the shell-reaper plan. Runtime **106 READY**, state **1108**, image
`59d8f47b1f0a4bc11668b90cf5bf254c2dc4ad4178904c29ba1d1d27910c8d29`
and actual source/mount/launcher checks are verified. The prior plans are
historical, not current apply targets. Earlier failure evidence remains
under `/tmp/aidlc-plan-tools/native-model-verify-20260924/`:
`codex-failed.json`, `codex-processes-after-timeout.json`,
`codex-stop-session.json`, `codex-durable-artifacts.json`,
`path-launcher-proof.json` and `codex-home-proof.json`.

Codex then returned the title question and resumed the same native session for
the synthetic answer. Both turns exited 0 with confirmed cleanup. Native Q1 now
reads **`X. Blue Lake`**; Q2–Q4 remain blank. `request_user_input` was unsupported
in exec mode, so next-question delivery and full Codex qualification remain open.
The session was stopped with HTTP 200 at **10:20:50Z**. After the turns, a
credential-free diagnostic measured **6.918 ms** for a login shell versus
**6,534.280 ms** for the bind hook, with unchanged session/pin metadata and
cleaned cache/home. This establishes hook-path overhead, not EFS causality;
storage architecture is unchanged.

Kiro returned the title question, recorded Blue Lake in the same native question
file and returned Q2/Q3 with both turns clean. Session IDs changed
`ad2d4ad5...` → `e96470cc...`, with two JSONL conversation logs and an empty
legacy SQLite store; history resume is not qualified. The `auto` model-selection
`MethodNotFound` warning also leaves exact model fidelity open. Kiro was stopped
with HTTP 200 at **10:48:49Z**; no speculative resume-flag change is included.
Claude passed setup, then CLI 2.1.246 received API 400 requiring at least 2.1.255:
exit 1, cleanup complete, no model response. OpenCode passed four setup commands
and 16 checks, then asked the title question, recorded **`X. Other: Blue Lake`**
and returned a follow-up choice for the remaining questions. Both turns exited 0
with cleanup and empty diagnostics; their structured events and native session
file agree on `ses_f2cf455cdffenpsQK2rQuqQHVQ`. Q2–Q4 remain blank.
OpenCode was stopped with HTTP 200 at **11:06:54Z**. Those four runtime-106
disposable sessions were stopped.

The [historical interaction results](native-interaction-probe.md#runtime-106--historical-interaction-results)
link the before/after artifacts and qualification limits. The
[CLI compatibility plan](native-interaction-probe.md#cli-compatibility-deployment--applied-and-verified-historical)
has since been applied and verified: runtime **107 READY**, state **1111**,
image tag **`7020eeb9b852efb2`**, and **25/25 independent deployment checks**.
Actual runtime sources, Claude 2.1.257, Codex 0.145.0 with both question-tool
overrides, Tini and NFS passed verification; all four affected Lambda bundles
and environments match state. That plan is historical. The generated Claude
SessionEnd timeout correction has since been applied and verified on runtime 108;
its same-session question/answer/follow-up and native end-hook experiment passed.
IAM, EFS and network configuration are unchanged. Shared native UI,
isolated human approvals, project isolation and execution cold recovery remain
open beyond this verified operator interaction loop.

1. **Prove the native interaction path.** Use the verified pinned public package,
   whose four harness configurations are now verified, and run the same small scenario through each:
   create a native artifact, ask a real question, accept a deliberate test
   answer through the harness-supported channel, and continue. Retain the
   files and native evidence. This is an integration experiment, not a claim
   that collaborative approval authority is implemented. It resolves the
   largest remaining technical uncertainty before expanding the product UI.
2. **Demonstrate the collaborative loop.** Start from the application, view the
   actual native file, answer or approve as an existing project member through
   the isolated authority store, and observe native continuation and updated
   shared artifacts. Demonstrate a second collaborator seeing the same state.
   Unsupported edits and per-unit PRs remain disabled.
3. **Demonstrate the agreed pilot.** Interrupt and restore a run, verify
   cancellation and serial execution, and complete the same acceptance matrix
   across all four harnesses and supported public/private source providers.
   Enable the pilot only after those results and the rollout decision.

Do not serialize all independent implementation behind every provider/recovery
test. Work on the backend boundary, protected action store and harness interaction
adapters can proceed alongside the remaining package verification.
Deferred tests still have to pass before the pilot is described as supported.

## What the current storage work actually delivers

The user-selected **8,192 MiB RAM** is deployed and verified. The remaining first
import settings stay 4,096 MiB temporary disk, 600 seconds, one worker and
three attempts.

A temporary storage probe used the existing worker role and network without
increasing permissions or enabling imports. Its first live run passed
conditional creation, current/pinned reads, overwrite rejection and
missing-condition rejection, then stopped on an unsupported condition value.
The user deployed the narrow probe correction; its deployed code was verified.

The second live run reached 13 of 20 cases. Overwrites, both copy attempts and
ordinary multipart initiation were rejected. **Multipart initiation with a
signed `If-None-Match: *` header succeeded**, exposing a real policy gap. The
probe stopped immediately. Independent reads confirmed the original 32-byte
file and version were unchanged, with no extra objects or delete markers.
The one empty synthetic upload session was inspected and aborted using
operator credentials; the package upload inventory was empty at that checkpoint.

The user deployed the correction. The third invocation completed all 20 cases:
18 passed, with only expected fixture reuse and the unsupported wrong-header
response recorded as inconclusive. Both multipart attempts, copies, overwrites,
adjacent-prefix writes and all deletion attempts were rejected. Independent
reads confirmed the original file/version and empty multipart inventory.

**Dev activation was verified on 23 September: 16/16 checks passed**, including
the exact deployed worker hash, both import flags, enabled SQS consumer, running
Pipe, retired probe/log group, and unchanged permissions.

The user applied `/tmp/aidlc-native-dispatch-fix-dev.tfplan`. Live `DescribePipe`
exactly matches the reviewed raw-heredoc `InputTemplate`; the Pipe is `RUNNING`,
its role/source/target/filter are unchanged, and the SQS consumer is enabled.

At **10:57:37.216Z**, a fresh authenticated UI official `latest` import used
normal Pipe/SQS delivery only and reached `SUCCEEDED` in **one attempt**, with
**no diagnostic replay**. Worker duration was **7,516.43 ms**, maximum memory
**738 MiB**, and initialization **340.20 ms**. UI Download verified v2.9.0,
commit `22f5d1b15a064c9ae80046e5b1761d5877e2f69f`, and Claude, Codex, Kiro and
OpenCode projections. The job pin and materialization exactly match the earlier
archive whose exact-version S3 manifest and all five files were independently
verified; the fresh receipt comparison remains with the main task.

Historically, the 06:18:41Z import stalled at `QUEUED`, attempts 0, and its
06:22:54Z diagnostic replay succeeded. The new normal success after the
template-only fix supports the escaped-template explanation for that failure;
the old SQS body was never captured, so its exact shape remains unknown.
See the
[import checkpoint](native-package-import-checkpoint.md) for job, package and
evidence identifiers, and the [dispatch review](native-package-dispatch-review.md)
for the correction. Signatures remain `not_checked`, execution remains
`not_qualified`, and milestone 1 is incomplete.

The interaction host is decided: existing dev AgentCore. The first loop measures
ordinary clarification and continuation; structured question transport and
lost-session behavior still require evidence. Those decisions remain with the user.

## Delivery expectation

The full pilot is not one or two infrastructure deployments away. Significant
integration remains, especially human interaction and execution recovery.
There is not yet enough end-to-end evidence for a dependable completion date.
Re-estimate after milestone 1 using observed harness behavior, rather than
using package test counts or the number of deployed resources as a proxy.

Each subsequent update should state which milestone advanced, what the user
can now observe, what was tested live, and what is still only locally tested.
Use the detailed [implementation plan](native-execution-plan.md) for design,
the [import checkpoint](native-package-import-checkpoint.md) for current live
evidence, and the [storage checkpoint](native-storage-probe-checkpoint.md) for
the completed probe history.
