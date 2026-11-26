# Yjs operations

Yjs runs collaborative editors on ECS Fargate. The default is one standalone
worker; cluster mode adds workers and recovers documents from S3 checkpoints.
Each document has one owner, so adding workers helps with more documents, but
not with one unusually busy document.

## Configuration

Set `yjs_scaling` in your environment's Terraform variables. Production defaults
to one worker with 1024 CPU units and 2048 MiB; other environments use 256/512.
For a larger standalone worker, set `cpu` and `memory` only.

After [enabling cluster mode](#enable-expand-and-roll-back), use a fixed
`desired_count` or automatic scaling:

```hcl
yjs_scaling = {
  cluster_enabled = true
  cpu             = 1024
  memory          = 2048
  autoscaling = {
    min_capacity = 2
    max_capacity = 8
  }
  # Add existing SNS topic ARNs to receive capacity/error alarms:
  # alarm_actions = ["arn:aws:sns:REGION:ACCOUNT:TOPIC"]
}
```

For a fixed count, replace `autoscaling` with `desired_count = 4`. Manage the count
through Terraform; console changes are not reliably restored by an unchanged apply.
Leave spare capacity for a worker failure or deployment. Autoscaling takes time
and fleet averages can hide an overloaded document owner.

These limits also belong in `yjs_scaling`. Byte settings use bytes, not MiB:

| Setting                    |                      Default |
| -------------------------- | ---------------------------: |
| `max_connections`          |              2000 per worker |
| `max_documents`            |               256 per worker |
| `max_document_bytes`       |              8388608 (8 MiB) |
| `max_total_document_bytes` |            67108864 (64 MiB) |
| `max_buffered_bytes`       | 16777216 (16 MiB per socket) |

Encoded document size is smaller than runtime memory use. Workers also reject
loads and updates above 85% of their configured memory capacity. Measure your
workload before raising limits.

## Current space permissions

Owners and Members can edit; Viewers can read. The projects Lambda checks access
when a document opens. For each sync or save message, the worker reads current
membership directly from DynamoDB and applies the shared Cedar policy
(`lambda/shared/policies/space.cedar`) locally.
Membership is not cached. Disabling `DOC_TOKEN_ENFORCE` does not bypass identity
or membership checks.

Temporary permission lookup failures cause a retryable disconnect (1013).
The browser keeps its last known permissions and unsent edits during network
failures; confirmed loss of write access discards unsaved edits. Initial permission
loads retry with backoff and on network reconnection.

Deploy the REST Lambdas, Yjs image, Terraform wiring, and frontend together before
assigning Viewers. To build the image locally, use BuildKit:

```bash
docker build -f lambda/yjs-server/Dockerfile lambda
```

## Ownership and durability

Cluster workers forward connections to the document owner. Leases prevent two
workers from committing the same document. Owners checkpoint changed documents
to S3, normally every two seconds, and recover the committed version before sync.
During transfer or shutdown, the owner saves and asks browsers to reconnect.

**A successful checkpoint receipt confirms durability; the two-second interval
alone does not.** Storage failures can delay saves. Browsers preserve edits across
reconnects, but have no IndexedDB backup: losing the owner and every browser before
a checkpoint can lose recent edits. Standalone mode relies on REST autosaves and
does not recover binary checkpoints.

REST saves still provide the business records used by APIs and workflows. See the
[data model](../concepts/data-model.md) for storage responsibilities.

API integrations must supply `ifDraftRevision` on draft PATCH and both
`ifEditRevision` and `collaborationEpoch` on artifact PUT; missing preconditions
return 428, and competing writes return 409 `edit_conflict`.

## Enable, expand, and roll back

1. Deploy the backend and frontend with one standalone worker, then reload active
   browsers. Standalone deployment briefly interrupts collaboration.
2. Let editors save and close. Set `cluster_enabled = true`,
   `mode_transition = true`, and `desired_count = 1`, with no autoscaling.
   Deploy and wait for the service to stabilize.
3. Verify editing and checkpoint recovery. Set `mode_transition = false`, then
   increase the worker count. Never combine the initial transition with scaling:
   overlapping standalone and clustered workers would hold independent state.
4. Test worker loss, reconnects, growth, and shrinkage in an isolated environment
   before enabling automatic scaling.

The deploy role needs permission to manage Application Auto Scaling and, when
first enabling it, to create the ECS service-linked role.

Normal cluster deployments start replacements before draining old tasks; allow
quota and subnet capacity for that overlap. Transition mode stops old tasks first
and must be removed after migration.

For rollback, first disable autoscaling and return to a fixed count, keeping
cluster mode enabled. Preserve the tables and S3 checkpoints. Returning to
standalone or an older server requires a maintenance window: save business data,
close editors, and account for drafts that exist only in binary checkpoints.
Standalone mode cannot read them.
ECR retains only the last 30 images, so rollback to an older Yjs image must stay
within that window.

## Metrics and incident checks

Run `terraform output -json yjs_scaling` for sizing and the CloudWatch service
name. Metrics use the `CollaborativeAI/Yjs` namespace. Configure `alarm_actions`
to receive notifications.

| Symptom                           | Check                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Slow edits                        | `EventLoopDelayP99Ms`, CPU, update rate, and whether one document is busy              |
| Memory pressure or rejected joins | `ResidentMemoryBytes`, `DocumentBytes`, `CapacityUtilization`, and worker limits       |
| Repeated reconnects               | `QueuedBytes` for slow consumers; worker drains or transfers; permission lookup errors |
| Save failures                     | `PersistenceErrors`, IAM, S3 errors, and DynamoDB throttling                           |
| Worker not ready                  | `NotReady`, cluster membership, and DynamoDB connectivity                              |

`/livez` (also `/healthz`) checks process liveness; `/readyz` checks cluster
readiness. A dependency outage can make a worker unready without triggering an
ECS restart. Recovery depends on storage availability and lease expiry.

## Deletion and snapshot retention

Deletion blocks new document owners, stops existing ones from writing, and removes all S3
versions under the scope. A `409 deletion_pending` response means cleanup needs
more time: retry shortly. Scheduled cleanup removes late uploads.

Keep deletion markers (tombstones) permanently, and never reuse document namespaces.
Do not apply blanket S3 age-based expiration: it can delete the only checkpoint
of an idle document. Successful checkpoints remove the previous version, but
interrupted uploads and old artifact epochs can leave objects until scope deletion.

Older tombstones need a one-time cleanup-index backfill. Review the dry run first:

```bash
YJS_DOCUMENTS_TABLE=your-table node scripts/backfill-yjs-deletion-cleanup.mjs
YJS_DOCUMENTS_TABLE=your-table node scripts/backfill-yjs-deletion-cleanup.mjs --apply
```

## Reproducible validation

Use Node 24. For local transport tests:

```bash
npm ci
npm ci --prefix lambda/yjs-server --ignore-scripts
npm --prefix lambda/yjs-server test
```

The [testing guide](testing.md) covers broader integration tests. For a deployed
load test, use a disposable intent and set `YJS_LOAD_JWT` to a Cognito ID token
valid for the run:

```bash
export YJS_LOAD_URL=https://your-test-application.example
export YJS_LOAD_PROJECT_ID=your-space-id
export YJS_LOAD_INTENT_ID=your-intent-id
YJS_LOAD_CLIENTS=100 YJS_LOAD_DOCUMENTS=25 YJS_LOAD_SECONDS=180 \
  YJS_LOAD_REQUIRE_DURABILITY=true node lambda/yjs-server/load.js > run.json
```

The run checks that clients agree on all edits and receive checkpoint receipts.
To verify stored snapshots and cold recovery:

```bash
export YJS_DOCUMENTS_TABLE=your-yjs-documents-table
export YJS_MEMBERS_TABLE=your-yjs-members-table
export YJS_SNAPSHOTS_BUCKET=your-artifacts-bucket
node lambda/yjs-server/verify-snapshots.js run.json > snapshots.json

# After the load process exits, replace the owner or wait for idle eviction.
YJS_LOAD_EXPECTED_FILE=run.json YJS_LOAD_REQUIRE_DURABILITY=true \
  node lambda/yjs-server/load.js > recovery.json
```

Test both many documents and one busy document, including worker replacement and
scale-in. Record worker sizing, document sizes, edit rate, reconnects, and latency.
The historical [PR #457 measurements](https://github.com/aws-samples/sample-collaborative-ai-dlc/pull/457)
predate per-message membership checks; rerun deployed tests before using those
numbers for capacity planning.
