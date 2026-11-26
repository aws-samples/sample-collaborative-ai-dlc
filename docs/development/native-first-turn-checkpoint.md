# Connected native first turn

29 September 2026 — `feat/native-aidlc-execution`.

M1b connects Start, the first native question, exact files and generic graph
links. Deployment is verified at state **1157**. The EFS initialization repair
passes live. The new Codex command returned and published 16 verified files,
which open in the existing UI, but no native intent or question was created.
The run is correctly not marked complete. Two reproduced integration gaps
remain: explicit Codex skill invocation and questions before intent creation.
Neptune ingestion also lacks a permission required for property upserts.
This does not complete milestone 1.

## Latest live verification: first published result

- Applied state **1157** matches all eight Lambda archives. Shared runtime,
  DEFAULT, observed state and both version consumers agree on **115**.
  Published image
  `sha256:a87c1003ef9c1fd9f935481e47c9fce327e62154b92b9bf692c08d87175a3e39`
  passes the ARM64 smoke check and six source-hash comparisons.
- Fresh draft `4344f624-aa8b-4e5e-a393-0dc04133ce9b` uses the unchanged
  authorized request, Codex, official v2.9.0 package and application commit
  `d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`. Its request hash
  `dca3e594f2b7937801bc3bfc7990b2d077ff811682ad5023354078ed2f40cfb3`
  matches the protected execution pin. The deployed worker reads the prompt
  from `draft.request.prompt`; the execution configuration stores its hash.
- Preparation took **107.369 seconds**, reaching READY at `13:21:30.369Z`.
  Independent preparation and attempt checks pass **25/25** and **16/16**.
  Start created attempt `af0a69d6-3f87-437b-96c8-ff2a9bc925e7` at
  `13:22:24.407Z`. Runtime initialization began at `13:23:34.440Z` and passed
  the initialization inspection before the `running` checkpoint at
  `13:26:49.220Z`: **194.780 seconds** of setup, separate from provisioning.
- The runtime reached `publication_ready` at `13:29:39.240Z`. Codex returned
  exit 0 with session `01a0ed58-b799-7ef1-b6f3-2ad01663e4ea`; the report records
  `STOPPED / native_wait_format_unrecognized`, no wait evidence and no output
  truncation. A session ID and exit code alone do not prove the model's exact
  tool sequence or a successful workflow.
- Immutable publication
  `d4e9ab9c66eb3491ee9c24f570e977a93254571653f7cc2f4a769383ce939308`
  passes **128/128** independent manifest/file checks: **16 versions**,
  **28,654 file bytes**. The UI lists those files and opens the shared viewer.
  All 12 files other than four hook-health timestamps match initialization
  exactly. There is no active intent, stage question or published code change.
- A local request-capture test with the published Codex 0.145.0 image and
  exact generated skill proves that `$aidlc` includes the full 60,667-byte
  skill in the first request; `/aidlc` does not. It used loopback, dummy
  credentials and immediate error responses, with no model/cloud calls.
  Implicit later skill selection is still possible, so this does not prove
  whether the live model subsequently read the skill.
- Running the pinned native engine with the exact full request returns
  `kind: ask` for workflow selection **before creating an intent**. No stage
  question file or active directive exists at this boundary. The earlier
  fixture supplied `poc`, bypassing this choice. The current classifier only
  recognizes questions within an active intent. This is a reproduced missing
  interaction case; the live response was not retained, so its exact reason
  for stopping remains unconfirmed. Do not choose a scope on the user's behalf.
- Projection was still pending at the last observation. The publication
  reconciliation released and requeued successfully at `13:29:40.115Z`;
  the next invocation claimed version 155 and failed in 855 ms with the
  generic `NATIVE_EXECUTION_RETRY` code. It did not time out. A fresh
  read-only Neptune inspection returned zero linked artifacts; its diagnostic
  session was stopped successfully.
- The trusted execution worker has Neptune read/write but lacks
  `DeleteDataViaQuery`. AWS requires all three actions for `property()`,
  including the projector's single-value upserts. Actual packaged queries
  serialize successfully; the permission gap is independently reproducible
  from the installed policy. The agent runtime must retain no graph grants.

Current live evidence is under `efs-identity-recovery/live-applied/` in the
evidence directory below. Bootstrap reproduction is under
`/tmp/native-init-repro-20260929-uamqntra/early-stop-analysis/`; skill capture is
under `/tmp/native-codex-skill-capture-20260929-d06r_9a7/`.
Keep this stopped publication and both earlier failed attempts unchanged.
The immediate fix preserves the exact request, explicitly invokes the selected
skill, and transports the native conversation. The user has selected the native
intent page for composer proposals and questions. Completed user-facing turns
are required run content, separate from optional debug archives, and are not
treated as proof of human approval or workflow completion.

## Local corrections after the published result

The prompt builder now requires an explicit harness and uses `$aidlc` for Codex,
retaining `/aidlc` for the other harnesses. Exact request and transport-annex
bytes are preserved. Its focused suite passes **112 tests**, and a local capture
using the updated production builder includes the complete installed skill.
The composed executor/preparation/initialization/controller/store/graph run
passes **367 tests**. These are local results, not a new live workflow turn.

The Neptune permission correction adds `DeleteDataViaQuery` only to the trusted
execution worker's existing cluster resource. The regression failed before the
change; **15 IAM/wiring tests** now pass, including the agent-runtime boundary.
Terraform formatting and validation pass with the four existing deprecation
warnings. No deployment has occurred for either correction.

The producing session was stopped with HTTP 200 at `13:44:02.752Z`. Reloading
the authenticated page still lists revision 1 and opens the exact `index.html`
bytes/hash. The Graph tab correctly retains its pending-projection message.
This proves durable file reads after session termination, not harness-session
recovery or completed Neptune ingestion.

The user selected the native intent page after Start, including the composer's
own questions. The [interaction plan](native-initial-question-plan.md) now
covers ordered completed messages, protected member replies and serial
continuation. Do not silently select a plan or treat a displayed agent response
as a human approval. No synthetic stage artifact is needed. This new transport
is being implemented and locally verified; it is not deployed yet.

## Previous live verification: filesystem identity

- Recovery deployment **1155** passes all eight actual Lambda/archive hash
  comparisons. The published image is
  `sha256:287f8be755b7490aa6077739a74ffa00992a87352383d1735d8b1fed07e7bfab`;
  its ARM64 smoke check and six critical source hashes pass.
- Shared runtime, DEFAULT, the new observed-runtime state and both
  `CORE_RUNTIME_VERSION` consumers agree on **114**. The underlying AWSCC
  resource still records the old computed version; consumers now use the
  separately observed value.
- Execution recursion is `Allow`; the other three native functions retain
  `Terminate`. The fresh failed attempt reached `FAILED` automatically and
  the UI updated without manual queue repair.
- The new authorized same-task draft is
  `b255dd02-b500-4218-9616-aa3671d0b4f8`. It reused the existing verified
  v2.9.0 package and the exact original prompt/Codex selection. Preparation
  reached READY/version **16** at `12:55:50.298Z`, about **102.3 seconds**
  after the Prepare action. Independent preparation checks pass **25/25**.
- Start was accepted at `12:57:09.851Z`, creating attempt
  `bbab0dae-c34f-423e-ae04-cc76e54f7dc1`. Its execution endpoint uses version
  **2** and its preparation endpoint retains version **1**. All **12**
  independent attempt/IAM checks pass; the EFS access point has UID/GID
  **1000:1000** and root mode **700**.
- The controller recorded `FAILED`/version **25** at `12:58:37.617Z`.
  A subsequent status read recovered the saved failure, with only
  `harness-layout` in `initializationChecks`. That identifies the pre-setup
  baseline capture, rather than the later 18-check inspection. No model
  invocation or committed publication occurred. The diagnostic session was
  stopped with HTTP 200 at `13:03:02Z`.
- Node 24.19.0's actual internal stat conversion was exercised in the ARM64
  image with simulated high-bit 64-bit inode values. Valid unsigned file IDs
  appear signed in `BigIntStats`; our positive-only validator rejected them.
  The reproduction produces the same executor failure before any package
  command. **The live EFS inode value was not observed**, so the reproduction
  establishes a concrete bug and a matching failure mechanism, not direct proof
  of that particular live value.
- The correction canonicalizes valid signed/unsigned inode representations
  to exact unsigned 64-bit strings. It rejects invalid types/ranges and retains
  owner, directory, symlink and changed-identity checks. Fixed allowlisted
  baseline reason codes distinguish any remaining failure without returning
  paths, arbitrary errors or file contents. **396 composed backend tests** and
  **145 focused tests/independent review** pass. The rebuilt ARM64 image passes
  its smoke check and six-source hash comparison.

Applied evidence: `recovery-2/live-applied/` under the evidence directory below.
Inode reproduction: `/tmp/native-init-repro-20260929-uamqntra/efs-stat-diagnosis/`.
The new recovery plan and build evidence use `efs-identity-recovery/`.

## Applied deployment: exact filesystem identities

The reviewed saved plan is `/tmp/aidlc-native-efs-identity-dev.tfplan`, based on
state **1155**, with SHA-256
`316f61ae7bb50eea7c0b3fca45b6e5ecfa99a2ea646e57c08fad61611f7bd1f1`.
It updates the runtime image and six Lambda configurations: **7 AWS updates**,
with no AWS deletes, IAM, storage or API Gateway changes. Recursion remains
`Allow`. The Docker replacement retains the previous remote image. All eight
plan-referenced archives pass verification; all 1,069 frozen source files match.
The execution worker's deferred archive preparation still resolves to the
verified existing ZIP; actual deployed hashes need readback after apply.

The applied image tag is `2fb0aeb5bfc9f11d`. The final built image passes all four
signed-stat cases and both exact-package/application-commit cases, using its
bundled runtime code. Ordinary and simulated signed stats each pass 18
initialization checks, preserve all 20 tracked `.kiro` files and invoke no
model. The actual EFS retry is now verified above.

From the repository, the user deploys:

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock AWS_PROFILE=solution AWS_REGION=us-east-1 bash scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-native-efs-identity-dev.tfplan --skip-seed
```

The parent and independent receipts are in `efs-identity-recovery/`. The apply
and subsequent verification are complete; this historical saved plan must not
be applied again. Preserve the earlier failed attempts and their EFS workspaces.

## Live verification and recovery in progress

- All 32 deployed Lambda hashes match the reviewed archives. The published
  ARM64 image is `sha256:d02e17d59676946840c5e742f8dae472211e3c48dafc02874aab90a108511ace`;
  its smoke check and five critical source hashes match.
- Independent live checks passed for infrastructure permissions and the
  installed attempt-specific policy. Execution uses isolated runtime version
  **2**, while its preparation endpoint retains version **1**. EFS access point,
  root, mount and network remain unchanged.
- The first Start exposed an August repository binding without a revision.
  Reverification through the existing owner UI retained the same GitHub
  credential, user and repository, and created revision
  `c0a3128a-0ec4-4135-9e72-2ebbe0f34f9e`. The native revision guard remains.
- The local frontend now displays verified public API errors instead of hiding
  them behind generic Start feedback. Native draft creation stays visible when
  execution is enabled; its copy distinguishes preparation from Start. The
  combined focused frontend run passes 184 tests and typechecking.
- Attempt `4222fe9f-4ce5-4743-b52f-d008b75aea3b` started at
  `2026-09-29T12:09:09.462Z`; the runtime accepted it by `12:10:20Z`.
  Its pinned application commit is `d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`.
- AWS Lambda's default recursion protection dropped the intentional SQS polling
  chain. `RecursiveInvocationsDropped` records one drop at `12:11Z`; the
  protected row remained `RUNNING` although polling had stopped. A scoped
  `recursive_loop = "Allow"` correction is prepared for the execution worker
  only. Protected leases and terminal states still govern each run.
- A read-only `native-status` call to the same attempt/session returned
  `failed / native_execution_initialization_unverified`. Setup commands had
  exited successfully; the filesystem inspection rejected initialization
  before the model command. No publication objects exist for this attempt.
  An exact local reproduction using the published ARM64 image, verified package
  and pinned application commit failed only `harness-layout`: flappy-bird already
  tracks `.kiro`, while the selected harness is Codex. The live runtime did not
  expose individual check IDs, so this cause is established by reproduction.
- The corrected executor captures existing known harness directories before
  package commands, then verifies the same directory identities afterward.
  Default isolated initialization remains strict, and unexpected new directories
  still fail. Both the actual repository and an empty project pass all 18
  checks; all 20 tracked `.kiro` files remain byte-identical. The focused fix
  passes 119 tests. This reproduction executes setup only, with zero model
  invocations. Failed initialization now retains bounded fixed check IDs/statuses
  for diagnostics.
- One normal queue pointer reconciled the existing failed attempt at
  `2026-09-29T12:37:47.791Z`. Its protected status is now `FAILED`, version **39**;
  the controller closed its fence and stopped the session. No new attempt or
  model turn was dispatched.
- Shared DEFAULT runs version **113**, but Terraform and two consumer Lambda
  environment values retained **112**. This affects version/image provenance,
  not DEFAULT routing or this isolated native endpoint. An update-dependent
  runtime observation is prepared; historical Standard revisions are not
  being relabeled.

Concrete observations are under the evidence directory below, including
`deployed-lambda-proof.json`, `deployed-image-smoke.json`,
`independent-native-infra-live-20260929-summary.md`,
`independent-native-attempt-4222fe9f-summary.md` and
`live-native-runtime-status.json`.

## Visible result and first verification

The flappy-bird drafts `e0d2836d-c794-48d0-8b77-52550cf3c65a` and
`b255dd02-b500-4218-9616-aa3671d0b4f8`, **Fix the pipe visualization**, record the
failed initializations above. Preserve those immutable attempts and workspaces.
After the next recovery deployment, create a
fresh native draft with the same authorized prompt, Codex harness and official
AI-DLC v2.9.0 package. The controller resolves the actual application's default
branch and commit before dispatch. It uses the starter's existing effective
credential binding; the API never accepts credential or image overrides.

After the user deploys, verify the exact deployed code/configuration, open this
fresh draft through the normal project list, and Start once. Observe the first
workflow question, open its file in Overview/Files and follow its graph link.
The first verification stops there. Answer, Approve, advanced edits, per-unit
PRs and native deletion remain disabled. Test a repeated Start, reload, a
second member, denial and durable reads after stopping the producing session
before calling milestone 1 complete.

## Connected implementation

- `RUNTIME` remains the immutable preparation record. A separate protected
  `EXECUTION` record owns start/configuration pins, one attempt/session, leases,
  cancellation epoch, the committed publication and graph projection status.
  It is not indexed as another native draft and creates no platform META.
- The controller upgrades the run's existing isolated runtime and role,
  verifies its EFS access point/root, and creates a separate version-pinned
  execution endpoint. It does not replace the recorded preparation image or
  endpoint. Preparation alone still invokes no model.
- A new controller-only credential Lambda rechecks the protected execution,
  preparation, existing memberships and repository bindings. The native runtime
  cannot invoke this function, read credentials from SSM, write the protected
  table or write the graph. Git credentials are confined to trusted checkout;
  the model receives only its selected model credential.
- The runtime restores the pinned prebuilt workflow package onto EFS, checks
  out the exact application commit, installs the selected harness files and
  runs asynchronously. Active harness homes remain on local AgentCore disk.
  Duplicate dispatches retain the same attempt and runtime session; a cold or
  ambiguous owner never creates another model writer automatically.
- Native subprocess output is bounded and drained without terminating the
  model for output size. Model turns have no application deadline. Short SDK
  and setup deadlines bound individual controller/transport operations.
- The runtime uploads versioned file bytes and an uncommitted manifest. The
  trusted controller reads and verifies every referenced version, hash, path,
  package and source pin before conditionally committing the publication.
  A CLI exit or transcript text alone cannot establish a native question or
  workflow completion. Missing session identity preserves files as a stopped
  result without promoting a question.
- Graph ingestion follows committed files. Intent, Artifact and Question
  vertices have deterministic project-scoped identities; retries reuse them.
  Existing vertices must match their expected scope before updates. Member
  file/graph reads derive from the protected publication, not graph authority.
  The graph is a recoverable projection; failure retains committed files.
- Cancellation fences publication immediately in DynamoDB. The controller also
  writes a cancellation record in an S3 prefix that runtimes can only read.
  ACTIVE is create-only, and CANCELLED cannot be reopened. The runtime checks
  the latest record before preparation and immediately before model spawn.
  This covers dispatches delivered after StopRuntimeSession. Interrupted stop
  or failure persistence retries cleanup while the fence remains closed.
- The existing native page uses the shared ArtifactViewer and GraphCanvas.
  Publication identity, account/session generation and denial checks protect
  asynchronous reads. Unsupported actions remain closed in the UI and API.

## Local verification

The final native foundation run passes **4,367 tests**. The frontend subtask
passes **243 focused tests**, typechecking, production build, scoped lint and
formatting. Terraform validates with zero errors and four existing deprecation
warnings; **13 offline IAM/wiring checks** pass. The ARM64 image builds and its
container smoke check passes, including UID 1000, health/routing and imports of
the actual execution modules. Five critical container source hashes match the
workspace.

Independent review found and resolved a late-dispatch cancellation race,
cross-project graph vertex collisions, pre-invocation lease expiry, and retry
cleanup after a closed fence. The composed API/storage tests also found and
fixed UTF-8 BOM loss. Final targeted review reports no remaining blockers
within its reviewed scope. These are local tests and reviews, not live
inference, EFS checkout, deployed authorization or graph ingestion proof.

Evidence directory:
`/tmp/aidlc-plan-tools/native-execution-m1b-20260929/`.
The prior M1a proof remains unchanged under its own deployment directory.

## Applied initialization and polling recovery

The applied saved plan is
`/tmp/aidlc-native-initialization-recovery-dev.tfplan`, based on state **1153**.
Its SHA-256 is
`540e37fa60eefa1600800dabcfb8f033d97856cb8e7db2ac72138ed0e257582c`.
This superseded the intermediate polling-only plan. Its deployment was verified
at state 1155 above; use the newer filesystem identity plan for the next apply.

It contains **8 AWS changes**: the shared runtime image update, six consuming
Lambda configuration updates and the execution worker's recursion setting.
There are no AWS resource deletions or API Gateway changes. The Docker
replacement retains the previous remote image. Other deletions are local build
bookkeeping, including deposed records from previous applies. The plan is a
scoped recovery and does not establish full-stack convergence.

All **8 plan-referenced Lambda archives** exist and pass ZIP integrity/content
hash checks; all **1,069 frozen source files** remain unchanged. The execution
worker's filename is deferred in Terraform, but its saved archive-preparation
program and query are fully known. Running those exact inputs resolves the
already-built archive with SHA-256
`facb3b67a317ec76f8d05b8fd3df85a080f0d7098969cd6933a135b7185f75a1`.
Verify its actual deployed Lambda hash after apply.

The image tag is `4f35aa934e7786d9`. The local ARM64 build passes its smoke check,
and six critical runtime source hashes match the workspace. Running that built
image with the verified workflow package and exact application commit passes
all 18 initialization checks without modifying the 20 tracked `.kiro` files or
invoking a model. The combined focused backend run passes **370 tests**; the
frontend run passes **184 tests**, typechecking and production build.

The new shared-runtime observation waits for the completed runtime update and
checks status, version, identity, image, environment and role. Its observed
version feeds both `CORE_RUNTIME_VERSION` consumers. The resulting published
image digest and runtime version remain apply-time values and must be verified
after deployment.

From the repository, the user deploys with:

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock AWS_PROFILE=solution AWS_REGION=us-east-1 bash scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-native-initialization-recovery-dev.tfplan --skip-seed
```

Plan review and package evidence are under `recovery-2/` in the evidence
directory. Exact runtime reproduction evidence is under
`/tmp/native-init-repro-20260929-uamqntra/evidence/`, including
`finalimage-reproduction.json`. The recovered failed UI is captured in
`native-failure-reconciled.jpg`. After deployment, verify actual image/runtime
and Lambda values, then use a fresh draft as described above to reach the first
question, files and graph.

## Previously deployed recovery plan

The replacement saved plan is `/tmp/aidlc-native-first-turn-docker-dev.tfplan`,
based on state **1148**. Its SHA-256 is
`79315282ab35dd35a9f3a3aeb48231865cf68ca8ed9cbaf612a396163a894eeb`.
The user's previous apply completed some changes before the Docker provider
failed, so `/tmp/aidlc-native-first-turn-dev.tfplan` is stale.

The remaining 29 AWS changes are 15 creates, 12 updates, one API Gateway
deployment replacement and removal of one obsolete deployment (`3jgmom`).
The live API has only the `dev` stage, pointing to `tjl2hx`; it does not use
that obsolete deployment. No persistent resource is deleted or replaced.
All remaining AWS resource addresses belong to the previously reviewed plan.
The plan is scoped to native execution, its configuration guard and API
publication, including dependencies; it does not establish full-stack
convergence.

All 32 referenced Lambda ZIPs exist and match their verification receipt.
The contents of all 28 non-native Lambda packages match their deployed-state
code-hash-validated archives. Shared build-input hashing causes their
redeployments. The ARM64 build is local; the user-operated apply builds/pushes
the source-derived image tag and binds its registry digest.

The controller has a 120-second invocation window, 180-second lease and an
80-second runtime transport window. Normal polling and recognized transport
uncertainty release the lease and enqueue a fresh five-second pointer with the
same attempt/session. The queue's 720-second visibility period protects crashed
controller invocations; it is not the normal retry delay or a model deadline.

The replacement plan includes a fresh scoped refresh after the partial apply.
Its 57 drift records account for default/computed normalization, EFS usage,
cached IAM/S3 metadata and the previously observed shared AgentCore runtime
version change from 111 to 112 with identical image/configuration. The image
update makes the resulting version unknown. After apply, verify the deployed
runtime version/digest and consuming Lambda `CORE_RUNTIME_VERSION` values.

The execution-worker policy still depends on new resource outputs. Its source
expression was reviewed, but its rendered value must be verified after apply.
The API policy, runtime boundary, credential policy and bucket policy created
or updated by the partial apply are now no-ops in the fresh plan.

From the repository, the user deploys with:

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock AWS_PROFILE=solution AWS_REGION=us-east-1 bash scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-native-first-turn-docker-dev.tfplan --skip-seed
```

The earlier `DOCKER_CONTEXT=default` instruction was incorrect: the same
Terraform Docker provider (3.9.0) reproduced the user's context-loading error.
Unsetting that variable and connecting directly to the Docker socket passed a
read-only provider image lookup and a local ARM64 build using the default
builder. This does not require changing the user's saved Docker context.

Recovery preparation performed no deployment, image push or real model
invocation. All 1,032 frozen source files and all 32 package hashes remain
unchanged. `handoff-receipt.json`, `docker-recovery-proof.json`,
`docker-provider-probe/` and `source-freeze.json` under the evidence directory
retain the concrete inputs and remaining verification.

## Current boundaries

The four harness adapters have local coverage; the first connected live proof
uses Codex. All-four live acceptance, public/private provider coverage, shared
answers/approvals, subsequent turns, typed graph enrichment and recovery across
fresh sessions remain later checkpoints in the active delivery sequence.

Published bytes are required execution records in a private versioned S3
bucket. Optional debug archive settings do not expire them. Private control
records, harness homes, session material and workflow locks/keys are excluded
from user publications and future Git commits. The EFS checkout remains the
native working directory.

The first checkout supports one repository and fails explicitly for submodules,
tracked symlinks, LFS content or tracked private native state. Publication has
bounded file count/size and fails rather than truncating or silently omitting
files. Inline reads support files through 3 MiB; larger files remain listed
but full download transport is not implemented. Generic graph links are
implemented; document sections and typed semantic entities are not yet
projected. Large-repository projection throughput has not been qualified.

Runtime lifecycle termination is still a cloud service boundary, not workflow
completion. Required recovery across that boundary is not claimed by M1b.
Existing Neptune membership remains the agreed trust limit; graph availability
is still required for membership checks.
