# Native session recovery

Updated 30 September 2026. The recovery implementation is deployed on
`feat/native-aidlc-execution`; runtime 117 and all 42 referenced Lambda hashes
are verified. The fresh user-authorized draft reached its first composer
question, published Files/Graph, and saved a verified private recovery checkpoint.
Its subsequent cold-session recovery and real Codex continuation now pass.
The controller's S3 permission repair and status-read retry correction are
deployed and verified. The first test stopped before the retry correction and
has no question or recovery checkpoint. It remains preserved for review.
This qualifies one Codex waiting-point recovery; other harnesses, interrupted
in-flight work and a separately confirmed forced-stop test remain unqualified.

## Current live checkpoint

**Cold-session recovery, the saved reply and the next visible response passed.**
The user authorized the restart test and the exact clarification:

> Before I approve this plan, clarify the missing pipe implementation you found
> in this branch and what you need from me. Keep the current plan unapproved.

The one guarded Stop request at **11:35:07 UTC** returned
`ResourceNotFoundException` / HTTP 404. Before/after reads verified the same
version-241 waiting row and ACTIVE fence. The exact runtime and endpoint were
still READY on the pinned version/image, with a 900-second idle-session limit.
This suggests natural expiry after the wait, but does not prove its cause or a
successful deliberate Stop. No Stop retry or protected-state reset was made.

The normal reply API accepted the authorized **153 bytes** once at
**11:37:08.858 UTC**. A cold prior-boundary report then triggered the deployed
recovery controller. It advanced writer generation 1 to 2 through its
positive-Stop guard, restored the checkpoint and resumed the same Codex session
`01a0f1ce-acb7-7310-a944-730086b1d282`. The attempt, AWS session, cancellation
epoch, package, model, image and source pins remained unchanged.

| Observed boundary                               | UTC          |
| ----------------------------------------------- | ------------ |
| Clarification accepted                          | 11:37:08.858 |
| Cold saved boundary, sequence 1, recovered true | 11:37:14.813 |
| First restoring report, writer generation 2     | 11:37:47.292 |
| Recovery ready                                  | 11:41:16.242 |
| One Continue acknowledgement, sequence 2        | 11:41:24.624 |
| First running report                            | 11:41:30.213 |
| First publishing report                         | 11:41:57.987 |
| Publication ready                               | 11:42:26.374 |
| Controller persisted AWAITING_USER              | 11:42:31.421 |
| Graph projection complete                       | 11:42:38.676 |

Reply acceptance to recovery-ready took **4m 7.384s**; to the saved response,
**5m 22.563s**; including graph projection, **5m 29.818s**. The actual observed
running interval before publishing was **27.774s**. Latency remains a material
limitation. Current diagnostics do not separate checkpoint download, filesystem
restore and package installation inside the restoration interval.

Independent verification passed **37 checks**. All **439** files in the new
private checkpoint (7,847,092 bytes) match exact S3 versions, hashes and lengths;
all 16 public files match the allowed project subset. Both prior Codex rollouts
remain byte-for-byte prefixes of the saved conversation. The exact accepted
clarification occurs once in the primary session's user-role records; mirrored
log events are not counted as additional deliveries. The continued assistant
message matches the committed interaction. These are evidence for this run,
not a general exactly-once guarantee for external effects.

The UI retained the previous response, files and graph during recovery.
Turn 2 survives a full page reload. Its graph has **18 nodes and 17
relationships**, and graph-to-response navigation opens that same new response.
The agent asks for the branch/file containing the pipes, or confirmation that
pipes should be built from scratch, and explicitly keeps the plan unapproved
and unchanged. No further reply or approval was sent.

Final protected state is `AWAITING_USER`, version **320**, sequence **2**, writer
generation **2**, with completed graph projection. Checkpoint:
`f147ee2d90c3f7620bd043e18ca05a6b45cf232c77d3b0be94561b10deab73d9`.
The complete scoped timeline contains one Continue acknowledgement, one
protected dispatch, no new Start, and no diagnostic failures or status retries.
The live failed-status retry path remains unexercised.

Evidence:
`/tmp/aidlc-plan-tools/native-status-diagnostics-20260930/live-restart-9a36/`,
including `recovery-test-result.json`, `final-timeline-receipt.json`,
`checkpoint/independent-checkpoint-verification-1790768649839.json`,
`public-interaction-verification.json`, and the saved UI screenshots/states.
No deployment or production-code change was needed for this test.

Remaining limits: no separate live filesystem-stat verification of restored
modes/timestamps, no interrupted in-flight replay qualification, no all-harness
recovery claim, and no proof of the original session-loss cause. The assistant's
absolute runtime file citation also renders as a local frontend path; artifact
link translation remains a UI follow-up, separate from the verified graph links.

### Earlier first-question verification

After deployment verification, the user approved a fresh first-question test.
Execution `9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831` was created once at
**10:07:04.890 UTC** and reached workspace READY at **10:09:06.356**. Its
Start was accepted at **10:09:41.715**, with attempt
`e9bc9d5c-59d7-497c-8545-73375949204d` and a fresh runtime session. Its complete
execution configuration, verified package receipt, and 92-byte Compose prompt
match the prior test. The first-question test passed and stopped at
`AWAITING_USER`, sequence 1, protected version 241. A final read at
**10:28:51.023 UTC** confirmed the same checkpoint, completed projection and no
human reply. No reply, approval, continuation or runtime restart was submitted.

| Observed boundary                        | UTC          |
| ---------------------------------------- | ------------ |
| Draft created                            | 10:07:04.890 |
| Workspace READY                          | 10:09:06.356 |
| Start accepted                           | 10:09:41.715 |
| Runtime Start acknowledgement, preparing | 10:10:52.285 |
| First running report                     | 10:14:08.619 |
| First publishing report                  | 10:20:40.754 |
| Publication ready report                 | 10:20:57.370 |
| Controller persisted AWAITING_USER       | 10:21:03.423 |
| Graph projection complete                | 10:21:10.900 |

Start to the saved question took **11m 21.708s**, or **11m 29.185s** including
graph projection. The runtime reports span about **3m 16s** in preparation and
**6m 32s** running before publishing. These are observed phase boundaries,
not separately instrumented process durations. Create to workspace READY was
121.466 seconds and includes the delay before clicking Prepare.

The real composer response proposes a custom plan and asks the user to approve,
edit, reject or provide another instruction. It correctly notes that the pinned
scaffold branch has no pipe implementation. The source remains
`ai-dlc/initial-game-1776942523258--task-project-scaffold`, commit
`d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`; it was not silently changed to another
branch. This is an ordinary assistant-turn interaction, not a file-backed
approval gate or workflow-completion decision.

Verified results:

- Overview displays the ordered response and preserves it after reopening.
- Files lists **16** published files; `.aidlc-version` opens with `2.9.0`.
- Graph displays **18 nodes and 17 relationships**; graph-to-file navigation
  opens the same published file.
- Independent checkpoint verification passed **29 checks**. All **439 files**
  (437 project files and 2 Codex rollout files), totaling **7,825,265 bytes**,
  match their exact recorded S3 versions, hashes and lengths. All 16 public
  files match the allowed checkpoint subset. Package, harness, image, session
  and prompt pins match.
- The complete scoped controller timeline contains one observed Start
  acknowledgement and **108 successful status reads**, with no continuation,
  recovery, owner change or retry. The live status-retry branch was therefore
  **not exercised**; its failure cases remain qualified by local tests.

Checkpoint `a956a08b3af524984c5181b06b806e58d1d0660388944efe258f71756a9afbff`
belongs to this attempt and native Codex session
`01a0f1ce-acb7-7310-a944-730086b1d282`. Stored bytes and descriptors are verified;
actual restart, restore and filesystem metadata restoration remain untested.
Git checks cover the captured index/config, not historical Git objects or
arbitrary unknown secret strings.

Evidence is under
`/tmp/aidlc-plan-tools/native-status-diagnostics-20260930/live-applied/first-question-9a36/`:
`first-question-result.json`, `diagnostics/final-timeline-receipt.json` and
`checkpoint/independent-checkpoint-summary.md`. The prepared metadata-only
progress probe aborted before invoking the runtime because the run had already
reached `AWAITING_USER`.

The first-question authorization ended without a reply or approval. The
separately authorized recovery verification is recorded above.

The first recovery-test Codex draft in flappy-bird used the existing
pipe-visualization request with an explicit Compose instruction. Execution
`b484ecf5-8cd9-42dd-875c-f1fa0c7678f3`, attempt
`2b8a3b06-bfe6-4c25-918b-c101c97e4744`, retains AI-DLC v2.9.0, the approved
model and application commit. The raw draft starts with `compose `; the
executor adds Codex's `$aidlc` marker once. Its 92-byte prompt has SHA-256
`4dac989282c1c89bfa48c2e58bfb924b70ca50c3d14d2c32307b5a51031ffc3e`.
Preparation took **102.554 seconds**. The platform accepted Start at
08:30:45 UTC.

The controller initially blocked before dispatching a model turn. Its recovery fence
lookup reads the control object before creating it. The exact object is absent;
the deployed worker can read/write that prefix but cannot list the bucket.
S3 documents that a missing-object read returns 403 without `s3:ListBucket`,
whereas this code correctly recognizes only a missing-key response as absence.
The worker's generic retry, absent dispatch marker, actual IAM policy and
read-only policy simulation supported this diagnosis. The subsequent normal
retry after deployment confirmed the repair, as recorded below.

The applied repair adds `s3:ListBucket` on the existing private publications bucket to
the trusted execution controller only. API and runtime permissions, object
content permissions, Lambda code and the runtime image remain unchanged.
State **1177**, all **30** independent deployed-configuration checks and the
unchanged runtime/Lambda hashes pass. The normal queue retry at 08:55:33 UTC
created the previously missing ACTIVE fence and dispatched this same draft.
The runtime Start acknowledgement was validated by **08:55:40.734**. This
confirms the S3 repair in the live execution path.

Seven subsequent status checks succeeded, the last at **08:56:20.319**.
The next reconciliation, **08:56:25.332–08:56:29.492**, fenced and stopped the
run with `DELIVERY_UNCERTAIN`. Protected version 40 has `canRecover: false`,
sequence 1 and no human reply. No public or private recovery objects exist.
Successful startup/status acknowledgements do not prove that model execution
began.

The original failing status response or SDK error was not recorded. A single
guarded status-only diagnostic after the controller stop found the saved owner,
but returned only `native_execution_existing_owner`. It did not expose a
checkpoint or a specific initialization failure. The diagnostic session was
stopped with HTTP 200; the protected row and FENCED control record remained
unchanged. A cold observation after that stop does not prove the original
failure was caused by a cold session.

Subsequent guarded command-API reads inspected only the saved control records
and preparation layout. They verified the owner identity, the initial
`preparing` status from **08:55:40.361**, the restored package and the exact Git
commit. The first AI-DLC installation was incomplete: no installed version or
launcher existed. These reads did not start a coding agent.

An isolated offline installer probe then used the same pinned binary and EFS
mount, with a separate diagnostic directory and an empty credential
environment. `aidlc use 2.9.0 --from ... --offline --json` completed
successfully in **145.958 seconds**. Its launcher and installed version existed;
the observed cgroup peak was 978,309,120 bytes with zero OOM events. The probe's
directories were removed, its runtime session stopped successfully, and the
original protected row and fence remained unchanged. This qualifies the
installer on EFS; it does not identify the original failed status request.

AWS metrics show one `UserErrors` event in the 08:56 minute and no system
errors or throttles. The minute-level usage data does not establish process
loss, peak memory or the exact request failure.

The deployed correction adds bounded controller diagnostics for status, protocol
and transport failures, without changing the rule against uncertain replay.
No cause for this new failure is claimed yet. Do not resubmit Start or reset
this draft.

The user approved retrying failed status-only checks after an acknowledged
Start or Continue while the existing agent may still be working. The controller
change passed local verification and independent source review. It never
resends a prompt; confirmed lost or conflicting ownership still requires
recovery review, and cancellation or
revoked access takes precedence. Initial dispatch and recovery delivery guards
remain unchanged. The earlier diagnostics-only and intermediate retry plans
are superseded and must not be applied.

Local validation passed **991 controller tests across 28 files**, **156 focused
tests** (overlapping the controller suite), **74 independent SDK/privacy/behavior
tests**, and **56 UI interaction tests**. The SDK cases include ordinary failed
status reads followed by healthy publication, explicit structured owner/scope
rejections with and without AWS exception headers, and cancellation/access
revocation during a failed read. The first independent review found a rejection
that escaped without persisting recovery; that path is corrected and the
unchanged reproduction passes. Lint, formatting and the worker build pass.
All **331 runtime/shared source files** remain unchanged.

The user applied the combined status-retry/diagnostics plan:
`/tmp/aidlc-native-status-retry-dev.tfplan`

SHA-256:
`231192a7f58aa5443afa2c7bce8f993984a7184bfdc246f94e042b029a0e6360`

The plan was based on state **1177** and passed **56/56 independent checks**.
It updates the execution-controller Lambda and repackages its credentials
dependency with **byte-identical code**. Six replacements are local packaging
helpers. There are no AWS resource additions/destructions or IAM, API, runtime
image, memory or timeout changes. Both referenced ZIPs are built and verified.
The verified deployed execution Lambda hash is
`u2tKW/lRN/PTeYCjnb3RmTQbZdeEBBT84v3E0SqfZLY=`.
The credentials hash remains
`DXuTPQxgKJMeXIOM2CsqBQYC6hi5DeXpGqshjlTk3ck=`.

Applied verification at **10:04:52 UTC** passed **36/36 checks**. State advanced
**1177 → 1178** with the same lineage. Both Lambda archives and all ten related
Lambda configurations match the reviewed deployment; the credentials code,
runtime 117, its image, and its version consumers remain unchanged. The
temporary operator plan copy is absent after deployment; the retained reviewed
binary still matches the recorded hash. Do not reapply this plan.

Evidence is under
`/tmp/aidlc-plan-tools/native-status-diagnostics-20260930/`, including
`deployment-handoff.json`, `independent-final-plan-review.json`, and
`live-applied/independent/independent-application-verification.json`.
No deployment was performed by the agent. The preserved draft is still version
40, `RECOVERY_REQUIRED`, with the exact same FENCED object version and no
checkpoint. Its UI remains stopped after Refresh.

The user approved the fresh draft described above. It was created and started
through browser tab 11 with Codex, AI-DLC v2.9.0 and the exact 92-byte Compose
prompt. The test stopped at the first question and verified its private recovery
checkpoint and Files/Graph projection as recorded above. No reply or gate
approval is implied.

Previously applied S3 permission repair plan:
`/tmp/aidlc-native-fence-read-permission-dev.tfplan`

SHA-256:
`461f6e5234964d26f7b61d77720efdbe81f5035b9c65e94a7341487efffc2a5e`

The applied plan was based on state **1176** and contained **one IAM policy update,
zero additions and zero destructions**. All 13 existing statements remain
unchanged. Its one referenced Lambda archive is verified and unchanged;
18 focused IAM tests and Terraform validation pass. Independent plan and
state review passed 32 checks. The user applied this plan; it must not be
reapplied against the newer state.

Evidence is under
`/tmp/aidlc-plan-tools/native-fence-read-permission-20260930/`.
The `live-applied/first-dispatch-investigation/` subdirectory records the
subsequent failure, its exact timeline and the status-only diagnostic.
At that earlier checkpoint, first-question and recovery verification remained
outstanding. The later authorized fresh draft and recovery result above supersede
that status; the uncertain earlier draft remains preserved.

The earlier run remains preserved, with its saved reply and committed
Files/Graph. During deployment it failed the credential service's comparison
between its pinned image and the newly deployed global image. This
[deployment compatibility defect](native-pinned-runtime-compatibility-follow-up.md)
is tracked separately; no old reply was replayed.

## Result to verify

A member replies to a native intent after its AgentCore process has expired.
The platform restores the exact harness session and its last verified waiting
point, then delivers that member's already-saved reply once. The existing
Overview, Files and Graph retain the committed revision throughout recovery.
The next real AI-DLC question appears on the same intent.

The user chose automatic recovery at verified waiting points. If execution
may already have started, the platform must stop for review instead of
automatically replaying the command. This does not promise exactly-once
external effects across an arbitrary process crash.

## Confirmed gap

The current executor writes owner, request-admission and status records to EFS.
It publishes exact project artifacts and assistant messages to versioned S3.
Its cold status reader can recover those receipts, but it cannot reconstruct
an executable owner. Harness homes remain on local AgentCore storage; their
conversation state is not part of artifact publication.

The existing `cb6c2fdd-1cf7-46f3-844c-f81d223353b0` run proves this gap.
Its sequence-2 graph projection is complete. Its saved explicit Compose reply
is pending at sequence 3. The 07:17 UTC status diagnostic returned
`recovered: true`; it did not inventory or restore the Codex rollout.
Recovery of this particular legacy run is not promised. A new conversation
must not silently replace it if its original session data is unavailable.

## Required boundaries

- Mandatory recovery checkpoints are private run data, separate from optional
  debug snapshots and conversation archives. Debug remains off by default.
  Recovery bytes do not enter Git, the graph or ordinary artifact downloads.
- Preserve exact native session IDs, package and image pins, approved model and
  source revision, accepted response identity/text and publication history.
- Capture only after the harness and its descendants have stopped. Validate
  complete content, modes and relevant timestamps; AI-DLC uses timestamped
  human-turn and engine-touch markers.
- Rebuild approved credential configuration and acquire fresh credentials.
  A runtime-written home must not restore permission policy or old credentials.
- A protected controller record anchors an immutable, versioned checkpoint.
  Local files and a runtime's claimed status do not authorize a new writer.
- Distinguish reply acceptance, dispatch attempt, runtime admission and completed
  publication. A missing acknowledgement is not proof that work did not run.
- Fence and stop the prior writer before admitting a restored writer. Keep
  writer generation separate from cancellation epoch and worker lease fencing.
- Retain committed content during recovery. Unknown or unavailable session
  formats, failed validation and uncertain dispatch remain explicit states.

## Implementation sequence

1. Add strict private checkpoint manifests and exact-version storage. Include
   the selected harness's resumable state, matching workspace data and resume
   metadata. Reject incomplete, cross-run or credential-bearing input.
2. Qualify capture and restore for the pinned Claude Code, Codex, Kiro and
   OpenCode versions. Harness executables remain on the AgentCore image/local
   disk; AI-DLC workflow and application files remain on EFS.
3. Commit checkpoints with completed turns and add controller-owned dispatch
   journaling and writer generations. Cold status is a recovery signal rather
   than permission to run. Preserve historical publication/response ownership.
4. Connect `RECOVERING` and `RECOVERY_REQUIRED` to the existing intent page.
   Retain a saved reply read-only and do not submit another response or Start.
5. Run a composed local restart test: complete turn, save checkpoint, destroy
   local process/home, restore, resume the same session and consume the same
   reply. Exercise crash windows, duplicate delivery, stale generations,
   checkpoint tampering, cancellation and membership denial.
6. Build and review the deployment artifact and Terraform plan; the user
   deploys. Verify actual deployed hashes, then deliberately stop a qualified
   waiting session and measure the real recovery/reply/next-question path.

## Verification limits

The composed local test now runs the production controller, protected store,
fence, executor, checkpoint storage and filesystem capture/restore with an inert
real child process. It deletes the local harness home and executor memory,
restores the same conversation, and verifies one delivery of the same saved
reply. The normal path, lost continuation acknowledgement and a failed restore
followed by an explicit member retry pass. These tests make no model calls.

The pinned Codex 0.145.0 binary can read the restored conversation with its
original ID and synthetic user/assistant context; its default history mode is
Legacy. The pinned OpenCode 1.17.20 export/import/export round trip retains the
same session and messages. The pinned Claude 2.1.257 binary resumes the restored
session and sends its prior user/assistant context plus the continuation to a
local mock endpoint with container networking disabled; no real inference was
performed. Kiro 2.19.2 currently has local filesystem fixture coverage, but its
actual CLI restore remains unqualified. The live Codex waiting-point result
above does not qualify recovery for the other three harnesses.
Dependency-bearing session formats are rejected rather
than silently losing context.

The first recovery checkpoint transport accepts 20,000 files, 40,000 total
file/directory entries, 64 MiB per file and 256 MiB total file bodies. Capture
applies those bounds before upload. The pilot must measure its actual checkpoint
size; arbitrary-sized repositories are not qualified. Streaming larger
checkpoints is still needed before claiming that support. Required recovery
data stays separate from debug retention and is never exposed by the public
artifact API.

The current checkpoint above qualifies one deployed Codex waiting-point recovery;
all-harness live restore remains unqualified.
An existing run without a complete checkpoint needs a specific, visible
recovery choice; assistant-message history alone is not a harness session.
Private repository/provider and gate approval qualification remain separate
from this session-recovery proof.

The final local regression passed 5,008 native/backend tests across 97 files,
333 frontend tests, frontend typechecking/build, 17 IAM tests and nine
deployment-policy tests. Terraform validates with zero errors and four
existing deprecation warnings. The independently built ARM64 image matches
15 critical source hashes and repeats the Codex, Claude and OpenCode
capture/storage/restore checks using its own packaged source. Its S3 transport
is an in-memory versioned fixture, not a live AWS test.

Local harness evidence is under
`/tmp/aidlc-plan-tools/native-session-recovery-20260930/independent-harness-state/`,
including `implementation-handoff.json`, `capture-restore-contract.json`,
`codex-history-default-verification.json` and `claude-module-mock-proof.md`.
Keep bulky evidence outside Git.

## Recovery deployment applied

Prepared against dev state **1167**, lineage
`e83979b6-e79b-4dbd-e03f-8442c74f741c`. The plan is:

`/tmp/aidlc-native-session-recovery-dev.tfplan`

SHA-256:
`595775bed5c10e16ab5d2f0e23b9576ebdd2962a6ecc7b1e317cde254933ddae`.

All 42 referenced Lambda archives are built and verified. Their previous
archives also match the state-recorded deployed hashes: 39 have identical file
contents; only the native API, execution worker and credentials bundle change.
The runtime image tag is `8990203953455c85`. The user applied this plan.
State **1176**, live runtime
**117**, both runtime-version consumers and all 42 Lambda hashes are verified.
The published image digest is
`sha256:a226eb964ae779ee64496f0bdbf481dee4e9025dcf5d642015c9018975d6c0ff`.
Its ARM64 manifest, configuration, all 21 layers and 15 critical source hashes
match the reviewed image. Terraform's managed AWSCC resource still reports
version 116 in its computed metadata; the observed runtime, endpoint and both
consumer functions agree on 117. This metadata discrepancy is not a consumer
deployment failure.

The final plan has 43 AWS resource changes and no persistent-resource
destruction. It adds the Cognito-protected recovery route and scoped recovery
permissions, updates the runtime and its consumers, and republishes the API
deployment. Five previously deposed Docker registry records are removed from
Terraform state with `keep_remotely = true`; their remote images remain
retained. The independent review passes all 218 checks, including every
deposed key and exact final archive/action comparisons.

Deployment evidence is under
`/tmp/aidlc-plan-tools/native-session-recovery-20260930/`, especially
`deployment-handoff.json`, `independent-final-plan-review.json` and
`live-applied/independent/independent-live-deployment-review.json`.
Only the user deploys. The new test draft is authorized and already created;
the IAM-only repair above is also applied. Follow the current live checkpoint
for the outstanding status failure.
