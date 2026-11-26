# Native composer checkpoint — 30 September 2026

**Latest result: the same Codex conversation resumed after cold-session recovery,
and turn 2 is visible in the intent and graph.** The user-authorized clarification
was accepted once and kept the proposed plan unapproved. Independent verification
passed 37 checks, including byte-for-byte prior rollout continuity, one primary
user-role occurrence of the reply, and exact versions/hashes for 439 checkpoint
files. The response survives reopening and graph-to-response navigation works.
Reply to recovery-ready took **4m 7s**; reply to the next response and completed
graph took **5m 30s**. The initial test Stop returned 404, so this proves the
observed cold-session recovery rather than a separately confirmed forced Stop.
See the [current recovery result](native-session-recovery-plan.md#current-live-checkpoint).

The following paragraphs preserve the earlier composer and recovery history.

The first real AI-DLC plan-selection question is now visible in the native
intent Overview. Reopening the intent preserves the same ordered messages.
The initial question verification stopped with an empty reply field. Following
the graph correction deployment, the user submitted `1` to choose Compose.
Reply transport and immutable publication passed, but the workflow returned
an invalid-command error. The user then authorized an explicit Compose request
in the same intent; that request is saved. Graph ingestion is now complete,
but a cold runtime cannot reconstruct the harness session. No plan or workflow
gate has been approved.

## Latest recovery deployment

The recovery implementation is deployed and its runtime 117/image/Lambda
hashes are verified. The old execution failed during deployment when the
credential resolver compared its old image pin to the new global image;
its saved reply and committed Files/Graph remain preserved. The
[image compatibility follow-up](native-pinned-runtime-compatibility-follow-up.md)
records that separate defect.

The user approved a new recovery-test draft,
`b484ecf5-8cd9-42dd-875c-f1fa0c7678f3`, with the same request and explicit
Compose. Preparation passed in 102.554 seconds. The missing controller S3
permission is fixed in deployed state 1177. The same draft passed Start
admission and seven status checks, then stopped with `DELIVERY_UNCERTAIN`.
No question or recovery checkpoint was published. The original failing status
response was not logged. The user approved status-only retries after an
acknowledged turn; the deployed controller correction combines this change with
bounded diagnostics, preserving the guards against uncertain replay.
The user applied the reviewed plan after **991 controller tests**, independent
source review and **56 plan checks** passed. Deployed state **1178** passes
**36 applied checks**, including exact Lambda hashes and the unchanged runtime
image. The old draft remains stopped. The user approved fresh test
`9a36cf43-eacb-4b9d-a4e3-4b5ceaecb831`; Start was accepted at 10:09:41.715 UTC
and its first composer question was saved at 10:21:03.423. Graph projection
completed at 10:21:10.900: **11m 22s** to the saved question, **11m 29s** including
projection.

The actual response proposes a custom plan and asks the user to approve, edit,
reject or provide another instruction. It notes that the unchanged scaffold
branch lacks a pipe implementation. The response survives reopening; **16
published files**, the **18-node/17-relationship graph** and graph-to-file
navigation are verified. All **439 private checkpoint files**, totaling
7,825,265 bytes, passed independent S3 version/hash/length verification.
The controller recorded **108 successful status reads and no retries**.
The first waiting point and checkpoint storage passed. The subsequent live
Codex recovery result is recorded above; a live status-read failure remains
unqualified.
Follow the [current recovery checkpoint](native-session-recovery-plan.md#current-live-checkpoint)
for the measured timeline, evidence and remaining restart checks.
At that first checkpoint, no new human reply or workflow approval had been
submitted. The later clarification did not approve the plan.

## Earlier checkpoint: legacy run recovery required

The graph cleanup plan was applied on 30 September. State **1167**, the
execution worker hash `qCjKsYdeQ/WWwBcJgHta4PJtiufLvaEJvpsDMzae1pI=`,
the byte-identical credentials dependency and the unchanged runtime/image pins
are independently verified. A single retry of the existing queue pointer
completed publication-2 ingestion in **4.08 seconds** at 07:12:56 UTC.
The live graph contains **18 nodes and 17 edges**.

At **07:17:13 UTC**, a status-only invocation of the same pinned AWS session
returned the same sequence-2 publication, interaction and Codex session ID with
`recovered: true`. This proves that EFS-backed result records survived; it does
not prove that the local Codex rollout survived. No model turn was started by
that diagnostic. The saved sequence-3 Compose request must not be resubmitted
or replayed based only on its pending delivery marker.

The user chose durable session recovery next, with automatic recovery at a
verified waiting point and explicit review for uncertain execution. Follow the
[recovery plan](native-session-recovery-plan.md). Evidence is under
`/tmp/aidlc-plan-tools/native-graph-cleanup-20260930/live-applied/`, especially
`independent-verification.json`, `parent-requeue-once.json` and
`parent-existing-session-diagnostic.json`. Earlier sections retain the
chronological evidence and are superseded by this checkpoint where noted.

## Verified deployment and run

- Environment: `dev`, `us-east-1`; Terraform state serial `1164`.
- Shared AgentCore runtime: version `116`, READY.
- All 32 plan-referenced Lambda code hashes match the reviewed archives.
- The deployed authenticated `/interaction` and `/response` routes point to
  the native controller.
- The published ARM64 image matches all ten reviewed critical source hashes
  and all four pinned harness versions. Its 21 filesystem layers and container
  configuration match the reviewed local image.
- Published image digest:
  `sha256:ffe68c138cb900a95ffcd82298852e0686c2c6462f03cb37dcdd11f4ad302329`.
- Fresh flappy-bird draft: `cb6c2fdd-1cf7-46f3-844c-f81d223353b0`.
- Attempt: `06dbdcf5-a041-43c8-ac49-8981cab80494`; Codex, AI-DLC v2.9.0.
- The original “Fix the pipe visualization” prompt is unchanged:
  `dca3e594f2b7937801bc3bfc7990b2d077ff811682ad5023354078ed2f40cfb3`.
- The application remains pinned to the existing default scaffold branch and
  commit `d99d2511c43f07ff2451e7e13f5a8f45b16dfce2`.

The actual response offers Compose, Express, Classic, Feature and Other, and
recommends Compose. It consists of two ordered messages: an introductory
sentence followed by the plan-selection question. This live response contains
no table; table rendering remains covered by the local UI checks.

At the first question the protected execution was `AWAITING_USER`, sequence 1. Its file publication
has outcome `STOPPED` and no question file, as expected for a composer question
before an active intent exists. Ordinary assistant text is not promoted to a
file-backed gate, human approval or workflow completion.

## Timing

All timestamps below are UTC.

| Boundary                        | Observation  |
| ------------------------------- | ------------ |
| Prepare clicked                 | 06:19:53.468 |
| Workspace READY                 | 06:21:30.091 |
| Start clicked                   | 06:21:42.885 |
| Protected start accepted        | 06:21:44.481 |
| Runtime entered model execution | 06:25:44.019 |
| File manifest created           | 06:27:48.573 |
| Interaction created             | 06:27:49.409 |

Preparation took **96.623 seconds**. Start acceptance to the runtime's model
execution checkpoint took **239.538 seconds**, including the isolated runtime
upgrade, initialization and initial snapshot. Model execution through
interaction publication took **125.390 seconds**; this is not a pure model
latency measurement. Start click to saved question was **366.524 seconds**.
No application model timeout was added.

## Durable content and UI

Publication:
`777a17cff7c0617aad0f461ff776eb40cf67e41667afbd2eecccda623e5cd0e0`.

Interaction:
`cf5b9bd16957330fc47c069e3ad2a2bca23bc0d45ae57a05924adefe9c06c31b`.

Independent verification passes **117 checks** across the protected pins,
interaction, manifest and all 16 versioned files, totaling 28,654 file bytes.
The exact versioned interaction object is 1,188 bytes. Its SHA-256, byte length
and S3 version match the protected receipt, and its messages match the live
page. The publication contains 16 files. `index.html` opens through Files and
through its graph node with the expected 1,089 bytes and SHA-256
`36836a36f1c740d27bbbb70cdec9361e076e44fe99b41199b45ccad378ed8a00`.

The original graph displayed one Intent and 16 Artifact nodes. The controller
reports its file projection complete. The member-facing graph is derived
from the protected manifest; viewing it is not an independent readback of
Neptune vertices. Direct Neptune readback was not completed because its private
endpoint was unreachable from the local verification host.

## Gap found by live verification

The local preview fixture supplied an `AI-DLC response` graph node. The
deployed production graph builder did not create one. Therefore response-node
navigation was not delivered by the composer deployment, despite passing the
preview check. The correction now feeds the same verified immutable interaction
into both the member graph API and the trusted Neptune projector. It passes 105
focused tests, independent source review, and a local production-builder check
against this run's real S3 interaction: 18 nodes and 17 edges, including the
correctly bound response node. The first-question display and durable reads do
not depend on this correction.

The applied follow-up plan is `/tmp/aidlc-native-composer-graph-dev.tfplan`,
SHA-256 `a07cddfc4018d0758c2c5e7dca837d36720f26b570feb57093830832f911f2fa`,
based on state `1164`. It contains three Lambda updates: changed API and worker
bundles, plus a byte-identical credentials bundle dependency. All three archives
and 645 frozen source inputs are verified. It changes no runtime, image, IAM,
API Gateway or persistent resources. The user applied it; state **1166** and
all three deployed Lambda code hashes/configurations are verified. The shared
runtime, image and version consumers remain on **116**.

The live graph now shows the response from this existing committed interaction.
Clicking its response node opens the correct saved question in Overview.
The already-successful Neptune file projection is not
requeued. Qualification of the new persisted response vertex requires the next
user-driven publication; it must not be claimed from the graph API alone.

The user submitted `1` at 06:41:40.328 UTC. The protected response is marked
delivered, and the same runtime session, attempt and epoch entered turn 2.
A status-only read of that active session confirms the next pre-model
checkpoint at 06:41:45.137 UTC, **4.809 seconds** after acceptance.
Turn 2 produced its manifest at 06:42:57.539 and interaction at 06:42:58.068.
Both exact S3 versions have `LastModified` 06:42:59 at second precision.
Independent checks verify the single accepted response and request-deduplication
record, the unchanged AWS and Codex sessions, both immutable publications and
all 16 versioned files. The exact DynamoDB publication-commit time was not
captured.

## Reply verification exposed two blockers

The actual second response is:

> Unknown --result "answered". accepted outcomes: approved, completed, complete, done, awaiting-approval, rejected, revised, resume, resumed, skipped.

This is a workflow failure, not a successful composer continuation. The
platform supplied only the user's exact `1`; neither its original prompt nor
its continuation contains an `answered` result value. The pinned v2.9.0
instructions route generic questions through `report`, while the initial plan
question precedes an active intent. An offline reproduction using the exact
package emits this same error for `report --result answered --user-input 1`.
Changing the result to `completed` instead returns “No active intent workflow
state found.” The package explicitly tells the conductor to stop at an engine
error. The actual live tool arguments and model reasoning were not retained.

The core's explicit `next compose <original task>` route emits the composer
proposal instruction without creating or approving a workflow. The user
authorized using that route while tracking the
[core plan-selection defect separately](native-core-plan-selection-follow-up.md).
At 06:52:05.794, the platform accepted the exact 99-byte reply
`$aidlc compose ` followed by the unchanged original request. It is sequence 3
in the same attempt; its protected delivery status remains pending. The user
does not need to submit it again.
A status-only read at 06:57:11 confirms the original runtime still holds the
sequence-2 publication and the same Codex session, without cold recovery or
starting another model turn. This does not qualify later cold-session recovery.

The second blocker is graph ingestion. After the turn-2 publication committed,
the worker failed in 2.84 seconds and retained the committed files. Its queue
message then became invisible for the configured 720 seconds. The explicit
Compose reply queued another normal reconciliation; that also failed before
dispatch. The graph API can display committed content while Neptune ingestion
remains pending, so response-node navigation alone does not prove ingestion.

Local inspection of the actual Gremlin client found an incompatible operation:
3.8.1's `iterate()` appends `discard` to the stale-edge deletion query, first
used at publication sequence 2. The deployed Neptune version does not support
that operation. The local fix consumes the deletion with `toList()` instead,
preserving all existing scope checks. The repair passes 98 focused tests,
including a new real traversal/serialization regression; the earlier in-memory
graph fixture hid this operation.
Neptune audit records confirm this cleanup was the last query from the worker
before both failures. Both queries contain `drop` and `discard`, identify this
execution, and use the trusted execution worker's IAM role:

| Reconciliation         | Last cleanup query (UTC) | Worker retry log (UTC) | Gap   |
| ---------------------- | ------------------------ | ---------------------- | ----- |
| Turn-2 ingestion       | 06:43:11.849             | 06:43:11.893           | 44 ms |
| Explicit Compose reply | 06:52:10.981             | 06:52:10.986           | 5 ms  |

Worker log pagination completed; the additional pages were empty. The event
mapping remained enabled with `ReportBatchItemFailures` and recursion allowed.
Neither invocation timed out. A failed reconciliation leaves its SQS pointer
under the 720-second visibility timeout; expiration of the shorter execution
lease does not itself enqueue another attempt.

Audit logging was enabled without CloudWatch export. The existing audit file
was read through the RDS `describe-db-log-files` and
`download-db-log-file-portion` APIs using `solution-read`; no runtime invocation,
query execution or AWS mutation was needed. Only sanitized metadata and hashes
were retained. Audit records contain requests, not the server's error response;
the exact exception text remains unavailable. This repair still needs deployment
and live ingestion verification.

An isolated TinkerPop 3.7.3 server also reproduces the old failure with both
GraphSON and GraphBinary: `Could not locate method: DefaultGraphTraversal.discard() (599)`.
The corrected production projector passes with the real turn-2 manifest and
interaction, retaining 18 current nodes and 17 edges. It removes three
synthetic stale edges, retains their historical vertices and a foreign
mixed-scope edge, and safely repeats the projection. This is an actual server
compatibility test, not a deployed Neptune replay.

Existing files and the question are available for inspection. Completion of
the next native turn remains a separate live acceptance check.
Cold harness-session recovery, all-four-harness live continuation and a
browsable conversation history are not established by this checkpoint.
The scaffold branch still lacks the pipe implementation; confirm the intended
source branch before qualifying actual pipe-code changes.

## Graph cleanup deployment handoff

Saved plan: `/tmp/aidlc-native-graph-cleanup-dev.tfplan`.

SHA-256:
`6d86a16a395ec23fbe6ec98c9b12875b4d0b887af94c4bf30a080da6b0274b22`.

The plan targets the execution worker from state **1166**. It updates two
Lambdas: the execution worker and a byte-identical credentials dependency.
The six additional replacements are local packaging helpers. No runtime,
image, IAM, API or persistent-resource change is planned. Both ZIPs and all
9,142 frozen inputs are verified; the worker bundle differs from the deployed
one by exactly `.drop().iterate()` → `.drop().toList()`.

Parent and independent reviews verify the saved binary against the reviewed
JSON, archives and fresh remote state. The refreshed embedded state differs
only in observed EFS size and the expected local/deferred data reads.
The user applies:

```bash
env -u DOCKER_CONTEXT AWS_PROFILE=solution AWS_REGION=us-east-1 DOCKER_HOST=unix:///var/run/docker.sock terraform -chdir=terraform apply /tmp/aidlc-native-graph-cleanup-dev.tfplan
```

Expected execution-worker `CodeSha256`:
`qCjKsYdeQ/WWwBcJgHta4PJtiufLvaEJvpsDMzae1pI=`.
The credentials hash remains
`JEXH26tjIqcWUN/vwG2NB7Vixv4i8H/FMwS0Ie6FcGE=`.

After deployment, verify those hashes, completion of publication 2's graph
projection, and delivery of the already-accepted sequence-3 request. Then
verify the next saved composer response in Overview and stop at its question
or approval. Do not resubmit the request, assume the old runtime stayed warm,
or treat cold recovery as qualified. This plan has not been applied by the
verification agent.

## Evidence

Detailed deployment, immutable-object and browser evidence remains outside the
repository in:

`/tmp/aidlc-plan-tools/native-composer-20260929/live-applied/`

Key files include `independent-deployed-image-verification.json`,
`initial-readback.json`, `api-route-verification.json`,
`parent-ui-actions.json`, `parent-runtime-status.json`,
`parent-verified-interaction.json`, `parent-verified-manifest.json` and
`parent-live-first-question.png`. These are local verification artifacts, not
portable repository fixtures or a claim that the source checkout was deployed
by the verification agent.

Graph deployment, reply transport, turn-2 verification and the offline engine
reproduction are recorded under:

`/tmp/aidlc-plan-tools/native-composer-graph-20260930/live-applied/`

The `turn2-projection/` subdirectory contains `diagnosis.json`,
`audit-scoped-metadata-v2.json`, `worker-logs-paginated.json`,
`after-compose-0652/worker-logs-paginated.json` and `cleanup-source-review.json`.
The audit correlation supports the cleanup diagnosis; it does not establish
successful projection or delivery of the queued Compose request.

The correction plan and its archive, source, server-compatibility and independent
review evidence are under:

`/tmp/aidlc-plan-tools/native-graph-cleanup-20260930/`.
