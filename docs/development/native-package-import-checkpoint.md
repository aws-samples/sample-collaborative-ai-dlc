# Native package import checkpoint

Updated 23 September 2026. Status: **dispatch-template fix applied and verified;
fresh authenticated public UI import succeeded through normal Pipe/SQS in one
attempt, without diagnostic replay**. No native agents have run.

The user selected the existing **`dev`** deployment. Its current tfvars and
backend configuration both use **`us-east-1`**. The
[historical foundation deployment review](dev-native-plan-review.md#post-deployment-verification)
records the earlier disabled deployment, protected storage, exact stored policy
agreement, and approved Yjs cluster retirement. Dev activation superseded that
disabled state; deployment alone does not establish dispatch or harness
qualification.
The user is running the frontend locally against this deployment.

The [temporary storage probe and 8 GiB worker configuration](native-storage-probe-checkpoint.md)
were deployed before activation. After a live multipart-initiation finding and
user-applied policy correction, all 20 cases completed: 18 passed, with expected fixture reuse and
unsupported wrong-header HTTP 501 recorded as inconclusive. Both deployed
policies matched review; inventories at probe completion contained only the
original fixture and no incomplete uploads. The probe and its log group are now
retired. This is effective combined-policy evidence for the direct-upload dev
experiment, not comprehensive IAM or runtime
qualification. The
[delivery status](native-delivery-status.md) distinguishes this prerequisite
from the outstanding native execution and collaborative product work.

The pre-activation public-source check confirmed an active/read-only binding
and catalog metadata for `v2.9.0`; no package jobs or Pipe existed then.
The subsequent worker run and independent archive reads verified actual bytes,
as recorded below.

## Live results — 23 September 2026

Activation passed **16/16 deployed checks**: healthy services, API and worker
imports enabled, SQS consumer enabled, Pipe running with the reviewed bindings
and filter, probe/log retirement, and unchanged permissions and resource
allocations. The deployed worker `index.mjs` SHA256 exactly matched review:
`d4ae7a7cd42af8f8c6f2853b6fe1d53986af2cebef29ba618175508d431701f8`.
These checks established deployment agreement, not correct template expansion.

The user applied `/tmp/aidlc-native-dispatch-fix-dev.tfplan`. At
**10:56:26.659Z**, live `DescribePipe` exactly matched the reviewed raw-heredoc
`InputTemplate`; the Pipe was `RUNNING`, its role/source/target/filter unchanged,
and the SQS consumer `Enabled`.

At **2026-09-23T10:57:37.216Z**, the authenticated UI submitted fresh
official public-source `latest` job `61f63842-1ce8-4b1e-b145-b3efdf6c3075`.
It reached **`SUCCEEDED`, attempts 1**, at **10:57:46.439Z**
(`updatedAt=1790161066439`) through **normal Pipe/SQS delivery only; no
diagnostic replay**. Worker duration was **7,516.43 ms**, maximum memory
**738 MiB of 8,192 MiB**, and initialization **340.20 ms**.

UI Download verified **v2.9.0**, commit
`22f5d1b15a064c9ae80046e5b1761d5877e2f69f`, with **Claude, Codex, Kiro and
OpenCode** included. The job's complete package pin and materialization match
the earlier import exactly:

- Package: `sha256:0399ab50fa7ed00eae5a246159fdb1d594c8fd4946c6aeb72452d9d6e2770ce0`.
- Materialization: `sha256:eed746ebdc9078b8bf9217cebaad743e8f90eded8b299da8b96c99eb81bf9368`.

At 10:59:19Z, independent reads confirmed the new receipt is identical to the
earlier verified archive. The exact manifest version was read and checked
again; all five file versions are unchanged. The inventory contains exactly
six object versions, with no extras or delete markers. Both DLQs are empty;
the earlier failed message remains in flight. Evidence:
`/tmp/aidlc-plan-tools/native-normal-import-archive-verification-20260923.json`.
The import API correctly reports signatures `not_checked` and execution
`not_qualified`. A separate [local initialization test](native-initialization-probe.md)
subsequently verified the signature and configured all four harnesses; it does
not change the import API's qualification scope.

**Historical initial dispatch failure and diagnostic replay.**

At **06:18:41Z**, the authenticated UI submitted official-source `latest` job
`b17f3cc4-d556-43bd-9cd2-7693f77c8d0e`. The normal SQS invocation lasted
**8.34 ms**, but the job remained `QUEUED`, attempts **0**. Its actual SQS body
was not captured.

At **06:22:54Z**, one diagnostic direct-Lambda canonical-pointer replay of
**the same authoritative job** succeeded: worker duration **8,073.01 ms**,
maximum memory **724 MiB of 8,192 MiB**, final attempts **1**. The UI Download
preview verified **v2.9.0**, commit
`22f5d1b15a064c9ae80046e5b1761d5877e2f69f`, and all four projections.
Signatures remain `not_checked`; native execution remains `not_qualified`.
No agents or coding harnesses were executed.

Independent operator read-only checks of that archive's exact S3 versions passed
for the manifest and all five files, including SHA256, byte size and package
identity/version.

**That replay was not normal dispatch success.** At that checkpoint the original
unread SQS message was in flight; no SQS deletion or visibility mutation was
performed. The then-deployed `InputTemplate` contained literal backslash
sequences `\u003c`/`\u003e` and no literal `<$.` tokens. The applied raw-heredoc
correction preserves those delimiters; the worker parser is unchanged.
The fresh normal success after this template-only update supports the
escaped-template explanation for the earlier failure, but the old body was never
captured and its exact shape remains unknown.
See the [dispatch review](native-package-dispatch-review.md).

Local evidence under `/tmp/aidlc-plan-tools/` (raw job records contain private
actor/revision fields and must not be copied into documentation):

| Evidence | File |
| --- | --- |
| Applied dispatch fix, exact template and running delivery | `native-dispatch-fix-deployed-20260923.json` |
| Fresh normal UI import, successful job and worker observations; no replay | `native-normal-import-live-20260923.json` |
| Activation and exact deployed worker hash | `native-first-import-deployed-20260923.json` |
| Historical initial job and stalled normal invocation | `native-first-import-live-20260923-initial.json` |
| Historical diagnostic replay of the same job | `native-first-import-canonical-replay-20260923.json` |
| Historical replay-completed job, queue and worker observations | `native-first-import-live-20260923-completed.json` |
| Earlier independent exact-version archive verification | `native-first-import-archive-verification-20260923.json` |

## Current deployment — dispatch fix applied and verified

The user applied `/tmp/aidlc-native-dispatch-fix-dev.tfplan`; deployed agreement
and fresh normal delivery are verified above. In the historical review, the
full plan, without targeting, was generated **2026-09-23T06:29:55Z** against
state serial **1089**. SHA256:
`046f57519bf514b589dc288678bfad7c2aafbc2a1d45e83ff47dab60e2ae3f01`.

Exactly one in-place change updated
`module.lambda.aws_pipes_pipe.native_package_jobs[0]`, solely
`target_parameters[0].input_template` from escaped to literal delimiters.
There were no other resource changes, output changes or deletions. The only
refreshed metadata difference was empty Pipe `tags`: `null` → `{}`.
All **11 review assertions**, **112 policy/wiring tests**, Terraform formatting
and validation (zero errors, two existing deprecations), and targeted lint passed.
Evidence: `/tmp/aidlc-plan-tools/native-dispatch-fix-dev-reviewed-20260923.json`.

The next loop is real local installation/configuration of the verified Linux
ARM64 package for all four harnesses, if Linux ARM64 Docker is available. The
main task is checking availability and owns the next probe and fresh S3 checks.
No agents have run.

## First-import activation — applied, historical plan

The user applied `/tmp/aidlc-native-first-import-dev.tfplan`; deployed
verification completed on 23 September. This historical activation preceded
the now-applied dispatch correction. It was generated **22 September 2026,
12:24 UTC**, against state serial **1087**.
SHA256: `84385df47007f2fb911cbca88bff5e54451ff1cbd3decd6903b010b2409c0599`.

The reviewed full plan, without resource targeting, contained these cloud changes:

| Resource | Change |
| --- | --- |
| Workflow-source API | Set `NATIVE_PACKAGE_JOBS_ENABLED=true`; other environment fields and code unchanged |
| Native package worker | Set the same import flag; recompute packaging metadata; preserve role, network, runtime and resource allocations |
| Existing SQS consumer | Enable it; other settings unchanged |
| Package-job Pipe | Create and start the reviewed queued-state filter and pointer transform |
| Temporary storage-probe Lambda and its log group | Remove them; all 12 log events and structured results are retained locally |

No tables, queues, buckets, IAM grants, gateway routes or AgentCore resources
changed in that activation. The full refresh observed the already-applied storage
policies in cached role/bucket attributes; it proposed no further policy mutation.
Local Terraform changes comprised a readiness-record update, probe
configuration/helper removal and three worker packaging-helper replacements.
The probe function-name output became null. The original synthetic S3 fixture
remains under the immutable package policy.

Before activation, **109 policy tests**, targeted formatting/lint, worker compilation, Terraform
validation, all **19 plan-review checks**, and the normal destruction inspector
passed. Worker compilation produced exactly the same `index.mjs` bytes as the
prior deployed archive:
`d4ae7a7cd42af8f8c6f2853b6fe1d53986af2cebef29ba618175508d431701f8`.

The Lambda module deferred worker archive metadata and its partition-dependent
logging block until apply because its readiness dependency changed. The
23 September activation checks verified the deployed bundle and expected
logging configuration. The separate dispatch-fix review is recorded above.

Historical pre-activation evidence:

- `/tmp/aidlc-plan-tools/native-first-import-dev-reviewed-20260922.json`:
  exact scope, checks, state, 178 input hashes and build hash.
- `/tmp/aidlc-plan-tools/native-first-import-worker-build-20260922.json`:
  successful compile and comparison to the prior archive.
- `/tmp/aidlc-plan-tools/native-first-import-readiness-20260922.json`:
  then-active public binding, empty job table and absent Pipe.
- `/tmp/aidlc-plan-tools/native-first-import-queue-preflight-20260922.json`:
  zero visible, in-flight and delayed messages reported for all three queues.
- `/tmp/aidlc-plan-tools/native-first-import-public-catalog-20260922.json`:
  live public release discovery through the implemented transport/catalog.

The historical diagnostic run exercised downloads, byte verification and immutable
archival; the fresh public UI job also verified normal dispatch. Recovery remains
acceptance work. The four harness projections are verified package contents,
not execution-qualified integrations.

## What is implemented

An authenticated request creates a conditional record in the protected
`native-package-jobs` DynamoDB table. The configured delivery path is its stream
through an EventBridge Pipe into SQS; the fresh public UI import verified this
normal delivery path after the template fix. The dedicated package Lambda obtains
the authenticated actor, workflow source, binding revision, and requested release
from the table, never from the queue body.

The worker acquires a lease and rechecks current membership and source access.
It journals the immutable package candidate before uploading, and the exact S3
commit receipt before reporting success. A replacement worker can reconcile a
lost receipt or restore exact pinned versions. It never resolves a newer
`latest` after a candidate has been saved. An incomplete archive without a
commit is not silently replaced with a new release.

Before success, the worker removes attempt files, drains owned I/O, closes the
attempt connection, and reads source/member authorization again through a
separate reusable read connection. Failure and cancellation close and drain that
connection too. This removes the stale authorization window caused by waiting
for attempt cleanup after the final read. The graph read and DynamoDB success
update are still separate operations under D18; instantaneous revocation is
not guaranteed.

The HTTP status view omits actor/credential references, lease data, package
inventory, internal errors, local paths, and S3 receipts. A successful import
explicitly reports signature verification as `not_checked` and execution as
`not_qualified`. Project settings now include import controls for active workflow
sources: latest stable or an explicit version, status polling, and the verified
package preview. Listing available release versions is still future work; the
first host checkpoint can also use the authenticated REST API.

The UI retains the original request ID and selection in session storage scoped
to user, project, source, and binding revision. After a lost response or remount,
it reads that job's status; it does not automatically submit another `latest`
request. A user can deliberately clear the local saved request, with an explicit
explanation that an existing import may continue. Clearing does not cancel a
worker. Source listing now advertises the effective
`capabilities.packageImportsEnabled` boolean. The UI requires explicit `true`
before mounting import controls or restoring/polling jobs. Legacy array
responses and missing/invalid capability metadata preserve source
administration with imports hidden. Disabled-import responses still remove
controls if the gate changes after listing. The
[source-settings checkpoint](native-source-settings-checkpoint.md) was applied
by the user on 22 September; the deployed bundle and source/import flags were
verified through read-only metadata. The user then completed the first
authenticated public-source save/list check for `awslabs/aidlc-workflows`;
the active, public, read-only binding was independently verified in DynamoDB.
The 23 September activation enabled imports, and the subsequent template fix
and fresh UI job verified normal official public-package delivery. The remaining
source-authorization/private-provider cases remain unverified.

## Remaining acceptance work

Normal dispatch for the official public source is verified. Failure/recovery, retry/DLQ,
duplicate and malformed-pointer cases, plus public/private GitLab/Bitbucket and
private GitHub imports, remain pilot acceptance work. Broader IAM and
multipart-completion claims remain outside the completed dev storage probe.

The selected **8,192 MiB memory, 4,096 MiB temporary disk, 600 seconds, one
worker and three leased attempts** are deployed and verified. Both import runs
measured memory and duration above; these settings do not limit coding-agent runs.

`enable_native_workflow_sources` controls source administration.
`enable_native_package_jobs` controls package imports. The separate
`native_package_jobs_host_qualified` switch records reviewed readiness for the
bounded first import; the switch alone is not dispatch or recovery evidence.
All three conditions are required: dev storage qualification, explicit
import enablement and host readiness. The root defaults remain off; this
checkpoint opts in only the selected dev configuration.

Earlier shell attempts to fetch the AWS reference documentation were blocked: the
sandbox could not resolve the host, and automatic approval review rejected an
escalated read-only download with an internal account/model validation error.
On 21 September the web lookup tool successfully retrieved the AWS references.
The [storage policy documentation review](native-package-policy-review.md) is
complete, including the copy-documentation discrepancy and multipart/deletion
boundaries. Documentation access is no longer a blocker. Subsequent manual
approval allowed Terraform validation and read-only deployed inspection.
Live request enforcement has now been exercised with the limits recorded above.

## Storage policy wiring

Policy templates are wired in Terraform from
`terraform/modules/data/s3/policies/native-packages-bucket.json.tftpl` and
`terraform/modules/api/lambda/policies/native-package-publisher.json.tftpl`.
The S3 bucket policy uses the first template. A separate inline policy attaches
the second template to the dedicated package worker. Both deployed documents
were retrieved and match their templates. Other account principals and
account-wide role dedication have not been audited.

The bucket policy denies package writes by other principals, false/missing
object-creation context, writes without the exact creation condition, copies,
object/version deletion and insecure transport. The worker grant requires
conditional HTTPS publication, true object-creation context and no copy-source
context within `native-packages/v1/`. It does not grant listing, deletion,
ACL/tag mutation or multipart abort. Completion shares true creation context;
empty upload inventory remains part of this direct-upload checkpoint.

The dependency order is worker role → bucket protection → exported bucket ARN
→ publisher grant → worker Lambda. Only the role ARN flows back into the S3
module; there is no whole-module dependency. The exported bucket ARN waits on
policy, versioning, ownership controls, encryption, and public-access blocking.
This is intended to prevent attaching the upload grant before those protections
exist. Terraform configuration validation accepted this dependency graph in
the earlier foundation deployment. Effective requests were exercised by the
probe; post-deployment snapshots do not prove historical IAM propagation or
deployment ordering.

`native_package_upload_policy_qualified` now requires `var.environment == "dev"`.
Both service enable flags, the SQS consumer and Pipe creation still depend on
that gate together with explicit enablement and host readiness. The plan-time
precondition rejects activation in other environments, even with both flags
set. This advances the dev experiment without asserting production or native
execution qualification.

Render the concrete proposal without AWS access or credentials:

```sh
node scripts/render-native-package-policies.mjs \
  --bucket-arn arn:aws:s3:::YOUR-NATIVE-PACKAGE-BUCKET \
  --publisher-role-arn arn:aws:iam::123456789012:role/YOUR-PACKAGE-WORKER
npm run test:native-policies
```

The renderer emits `qualification: "unverified"` with the remaining checks;
the documentation review is recorded separately from live qualification.
The local tests evaluate explicit request-context examples against the
rendered JSON, including attempted bypasses with another broad writer grant.
The publisher is checked independently of bucket denies; both source namespaces,
adjacent prefixes, and designated/other/missing principal contexts are exercised.
Static source checks cover exact template attachment, dependency ordering, and
the effective activation block. In-memory mutations exercise those checks
against broken permissions and activation/dependency changes. They do
**not** establish which context keys S3 supplies, how each multipart/copy API
maps to IAM actions, or whether AWS accepts these policies.

AWS accepted these policies in the earlier foundation deployment. The corrected
live probe completed positive/negative request checks, and the historical
diagnostic import exercised the worker's package-read/publication path. Fresh
normal delivery is verified above. Activation and the dispatch fix left permissions
unchanged. This evidence supports the bounded dev experiment, not broader IAM,
recovery or native execution qualification.

The following records historical foundation validation. After the
user selected manual approval and installed Terraform through Homebrew, local
validation completed on 21 September with **Terraform 1.16.3**. CI is still
pinned to **1.15.0**; exact CI-version parity was not tested or changed.

`terraform fmt -check -recursive terraform` passed after formatting two files.
For validation, a private temporary copy of the Terraform tree uses the same
local-backend override as CI, with links to the repository's required source and
configuration files. `init -backend=false -lockfile=readonly -input=false`
succeeded, using the existing provider lock selections. The lockfile is
unchanged. `terraform validate -json` reported **valid, zero errors, two warnings**:
deprecated `hash_key` and `range_key` on the existing Git source-control binding
table. Provider processes required normal manual approval to run outside the
sandbox. No deployment backend, state, or AWS account was accessed.

The validation summary is retained locally in
`/tmp/aidlc-plan-tools/terraform-validate-summary-20260921.json`.
The first `dev` plan was generated and rejected by the wrapper because it
deletes a Yjs cluster worker-membership table from a previously deployed branch.
The user subsequently approved retiring the Yjs cluster features. The
[saved-plan review](dev-native-plan-review.md) records the exact plan, unchanged
document/snapshot storage, disabled native flags, and this one-off approval.
The user subsequently reported deployment complete. Read-only verification
confirmed the then-disabled foundation and healthy standalone Yjs service.
The subsequent source and import activations superseded those disabled flags.

At the historical foundation checkpoint, the wrapper's default `--phase all`
displayed a plan, checked protected-resource destruction and applied the saved
plan without another Terraform confirmation; separate plan/apply phases allowed
a review pause. The all-false native flags belonged to that historical checkpoint.
The wrapper also ran legacy agent retirement before apply and reseeded SYSTEM
workflow defaults afterward unless `--skip-seed` was supplied; those script
actions were outside the Terraform plan.

## Submission contract and remaining live coverage

Use a current project member's authenticated session and an active workflow
source returned by the source API. Generate one client UUID per intended import
and retain it until the response is known.

`POST /api/projects/{projectId}/workflow-sources/{sourceId}/packages`

```json
{
  "jobId": "22222222-2222-4222-8222-222222222222",
  "expectedRevision": "11111111-1111-4111-8111-111111111111",
  "requestedRelease": "latest"
}
```

Replace both example UUIDs. `expectedRevision` must be the current source
binding revision. The default selection is `latest`; an explicit supported
`vX.Y.Z` or native preview tag can be supplied.

A valid submission returns HTTP 202 with the job status. If the response is
lost, repeat the **same body and job ID**. A different source, actor, revision
or selection with the same ID must return conflict instead of changing a job.

`GET /api/projects/{projectId}/workflow-sources/{sourceId}/packages/{jobId}`

Expect `QUEUED → RUNNING → SUCCEEDED`, or a safe `FAILED` status. An unauthorized
or removed member must not obtain job details. A source revision change must
prevent use of its old authorization; reconfiguration does not silently migrate
an existing job.

Beyond this normal official public import, acceptance still needs explicit-version
and provider cases, duplicate delivery, interrupted/cold recovery, revocation and source-change
denials, malformed input, and retry/resource behavior. The completed storage
probe, historical diagnostic import and fresh normal import establish only the
results recorded above.
The API's underlying `PutItem` grant can replace rows; create-only behavior is
application-enforced, not an independent IAM boundary between these services.
This checkpoint does not constitute the all-four harness initialization gate.

## Historical local verification

- The earlier foundation run passed 2,798 tests across 48 suites. Its four
  skipped loopback-socket tests subsequently passed in a targeted run with
  manually approved localhost access. Those skips are now verified; unrelated
  passing foundation tests were not rerun.
- All 36 buildable Lambda workspaces compiled. Both new production entry points
  imported, and the bundled worker rejected requests while disabled.
- Lint passed with zero errors and the same 16 existing warnings.
- The worker/host suites cover 47 cases, including filesystem-backed cold
  recovery, lost receipts, stale leases, cleanup/close revocation, redirects,
  bounded credential transport, and cancellation/draining.
- All frontend tests now pass: **768 tests across 83 suites**, comprising 276
  planned component/service tests and 492 remaining tests in a separate run
  without repeating the planned suites. Full TypeScript checking and the
  production build also pass. Vite reports large output chunks; frontend lint
  passes with five existing warnings.
- Locked frontend dependencies installed successfully after manual approval.
  No source fixes, manifest changes, or lockfile changes were needed. The prior
  missing-dependency restriction no longer blocks local UI validation. Browser
  interaction and deployed integration were not covered by those local checks;
   the subsequent authenticated UI and normal/diagnostic import results are recorded above.
- The latest storage-wiring slice passed 99 policy/renderer/static-wiring tests,
  including detection of 29 harmful in-memory mutations.
  Root lint passed with the same 16 existing warnings. No production bucket
  policy or role was changed. All 99 tests passed again after Terraform formatting.
- Terraform 1.16.3 formatting, initialization with the readonly provider lock,
  and configuration validation passed as described above. CI still uses 1.15.0.
- Provider, AWS storage, and authority responses in these tests are simulated.
  Unit tests do not qualify deployed IAM, Pipes, or real ARM64 resource usage.
  Terraform schema validation is a separate completed check, not live proof.

## Recovery and operational limits

SQS deliveries and leased attempts are distinct. Duplicate/busy deliveries may
consume queue receives without beginning another attempt. The queue dead-letter
threshold therefore differs from the worker's attempt limit.

The table has no TTL. The queue and dispatch stream have finite retention.
There is no periodic reconciliation sweep in this slice: after a dispatch
outage beyond stream retention, operators must inspect durable `QUEUED` rows.
Alarms are created without notification destinations; nobody is automatically
paged by this patch.

After fixing the underlying problem, an authorized operator may resend only
this pointer to the protected work queue for an existing nonterminal job:

```json
{
  "schemaVersion": 1,
  "projectId": "existing-project-id",
  "jobId": "22222222-2222-4222-8222-222222222222"
}
```

The worker rereads the protected record and reauthorizes the original actor.
Do not copy a raw dispatch dead-letter record into the work queue, edit the
table's candidate/receipt/lease, or re-resolve `latest` as recovery. Terminal
jobs are immutable; a deliberate new import uses a new job ID.

Stopping dispatch does not remove retained records or packages. Removing a
source does not delete immutable bytes. Retention and automated cleanup remain
the separate D10 decision.
