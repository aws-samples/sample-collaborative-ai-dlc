# Native workspace preparation latency

Updated 29 September 2026 — `feat/native-aidlc-execution`.

**Current measured result:** two fresh preparations now take **1 minute
39 seconds** and **1 minute 41 seconds**, both succeeding on their first
filesystem invocation without a timeout or long recovery wait. The timeout
repair is applied at state **1143** and passes the agreed two-run check.
The earlier 20-second change left G/H at 4:18/4:14; their time-correlated AWS
first-invocation samples were 51.833/50.470 seconds. Startup varies across
samples, and its internal breakdown remains unknown.

On 29 September the user selected **only the timeout repair**, with
pre-provisioning deferred. Seconds-level preparation is not required before
UI/graph integration; no further latency optimization is on this path.

Before the retry fix, two successful preparations each took **12 minutes 4 seconds**.
The main cause is the controller's retry schedule: normal asynchronous AWS
readiness is handled through failed SQS deliveries, with **180 seconds between
attempts**. Four such intervals dominate both runs. This is a preparation
orchestration issue; these fixtures do not install AI-DLC, clone application
code or run a model.

## Measured sequence

| Attempt | Run C, UTC | Run D, UTC | Result |
| --- | --- | --- | --- |
| 1 | 12:36:08 | 12:42:32 | EFS access point created; immediate read is not yet available |
| 2 | 12:39:08 | 12:45:32 | Access point verified; role created; AgentCore has not yet accepted the new role |
| 3 | 12:42:08 | 12:48:32 | Same role accepted; runtime created; immediate read is not yet READY |
| 4 | 12:45:08 | 12:51:32 | Runtime verified; pinned endpoint created; immediate read is not yet READY |
| 5 | 12:48:08 | 12:54:32 | Endpoint verified; filesystem diagnostic and final authority checks pass |

Run C took **724.269 seconds** from Prepare to the protected READY write.
Its five Lambda invocations totalled **9.53657 seconds**, plus 0.25812 seconds
of reported initialization. Run D took **724.297 seconds**, with **8.57381
seconds** of invocation duration and 0.26281 seconds of initialization.
Neither run needed a manual retry.

The remaining elapsed time includes real AWS provisioning and IAM propagation
while the worker is idle. It must not all be counted as removable overhead.
The existing checks sample too infrequently to establish the earliest EFS or
IAM readiness time.

For C, the final READY runtime records creation at 12:42:09.496Z and its last
update at 12:42:21.566Z: approximately **12 seconds**. Its next worker check
starts at 12:45:08Z. The endpoint records creation at 12:45:09.177Z and its last
update at 12:46:06.521Z: approximately **57 seconds**. Its next worker check
starts at 12:48:08Z. These are `lastUpdatedAt` timestamps on final READY
resources, not separately captured READY transition events. They support
substantial scheduling overhead, but do not establish a new end-to-end target.

The first worker invocation starts within about two seconds of Prepare.
The live event source mapping has batch size 1, no batching window and
`ReportBatchItemFailures` enabled. This evidence points to repeated readiness
waits rather than an initial backlog.

## Why the implementation waits

- [The worker](../../lambda/native-runtime-control/worker.js) acknowledges only
  READY, FAILED, terminal or missing work. Every pending result becomes a
  `batchItemFailures` entry. There is no separate readiness retry schedule.
- [The queue](../../terraform/modules/compute/native-runs/main.tf) has a
  180-second visibility timeout. The deployed setting was re-read and matches.
- [The store](../../lambda/native-runtime-control/store.js) retains a
  120-second lease after a pending attempt. An earlier delivery would encounter
  that active lease and return busy.
- [The provisioner](../../lambda/native-runtime-control/provisioner.js) yields
  immediately when an asynchronous resource is not ready. The next delivery
  rechecks the saved resources and progresses to the next step.

The queue setting is consistent with AWS's recommendation of at least six
times the Lambda timeout, which is 30 seconds here. Its use as the normal
readiness polling interval is the problem. The 30-second invocation budget
and 10-second individual request budget were not exhausted in C or D.
Increasing memory or these budgets alone would leave the four waits intact.

## Selected improvement

The user selected **fix and measure preparation first**, before the first
agent-turn milestone. The following change is deployed at state **1141** and
verified on two fresh preparations.

Keep the existing per-run runtime, role, EFS access point/root, pinned endpoint
and final filesystem checks. Separate a safely completed readiness wait from
a crash or uncertain service operation.

1. Identify ordinary readiness waits explicitly: access point creating,
   the already narrowly recognized new-role propagation response, runtime
   creating and endpoint creating. Do not apply the fast path to every
   exception currently labelled pending.
2. After the attempt has finished all work, conditionally release only its
   own lease using the existing binding, version, fence and lease token.
   Keep allocated resource identities and immutable pins.
3. Shorten that delivery's visibility using its receipt handle, with bounded
   backoff of 5, 10, 20 and then 30 seconds, with 0–2 seconds of jitter capped
   at 30 seconds.
   Retain the message in the partial failure response. A pending operation
   must never be acknowledged as complete.
4. Keep the queue's 180-second default for crashes and uncertain failures.
   Failed or ambiguously acknowledged visibility changes must not lose work.
   Another owner's active lease, expired ownership, and uncertain diagnostic
   session cleanup must not take the cooperative release path.
5. Log the stage, receive count, selected retry delay and scheduling outcome.
   The provisioner also logs invocation duration. Correlate these with Prepare
   and the protected READY write to measure total preparation time,
   using fixed fields without request payloads or receipt handles. This makes
   the next timing breakdown observable.

This adds a guarded store operation, explicit provisioner wait results,
worker retry handling and `sqs:ChangeMessageVisibility` scoped to this queue.
It does not require a different storage service or additional compute hosts.

Faster checks increase control-plane requests and encounter throttling sooner
at scale. Backoff, duplicate handling and the existing 100-delivery dead-letter
policy must be considered together. Constant five-second retries could consume
that budget before the ten-minute IAM propagation window; the example backoff
avoids that particular problem, but does not by itself qualify prolonged
failures. These are provisioning delivery limits, separate from agent-turn
execution policy.

A small amount of budget-aware polling inside one invocation is another
option. It can catch transitions completing within seconds, but a transition
longer than the available invocation budget still falls back to a three-minute
delivery unless scheduling also changes. It is therefore a secondary
optimization, not the preferred first fix.

## Readiness-retry deployment

All **288 native-control tests pass**, including lease release and immediate
reacquisition, stale-owner rejection, lost acknowledgements, duplicate
deliveries, visibility-change failures/timeouts, terminal acknowledgement,
backoff and conservative diagnostic handling. Both Lambda builds, lint,
formatting and Terraform validation pass. These are local fixture and
configuration checks.

The applied plan updated the **provisioner Lambda and its queue permission**.
Three local packaging resources were replaced; no AWS resource was created or
destroyed. Runtime image, per-run authority, network, EFS, API and the default
180-second queue visibility were unchanged.

Applied plan: `/tmp/aidlc-native-readiness-retries-dev.tfplan`.
SHA-256:
`ece7f32c34cef2bf25299a1c2b398f9a1363aa53ddbef3ed3076d4fb677d2038`.

The IAM update deferred packaging and logging metadata during planning.
After apply, the actual ZIP/bundle matched exactly; all **19 deployed checks**
passed, including the full worker policy, environment, role, queue mapping,
timeout, Text logging and seven-day retention. Independent review of the
downloaded package and saved AWS responses found no blockers.

Deployed readiness worker bundle SHA-256:
`9a4aa2a54f8be553b665f49ef333f071d3bb0d05cc342a1e974fdb7c20d1fcb9`.

## Measured E/F results

The user restored the member session. Two fresh Codex drafts used the same
verified v2.9.0 package as the baseline. Each received exactly one authenticated
Prepare action; neither needed a manual retry.

| Run | Prepare to protected READY | Short retry delays | First diagnostic attempt |
| --- | --- | --- | --- |
| E | 261.581 seconds | 6, 12, 22, 30 seconds | Aborted at the 10-second invocation deadline |
| F | 255.552 seconds | 7, 10, 21, 30 seconds | Aborted at the 10-second invocation deadline |

All eight visibility changes were confirmed with HTTP 200 and followed by
short redeliveries. Each aborted diagnostic retained its lease and used the
conservative 180-second redelivery interval; its next attempt succeeded.
Lambda invocation time totalled 21.18113 seconds for E and 17.77673 seconds
for F across six attempts each. Resource creation was therefore no longer
held behind four mandatory three-minute intervals, but the diagnostic
deadline still added a recovery cycle.

Both pages show Workspace ready. Separate fresh sessions independently
passed NFS4 write/readback, hard-link, atomic-rename and cleanup checks, then
stopped with HTTP 200. Runtime, role, access point and root identities differ.
No coding agent started.

The first-invocation delay's underlying service component remains unknown:
the runtime log groups contained no events when inspected. Cold startup is a
possible explanation, not established by these logs. No run was excluded
because it encountered this delay.

## Applied diagnostic-budget follow-up

Only the fixed filesystem invocation and proof-reading budget increase to
at most **20 seconds**, further bounded by the remaining Lambda and lease
time minus **eight seconds reserved for cleanup**. The invoke SDK client uses
the same ceiling. Other control/stop calls remain capped at ten seconds,
Lambda stays at 30 seconds, and the queue remains at 180 seconds.
Uncertain invocation or cleanup still retains conservative retry behavior.
This does not alter coding-agent execution policy.

The change also handles numeric DOMException error codes without attempting
string operations on them. **293 native-control tests**, both Lambda builds,
lint, formatting and Terraform validation pass. Tests cover a successful
15-second first invocation, exceeded deadlines, time already consumed by
earlier checks, and cleanup reserves under a shorter lease.

The applied plan updated only the provisioner Lambda code, plus three local
packaging replacements. IAM, runtime images, EFS, network, queue, logging,
Lambda timeout and environment remain unchanged.

Applied at state **1142** on 28 September. All **16 deployment checks** pass;
the downloaded ZIP and bundle match the reviewed bytes. An independent saved
evidence review passes **13/13** checks, without independent state retrieval
or fresh IAM/retention reads.
Applied plan: `/tmp/aidlc-native-workspace-check-budget-dev.tfplan`.
Plan SHA-256:
`061c19d1360560973e63c3a8ee244aeed3befa477a47e999fc3d486ef18d99b5`.
Deployed bundle SHA-256:
`0ccbc0952c07cd68487c7efb8f0a79a3a7598bf1b9bb920f2565d8cb580f8d5c`.

## Measured G/H results

Two new member-created Codex drafts used the same verified v2.9.0 package.
Each received exactly one authenticated Prepare action and no manual retry.

| Run | Prepare to protected READY | Short retry delays | First diagnostic attempt |
| --- | --- | --- | --- |
| G | 258.125 seconds | 6, 11, 21, 30 seconds | Aborted at the 20-second invocation deadline |
| H | 254.400 seconds | 7, 10, 20, 30 seconds | Aborted at the 20-second invocation deadline |

All eight visibility changes returned HTTP 200. Both runs retained their
lease after the diagnostic abort, recovered on the conservative 180-second
redelivery and reached READY on attempt six. Lambda duration totalled
29.87654 seconds for G and 27.58317 seconds for H. The longer deadline adds
worker time but does not materially change overall latency because the next
delivery is timed from receipt of the message.

Both pages show Workspace ready with agent and human-action controls disabled.
Separate fresh sessions passed NFS4 write/readback, hard-link, atomic-rename
and cleanup checks, then stopped with HTTP 200. The two runs have distinct
runtime, role, access-point and protected root identities. Preparation periods
overlapped, with one provisioner worker; this is not a load or concurrency test.

### What the first-invocation measurement establishes

For G, AWS's one-minute metrics contain one latency sample of **51,833 ms**
in the 17:21 UTC bucket, **77 ms** in the automatic-retry bucket at 17:23,
and **3,319 ms** for the independent session at 17:24. H repeats the pattern:
**50,470 ms** at 17:23, **75 ms** on retry at 17:25 and **3,248 ms** for the
independent session at 17:26. Each bucket has one invocation/sample and zero
reported errors. G also reports zero throttles; H throttles were not queried.
Attribution to the first requests is by timing and invocation count, not
request-ID joins. The clients had already aborted; these samples do not prove
they received the responses.

The runtime reports platform V1. Both runtime log groups contain no events
in the inspected window. The isolated server normally emits no startup or
request timings, so empty logs do not establish that the process never started.
Its HTTP response headers are sent only after all EFS checks finish.
Service allocation, image loading, mount establishment and filesystem I/O
therefore cannot yet be separated. ECR reports a 1,291,462,353-byte image;
image size alone does not establish the cause.

A 51.833-second invocation cannot complete inside the current 30-second
Lambda while preserving cleanup time. The user selected a longer preparation
worker window; startup instrumentation and pre-provisioning are deferred.

An independent review verifies **34 measurement checks**, including complete
per-request Lambda REPORT totals, all eight successful short visibility
changes, protected READY identities and independent proof checksums. It also
identifies a standalone first-invocation experiment on a never-invoked isolated
diagnostic runtime as an alternative to changing the worker budget.

## Applied timeout repair — 29 September

The worker window increases from **30 to 90 seconds**. Only the fixed filesystem
invocation/proof ceiling increases from **20 to 80 seconds**; the remaining
Lambda time and ownership lease, minus the existing eight-second cleanup
reserve, can shorten it. Other SDK calls remain capped at ten seconds, the
API Lambda remains at 30 seconds and the ownership lease remains at 120 seconds.
Coding-agent execution policy is unchanged.

Queue visibility increases from **180 to 540 seconds** to preserve the existing
six-to-one ratio. Confirmed readiness waits keep their short backoff. Crashes
and uncertain operations now have a nine-minute fallback; this tradeoff was
presented before the user selected the timeout repair.

**294 native-control tests pass**, including a measured-length 52-second first
invocation, an exceeded 80-second ceiling with cleanup and an unexpired lease,
and a 30-second worker during deployment. Both Lambda builds, lint, formatting
and Terraform validation pass. Parent and independent plan reviews each pass
**21/21** checks.

The saved plan has exactly two AWS updates: the worker code/timeout and queue
visibility. Three local packaging resources are replaced. It creates or deletes
no AWS resources and changes no runtime image, role, EFS or API.

Historical applied plan: `/tmp/aidlc-native-workspace-timeout-dev.tfplan`.

Plan SHA-256:
`373f70fb7263b258b0ad53f733e38f828c998473a4b53aa46c87c7d112fa3241`.
Expected bundle SHA-256:
`7ec7e2f99cfa9f0b67e580108c8c2a0ef783caaa426727f5674c58ea3fe2d8dd`.
Expected ZIP SHA-256:
`ce32c7622242f642d63aed9183e999f885830f1743e2d7027c1ca96050e4d88a`.

Packaging and logging metadata were deferred by the plan's queue dependency.
The exact planned packaging query was run locally; the resulting archive and
597 source files were frozen for review. After user deployment, all **15**
parent checks and **18** independent saved-evidence checks pass: exact actual
ZIP/bundle, 90-second worker, unchanged role/environment, Text logging with
seven-day retention, 540-second queue and the existing partial-failure mapping.
The worker was last modified at **07:39:25Z on 29 September**.

| Run | Prepare to protected READY | Short retry delays | Final verification attempt |
| --- | --- | --- | --- |
| I | 98.968 seconds | 6, 12, 20, 30 seconds | 23.021 seconds; first diagnostic succeeds |
| J | 101.093 seconds | 7, 12, 21, 30 seconds | 25.833 seconds; first diagnostic succeeds |

Both were fresh member-created drafts with one Prepare action each, tested
sequentially. All eight short visibility changes returned HTTP 200; both reached
READY at fence 5/version 16 with no retained lease, runtime error or manual
retry. Their five Lambda invocation durations total 29.55997 and 30.24389 seconds.
The final-attempt timings include authority checks and cleanup, not just the
runtime invocation.

Separate fresh sessions passed NFS4 write/readback, hard-link, atomic-rename
and cleanup checks for each runtime, then stopped with HTTP 200. Runtime,
role, access-point and root identities differ. Both UI pages show Workspace
ready with model/human-action controls disabled. No coding agent ran.

Evidence is in `/tmp/aidlc-plan-tools/native-workspace-timeout-20260929/`
and its `applied/` directory. Continue the [existing UI/graph delivery sequence](native-ui-first-slice.md#active-delivery-sequence);
do not add a pre-provisioning milestone.

The two I/J samples do not establish production percentiles, sub-minute
preparation, forced worker-loss/duplicate-race recovery or the later
package-installation/model-start latency.

## Evidence

Analysis and source hashes:
`/tmp/aidlc-plan-tools/native-workspace-latency-20260928/latency-analysis.json`.
Applied evidence is in the sibling `applied/` directory, including
`latency-results.json`, complete E/F worker logs, protected rows, UI timestamps,
screenshots and fresh-session proofs. The `diagnostic-budget/` directory
contains the follow-up tests, plan, exact archive and source freeze.
Its `applied/` directory now contains the state-1142 deployment proof,
G/H timing results, complete worker logs, protected rows, UI timestamps and
screenshots, fresh-session filesystem proofs and startup investigation.

Underlying deployed-run evidence:
`/tmp/aidlc-plan-tools/native-runtime-preparation-applied-20260925/role-propagation-applied-20260928/`.
The analysis references the complete worker log, UI action timestamps, final
protected rows and independent AWS runtime/endpoint snapshots. Live reads on
28 September also confirmed the 180-second visibility, 30-second Lambda,
successful worker update and unchanged deployed code hash.

AWS documentation read on 28 September; retrieved copies and source metadata
are alongside the analysis:

- [Lambda SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html):
  visibility recommendation and event source validation.
- [Lambda SQS error handling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html):
  partial failures and redelivery.
- [SQS ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html):
  per-delivery visibility changes and restoration of the queue default on the
  next receipt.
- [Using Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html):
  at-least-once delivery and acknowledgement behavior.
