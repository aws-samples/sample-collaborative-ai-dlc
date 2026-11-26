# Dev native-foundation plan review

Reviewed: 21 September 2026. Target: `dev`, `us-east-1`.
Status: the user approved the Yjs cluster retirement described below and
reported deployment complete. Read-only AWS verification subsequently confirmed
the disabled foundation and healthy standalone Yjs service. This task did not
apply the plan or change Terraform state.

Saved plan: `/tmp/aidlc-native-dev.tfplan`

SHA256:
`9cc275542502f00d005d0c1058ab10c558d6ab064170b28271133f2ef8d4cd48`

The deploy wrapper produced `/tmp/aidlc-native-dev.tfplan.json` before its
destruction check rejected the plan. Review used that local JSON, which was
written after the saved binary, and exposed only selected non-secret fields.
The approval applies to this saved plan, not a regenerated plan.

## Why the guard stopped

The running deployment includes work from `origin/codex/455-yjs-scaling`:
commits `6865de2`, `3c18aad`, and `25f6254`. Those commits are not in the native
branch's ancestry. The current checkout contains the standalone Yjs server.
Consequently Terraform proposes removing resources defined only by the scaling
branch.

The sole protected-resource deletion is:

`module.yjs_server.aws_dynamodb_table.members[0]`

This is the `collaborative-ai-dlc-yjs-members-dev` worker-heartbeat table, keyed
by `id` with TTL `expiresAt`. It is not the project-user membership authority.
Its deletion reason is `delete_because_no_resource_config`.

The same plan also retires the Yjs autoscaling target, four worker alarms and
the cluster IAM policy, replaces the task definition, and removes its cluster
storage and capacity environment variables. Desired worker count remains one.
This is a rollback to the standalone server, not just a table cleanup.

After being told about the broader Yjs rollback, the user confirmed that `dev`
had been deployed from another branch and approved getting rid of those
features. No exception was added to the general destruction guard.

## Data and feature checks

- The Yjs document table has a `no-op` action.
- The existing artifacts and code-snapshots buckets have `no-op` actions,
  including their versioning and lifecycle configurations.
- No other protected persistent resource is deleted or replaced in this plan.
- The new workflow-source table, package-job table, and private package bucket
  are created.
- `enable_native_workflow_sources`, `enable_native_package_jobs`, and
  `native_package_jobs_host_qualified` are all false in the saved plan.

The standalone server does not load the cluster's binary checkpoints. Keeping
the storage does not make checkpoint-only drafts available to that runtime.
The scaling branch's rollback documentation describes that limitation explicitly.

## Applying the approved plan

The deployment remains the user's action. From the repository root, direct
Terraform application of this reviewed plan is:

```sh
terraform -chdir=terraform apply /tmp/aidlc-native-dev.tfplan
```

This is a one-off, explicitly approved retirement. The deploy wrapper will
continue rejecting that deletion because its general guard remains unchanged.
Direct Terraform application also does not run the wrapper's extra legacy-agent
retirement helper or SYSTEM workflow reseed.

If the plan is regenerated, review the new plan rather than transferring this
approval to different actions. After apply, verify infrastructure and existing
application behavior before enabling any native feature or running import tests.

## Post-deployment verification

Collected on 21 September 2026, with the infrastructure snapshot completed at
14:31 UTC. The `solution-read` profile resolved to the reviewed account
`746558295630` with its `ReadOnly` role. The similarly named `aidlc` profile
resolved to a different account and was not used for resource inspection.

| Area | Observed result |
| --- | --- |
| Source API and package worker | Both Lambda functions are `Active`, with successful updates. Source administration and import environment flags are `"false"`. Worker architecture is ARM64. |
| Dispatch | SQS consumer is `Disabled`; no matching EventBridge Pipe exists. Main queue and both dead-letter queues report zero visible/in-flight messages and managed encryption. |
| Protected tables | Job and source-binding tables are `ACTIVE`, encrypted, on demand, with PITR enabled and TTL disabled. Job stream is enabled with `NEW_IMAGE`. |
| Package bucket | Versioning enabled, AES256 default encryption, all four public-access blocks enabled, `BucketOwnerEnforced`, and no lifecycle configuration. |
| Package policies | Retrieved bucket policy and worker publisher policy exactly match the rendered repository templates, ignoring JSON member/array ordering. AWS has accepted and stored these policies; request enforcement has not been exercised. |
| API configuration | All five source/package methods use `COGNITO_USER_POOLS` and proxy to the dedicated workflow-source Lambda. The `dev` stage has a deployment updated after the infrastructure apply. These are configuration checks, not authenticated route execution. |
| Yjs runtime | Task definition revision 28, one desired/running task, zero pending, rollout `COMPLETED`, ALB target `healthy`. Cluster-related environment variables are absent. |
| Approved retirement | Worker-members table returns `ResourceNotFoundException`; old scaling target and four alarms are absent; cluster ownership policy is absent from the Yjs task role. |
| Existing storage | Original Yjs document table remains active with its pre-deployment creation date. Artifacts and code-snapshots buckets remain present/versioned; lifecycle rules match the reviewed plan. No document or object contents were read. |
| Frontend | Public homepage and the user's local Vite frontend return HTTP 200. Local `.env` points to the reviewed `dev` API and both WebSocket endpoints. The user is deliberately running the frontend locally; frontend publication is not required for this checkpoint. |

An initial API resource-list request was throttled; a single larger-page retry
and subsequent method reads succeeded. Initial automatic-approval failures
were resolved by manual approval. Two additional public HTTP probes were
declined and were not rerouted through another tool.

Local evidence, containing selected infrastructure metadata rather than tokens,
full Lambda environments, table items, or object bodies:

- `/tmp/aidlc-plan-tools/dev-native-live-readonly-20260921.json`
- `/tmp/aidlc-plan-tools/dev-native-policy-template-comparison-20260921.json`
- `/tmp/aidlc-plan-tools/dev-native-route-metadata-20260921.json`

These temporary files are not durable CI evidence. The findings above retain
their scope and limitations independently of those files.

## Permission review and remaining checks

Fetched inline policies show no AgentCore grants to the native bucket, either
protected table, or either new Lambda. The source API has no object access or
worker invocation grant. The worker has no bucket/role administration, object
deletion, ACL/tag mutation, or bucket-listing grant in the fetched policies.
Its reads cover the package prefix, not a per-job subset.

The source API's `PutItem` permission can replace an existing job if its
application condition is omitted. Similarly, worker `UpdateItem` permission
does not itself enforce row existence or immutable fields. Conditional
creation, leases, and worker-owned fields are enforced by trusted service
code. This is isolation from the agent runtime, not an IAM-enforced boundary
between source submission and worker state. A compromised control service is
outside that guarantee. This limitation does not relax the separate D3
requirement for human approval authority isolated from native runtimes.

Managed attachment names were inspected, but their policy documents were not
fetched. No account-wide principal, indirect invocation, resource-policy, or
role-dedication audit was performed. Policy storage and metadata review do not
qualify effective access or live S3 conditional/copy/multipart behavior.

Authenticated existing-project reads, SYSTEM workflow baseline, two-session
editing/reconnect, and source administration remain unverified. Direct apply
skipped the wrapper's SYSTEM reseed; repository comparison found no changed
baseline requiring reseed, but the deployed published baseline still needs an
authenticated read.

Next checkpoint: prepare source administration enablement
(`enable_native_workflow_sources = true`) for the user's deployment. A test
project can be chosen afterward; its ID does not block plan preparation.
Keep package imports, host qualification, and native execution disabled.
The local UI intentionally hides workflow-source settings while its API is
disabled. The [source-settings checkpoint](native-source-settings-checkpoint.md)
records the rollout preparation. No source enablement or live import has been
performed.
