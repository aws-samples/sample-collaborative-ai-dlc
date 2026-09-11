# Yjs operations

Yjs supports a standalone worker and an opt-in cluster that distributes documents
across ECS tasks. A document has one owner. Adding workers increases capacity for
many documents; it does not divide the CPU or fan-out cost of one busy document.
Use the load workload below to distinguish those cases before setting capacity.

## Configuration

Set `yjs_scaling` in the environment's Terraform variables. Production defaults to
one worker with 1024 CPU units and 2048 MiB, increased from 512/1024. Other
environments retain 256/512. To retain the previous production allocation, set
`cpu = 512` and `memory = 1024` explicitly.

Standalone vertical sizing:

```hcl
yjs_scaling = {
  cpu    = 1024
  memory = 4096
}
```

Manual horizontal sizing, after enabling cluster mode with one worker:

```hcl
yjs_scaling = {
  cluster_enabled = true
  cpu             = 1024
  memory          = 2048
  desired_count   = 4
}
```

Automatic horizontal sizing:

```hcl
yjs_scaling = {
  cluster_enabled = true
  cpu             = 1024
  memory          = 2048
  autoscaling = {
    min_capacity = 2
    max_capacity = 8
  }
  # Optional existing SNS topic ARNs for capacity/error alarms:
  # alarm_actions = ["arn:aws:sns:REGION:ACCOUNT:TOPIC"]
}
```

Terraform rejects multiple standalone workers, invalid Fargate CPU/memory pairs,
and invalid limits. `desired_count` applies in manual mode. The scalable target
uses identical minimum and maximum bounds for a manual count; updating those
bounds updates the service count. In automatic mode, Terraform ignores ECS's
changing desired count and maintains the configured bounds. Do not manage the
count independently in the console while expecting Terraform to restore it on
an otherwise unchanged apply.

Automatic policies target service CPU, service memory, and average worker
capacity utilization. Capacity is the largest fraction of the connection,
document-count, and total-document-byte budgets. Targets are 60% CPU, 70% memory,
and 60% capacity, with 60-second scale-out and 600-second scale-in cooldowns.
The CPU target accounts for a single Node event loop when allocating more than
one vCPU. These are initial settings, not measured customer capacity guarantees.
A skewed workload or one hot document can still saturate an individual owner;
the maximum-worker alarms must be monitored even when fleet averages are low.

Worker limits, also configurable inside `yjs_scaling`:

| Setting                    |  Default | Meaning                                                                         |
| -------------------------- | -------: | ------------------------------------------------------------------------------- |
| `max_connections`          |     2000 | Incoming sockets and pending upgrades per task, including forwarded connections |
| `max_documents`            |      256 | Loaded/loading documents and ownership admission per task                       |
| `max_document_bytes`       |  8388608 | Conservative encoded document budget, 8 MiB                                     |
| `max_total_document_bytes` | 67108864 | Total encoded document budget, 64 MiB                                           |
| `max_buffered_bytes`       | 16777216 | Maximum queued bytes per socket, 16 MiB                                         |

Encoded document size is not heap size. The server also rejects updates/loads
above 85% of configured task RSS capacity. Leave memory headroom and measure the
actual document structures, sizes, and edit patterns. A slow consumer is closed
with code 1013 and must reconnect/resynchronize; updates are not silently dropped.

## Ownership and durability

```mermaid
flowchart LR
  Browser --> CloudFront --> ALB
  ALB --> A[Worker A]
  ALB --> B[Worker B]
  A -->|private authenticated forwarding| B
  B -->|owns a document| Doc[Y.Doc]
  A --> Members[DynamoDB task membership]
  B --> Members
  Doc -->|binary checkpoint| S3[S3 versioned object]
  Doc -->|fenced manifest and lease| DDB[DynamoDB document metadata]
```

Workers register their private ECS task address with a 30-second membership
expiry and refresh every ten seconds. Rendezvous hashing chooses a preferred
owner. An existing document lease takes precedence until it is safely released
or expires. The ALB may connect a browser to any task; that task forwards the
WebSocket to the owner, which independently verifies the Cognito and scope
tokens. Forwarding is restricted to private IPv4 addresses and a single hop.
Neither browser redirects nor ALB stickiness establish document ownership.

Document leases carry a unique fencing token. Claims, renewals, and checkpoint
manifest updates check that token and the parent scope's revocation marker.
Workers stop accepting document messages five seconds before their local lease
deadline. This assumes normally synchronized ECS task clocks.

Dirty documents checkpoint at most once per two-second interval. Concurrent
explicit flushes share the checkpoint. S3 holds the binary Yjs update, while a
conditional DynamoDB transaction commits its exact object/version and sequence.
An uncertain write response never causes deletion of an object that might have
committed. The sequence condition prevents a delayed checkpoint from replacing
a newer one. Recovery loads the committed version before the initial handshake.

The normal checkpoint interval is **not** a guaranteed recovery-point objective:
upload latency, retries, and a storage outage can extend it. A receipt confirms
durability through the revision requested on that connection. Changes newer than
the last successful checkpoint rely on surviving browsers resynchronizing; if
the owner and all those browsers disappear, uncommitted edits can be lost.

Browser business-data autosaves run only for local changes, with a two-second
debounce, ten-second maximum wait, serialized saves, and retries. In cluster mode
they wait for a checkpoint receipt before writing the REST representation.
Backend business records remain necessary for workflows and API reads. Those
REST writes still use their existing concurrency semantics; a checkpoint receipt
does not serialize separate editors' business requests.

Agent/Quorum replacement of an artifact rotates its collaboration epoch. A new
editor then seeds a new document from the replacement content. Human autosaves
retain the epoch, and the content API rejects an editor carrying an older epoch.
This prevents recovery from reintroducing a previous generated artifact.

Idle owners checkpoint and release documents after sixty seconds. During
membership changes, a worker transfers at most four documents per heartbeat:
freeze messages, checkpoint, release, and close sockets with 1012. Clients keep
their local CRDT, reconnect with jitter, and merge with the successor. Existing
WebSockets do not move merely because the ECS count changes.

SIGTERM starts a drain and stops new upgrades. Lease renewals continue while
documents checkpoint in bounded batches. The application allows 90 seconds;
ECS's stop timeout is 120 seconds. An abrupt task loss requires lease expiry
plus reconnection/backoff before another owner can recover the document.

## Enable, expand, and roll back

Use an isolated deployment first. No deployment or load against a customer
environment is implied by running the unit tests.

1. Deploy the new backend and frontend while retaining one standalone worker.
   Reload active browsers so they use the corrected awareness protocol and
   artifact document identities. The single-worker deployment stops the old
   task before starting the replacement and briefly interrupts collaboration.
   Terraform explicitly disables ECS Availability Zone Rebalancing in the same
   service update. Existing installations may have it enabled; ECS otherwise
   retains that setting and rejects the required `maximumPercent = 100`.
2. During a maintenance window, let editors save and close them. Set
   `cluster_enabled = true`, **keep `desired_count = 1`**, and leave automatic
   scaling unset. Deploy and wait for the service to stabilize. The old
   standalone worker has no binary checkpoints; REST data and surviving browser
   CRDTs provide the initial state for the cluster.
3. Verify health, editing, persisted recovery after all browsers disconnect, and
   the absence of checkpoint errors. Then increase the manual count to two/four.
   Do not combine the initial mode transition with an increase in worker count:
   overlapping standalone and clustered workers would own independent state.
4. Exercise growth and shrinkage, abrupt owner termination, continuous editing,
   reconnects, and storage errors in the isolated environment. Confirm recovery
   and resource headroom. Enable automatic policies only after those checks.

For rollback, remove automatic policies and set a fixed manual count while
keeping cluster mode enabled. Scale back to one owner if necessary. Keep the
membership table, manifests, and S3 snapshots. Returning to standalone mode or
deploying the old server is a maintenance operation: finish business saves,
close clients, wait for drains, and explicitly account for drafts that exist
only in the binary checkpoints. Standalone mode does not read those checkpoints.

The deploy role needs permission to manage Application Auto Scaling and, on
first use, its ECS service-linked role. The task role receives only the document
table operations, membership operations, and `yjs-documents/*` S3 operations it
needs. The task security group admits forwarding from itself on port 1234.

## Metrics and incident checks

`terraform output -json yjs_scaling` shows effective sizing and the CloudWatch
`ServiceName` dimension. The namespace is `CollaborativeAI/Yjs`; each task emits
metrics every thirty seconds through its existing log group.

| Signal                                                          | What to check                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `EventLoopDelayP99Ms`, ECS CPU                                  | One busy document, many updates, initial sync bursts, serialization    |
| `ResidentMemoryBytes`, ECS memory, `DocumentBytes`, `Documents` | Heap growth, document size/history, idle eviction, skew between owners |
| `QueuedBytes`, `Connections`, `ProxiedConnections`              | Slow consumers, connection distribution, forwarding cost               |
| `Updates`, `UpdateBytes`                                        | Actual editing rate and payload size; compare with user/room counts    |
| `PersistenceErrors`                                             | IAM/network errors, S3 latency, DynamoDB throttling or lease conflicts |
| `RejectedConnections`, `CapacityUtilization`                    | Worker admission limits and fleet headroom                             |

Alarms cover maximum worker capacity, maximum event-loop delay, persistence
failures, and rejected connections. Notifications require `alarm_actions`.
Inspect DynamoDB throttle reasons, request latency, and the configured billing
mode separately. The repository uses on-demand tables; this does not prove that
a particular customer deployment applied that configuration or has no hot key,
quota, or throttling problem.

## Reproducible validation

Use Node 24 (the production image's major version). Install the root and
standalone server dependencies:

```bash
npm ci
npm ci --prefix lambda/yjs-server --ignore-scripts
npm --prefix lambda/yjs-server test
```

The standalone suite exercises real local WebSockets, concurrent joins,
awareness ownership, resource rejection, task forwarding, checkpoint failures,
and repeated 1 → 2 → 4 → 2 membership changes. With Docker available, the root
runner also starts DynamoDB Local and Gremlin:

```bash
npm test -- --project yjs-server --project intents --project projects
npm --prefix frontend test
```

Terraform's `tests/yjs.tftest.hcl` uses mock providers to verify standalone,
manual, and automatic settings and reject unsafe configurations. The Terraform
CI workflow uses a temporary local backend so these checks need no AWS account.

For deployment measurements, create a disposable test intent, supply its project
and intent IDs, and use a Cognito ID token that remains valid for the run. Set
the token through your local secret-handling mechanism; do not commit it:

```bash
export YJS_LOAD_URL=https://your-test-application.example
export YJS_LOAD_PROJECT_ID=00000000-0000-4000-8000-000000000001
export YJS_LOAD_INTENT_ID=00000000-0000-4000-8000-000000000002
# Set YJS_LOAD_JWT securely in the environment.
YJS_LOAD_CLIENTS=100 YJS_LOAD_DOCUMENTS=25 YJS_LOAD_SECONDS=180 \
  node lambda/yjs-server/load.js
```

The workload uses isolated review-room names, refreshes scope tokens, edits
unique writer keys, and sends presence updates. It reports join p95, propagation
p95/p99, bytes received, reconnect/close counts, and final convergence. Its
sequence check verifies that every connected peer sees every writer's final
value; it does not by itself prove durable cold recovery or REST autosave rates.
The server integration suite tests cold recovery separately.

Repeat with many rooms and with `YJS_LOAD_DOCUMENTS=1`, larger
`YJS_LOAD_INITIAL_BYTES`, bursty joins (`YJS_LOAD_RAMP_MS=0`), and higher edit
rates (`YJS_LOAD_UPDATE_MS`). Observe task metrics and DynamoDB/S3 requests while
changing the worker count. Run a longer idle phase to observe automatic scale-in.
Record deployment size, users per document, bytes per document, edit frequency,
latency/error targets, and results before choosing production limits.

## Retention

Deleting an intent/project writes a revocation marker that fences future leases
and checkpoints (active ownership notices on renewal). Existing deletion code
still removes its known metadata rows. **The new binary snapshots are retained;
this change does not add permanent snapshot purge to parent deletion.** Do not
remove the revocation markers while old scope tokens or clients might exist.
Snapshot retention and permanent deletion require an explicit operational policy
before enabling cluster mode for data that must be erased with its parent.

Successful checkpoints remove their previous committed object version.
Ambiguous writes, process death between upload and commit, failed cleanup, and
old artifact epochs can leave additional objects. Do not attach a blanket S3
age-based expiration rule: it could delete a still-authoritative idle document.
Inventory and garbage collection must check the manifest/ownership state and
revoked scopes, including uploads that were in flight when deletion began.
