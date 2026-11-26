# Native package storage probe checkpoint

Target: existing `dev`, `us-east-1`. Prepared locally on 22 September 2026.
The user deploys infrastructure. Neither this document nor deployment invokes
the probe, creates a package job, or enables imports.

Status: **completed for the first dev package-import checkpoint**. The user
applied the multipart-policy correction; both deployed policies were verified.
The third invocation completed all 20 cases without unexpected mutations.
On 23 September, dev import activation was verified and this probe/log group
was retired. This document retains the completed storage experiment's history;
see the [import checkpoint](native-package-import-checkpoint.md) for the
successful diagnostic import and pending normal-dispatch correction.

## Completed verification loop

The third invocation returned **18 PASS and two INCONCLUSIVE** results:

- `INITIAL_CREATE_REUSED`: the fixed fixture already existed; its first
  invocation supplies the successful creation evidence.
- `CONDITION_NOT_IMPLEMENTED`: the deliberately unsupported wrong condition
  returns HTTP 501, not authorization evidence.

All other cases passed, including both multipart-initiation attempts, both copy
attempts, overwrite attempts, adjacent-prefix publication, and single/batch
current/version deletion. Batch requests returned HTTP 200 with every item
denied and no deletions. Final current and exact-version reads matched the
original fixture. Independent post-invocation reads found no negative objects,
delete markers or unfinished multipart uploads.

The raw probe correctly retains `code: INCONCLUSIVE` and
`qualification: unverified`; its designed scope cannot establish all IAM,
provider or execution guarantees. The combined live results and reviewed
policies are sufficient to advance the current direct-upload dev experiment.
They do not independently prove each bucket denial, other-principal/account-wide
IAM, multipart completion, or native execution. Keep those limits explicit.

Evidence:

- `/tmp/aidlc-plan-tools/native-storage-multipart-fix-deployed-20260922.json`:
  11 deployed-policy, configuration and preflight checks passed.
- `/tmp/aidlc-native-storage-probe-result-third.json`: all 20 observed cases.
- `/tmp/aidlc-plan-tools/native-storage-third-invocation-20260922.json`:
  invocation metadata.
- `/tmp/aidlc-plan-tools/native-storage-third-run-postconditions-20260922.json`:
  all five independent postcondition checks passed.
- `/tmp/aidlc-plan-tools/native-storage-probe-logs-before-retirement-20260922.json`:
  all 12 log events exported before planned probe/log-group removal.

Next: deploy the bounded package-import activation described in
[the import checkpoint](native-package-import-checkpoint.md), retire the
temporary probe, and submit one real public import through the existing UI.

## Second invocation and policy correction — completed

At 12:03 UTC on 22 September, the corrected probe reached 13 of 20 cases:

| Observed operation | Actual AWS result |
| --- | --- |
| Existing source creation attempt | HTTP 412; expected `INITIAL_CREATE_REUSED`, not a new-create success |
| Current and pinned reads | HTTP 200; original version and bytes |
| Identical/conflicting conditional overwrites | HTTP 412 |
| Missing condition, replacement condition, unconditional overwrite | HTTP 403 |
| Unsupported fixed condition value | HTTP 501; inconclusive, continued as intended |
| Copies with/without the destination condition | HTTP 403 |
| Ordinary multipart initiation | HTTP 403 |
| Multipart initiation with a signed `If-None-Match: *` header | **HTTP 200; unexpected mutation, stopped immediately** |

The remaining seven cases were not executed. The failure shows that requiring
the header does not itself prevent multipart initiation. Independent reads
confirmed only the original 32-byte source version, no extra objects/delete
markers in either synthetic prefix, and exactly the reported unfinished
upload. `ListParts` confirmed that upload was empty. Operator credentials
aborted only that confirmed synthetic session; a fresh inventory found no
remaining uploads under `native-packages/v1/`. The runtime gained no cleanup
permissions, and the source fixture remains intact.

The policy correction requires `s3:ObjectCreationOperation: true` in the
publisher allow and adds an explicit bucket denial using `BoolIfExists: false`.
False or missing operation context is denied even with an injected correct
header and another broad allow. Existing guards are unchanged. Completion
creates an object and shares true context; it is not independently blocked by
this guard. The empty-inventory requirement therefore remains.

Local verification: **104 policy tests pass**, Terraform validation reports no
errors, and AWS Access Analyzer reports no errors or security warnings for
either rendered policy. Its sole warning in each is the intentional exact
literal `*` comparison; changing that to wildcard matching would weaken the
condition. These checks do not establish live request behavior.

The user already applied this historical policy-correction plan:

```sh
terraform -chdir=terraform apply /tmp/aidlc-native-storage-multipart-fix.tfplan
```

This targeted correction updates only the `policy` field of:

- `module.s3.aws_s3_bucket_policy.native_packages`
- `module.lambda.aws_iam_role_policy.native_package_publisher`

There are no Lambda, resource-sizing, network, data or import-activation
changes, no helper changes and no deletions. The existing probe is retained.
All 13 review checks and the normal destruction inspector pass. The plan is
targeted to these policies and their dependencies, not a full-stack drift
review.

Plan generated at **12:09 UTC**, state serial **1086**.
SHA256: `990ef73dbbcf6bd60e5c81f7f4c8364989b90d263bb2060113745cde252d8ce7`.

Post-apply verification and the unchanged probe's third invocation are now
complete, as recorded above. The code gate advances only the dev import
experiment; other environments remain blocked and native execution remains
unqualified.

Current evidence:

- `/tmp/aidlc-native-storage-probe-result-second.json`: complete stopped result.
- `/tmp/aidlc-plan-tools/native-storage-probe-fix-deployed-20260922.json`:
  corrected code and configuration verified before invocation.
- `/tmp/aidlc-plan-tools/native-storage-second-run-postconditions-20260922.json`:
  original bytes/version intact, exact empty upload identified.
- `/tmp/aidlc-plan-tools/native-storage-second-run-cleanup-20260922.json`:
  empty session aborted and package upload inventory empty.
- `/tmp/aidlc-plan-tools/native-storage-multipart-fix-reviewed-20260922.json`:
  reviewed plan, policy scope, validation and hashes.

## First invocation and probe correction — completed

The deployed probe ran on 22 September at 09:04 UTC using the verified
`solution` profile in the same dev account. `solution-read` remains suitable
for inspection but its invocation dry run was denied. No permission changes
were made.

| Observed operation | Actual AWS result |
| --- | --- |
| Conditional creation | HTTP 200; one 32-byte version created |
| Current and exact-version reads | HTTP 200; expected bytes and encryption |
| Identical and conflicting conditional overwrites | HTTP 412 `PreconditionFailed` |
| Write without the creation condition | HTTP 403 `AccessDenied` |
| Fixed unsupported condition value | HTTP 501 `NotImplemented`; inconclusive, probe stopped |

The first six cases passed; the seventh stopped the probe before its remaining
13 cases. This is partial live evidence, not completed storage qualification.
Independent post-test reads confirmed exactly the original source version,
matching bytes, no additional objects/delete markers, and no incomplete
multipart uploads.

The correction recognizes only the exact fixed wrong-condition PUT with
`NotImplemented`/501. It records `CONDITION_NOT_IMPLEMENTED` as inconclusive
and continues. It does not count the response as an authorization denial or
relax any bucket policy. Unexpected successful mutations still stop the probe.
All **153 probe tests** pass, including eight regressions around this response.

The user already applied this historical probe correction:

```sh
terraform -chdir=terraform apply /tmp/aidlc-native-storage-probe-fix.tfplan
```

This plan is intentionally targeted to the temporary probe and its
dependencies. Its only cloud change is the probe's code update; three local
packaging helpers are replaced. Worker configuration/code, IAM, storage,
runtime settings and import flags are unchanged. The normal destruction
inspector passes. Targeting does not establish a fresh full-stack drift review.

Plan SHA256:
`aab12408d968c2275924513b2b20bab8e1cb13d89bff440e507b1ed161d3c6a6`

Reviewed corrected `index.mjs` SHA256:
`dd914d4dae0d58c2222da17737590128ee2a8bf21badf81628860dde1d69e761`

The plan was generated at 09:08 UTC against state serial **1085**. Keep its
reviewed build inputs unchanged through apply. The repeat will use the same
run ID and retained fixture. `INITIAL_CREATE_REUSED` is expected on repeat;
the original invocation supplies the successful fresh-create evidence, and
the repeat must confirm that exact version remains unchanged.

Evidence:

- `/tmp/aidlc-plan-tools/native-storage-deployed-20260922.json`: all 24 deployed
  configuration/code/preflight checks passed, including the live 8,192 MiB
  allocations and both deployed bundles matching review.
- `/tmp/aidlc-native-storage-probe-result.json`: original live result.
- `/tmp/aidlc-plan-tools/native-storage-first-run-postconditions-20260922.json`:
  all five postcondition checks passed.
- `/tmp/aidlc-plan-tools/native-storage-probe-fix-reviewed-20260922.json`:
  correction scope, checks and build-input hashes.

This checkpoint combines the requested **8,192 MiB worker memory** with one
temporary diagnostic Lambda. Temporary storage remains **4,096 MiB**, timeout
**600 seconds**, worker concurrency **one**, and maximum leased import
attempts **three**. These are package-import settings, not coding-agent limits.
The diagnostic makes small S3 requests; it does not measure package-import
memory requirements.

## What will be deployed

The temporary Lambda uses the package worker's existing IAM role, private
subnets, security group, ARM64 architecture, Node runtime, and resource
allocations. It has a separate S3-only entry point with a shorter internal
diagnostic deadline, concurrency one, and seven-day logs. It does not import
the worker or read jobs, memberships, tokens, or source credentials.

There are no additional IAM grants, changed bucket policies, public routes,
function URLs, event sources, or automatic invocations. The role's existing
non-S3 permissions remain available to the function, so its reviewed code is
part of the boundary. Synthetic-key restrictions are enforced in that code,
not by a narrower role policy. Invocation accepts only a schema version and
the fixed deployment run ID.

The root defaults keep the probe absent. The reviewed plan opts in with:

```hcl
enable_native_package_storage_probe = true
native_package_storage_probe_run_id = "2995f24c-c750-4a1d-b1c1-9eac45e1c819"
```

Source settings stay enabled. Package jobs, their consumer and Pipe, host
qualification, and the hard upload-policy qualification gate stay disabled.
The probe can be deployed only in `dev` while imports and host qualification
are false.

## Synthetic data and request scope

The bucket is the existing private native package bucket. Expected retained
data after a fully passing first invocation is **one 32-byte synthetic object**:

```text
native-packages/v1/__qualification__/2995f24c-c750-4a1d-b1c1-9eac45e1c819/source.txt
```

Its body is the fixed UTF-8 string `native-package-storage-probe/v1\n`.
It stays in the bucket under the same immutable-object policy as packages.
Removing the temporary Lambda does not delete that object.

Negative destinations are inside that same run directory, under a UUID
generated by the function for each invocation. Their names identify the
missing-condition, wrong-condition, copy, or multipart case. A single additional
negative sentinel tests the grant boundary:

```text
native-packages/__qualification__/2995f24c-c750-4a1d-b1c1-9eac45e1c819/outside-prefix.txt
```

Successful negative cases create nothing. An unexpected accepted mutation
stops further mutations and is reported for inspection; it may leave another
tiny synthetic object/version or an unfinished upload. No cleanup permission
or automatic cleanup is added.

## Checks and interpretation

The probe records sanitized S3 evidence and always reports overall
`qualification: "unverified"`. It exercises:

- Conditional creation with a body checksum, followed by current and exact
  version reads of the fixed bytes.
- Identical and conflicting conditional overwrites; missing, wrong, and
  replacement conditions; and the adjacent-prefix write.
- Copies of the readable fixture with and without the destination creation
  condition, excluding annotations and replacing metadata/tags.
- Multipart initiation with and without a signed creation-condition header.
- Single and batch deletion of the current object and its exact version.
- Final current/exact-version reads to check that the original remains intact.

A deletion batch must reject every requested item and report no deletions.
Its Content-MD5 is calculated from the actual serialized XML. Local transport
tests check serialization and signing, including the destination copy condition
and multipart header; they do not establish AWS authorization behavior.

Only the expected S3 error code together with its HTTP status counts as a
passing rejection. Unsupported headers, malformed requests, timeouts, and
unexpected service responses do not establish policy enforcement. A repeated
invocation can reuse and verify the fixed fixture but cannot claim a new
conditional-create success.

These checks establish effective behavior of the combined worker identity and
bucket policies. A denial does not independently identify the denying policy
statement. The probe also cannot test another principal by accepting an ARN
in the request.

## Read-only prerequisites

The 22 September preflight read found no incomplete uploads under
`native-packages/v1/`, no versions or delete markers in the selected probe
directory, versioning enabled, and no lifecycle configuration. Both inventory
responses were empty and explicitly not truncated. Imports remained disabled.
The only Lambda using the worker role in the target region was the worker;
it had no function resource policy. The probe did not yet exist.

The current worker managed policies were retrieved and contain only logging
and VPC network-interface permissions. The two inline grants and bucket policy
were collected for comparison. Evidence is retained locally at:

```text
/tmp/aidlc-plan-tools/native-storage-preflight-20260922.json
```

Repeat the inventories of both synthetic prefixes and incomplete package
uploads immediately before invocation. Inspect the
deployed probe's code hash, role, architecture, network settings, and absence of
invocation routes. After deployment, exactly the worker and probe should use
the worker role in the target region. Check endpoint and identity policy restrictions that could
distinguish the probe from the worker. Organization-level restrictions and
other account principals are not proven by this inspection.

After invocation, inspect versions and delete markers in both synthetic
prefixes and incomplete uploads throughout the package prefix. Expect only the
declared source version, with no negative-destination objects, markers, or
uploads. If an inventory is nonempty or truncated, inspect all pages; do not
treat the first page as complete.

This checkpoint supersedes the earlier proposal to seed multipart uploads
before attaching protection. It keeps the deployed policy intact. Empty
before/after inventories and initiation rejection provide evidence for the
current direct-upload path. Part upload, part copy, and completion remain
unexercised; an existing incomplete upload invalidates this argument.

## Initial deployment and invocation

The initial saved plan below has already been applied by the user. It is
historical evidence, not the current correction plan above.

It was generated on 22 September 2026 at 08:29 UTC using
Terraform 1.16.3 and the `solution-read` profile. It refreshed the existing
`dev` stack without taking a write lock and did not apply changes.

Saved plan: `/tmp/aidlc-native-storage-dev.tfplan`

SHA256:
`9af187cf3ff31f31ae18c89a8499dc3ec3cd0f247ece5c474d07f313f493a074`

The reviewed cloud changes are exactly:

| Resource | Change |
| --- | --- |
| Native package worker | Increase memory from 2,048 to 8,192 MiB and repackage the archive after the source-hash correction. Its compiled `index.mjs` bytes match the previous deployed archive. |
| `collaborative-ai-dlc-native-storage-probe-dev` | Create the temporary ARM64 diagnostic using the worker's existing role and network configuration. |
| Probe log group | Create with seven-day retention. Export needed evidence before teardown. |

There are no cloud resource deletions/replacements, IAM changes, S3 changes,
database changes, AgentCore changes or import activation. Terraform also
creates the probe's local packaging/configuration helpers and replaces three
local worker packaging helpers. Those helper replacements are not cloud
resource destruction. The general destruction inspector passes.

All 20 selected plan/configuration checks passed. The plan contains deployed
state lineage `e83979b6-e79b-4dbd-e03f-8442c74f741c`, serial **1084**. The probe's
VPC ID is computed on creation; its configured subnets, security group and IPv6
setting match the worker and must be compared again after deployment.

The user applies this exact plan using the existing dev deployment credentials:

```sh
terraform -chdir=terraform apply /tmp/aidlc-native-storage-dev.tfplan
```

Run from the repository root. The `solution-read` profile is only for
verification and cannot apply the plan. Direct apply avoids the deployment
wrapper's separate reseed/legacy-retirement actions. Regenerate and review if
the saved plan becomes stale or relevant build inputs change.

The Lambda module builds its archive during apply; the saved plan alone does
not freeze the JavaScript bytes. Record the locally reviewed bundle hash,
preserve its source/dependency inputs through apply, and compare the deployed
bundle before invocation.

Reviewed probe `index.mjs` SHA256:
`5799c60bce70b330a3db908697568afd210d499f2e818f7e6339b5f25474e59f`

Local probe validation passed **145 targeted tests**, lint, formatting, build
and bundle syntax checks. Terraform validation passed with its two existing
Git binding-table deprecation warnings. The 99 policy/wiring tests passed.
A direct check of the installed packaging module confirmed that generated
bundles do not change the source hash, while source edits do. None of these
local checks constitutes a passing live probe.

Review evidence:

- `/tmp/aidlc-native-storage-dev.tfplan.json`
- `/tmp/aidlc-plan-tools/native-storage-dev-reviewed-20260922.json`
- `/tmp/aidlc-plan-tools/native-storage-reviewed-inputs-20260922.json`
- `/tmp/aidlc-plan-tools/native-storage-dev-plan-20260922.log`

After deployment and the read-only checks, invoke synchronously once using an
authorized dev operator:

```sh
aws lambda invoke \
  --region us-east-1 \
  --function-name collaborative-ai-dlc-native-storage-probe-dev \
  --invocation-type RequestResponse \
  --cli-binary-format raw-in-base64-out \
  --payload '{"schemaVersion":1,"runId":"2995f24c-c750-4a1d-b1c1-9eac45e1c819"}' \
  /tmp/aidlc-native-storage-probe-result.json
```

Do not infer passing tests from Lambda's invocation status alone. Inspect the
JSON result and subsequent inventories. A successful result does not enable
anything automatically.

After retaining the evidence, including any required logs, prepare and review a plan with the probe disabled
again. Its default is false, so an ordinary dev plan without the temporary
overrides will remove the diagnostic resources. Keep the 8,192 MiB worker
allocation and existing import qualification gates. The module deletes its log
group on removal; seven-day retention is not preservation through teardown.

## Remaining work

Even a passing storage probe does not complete package-import qualification.
Other-principal enforcement, dispatch/filter/retry behavior, the real worker
entry point, package archival/recovery, source authorization/provider cases,
and measured import resource usage remain separate. All four harnesses still
need execution qualification. No approval authority or native execution route
is enabled by this checkpoint.
