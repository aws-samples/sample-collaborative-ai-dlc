# PR #457: deployed Yjs hardening evidence — 2026-09-23

The requested **400-client / 40-document** workload preserved **287,200 edits**
over 12 minutes, with **99.617% synchronization availability** and a
**3.344s** maximum observed connection gap. All clients converged and
all 40 exact committed snapshots matched the complete edit journals. Separate
DynamoDB and abrupt-owner-loss tests used the same client/document count; their
worst observed gaps were **28.689s** and **61.200s**.

In the comparable 400-client, 200-document workload, synchronization availability increased from
**90.09% to 99.78%**, and the longest observed gap fell
from **385.24s to 3.17s**. Every generated edit in the completed
workloads converged and received a durability receipt; independent reads of the
committed S3 versions matched the expected journals. This qualifies the tested
workloads and failure cases, not an unrestricted enterprise capacity or uptime SLA.

## Deployment and method

Tests used the AWS `review` environment in `eu-central-1`, real Cognito tokens,
CloudFront/ALB WebSockets, Fargate workers, DynamoDB coordination, versioned S3,
and Neptune-backed business APIs. Deployments used `solution`; log reads used
the installed `solution-read` profile. Each load run used disposable document ids.
The worker tests used 1024 CPU units / 2048 MiB, a 100-document limit per worker,
and automatic scaling from two to four workers. The final review allocation was
restored after testing; see [final state](final-infrastructure.json).

The comparable scale runs used 400 protocol clients, 200 rooms, 64 KiB initial
content per room, one edit per client per second, and a 20 ms connection ramp.
The load generator ran locally and measured end-to-end behavior. These are
protocol clients, not 400 rendered browser tabs. One identity/intent was used for
the contention test; a separate test used ten identities, projects, and intents.

Every edit is recorded in an append-only CRDT journal. Verification checks its
count and independent SHA-256 digest, writer sequences, and initial content on
every client and in each exact S3 object version referenced by DynamoDB. Checking
only a final writer value would miss intermediate lost edits. `syncAvailability`
includes initial joins and detected reconnect gaps; it does not detect a broken
connection before the transport notices it or measure REST autosave uptime.

## Requested qualification target: 400 clients across 40 documents

The requested target uses ten concurrent editors per document, with 64 KiB
initial content and one edit per editor per second over 12 minutes. This run
preserved **287,200 journaled edits**, with **99.617%**
synchronization availability and a **3.344s** maximum observed gap.
Received-update propagation p95/p99 was **243/451 ms**.
All 400 replicas converged, every final checkpoint had a receipt, and all 40
committed S3 snapshots matched the complete expected edit journals. The
DynamoDB outage and abrupt owner-loss tests below also used 400 clients across
40 documents. [Target results](target-400-40.json),
[snapshots](target-400-40-snapshots.json), [AWS measurements](target-400-40-aws.json).

After resolving conflicts with `main`, the final merged image also completed a
five-minute repeat at 400 clients / 40 documents on two workers: **119,600 edits**,
**0 reconnects**, and **0 offline edits**, with all 40 snapshots verified.
Received-update p95/p99 was **283/457 ms**. The longest gap,
including initial joins, was **0.653s**.
[Final build results](merged-400-40.json), [snapshots](merged-400-40-snapshots.json).

The merge added structured startup/error logging and its dependencies to the
worker. Runtime hashes confirm that all eight coordination, persistence,
protocol, routing, and configuration modules are unchanged from the earlier
stress/failure image. The CloudWatch EMF envelope remains top-level JSON.
The final API/AgentCore packages were rebuilt too; Neptune CAS/producer checks
and the browser checks were repeated after that deployment.
[Worker comparison](merged-worker-runtime-proof.json),
[AgentCore runtime](merged-agentcore-runtime-proof.json),
[final CAS](merged-artifact-cas-proof.json),
[final producer checks](merged-artifact-producer-proof.json).

## Comparable scale results

| Revision / setup                               |   Edits | Reconnects | Synchronization availability | Longest gap |
| ---------------------------------------------- | ------: | ---------: | ---------------------------: | ----------: |
| Before hardening (2026-09-22)                  | 287,200 |      5,127 |                      90.091% |    385.244s |
| Contention/health fixes; original placement    | 287,200 |        785 |                      98.735% |    321.008s |
| Capacity fix; overlapping scale-in preparation | 287,600 |      1,090 |                      99.595% |      6.800s |
| Final worker; clean two-member start           | 287,600 |        626 |                      99.780% |      3.166s |

The first hardening run exposed a placement defect: one worker held 100 rooms
while its peer held 95, leaving ten clients waiting despite free slots. Admission
now reserves local slots before asynchronous claims, advertises capacity, and
places unowned rooms on eligible members. Existing ownership leases remain
authoritative; transfers avoid full destinations.

The first run of that fix overlapped the end of a manual 4→2 preparation step.
ECS reported two healthy workers while two stopping tasks still advertised live
membership and accepted initial rooms. That run is retained as transition
evidence. The clean comparison waited for two healthy tasks, two live members,
no loaded rooms, and 30 seconds of stable membership before starting.
See [start conditions](capacity-clean-scale-start.json), [timeline](capacity-clean-scale-progress.json),
[AWS measurements](capacity-clean-scale-aws.json), and [all 200 snapshots](capacity-clean-scale-snapshots.json).

The clean run recorded 6 client-observed HTTP 503 responses,
220 ownership-transfer closes, and 400 intentional
ten-minute token-expiry closes. Token renewal and transfer reconnects are included
in the availability figure. Initial join p95 was 833 ms; received-update
propagation p95/p99 was 266/448 ms. Propagation statistics cover
received updates only, so they must be read alongside the gap measurements.

## Fixes and deployed checks

- **Navigation and autosave lifetime.** Registered saves finish before their own
  document socket closes; old document lifetimes cannot close a new editor's
  socket. The final SPA-navigation test edited and navigated immediately,
  observed exactly one successful REST save, and reopened the exact text.
  [Evidence](navigation-final-proof.json).
- **Explicit saves include peer edits.** Start flushes the current shared
  content even without a local dirty revision. In two deployed browser tabs,
  the writer's REST request was held while the receiving browser pressed Start.
  Its own checkpoint/CAS save completed before the launch request. That launch
  request was intercepted so no workflow ran. The first test assertion mistakenly
  included the remote cursor name in the document text; the corrected assertion
  excludes CodeMirror cursor decorations. [Evidence](remote-start-proof.json),
  [test-harness failure](remote-start-proof.failed-dom-label.json).
- **Visible save failures.** Artifact editing reports failures from revision
  preflight, the durability barrier, and the business write. A failed checkpoint
  never proceeds to REST; retry retains the unsaved edit.
- **Stale business writes.** The client reads a business revision before the Yjs
  checkpoint barrier, then captures current CRDT content and writes with a CAS.
  Draft and artifact APIs reject stale revisions. A held older request returned
  409 after another editor saved; its retry preserved the merged text. A later
  deliberate reversion was also saved, proving deduplication tracks the actual
  saved payload. [Browser race](delayed-save-reversion-proof.json).
- **Artifact replacement.** Six concurrent writes from the same Neptune revision
  produced one winner and five conflicts. Actual agent-writer and Quorum helper
  mutations rotated epochs, and the deployed API rejected stale editors.
  These helpers ran against Neptune through an isolated Lambda built from the
  verified runtime source; no agent workflow was started.
  [CAS](artifact-cas-proof.json), [producers](artifact-producer-proof.json).
- **Coordination under load.** Only claims retain the shared-parent transaction.
  Renewals and checkpoints conditionally update their own document. Claim queues
  are bounded; membership, renewal, and transfer work have independent lanes.
  Sixteen renewal consumers prioritize the earliest deadlines. Uncertain commit
  responses are read back before candidate snapshots can be deleted.
- **Health and rollout.** ALB and explicit ECS container health checks use
  liveness; cluster membership readiness is separate. ECS ignores image-only
  health checks, so the probe is also registered in the task definition. Normal
  clustered rollouts use 100/200 healthy/max percentages, retain prior active
  task definitions and release images, and reserve 0/100 for an explicit
  one-worker mode transition. Terraform rejects a transition with multiple
  workers or autoscaling. [Runtime and probe](final-worker-runtime-proof.json),
  [retained rollback definition](retained-rollback-definition.json).
- **Open-tab asset retention.** The deploy script keeps older hashed assets.
  Previous entry and compose-page bundles were confirmed at the S3 origin after
  the new deployment. The earlier failed lazy-import attempt is retained as
  evidence of the defect. [Origin checks](frontend-asset-retention-proof.json),
  [failed attempt](delayed-save-during-upload.failed.json).
- **Complete deletion.** A permanent parent tombstone blocks new claims. A
  resumable consistent scan fences every document variant before business
  deletion proceeds. Pending scans return `409 deletion_pending`. Deletion
  removes all snapshot versions and delete markers; scheduled cleanup removes
  late uploads. The deployed test covered arbitrary artifact epochs, uppercase
  legacy names, active sockets, old-token replay, and late uploads. Old review
  tombstones were backfilled and their leftover snapshots purged. Final cleanup
  also exercised a real S3 listing spanning more than 1,000 versions.
  [Deletion](deletion-proof.json), [backfill](backfill-proof.json),
  [pagination fixture](version-pagination-fixture.json), [final purge](cleanup-final.json).

## Large deletion: two further failures found and corrected

The original heavily exercised project returned HTTP 504 while its Lambda
finished deletion after 29.389 seconds. A shared cleanup budget and 128-record
scan pages now bound each attempt; partial snapshot purges resume from the
remaining versions. Child-intent pending responses propagate as 409.
[Original timeout](cleanup-final.failed-timeout.json),
[CloudWatch diagnostics](deletion-failure-diagnostics.json).

The first 4,096-record fixture then exposed a cursor race with scheduled cleanup:
another invocation advanced the scan and the API returned 500. Cursor conflicts
now return retryable pending without undoing progress. A real DynamoDB integration
test synchronizes two scans to exercise that race. The deployed repeat used a
fresh 4,096-record fixture and 1,005 S3 versions plus five delete markers, beginning
with two concurrent API deletion requests. Both returned pending. Across the
concurrent requests and subsequent retries, eight pending responses were followed
by a successful 204; the longest request took 15.207 seconds. Every record,
version, and delete marker was independently confirmed absent. The earlier failed attempt is retained alongside its successful
recovery. [Race failure](deletion-budget-proof.failed-concurrency.json),
[recovery](deletion-budget-proof.json), [concurrent repeat](deletion-concurrency-proof.json),
[deployed API package hashes](cleanup-api-runtime-proof.json).

## Additional workload and failure results

| Case                                                               | Clients / rooms |   Edits | Reconnects | Longest gap |
| ------------------------------------------------------------------ | --------------: | ------: | ---------: | ----------: |
| [Rolling worker deployment](capacity-rolling.json)                 |         40 / 20 |  14,360 |        136 |      5.320s |
| [Ten users / ten projects](tenants-load.json)                      |       400 / 200 | 119,600 |          0 |      1.489s |
| [Sustained low-load observation](capacity-scale-in.json)           |         40 / 20 |  35,960 |         40 |      0.850s |
| [Requested target: scale-in and token renewal](target-400-40.json) |        400 / 40 | 287,200 |        727 |      3.344s |
| [Final merged build: ten editors per document](merged-400-40.json) |        400 / 40 | 119,600 |          0 |      0.653s |
| [Hot document during automatic 4→3 scale-in](hot-document.json)    |         100 / 1 |   8,900 |         26 |      0.997s |
| [DynamoDB outage](ddb-load.json)                                   |        400 / 40 | 239,200 |        221 |     28.689s |
| [Abrupt owner death](abrupt-load.json)                             |        400 / 40 | 191,600 |      1,004 |     61.200s |
| [Restored review sizing](restored-smoke.json)                      |          10 / 2 |     440 |          0 |      0.696s |

The 15-minute low-load test retained four workers. AWS subsequently performed
an automatic 4→3 reduction at 08:15:58 UTC, during the 100-client hot-document
test. Its 26 affected connections recovered within 997 ms; all 8,900 edits
converged and the committed snapshot matched. This is measured scale-in evidence;
the configured 600-second cooldown alone was not a promise of when it would occur.
[Scaling activity and client overlap](hot-document-aws.json).

The rolling-deployment run overlapped a scoped S3 denial on a separate fixture
document during its latter portion. Its availability result therefore reflects
that combined environment, not an isolated deployment-only benchmark.

The ten-tenant run preserved **119,600 edits** across 200 rooms, with
**0 reconnects** and **0 offline edits**. Independent snapshot checks passed
for every tenant. All ten cross-tenant API and WebSocket probes returned 403.
[Isolation evidence](tenant-isolation.json).

The S3 write-denial test recorded no additional save receipt and no checkpoint
sequence advance for the rejected flush. Cold reads failed closed under a read
denial and recovered exact content after restoration. [Storage fault](storage-fault.json).

The DynamoDB test denied the worker role access to both coordination tables for
60 seconds. Effective failure/recovery can outlast policy removal. Cluster
readiness emitted NotReady while existing ECS tasks remained healthy; there was
no health-triggered replacement. All 239,200 edits recovered, including
1,195 generated offline. [Task identities and readiness](ddb-proof.json).

The abrupt-loss test used a temporary task command that SIGKILLed Node on ECS
termination and verified exit 137. ECS deregistration preceded the kill; this is
not an instantaneous host-power-loss test. Live clients recovered every journal
entry. A separate document had no surviving clients and recovered from the same
committed S3 version under a new ownership token. The regular task command was
restored and the fault task definition deregistered. [Fault details](abrupt-fault.json).

## Validation, runtime identity, and cleanup

**3,037 backend tests passed (3 skipped), 606 frontend tests passed, all 9
Terraform configuration tests passed, and 54 release-tool tests passed.**
[Test results](tests-final.json) records the commands, outcomes, and skipped tests.
Three unrelated script-sensor tests skipped because the local PATH has no `bun`;
Yjs DynamoDB integration tests ran. The suites cover lifecycle navigation, reordered REST saves, bounded conflicts,
real DynamoDB fencing/deletion pagination, real Gremlin concurrency, capacity
admission, independent renewals, readiness, and Terraform rollout guards.
[Stress-run worker hashes](final-worker-runtime-proof.json),
[final worker hashes](merged-worker-runtime-proof.json), and
[final AgentCore hashes](merged-agentcore-runtime-proof.json) identify the deployed
images independently of an uncommitted build tag or Git revision.

All thirteen temporary projects and eleven users, the child deletion fixture, graph user
records, snapshot versions, temporary Lambda/log group, and fault policies were
removed. Scope tombstones remain intentionally. The review service was restored
to one worker at 256 CPU units / 512 MiB with autoscaling disabled.
[Cleanup verification](cleanup-final.json), [restored state](final-infrastructure.json),
[health after cleanup](final-observation.json).

## Qualification limits

This is substantially stronger evidence than the previous run. It is not proof
of arbitrary enterprise scale. No multi-day soak, regional outage, thousands of
unique identities, hostile tenant fairness, or long-lived rich-text history test
was performed. The largest measured fleet here is four workers and 400 clients.
A single busy document still has one owner; adding workers does not split its
fan-out or CPU work. Large, uneven documents can exhaust one owner's byte or
memory budget while another worker has spare capacity. Provision N+1 headroom;
autoscaling reacts after metrics and task startup.

A durability receipt protects the checkpoint it confirms. Newer unacknowledged
edits depend on surviving replicas. Browser IndexedDB persistence is not
implemented, and the 30-second SPA-navigation save window is not a guarantee
against browser/process termination or full-page unload. Business REST saves are
separate from Yjs receipts; the browser save completes after the REST write.
The new APIs require revision preconditions (428 when missing), so update API
integrations and reload older clients during rollout. Managed runtime images
that pin older producer code also need their normal rebuild/publication flow.

For production, define target workload distributions, recovery objectives, token
and membership-revocation expectations, and SLOs, then qualify those exact limits.
The measured synchronization percentages here must not be presented as a service
uptime SLA. See the [operations guide](../../yjs-operations.md) for configuration,
migration, retry, retention, and reproduction commands.

## Primary-source design references

- [Yjs WebSocket scaling guidance](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket):
  document ownership/sharding improves multi-document capacity; uneven document
  load remains a limitation.
- [Yjs IndexedDB persistence](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb):
  local persistence is a separate capability, not provided by network sync alone.
- [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html):
  shared transactional items introduce conflicts; the hot path now avoids them.
- [ECS rolling deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html)
  and [container health checks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html):
  replacement capacity and explicit container probes are deployment responsibilities.
- [Neptune transaction isolation](https://docs.aws.amazon.com/neptune/latest/userguide/transactions-isolation-levels.html):
  preconditions and mutations belong in the same transaction.
