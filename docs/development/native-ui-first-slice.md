# First shared native UI slice

29 September 2026 — `feat/native-aidlc-execution`.

The next feature result is a real native intent in the **existing Intent UI
and graph**, with its first question and exact files visible to two project
members. The user selected the preparation timeout fix on 29 September and
deferred pre-provisioning. Dedicated resources per run remain in place.
The complete pilot still requires protected answers/approvals, all four
harnesses, serial execution and checkpoint recovery.

## Decisions confirmed by the user on 25 September

- **D19:** isolate each native run's working files, including from other runs
  in the same project. Project members may share published artifacts through
  the application. The runtime, EFS access point and permission boundary must
  be bound to the execution; attempt ownership is enforced inside that boundary.
- **D9:** native execution is opt-in for new intents; the current backend stays
  the default. Existing executions retain their backend.
- **D8:** use **flappy-bird** in **dev** for the first native-intent pilot.
- **D7:** reuse a recovered approval only when it can be reliably matched to
  the restored approval step and content. Otherwise present the approval again
  and require fresh human confirmation.
- **D10:** no application-imposed turn timeout, token limit or spending cutoff.
  Keep the previously agreed serial execution model.
- **D10:** platform settings control storage of snapshots and conversation
  archives for debugging: **off** by default, with **7 days** default retention
  when enabled. Required recovery checkpoints/session state for unfinished or
  resumable work remain available independently of these settings.

These decisions retain AgentCore microVMs, EFS working files and local harness homes.
EC2/Instances is excluded. The current synthetic runtime's shared EFS mount is
not a real-project boundary. New directory names or enabling one project in the
UI do not establish isolation. Runtime selection must fail if the project's
binding is absent; it must not fall back to that shared test runtime.
Snapshot access, package access and credential grants must use the selected
scope too. Copying the current broad role is insufficient.

Recovery snapshots and saved harness conversation archives belong outside the
application checkout, including `aidlc/`, and must not enter Git commits.
Native workflow artifacts retain the layout expected by the pinned AI-DLC
package; private runtime records inside that layout need explicit commit
filtering. Durable native checkpoint publication and this filtering are still
implementation work.

No application cutoff does not remove the cloud service's lifecycle limits.
AWS documents a maximum microVM lifetime of 28,800 seconds. The native recovery
path must qualify continuation across that boundary without interpreting
termination as workflow completion or failure due to an application budget.
Source checked 25 September: AWS AgentCore guide, “Configure Amazon Bedrock
AgentCore lifecycle settings.” No switch to EC2/Instances is proposed.

## Active delivery sequence

Complete one visible loop and verify it in dev before expanding it. Keep
deployed evidence in the relevant checkpoint; local test counts alone do not
complete a milestone. Deployment is user-operated.

| Step                                                   | Result the user can verify                                                                                                                                 | Completion evidence                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Preparation timeout — verified**                  | Prepare succeeds through its first filesystem invocation instead of aborting at 20 seconds                                                                 | State 1143 matches the reviewed worker/queue settings and code. Fresh I/J reach READY in 98.968/101.093 seconds without invocation abort or long recovery; independent EFS checks pass and both sessions stop. No seconds-level startup target or pre-provisioning work is added.                                                                          |
| **1. First native turn in the existing UI and graph**  | Create/open a native intent from the normal Intent experience, start its harness, then read its real first question and files and follow their graph links | One logical turn despite duplicate Start; two members see identical text/file hashes and the same published revision after reload and after session stop. Generic Intent/Artifact/Question graph links resolve to those files. Denied users see no cached details. Answer/Approve remain disabled until step 2.                                            |
| **2. Shared answers and protected approvals**          | Answer in the existing question UI, receive the next native question, and approve a real native gate                                                       | An accepted answer is applied to the expected native question and continuation runs. A real approval is bound to the exact presented step/content. Racing members, duplicate delivery, stale content and forged runtime audit text cannot create a second or unauthorized acceptance.                                                                      |
| **3. Continuing execution, graph detail and recovery** | Progress, artifact history and traceability follow further native turns; a stopped session can resume and finish                                           | Subsequent revisions, renames and deletions converge in both member views. Recognized native documents produce the expected typed graph entities/links. Projection replay is idempotent. Forced interruption before/after publication and human acceptance resumes in a fresh session without lost committed files, late publication or duplicate actions. |
| **4. Integrated acceptance**                           | Complete the same small workflow using Claude Code, Codex, Kiro and OpenCode through the existing UI and graph                                             | Four end-to-end runs cover questions, real approvals, generated artifacts/code and recovery; platform-backend regressions remain green. Complete the already agreed public/private GitHub/GitLab/Bitbucket source matrix before claiming broad provider support. Keep advanced edits and per-unit PRs disabled in UI and API.                              |

Steps 1–2 establish the first interactive native execution. Steps 3–4 establish
the agreed recoverable, supported pilot. A first step-1 demonstration may use
one harness to shorten the integration loop; this is explicitly partial and
does not replace all-four acceptance.

### Step 1 implementation

M1a discovery is deployed. The connected M1b implementation is locally verified
and awaiting deployment; see the [first-turn checkpoint](native-first-turn-checkpoint.md)
for its evidence and remaining live acceptance criteria.

1. **Connect native identity to existing discovery and navigation.** Query a
   project/creation-time index on the protected native binding table, validate
   every result with a consistent source read, and merge public summaries with
   platform intents for display. Keep the backend and project in each display
   identity. Process META remains agent-writable and cannot establish native
   authority; do not copy native drafts there or treat a platform row's backend
   flag as a protected native binding. Recheck membership before returning a
   page, clear native results on identity changes or denial, and preserve saved
   native URLs. Add the graph Intent anchor with durable publication in the
   following increment. Route future native starts before the platform plan
   compiler and retain the protected runtime resolver.
2. **Add the actual start contract and supervisor.** Keep resource preparation
   `READY` separate from execution `RUNNING`/waiting status. Persist an
   idempotent start/dispatch record, serial owner, attempt epoch, cancellation
   state, native session mapping and publication head. Pin the package, source,
   harness/adapter, image, repository revisions and starter credential binding.
   Reconcile uncertain dispatch instead of starting another writer.
3. **Run the selected native workflow.** Extend the isolated runtime beyond
   its fixed filesystem check. Reuse the qualified package loader and four
   harness mechanisms, extracting them from the operator probes. The production
   command runs asynchronously and uses native lifecycle evidence to identify
   a human wait, completion or failure. Probe prompts, fixed identities and
   finite model-turn deadlines must not enter this path. CLI exit alone does
   not prove workflow completion.
4. **Grant only execution-scoped access.** The current isolated role has EFS,
   image and logging access; package reads, credential resolution and result
   publication still need explicit wiring. Reuse existing source/model
   connections through a native binding/attempt check. Keep approval and
   dispatch authority outside runtime-writable stores. The trusted ingestion
   component owns graph writes; do not copy the broad platform runtime role.
5. **Publish exact files before announcing a turn.** Store validated files and
   immutable object versions, then conditionally commit a manifest/head and
   ingestion outbox for the current epoch. Include scope, package, sequence,
   relative path/file role, hash and completeness. Use stable identity based
   on execution/root/path, with separate content revisions and tombstones.
   Exclude secrets and active harness stores. The probe's selective/redacted
   snapshot is not an exact publication or recovery implementation.
6. **Populate the existing views from that publication.** Add a native branch
   in IntentContext/IntentView, reuse ArtifactViewer/history and the graph
   page, and add an intent-level Files section for files without platform
   stage instances. Show the exact pending question read-only. Generic
   Artifact/Question/section nodes link back to the committed revision.
   Native progress comes from native engine evidence; do not manufacture a
   platform compiled workflow or require platform YAML schemas in native files.
   Unknown files remain visible; optional enrichment follows raw publication.
7. **Verify the connected result.** Use the real member UI, one duplicate Start,
   a second member session, exact file/hash comparison, graph-to-file links,
   session stop/reopen, cancellation fencing and unauthorized read/write tests.
   Carry denial clearing and late-response guards into the reused Intent and
   graph caches. Confirm platform intents still load and run normally.

Implementation within step 1 uses two short increments:

- **M1a — discovery/navigation/status:** native drafts appear in normal project,
  sidebar and dashboard discovery and open their native status page. Native
  work, graph, edit, delete and model-start actions remain unavailable until
  their corresponding backend paths exist. Listing is paginated and eventually
  consistent; status details remain authoritative. This increment adds the
  protected index and collection API, without process META or graph writes.
- **M1b — first real turn and publication:** connect the supervisor, scoped
  runtime permissions, exact durable files, first question and existing Intent
  and graph views described below.

The feature milestone is complete only after the real question, files and
graph are verified together. M1a is now deployed at state **1144**: actual API
bytes/permissions, index backfill and authenticated project/sidebar/dashboard
navigation pass. See the [discovery checkpoint](native-discovery-checkpoint.md)
for evidence and remaining qualification limits.

The approved M1b task is the separate native **“Fix the pipe visualization”**
draft `e0d2836d-c794-48d0-8b77-52550cf3c65a` in flappy-bird. It is Workspace
ready with Codex and the official v2.9.0 package, preserving the existing
platform draft. Before enabling Start, explicitly bind and verify an
execution-capable image and policy without changing its identity or package
pin. A global image deployment cannot upgrade this draft's immutable
preparation binding by itself. Resolve the configured application repository's
base commit and the authenticated starter's existing credential binding;
connection metadata alone does not prove checkout or inference.

### Human actions and recovery contracts

For step 2, persist the immutable pending presentation and an accepted-action
ledger/outbox behind the isolated authority boundary before enabling the
existing QuestionEditor/GateCard handlers. Record responder, content revision,
native challenge and original execution credentials. Expose accepted, delivered
and applied as distinct states; a graph mirror, realtime event or native
`HUMAN_TURN` record does not authorize execution. Re-fetch durable state or
check sequence/revision before applying realtime question updates.

Step 3 adds periodic and turn-boundary recovery checkpoints, local harness-store
export/restore, cancellation and protected resume. Checkpoints live outside
the checkout and never enter Git. Optional debug retention does not govern
required recovery. An approval is reusable only when the restored step and
content match reliably; otherwise request it again. Exercise service-lifetime
recovery without introducing an application turn/token/spending cutoff.

Projection failure must preserve committed files and allow replay. Because
current membership reads use Neptune, a total Neptune outage can still block
authorized reads; durable storage does not imply authorization availability.
Typed graph extraction in step 3 is qualified against pinned native formats,
while generic files/sections remain available for unfamiliar fork output.

Primary reuse points: native-runtime-control API/store; the protected native
runtime binding; native package loader and harness adapters; IntentContext and
IntentView; ArtifactViewer/history and IntentGraphPage; artifact versioning,
generic extractors and graph read/write primitives. The existing
`native-workspace-projector.js` exports platform state to native files; it is
not the ingestion adapter needed here. Existing question graph insertion must
also become idempotent for native publication replay.

## Foundation evidence and earlier first-slice contract

The user's debug archive preferences now have a settings API and platform UI.
The [settings checkpoint](native-debug-settings-checkpoint.md) records local
verification and the completed authenticated save/reload round-trip on runtime 111. Preferences are restored to off/seven days; capture and cleanup are not yet
connected. Native runtime selection guards and a protected-binding reader are
also locally implemented. The deployed increment adds a real native draft
with explicit workspace preparation: one runtime, role and EFS access point per
run, with a live filesystem check before readiness. Model dispatch remains
disabled until that path is verified.
The [preparation checkpoint](native-workspace-preparation-checkpoint.md) records
the dedicated native draft/status routes and explicit preparation action.
Authenticated draft creation and saved-URL recovery are now verified in the
local frontend. The EFS tagging repair is deployed and access-point creation
now works. A repeated Prepare request left the protected row unchanged.
IAM/identity provisioning repairs are now applied through state 1139. Run A
reaches **Workspace ready** in the UI with its own runtime/version-pinned endpoint,
role and EFS access point. One diagnostic abort recovered on the next automatic
retry. A fresh independent session verified NFS4 writes/readback, hard links,
atomic rename and cleanup, then stopped with HTTP 200. Run B now passes too,
using distinct runtime/role/AP/root resources. Bidirectional mismatched-request
rejection, IAM cross-AP denial simulations and unauthenticated API rejection
pass. Physical cross-mount and the remaining authenticated write/other-project
checks remain open. B's newly created IAM role needed a manual retry. State **1140**
now deploys the worker fix: fresh C and D each reproduce the exact error and
reach READY automatically with unchanged role/AP and creation parameters.
Both pass independent fresh-session filesystem checks; C's independent
configuration review passes **21/21**. Duplicate Create and repeated Prepare
after D is READY both return **200** with its entire protected record unchanged.
The UI keeps model and human-action controls disabled.
Native drafts were not in the existing intent list at that preparation
checkpoint; M1a now adds and verifies that discovery path.

Authenticated nonmember item reads and the native draft capability read now
return 403 through the real UI/API. Existing run details and the creation form
are absent. The page also clears previously loaded content on a later
401/403/404, invalidates late completions and stops polling; these revocation
and concurrency cases are local regressions, not a live revocation test.
All 48 related UI tests and the TypeScript/production build pass. Direct
unauthorized POSTs, another enabled project's boundary and physical
cross-mount behavior remain unqualified.

1. Add the native intent/start contract. Reuse existing membership and source
   bindings; pin backend, package/source, harness, image and starter credential
   binding. Route native starts before the current platform plan compiler.
2. Provision the selected isolation boundary and bind runtime selection to the
   project/execution. Make start retry-safe; enforce one writer and an attempt
   epoch; reject late publication after cancellation. Do not repurpose synthetic
   operator identities or its fixed package as real project execution.
3. Execute one native turn and publish a bounded, path-validated snapshot with
   hashes, object versions and ownership epoch. Exclude credentials, steering
   keys and private active harness stores. Publish files durably before making
   them visible. Optional graph enrichment must not delay raw-file visibility.
4. Add the shared read-only view for execution status, exact first question and
   native files. Both members read the same published revision. Keep response,
   approval, advanced edit and per-unit PR actions visibly disabled until their
   corresponding backend paths are available.
5. Deploy with the user and verify one authenticated start despite a duplicate
   request, exact file bytes, two-member visibility, denial to nonmembers and
   other projects, persistence after the producing runtime stops, cancellation
   fencing and rejection of unsupported actions.

The preparatory frontend response guards are implemented and locally verified.
Native question answers, approval/review controls and feedback fields are
disabled with an explanation; the component submission handlers and shared
intent context also block those responses. Legacy and platform responses retain
their behavior. This does not enable native intent creation or execution.

Validation: 132 focused tests across five files passed. After a test-fixture
typing correction, the affected 18 tests passed again; full frontend typechecking,
lint and formatting passed. Parent review confirmed the ten tested file hashes
and the visible-control/submission guards. See the
[frozen validation record](/tmp/aidlc-plan-tools/native-kiro-prompt-applied-20260925/ui-response-guard-freeze.json).
The dedicated native draft/preparation UI is now verified. Browser verification
of the earlier response guards inside platform/legacy intent views remains open.

D19/D9 and the first-pilot operating choices are settled. Implement the native
start and runtime boundary, then durable publication and the shared view.
Deployment remains user-operated.

The protected accepted-action store (P3) remains required before native answers
or approvals are enabled (P6). Existing membership is reused as requested;
OAuth and membership bootstrap decisions are not reopened. Native HUMAN_TURN
or audit text cannot prove a person approved an action. Kiro's live ACP load
also emitted native `SESSION_STARTED` with `Source: startup`; ingestion must
bind records through the control-plane session/attempt, not infer identity from
that event label. This slice does not claim cold conversation recovery.

Current code entry points: `lambda/shared/execution-backend.js`,
`lambda/intents/index.js`, `lambda/shared/runtime-target.js`,
`lambda/shared/v2-process-store.js`, `frontend/src/pages/NewIntentPage.tsx`,
`frontend/src/contexts/IntentContext.tsx` and
`frontend/src/lib/executionCapabilities.ts`.
