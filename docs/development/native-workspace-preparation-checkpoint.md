# Native draft and workspace preparation checkpoint

28 September 2026 — `feat/native-aidlc-execution`.

**The preparation deployment is applied; the first real draft is visible.**
Live infrastructure verification passed **67/67 checks** on shared runtime
**112 READY**. The EFS tagging/network repair is also applied, at Terraform
state **1131**, and passed **15/15 independent live checks**. Authenticated
draft creation, saved-URL recovery and repeated preparation of the same draft
succeeded in flappy-bird. EFS now creates and verifies its access point.
The IAM lookup repair is also applied, at state **1132**: the next retry
successfully created the per-run role. The boundary-label compatibility fix is
now applied at state **1133**, with exact deployed bundle matching and
**22/22 independent configuration checks**. The authenticated retry passed role
validation and installed its policy. The default-endpoint authorization repair
is now applied at state **1134**, and runtime tagging is repaired at **1135**.
Identity tagging is also applied at **1136**. The latest retry now stops on
creation of that identity, an internal runtime dependency. The access point
and role are retained; no per-run runtime or coding agent has started. A single
worker IAM update is prepared below.

The preceding debug-settings round-trip remains verified and restored to
off/seven days. Workspace readiness, per-run isolation and model execution are
not yet qualified by this increment.

## Observable result

Open the local frontend at **flappy-bird → Settings → Agent → AI-DLC workflow
sources**. A successfully imported package offers **Create a native intent
draft** when the authenticated backend confirms that this project's pilot is
enabled. Existing intent creation continues to use the platform backend.

The draft selects one of the four existing harnesses and records a title and/or
prompt. Creation freezes the verified package/source receipt and runtime image.
It opens a dedicated native status page. **Prepare workspace** advances
**Draft → Preparing → Workspace ready**, or shows a preparation failure that
can be retried explicitly. A lost create response retains the draft ID in the
URL; a prepare retry retains the run's identity and allocated resources.

These drafts currently have their own shared URLs; they are not yet projected
into the existing intent list. The status page explicitly disables agent start,
answers, approvals, advanced editing and unit PRs. Ready means a verified
workspace, not an installed workflow, generated artifact or completed agent run.

## Control and storage boundary

- Existing project membership and separate workflow source bindings authorize
  draft creation, reading and preparation. Only the explicitly configured dev
  flappy-bird project is enabled.
- A separate protected DynamoDB table owns the draft, immutable pins, resource
  tuple, preparation lease and fencing counter. Runtime roles cannot read or
  write it. It has point-in-time recovery and no configured TTL.
- The controller provisions one execution role, EFS access point, AgentCore
  runtime and version-pinned endpoint per run. Runs in the same project receive
  separate boundaries. Existing synthetic runtimes and storage are not reused.
- The new encrypted EFS filesystem has a deny-only resource policy. Each run's
  role grants mount/write only through its exact access point, denies other
  mounts and root access, and is capped by a managed permissions boundary.
- The runtime image enters a minimal isolated server before importing platform
  clients. Its role permits its EFS mount, repository image pull and logs.
  Model, credential broker, graph, package download and control-table access
  are absent from this preparation step.
- Before publishing Ready, the worker reads back the actual filesystem, access
  point, role policies, runtime configuration and pinned endpoint. It invokes
  a fixed filesystem check, verifies identity, NFS, ownership, hard links,
  atomic rename, exact bytes and cleanup, stops the diagnostic session, then
  rechecks the AWS tuple under the current lease.

The filesystem check uses private `.control` files outside the future code
checkout and removes its test files. It captures no conversation or debug
snapshot. Required recovery state remains independent of optional debug
retention. The deployment inspector now also rejects EFS deletion/replacement.

The SQS worker uses short control-plane passes with retries and a 30-second
Lambda timeout. These are provisioning transport limits; this step has no
agent turn and adds no model time, token or spending cutoff. AWS resources
remain allocated after a preparation failure for explicit retry; automatic
resource deletion and cancellation are not implemented here.

## Local verification and deployment scope

- The combined native foundation suite passed **3,629 tests**. After adding
  sanitized failure diagnostics, **102 affected tests** passed again.
- **71 frontend tests**, full frontend typechecking and production build passed.
  Backend lint, formatting and both new Lambda builds passed.
- The actual ARM64 image ran as UID 1000 with networking disabled, served its
  health endpoint, rejected platform commands and invalid native configuration,
  and refused to qualify local disk as EFS. Its relevant source bytes matched
  the checkout. This is not live EFS or IAM proof.
- All **20 affected workspace builds** passed. Downloaded deployed Lambda code
  was compared against the new bundles: **16 of 20 existing functions are
  byte-identical**. The four changed bundles are discussions, intents,
  projects and the orchestrator. They add the reviewed native routing guards;
  discussions also fails closed when execution metadata cannot be verified.
- Seven image/filesystem retention tests, Terraform validation and the saved
  plan's destruction check passed.

The API stage's existing dependency graph includes those 20 Lambda uploads,
the orchestrator alias and the existing runtime's image update. This is wider
than only adding the two native-control functions; the code differences were
reviewed explicitly. Existing runtime role, network, mounts, environment and
lifecycle remain unchanged. The plan retains prior ECR images.

Applied plan: `/tmp/aidlc-native-workspace-preparation-iam-dev.tfplan`.
The earlier `native-workspace-preparation-dev` plan is superseded: its runtime
creation permission used an ARN scope unsupported by AWS.

SHA-256:
`38a72ff96fc888623037bc2b05b19b13f01040b2de9e09c1258cb9d6a3e52ac2`

The plan contains 56 creations, 23 updates and 63 replacements. Replacements
are API deployment, retained image-build records and local packaging records.
No existing persistent resource is destroyed. Parent review passed **30/30**
checks; independent final-plan review passed **33/33**.
Independent IAM integration review caught the runtime creation
permission mismatch. Only `CreateAgentRuntime` now uses `Resource: "*"`,
restricted by the supported subnet/security-group conditions and required
native tags. Other runtime operations retain native ARN scopes; role passing
and the execution-role boundary remain constrained. The corrected integration
passed **22/22 checks**, and read-only AWS IAM simulation passed **20/20**
cases: valid context allowed, missing/wrong network or tags denied, and other
runtime operations still restricted to native ARNs. Simulation used placeholders
for the new filesystem and security-group IDs; actual creation, role assumption,
propagation and EFS isolation remain live qualification steps. The account's
AgentCore network service role was also read back and confirmed.
Detailed evidence and source freezes are outside the repository under
`/tmp/aidlc-plan-tools/native-runtime-provisioning-20260925/`.

The apply wrapper removes a saved plan after a successful apply unless
`AIDLC_KEEP_PLAN=1` was set. Its subsequent “Terraform plan not found” message
does not mean this deployment failed. Deployed resources and bundles were
independently compared with the original plan and source freeze.

## Authenticated result and scoped repair

The new API and provisioner bundles, four authenticated API routes, image pin,
protected table, EFS policy, mount targets, network, IAM boundaries and SQS
mapping passed **67/67 independent live checks**. The shared runtime's role,
environment, mounts, network and lifecycle remain unchanged.
The actual shared runtime is **112 READY** with image digest
`sha256:de8baffcfe5144fc7912389231f86091f8c06742b2eea44b9e60e01122e99920`.
Terraform's computed runtime version lags at 111.

The authenticated UI created **Native workspace isolation verification A**:

- Project: `22371643-2db5-42a4-a571-e47fc35745f5` (flappy-bird).
- Execution: `e6af713e-eae6-48f4-8bd0-7ed7cba550d6`.
- Protected binding: `dee70406-a7fb-46e8-9bc8-cec63086d535`.
- Harness: Codex; official package v2.9.0.
- Reopening the saved creation URL recovered the same draft and left its
  protected row unchanged. This verifies recovery by GET, not duplicate POST
  acceptance.
- Preparation at **11:27:42Z on 25 September** recorded
  `native_provisioning_access_denied`, version 4, fence 1. Identity, image and
  package pins stayed unchanged. The UI shows **Preparation failed** with
  **Retry preparation** enabled and model/answer/approval/edit/unit-PR actions
  disabled.

CloudTrail confirms `TagResource` was denied during `CreateAccessPoint`, request
`214acfa5-2fe2-473b-ab8a-b4287b96d7fb`. It does not identify the denied ARN.
The deployed policy allows tagging access-point ARNs but not the parent
filesystem. Extending that scope is supported by the AWS action schema,
tag-on-create documentation and IAM simulation; actual EFS acceptance still
requires the retry. Tagging is now restricted to access-point creation with
both native scope tags and no extra tag keys. These restrictions apply to
tagging; the unchanged create permission still permits untagged creation.
The deployed worker always supplies both tags and verifies them on readback.

The first repair plan also exposed mixed inline/standalone security-group rule
management: it would have removed runtime NFS egress. That plan,
`/tmp/aidlc-native-efs-tagging-dev.tfplan`, is **superseded and must not be applied**.
The replacement manages both runtime egress rules as standalone resources and
adopts the existing HTTPS rule by ID. It preserves the same security group,
HTTPS rule and NFS rule, without revoking or recreating connectivity.

**Applied EFS repair plan:** `/tmp/aidlc-native-efs-preparation-repair-dev.tfplan`.

SHA-256:
`51543aa81e75c25d313c4683028c358ad587ba4f7d502390a7ccc5fb253144d8`

The saved plan imports the existing HTTPS rule and contains **two in-place
updates**: the worker's EFS tagging policy and metadata tags on that HTTPS rule.
There are no creations, deletions or replacements, and no Lambda/image rebuild.
Runtime NFS and security-group resources are no-ops. The import ID is captured
in this saved plan; the environment configuration has no persistent import ID.
Future plans use normal standalone rule ownership.

Terraform validation and the destruction guard passed. Parent plan review
passed **21/21 checks**; independent final-plan review passed **30/30**.
The saved plan is targeted and does not establish full-stack convergence.
Independent IAM simulation passed **12 requests / 29
resource-specific expectations**, including valid creation context, wrong
resources, direct tagging, missing/extra tags and wrong create action. The
simulated policy matches the saved repair plan. These checks do not prove a
successful EFS API call or a Ready workspace.

Evidence, screenshots, CloudTrail, simulation results, repair-plan JSON and
separate deployed/current source freezes are outside the repository under
`/tmp/aidlc-plan-tools/native-runtime-preparation-applied-20260925/`.
Only the two native-preparation Terraform files differ from the 596-file
original deployed backend/infrastructure freeze.

## Applied EFS repair and role-lookup verification

The user applied the EFS repair. Fresh state is **1131**, and read-back of the
actual worker policy matches the reviewed plan. Both network rules retain
their IDs and connectivity; HTTPS was adopted as
`sgr-04f843d122b8996c1`, NFS remains `sgr-0dc266731523ec32a`.
Independent deployment review passed **15/15 checks**. A follow-up scoped
Terraform plan, without the one-time import input, exited 0 with **no changes**.
This is scoped convergence, not whole-stack convergence.

The authenticated retry at **11:50:02Z** created access point
`fsap-0006d4d4b372ce750` on `fs-0dbff85b86169efdc`. Independent read-back confirms
it is available, with configured UID/GID 1000, root creation permissions 700 and root
`/runs/7ddb690e1638d82be083b19327a8711ed7c01c321e7106f3e8f364a95cd04447`.
The first worker pass waited for access-point availability. Repeating the
authenticated Prepare request while that pass held the lease left the complete
protected row unchanged (version 7, fence 2); no second access point was created.

The automatic queue retry at **11:53:03Z** passed the filesystem/access-point
checks and failed at `iam:GetRole`, HTTP 403, request
`f8696968-98d1-419c-b6a8-67e4b9e4bad1`. The row is now **FAILED**, version 9,
fence 3, with `native_provisioning_access_denied`. Identity, package/image pins
and the access point remain unchanged. CloudTrail confirms the matching
request was denied because no identity policy allowed GetRole for the role
name. A separate read-only GetRole, using the name derived by the provisioner's
helper, confirms that `native_7ddb690e1638d82be083b19327a8711e` does not exist.

The worker's existing IAM grant covers roles under `/native-runs/`. The repair
also permits `GetRole` against the account's name-only `role/native_*` scope
for the lookup before creation. It adds no mutation or role-passing permission:
all original statements, path restrictions and creation-boundary requirements
are retained exactly. Actual acceptance of the lookup still requires a retry
after user deployment; simulations do not execute IAM's role-lookup operation.
CloudTrail includes the role name but no evaluated ARN, so the pathless
authorization explanation remains an inference until that retry.

**Applied IAM lookup repair plan:** `/tmp/aidlc-native-role-lookup-dev.tfplan`.

SHA-256:
`6662cf2c6cc92dddac48b1daac5510e0c937a5de116bcaa646fa7875a7c96d39`

The targeted plan, based on state 1131, has **one in-place worker IAM policy
update** and no other resource changes. Terraform validation and the
destruction guard passed; parent review passed **16/16 checks**.
Independent final review passed **27/27 checks**, and **7 IAM simulation
requests / 40 resource evaluations** passed. The remaining provisioning
action/resource-schema audit found no obvious gaps for the configured role,
runtime, endpoint and diagnostic operations. This targeted plan has 31 deferred
checks and does not prove service-side creation, mounting or role assumption.
The only source change since the EFS repair is the
additional read-only statement in the native-runs Terraform module.

Evidence for this loop is in the same external evidence directory:
`repair-applied-review/`, `repair-postapply-convergence.log`,
`a-before-duplicate-prepare-binding.json`, `a-after-duplicate-prepare-binding.json`,
`a-repair-runtime-pass.log`, `a-role-lookup-cloudtrail.json`,
`a-actual-role-existence.stderr`, `a-role-lookup-failed.png` and `role-lookup-plan.json`.
No independent runtime filesystem probe has been invoked because the draft is
not Ready. Access-point allocation/configuration alone is not proof that a
runtime can mount it or create hard links.

## Applied role lookup and boundary read-back compatibility

The user applied the IAM lookup repair. Fresh state is **1132**, the live
worker policy exactly matches the reviewed policy, and the follow-up scoped
Terraform plan exits 0 with **no changes**.

The authenticated retry at **12:07:06Z** passed the initial GetRole check
(404 `NoSuchEntityException`) and created the expected role under `/native-runs/`.
The role is
`arn:aws:iam::746558295630:role/native-runs/native_7ddb690e1638d82be083b19327a8711e`.
Read-back at **12:07:08Z** then reported `native_provisioning_resource_mismatch`.
The protected row is **FAILED**, version 12, fence 4. The previously allocated
access point and original identity/package/image pins remain intact.

Live GetRole returns:

```json
{
  "PermissionsBoundaryType": "Policy",
  "PermissionsBoundaryArn": "arn:aws:iam::746558295630:policy/collaborative-ai-dlc-native-runs-dev-boundary"
}
```

The IAM SDK enum instead declares `PermissionsBoundaryPolicy`; the existing
check and test fixture used that value. The SDK's own field documentation says
`Policy`. Independent read-back and parent comparison confirm the role ARN,
path, trust policy, boundary ARN and native tags are correct. The boundary type
label is the sole failed comparison at this step. No permission policy was
installed on the role and no runtime was created.

The fix recognizes both known type labels while still requiring the exact
configured boundary ARN and every other authority check. The main test fixture
now uses the actual service response. A regression reproduced the old failure
for `Policy`; after the fix **174/174 native-control tests** pass, including both
known labels and rejection of missing/unknown types or a different boundary.
Lint, formatting, worker build, Terraform validation and the destruction guard
passed. Parent source/plan review passed **15/15 checks** and independent
final review passed **27/27**. No additional obvious response-comparison
mismatch was found in the collected service responses and SDK declarations;
the fresh runtime/endpoint responses remain a live qualification step.

**Applied boundary-label plan:** `/tmp/aidlc-native-boundary-readback-dev.tfplan`.

SHA-256:
`a7d7004d875d79f62da1cac4ef5710fa8b0970272c78aae4678004dcb379687c`

The plan, based on state 1132, updates **only the provisioner Lambda's code**,
with three local packaging-record replacements. IAM policies, runtime image,
network, API and frontend are unchanged. The compiled worker differs from the
deployed worker only by the boundary-type allowlist and its membership check.
Expected compiled worker SHA-256:
`5da5d7578f0b9b1a7e856d442a9a67e57700cae154a1e6e0d92bef699568ba7a`.

Evidence includes `a-role-repair-pass1.log`, `a-created-role.json`,
`parent-live-role-comparison.json`, `boundary-type-regression-before-fix.log`,
`boundary-type-control-tests.log`, `boundary-type-worker-bundle.diff`,
`parent-boundary-type-review.json` and `boundary-type-plan.json` in the external
evidence directory above. These prove the observed comparison defect and local
fix; live role adoption, runtime creation and filesystem proof remain to verify.

Historical worker apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-boundary-readback-dev.tfplan \
  --skip-seed
```

Do not reuse the saved plan if state or build inputs change. No apply, image
push or model invocation was performed while preparing this repair. The
frontend remains local on port 5173 with the failed draft available for retry.

## Applied boundary fix and default-endpoint authorization

The user applied the boundary-label plan. On **28 September**, fresh state is
**1133** and the downloaded worker bundle has the expected SHA-256 above.
Independent read-back passed **22/22 checks** for the worker configuration,
IAM documents and retained run role/access point.

The authenticated retry at **07:18:13Z** passed role validation and installed
the exact expected `native-runtime` policy. At **07:18:17Z**, runtime creation
failed with `native_provisioning_access_denied`, leaving **FAILED**, version
**16**, fence **5**. The role ARN is now persisted. Existing identity, package,
image and access-point fields are unchanged; no per-run runtime was created.

CloudTrail request `b8c6f227-383a-4dfc-9bd9-ed1a7b58f406` identifies the denied
dependent action as `bedrock-agentcore:CreateAgentRuntimeEndpoint` on
`arn:aws:bedrock-agentcore:us-east-1:746558295630:runtime/*`. Runtime creation
authorizes its default endpoint before assigning the concrete runtime ID.
The existing `runtime/native_*` permission does not match this placeholder.

The repair adds that action on `runtime/${*}`. IAM's documented special
variable matches a literal asterisk; Terraform emits it using `$${*}`.
This grants the observed pre-allocation authorization while preserving the
existing restriction on named runtime endpoints. All previous policy
statements, runtime creation's network/tag conditions, role passing and
execution-role boundaries remain unchanged.

**Applied default-endpoint plan:** `/tmp/aidlc-native-default-endpoint-dev.tfplan`.

SHA-256:
`8105e60418cf9f51ed63a039a1ee6e6a1773a5b7a8779206f7108c7ed5335bf2`

The targeted plan contains **one in-place worker IAM policy update**, without
resource creation/deletion, Lambda/image rebuild or network changes.
Terraform validation, formatting and the destruction guard passed. Parent
read-back/plan review passed **12/12 checks**, and independent final review
passed **15/15**. The exact saved-plan policy passed
**16 IAM simulation requests / 43 resource evaluations**, including the
observed placeholder, existing native/non-native resources, other actions,
accounts/regions and runtime creation's network/tag conditions. Access Analyzer
reports no new findings; its existing redundant-resource suggestion is unchanged.
Only the native-runs Terraform module differs from the prior 596-file
backend/infrastructure source freeze.

These checks do not execute runtime creation or prove EFS mounting. IAM's
multi-resource aggregate can report deny while the specific placeholder is
allowed; the review uses each resource's decision. Missing `*` context values
appear on nonmatching literal-variable resources, which remain denied.
The targeted plan has 31 deferred checks and does not establish full-stack
convergence. The independent dependency review found no concrete further
permission gap. AWS's tagging authorization ARN during creation remains
unobserved; the endpoint denial alone does not justify broadening tagging.
This worker supplies neither a capacity provider nor a runtime-user-ID header.

Historical default-endpoint apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-default-endpoint-dev.tfplan \
  --skip-seed
```

Fresh evidence is in the same external directory: `create-runtime-cloudtrail-20260928.json`,
`run-role-policy-after-retry-20260928.json`, `default-endpoint-plan-20260928.json`,
`default-endpoint-parent-review-20260928.json`,
`default-endpoint-policy-verification-20260928/summary.json` and
`create-runtime-review-20260928/final-bounded-review.json`, plus
`a-create-runtime-denied-20260928.png`.
Primary references checked on 28 September:
[IAM policy variables, Special characters](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html)
and [AgentCore action authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html).

## Applied default-endpoint repair and initial runtime tagging

The user applied the default-endpoint plan. Fresh state is **1134**, and the
actual worker policy matches the reviewed 11-statement policy exactly.
The authenticated retry at **07:46:34Z on 28 September** progressed past endpoint
authorization, then failed `CreateAgentRuntime` at **07:46:39Z**. The retained
binding is **FAILED**, version **19**, fence **6**; runtime creation and
filesystem verification have not succeeded. A complete read-only runtime
listing confirms no runtime with this run's expected name has been allocated.

CloudTrail request `303804a4-92a0-4ce6-9d2a-9266354a8c24` now identifies
`bedrock-agentcore:TagResource` on the literal
`arn:aws:bedrock-agentcore:us-east-1:746558295630:runtime/*`.
This confirms the tagging condition left unverified in the previous review.
The repair adds only `TagResource` to the existing `runtime/${*}` statement.
No ordinary wildcard grant, other policy statement, network/tag condition or
role boundary changes.

**Applied runtime-tagging plan:** `/tmp/aidlc-native-runtime-tagging-dev.tfplan`.

SHA-256:
`e90d673fe550f4e13972a822a528aa7973f13e54ba9844a5f56cad5e6f4b11c9`

The plan has **one in-place worker IAM update**, with no Lambda/image rebuild
or resource creation/deletion. Terraform validation, formatting and the
destruction guard passed. The exact candidate policy passed **4 focused
IAM simulation requests / 18 resource evaluations**: initial tagging allowed,
existing native permissions retained, other runtimes/accounts/regions denied,
and unrelated actions denied on the placeholder. Access Analyzer reports only
the unchanged redundant-resource suggestion, without errors or security warnings.
Parent verification passed **8/8 checks**, and independent final review passed
**15/15**. Only the native-runs Terraform file differs from the prior 596-file
backend/infrastructure freeze. The targeted plan has 31 deferred checks.
These results still require a deployed service retry.

Historical runtime-tagging apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-runtime-tagging-dev.tfplan \
  --skip-seed
```

Evidence is under the existing external directory's
`default-endpoint-applied-20260928/`: `deployment-proof.json`, `cloudtrail.json`,
`runtime-tagging-plan.json`, `runtime-tagging-proposed-policy.json`,
`runtime-tagging-simulation-summary.json`, `runtime-tagging-parent-review.json`,
`review/final-review.json` and `a-runtime-tagging-denied.png`.

## Applied runtime tagging and automatic identity tagging

The user applied the runtime-tagging plan. Fresh state is **1135** and the
actual worker policy matches the reviewed candidate exactly. The authenticated
retry at **08:14:22Z on 28 September** passed runtime-tagging authorization,
then failed during tagging of the automatically created workload identity.
CloudTrail request `7c900f2f-8dfc-4c7d-bcae-1985f72e6e0f` at **08:14:29Z**
identifies `bedrock-agentcore:TagResource` on
`arn:aws:bedrock-agentcore:us-east-1:746558295630:workload-identity-directory/default/workload-identity/*`.
The message includes nested request `cf481503-18eb-4ffa-80d9-34614690dbe1`.

The retained binding is **FAILED**, version **22**, fence **7**. Only its
version, fence and update time changed; identity, pins and allocated resources
remain intact. A complete runtime listing confirms that this run's runtime
has not been allocated.

The repair adds a separate `TagResource` grant on the literal identity
placeholder using `${*}` (escaped as `$${*}` in Terraform). It retains all 11
existing statements. Existing identities, direct identity creation and token
access remain denied; runtime creation's network/tag conditions, role passing
and execution-role boundaries are unchanged.

**Applied identity-tagging plan:** `/tmp/aidlc-native-identity-tagging-dev.tfplan`.

SHA-256:
`bd5aba1391aaa57cb1cabe190b3f77681a74b40a676e6c59d5d2ea6949bf8206`

This is **one in-place worker IAM policy update**, without image/Lambda rebuild
or resource creation/deletion. Terraform validation, formatting and the
destruction guard passed. Parent verification passed **9/9 checks**, and
independent final review passed **16/16**.
The exact candidate passed **5 IAM simulation requests / 28 resource
evaluations**, including existing-identity/token denial and retained runtime
permissions. Access Analyzer reports only the unchanged redundant-resource
suggestion. Only the native-runs Terraform file differs from the prior
596-file backend/infrastructure freeze. The targeted plan retains 31 deferred
checks. Service acceptance and workspace readiness still require user deployment
and retry.

Historical identity-tagging apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-identity-tagging-dev.tfplan \
  --skip-seed
```

Evidence is under `runtime-tagging-applied-20260928/` in the existing external
directory: `deployment-proof.json`, `cloudtrail.json`,
`identity-tagging-plan.json`, `identity-tagging-proposed-policy.json`,
`identity-tagging-simulation-summary.json`, `identity-tagging-parent-review.json`
and `runtimes-after-identity-tag-denial.json`, plus `review/final-review.json`
and `a-identity-tagging-denied.png`.

## Applied identity tagging and identity creation

The identity-tagging deployment is applied at state **1136**; the actual worker
policy matches the reviewed 12-statement candidate. The authenticated retry at
**08:33:04Z on 28 September** passed identity-tagging authorization but failed
the identity creation call at **08:33:10Z**. The binding is **FAILED**, version
**25**, fence **8**, with its original identity, pins and resources retained.
A complete runtime listing confirms that its runtime is still absent.

Parent CloudTrail request `12df676a-468f-4780-b10a-1d3b0342447d` and the actual
child `CreateWorkloadIdentity` event, request
`38e68794-eafd-4c23-be5e-34bab23efa31`, both identify the denied action on
`arn:aws:bedrock-agentcore:us-east-1:746558295630:workload-identity-directory/default/workload-identity/*`.
The child request already contains the generated native name
`native_7ddb690e1638d82be083b19327a8711e-6Vw5PPCY62` and both native scope tags.

AWS's service authorization metadata, checked on 28 September, lists
`CreateWorkloadIdentity` and `TagResource` for that identity-creation operation,
and supports identity and directory resources. The fix adds only the creation
action on the literal identity placeholder and the exact default directory.
The directory scope covers a published resource type; its necessity has not
been demonstrated by a separate live denial. Both native request tags and an
exact tag-key set are required. All 12 previous statements remain unchanged.
No identity read/update/delete/token or directory-tagging permission is added.
The trusted controller can intentionally create a matching tagged identity
directly as well as through AgentCore; no called-via restriction is claimed.

**Applied deployment plan:** `/tmp/aidlc-native-identity-creation-dev.tfplan`.

SHA-256:
`e38d0a0a415c9f89542fb144bffdd3eed399b7f98b5c77115cd0dde1bdb6288d`

The plan has **one in-place worker IAM update**, without Lambda/image rebuild
or resource creation/deletion. Terraform formatting, validation and destruction
checks passed. The exact policy passed **10 IAM simulation requests / 49
resource evaluations**, including missing/extra tags, resource boundaries,
identity-operation denials and retained runtime/tagging permissions. Access
Analyzer reports only the unchanged redundant-resource suggestion. Parent
verification passed **9/9 checks**, and independent review passed **19/19**.
Only the native-runs Terraform source differs from the prior 596-file
backend/infrastructure freeze; the targeted plan retains 31 deferred checks. Actual
request-context propagation, service acceptance and workspace readiness still
require user deployment and retry.

Historical identity-creation apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-identity-creation-dev.tfplan \
  --skip-seed
```

Evidence is under `identity-tagging-applied-20260928/` in the existing external
directory: `deployment-proof.json`, `cloudtrail.json`,
`identity-create-child-cloudtrail.json`, `service-authorization.json`,
`identity-creation-plan.json`, `identity-creation-proposed-policy.json`,
`identity-creation-simulation-summary.json`, `identity-creation-parent-review.json`,
`review/final-review.json` and `a-identity-creation-denied.png`.
Primary source:
[AWS service authorization metadata](https://servicereference.us-east-1.amazonaws.com/v1/bedrock-agentcore/bedrock-agentcore.json).

## Applied identity creation and named identity authorization

The identity-creation deployment is verified at state **1137**. The actual
worker policy matches the reviewed 13-statement candidate. The authenticated
retry at **09:33:57Z on 28 September** failed at **09:34:03Z**. The binding is
**FAILED**, version **28**, fence **9**; its pins, role, access point and root
are retained. A complete four-runtime listing still contains no runtime for
this run.

Outer request `d34e6cf1-2610-4940-969d-087f4e02600a` and child request
`96583e5f-5080-4915-8dbf-3531f33a9b3e` identify `CreateWorkloadIdentity` on
`arn:aws:bedrock-agentcore:us-east-1:746558295630:workload-identity-directory/default/workload-identity/native_7ddb690e1638d82be083b19327a8711e-hwLZm550yY`.
The child request includes both native scope tags. The earlier fix missed this
named-resource check: its literal placeholder grant does not match a generated
name. IAM simulations with supplied context did not establish service acceptance.

The repair preserves all 13 existing statements and adds creation/tagging on
`workload-identity-directory/default/workload-identity/native_*` in this account
and region. Both request tags and the exact two-key set are required. The named
creation permission addresses the observed denial. Named tagging covers the
documented create-and-tag operation; no separate named-tagging denial has been
observed. No directory-tagging, identity read/update/delete/token permission or
runtime-role permission is added.

The trusted provisioning controller can directly create or retag native
identities, including another run's identity, with any values for the two
required tags. These conditions are not a per-run authority boundary, nor a
called-via-only restriction. The controller validates/generates the run binding;
the model runtime does not inherit this grant.

**Applied deployment plan:** `/tmp/aidlc-native-named-identity-dev.tfplan`.

SHA-256:
`5ea40b32cc60fc47ee2f17f6940ecaf2548344032d9c882f467534a34d0ba3cd`

The plan has **one in-place worker IAM update**, without Lambda/image rebuild
or resource creation/deletion. Terraform formatting, validation and the
destruction guard passed. **11 IAM simulation requests / 43 resource evaluations**
passed, including the exact denied ARN, other native names, foreign resources,
missing/extra tags, retained placeholder grants and excluded identity operations.
Access Analyzer reports only the existing redundant-resource suggestion.
Parent review passed **9/9 checks**, and independent review passed **20/20**
with no blockers for the stated trusted-controller scope. The independent
review decoded the saved binary and audited all 43 saved simulation results;
it did not repeat AWS calls or claim live service acceptance.
Only the native-runs Terraform source differs from the prior 596-file
backend/infrastructure freeze. The targeted plan has 31 deferred checks; it
does not establish full-stack convergence or successful workspace preparation.

Historical named-identity apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-named-identity-dev.tfplan \
  --skip-seed
```

Evidence is under `identity-creation-applied-20260928/` in the existing external
directory: `deployment-proof.json`, `CreateAgentRuntime-cloudtrail.json`,
`CreateWorkloadIdentity-cloudtrail.json`, `service-authorization.json`,
`named-identity-plan.json`, `named-identity-proposed-policy.json`,
`named-identity-simulation-summary.json`, `policy-validation.json`,
`named-identity-parent-review.json`, `review/final-review.json`,
`runtimes.json` and `a-after-identity-creation.png`.

## Applied named identity scope and directory tagging

The named-identity deployment is verified at state **1138**; the actual worker
policy matches the reviewed 14-statement candidate. The authenticated retry at
**10:05:44Z on 28 September** failed at **10:05:50Z**. The binding is **FAILED**,
version **31**, fence **10**, with the same pins, role, access point and root.
The complete four-runtime listing still contains no runtime for this run.

Outer request `c40b50cc-70e2-4c01-b1e5-b843ee499706` and child
`CreateWorkloadIdentity` request `ff16dc8d-572d-4d6b-bb09-848011615f09` now
identify `TagResource` on
`arn:aws:bedrock-agentcore:us-east-1:746558295630:workload-identity-directory/default`.
The child request carries both native tags and generated name
`native_7ddb690e1638d82be083b19327a8711e-26RX2gABwi`. The named-resource check has
progressed; successful identity/runtime creation has not been observed.

The repair adds `TagResource` to the existing guarded creation statement.
Its resources and conditions stay unchanged: exact default directory plus the
literal identity placeholder, both native request tags required, no extra tag
keys. The placeholder already has a separate unconditional tagging grant, so
the effective authority addition is tagging the exact shared directory. All
14 statements remain; the other 13 are unchanged.

This is shared controller authority: it permits directly setting or overwriting
the directory's two native tags with values that are not validated by IAM against
a particular run. It must not be interpreted as a per-run ownership boundary
or a create-only/called-via-only permission. Identity read/update/delete/token
permissions and agent-role permissions are unchanged. No direct directory-tagging
API call was performed in this verification. The denial establishes the required
authorization; it does not prove AgentCore persists tags on the shared directory.

**Applied deployment plan:** `/tmp/aidlc-native-identity-directory-tagging-dev.tfplan`.

SHA-256:
`ac9a387099a8e9166bca8d60e4a675c59d166676cedab0bd00d2d7b9b81e10cd`

The plan has **one in-place worker IAM update**, with no Lambda/image rebuild,
resource creation, deletion or replacement. Terraform formatting, validation and
the destruction guard passed. **12 simulation requests / 60 resource evaluations**
passed: 59 candidate-policy evaluations and one deployed-policy baseline showing
the directory-tag denial. Missing/extra tags, foreign directories/resources,
retained named/placeholder grants and excluded identity operations were checked.
Access Analyzer reports only the unchanged redundant-resource suggestion.
Parent review passed **9/9 checks** and independent review passed **20/20**,
with no blockers for the stated shared-controller scope. The independent review
decoded the binary and audited the saved before/after simulation inputs and
results; it did not repeat AWS calls or claim successful service execution.
Only the native-runs Terraform source differs from the prior 596-file freeze;
the targeted plan retains 31 deferred checks. Service acceptance and workspace
readiness still require user deployment and a real retry.

Historical directory-tagging apply command (completed on 28 September):

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-identity-directory-tagging-dev.tfplan \
  --skip-seed
```

Evidence is under `named-identity-applied-20260928/` in the existing external
directory: `deployment-proof.json`, `CreateAgentRuntime-cloudtrail.json`,
`CreateWorkloadIdentity-cloudtrail.json`, `directory-tagging-plan.json`,
`directory-tagging-proposed-policy.json`, `directory-tagging-simulation-summary.json`,
`directory-tagging-parent-review.json`, `review/final-review.json`,
`policy-validation.json`, `runtimes.json` and `a-after-named-identity.png`.

## Applied directory tagging and first Ready workspace

State **1139** is verified; the deployed worker policy matches the reviewed
directory-tagging candidate. The UI retry at **11:29:37Z on 28 September**
successfully created the runtime and its workload identity at **11:29:43Z**.
CloudTrail records successful runtime request
`9c393200-67a8-4420-a50f-8a64954205f6` and identity request
`90bae6ef-5152-4142-8172-a26592abc35b`.

Run A's resources are:

- Runtime: `native_7ddb690e1638d82be083b19327a8711e-jJrNZ922rE`, version **1**.
- Endpoint: `run_7ddb690e1638d82be083b19327a8711e`, live version **1**.
- Original role: `arn:aws:iam::746558295630:role/native-runs/native_7ddb690e1638d82be083b19327a8711e`.
- Original AP: `fsap-0006d4d4b372ce750` on `fs-0dbff85b86169efdc`.
- Original root: `/runs/7ddb690e1638d82be083b19327a8711ed7c01c321e7106f3e8f364a95cd04447`.
- Original image: `sha256:de8baffcfe5144fc7912389231f86091f8c06742b2eea44b9e60e01122e99920`.

AWS creation and endpoint readiness were followed through the normal queue
retries. The first filesystem invocation at **11:38:39Z** reached the controller's
10-second request limit and was stopped; the next automatic attempt completed
in **2.064 seconds** and marked the protected binding **READY**, version **40**,
fence **15**, at **11:41:41Z**. The UI displayed **Workspace ready** and removed
Retry preparation while Start/Answer/Approve/Edit/PR controls remained disabled.
The transient abort recovered without a code or configuration change. This does
not qualify all cold-start latency cases.

The independent live configuration review passed **16/16 checks**, covering the
image, environment, role trust/permissions/boundary, AP/root, filesystem policy
and network controls. Its earlier snapshot was AWS CREATING/app PREPARING;
readiness is established by the later protected row and verification below.

A fresh independent session
`native-independent-f7c2c079-f286-4317-9fb2-d41eba47c193` ran from **11:44:02Z**
to **11:44:06Z**. Invocation and stop both returned HTTP 200. It verified NFS4
at `/mnt/native`, UID/GID 1000, exact **243-byte** readback with SHA-256
`29a59908fb7e6e51b31b042c3a5146128af0d870f0cb8bb0246575862c0a61cd`,
hard-link same inode/link count 2, atomic rename and removal of test files.
The private `.control` directory is outside the future application checkout.
No model, workflow installation, project-code clone or artifact publication ran.

Run B was created through the authenticated UI at **11:46:49Z**, with preparation
requested at **11:47:24Z**:
execution `8ebc25ad-4e03-49b6-948f-25540bfe3fb9`, binding
`8100f124-0b0e-40f0-a475-5005997dd6a0`. It uses the same verified Codex/v2.9.0
package. Its completed preparation and resource separation results follow below.

Evidence is under `directory-tagging-applied-20260928/` in the existing external
directory: `deployment-proof.json`, `CreateAgentRuntime-cloudtrail.json`,
`CreateWorkloadIdentity-cloudtrail.json`, `review/live-configuration.json`,
`a-workspace-ready.png` and `b-preparation-requested.png`. Sibling files
`workspace-second-attempt-binding.json` and
`a-directory-tagging-independent-workspace-proof.json` hold readiness and the
fresh-session filesystem result.

## Second Ready workspace and scoped isolation evidence

Run B's first attempt created its AP and role, then received a role-validation
error at **11:50:26Z**, request `12699bda-5e5e-4132-8263-523759ebf2d5`.
CloudTrail's exact message names its expected role and asks to verify existence
and trust. The same unchanged role/configuration passed after the UI retry at
**11:54:42Z**. This is consistent with propagation of a newly created IAM role;
it does not establish a general IAM propagation deadline.

B reached protected **READY**, version **14**, fence **5**, at **12:00:49Z**:

- Runtime: `native_5aa4c96f417bffb7ac35213bb4e5784d-lkxJvb2l3i`, version **1**.
- Endpoint: `run_5aa4c96f417bffb7ac35213bb4e5784d`, live version **1**.
- Role: `arn:aws:iam::746558295630:role/native-runs/native_5aa4c96f417bffb7ac35213bb4e5784d`.
- AP: `fsap-0fa488005ab2c9589`, on the same dedicated filesystem as A.
- Root: `/runs/5aa4c96f417bffb7ac35213bb4e5784d844fa24b38b97acd18519d39d85df5e4`.

Its fresh session `native-independent-9b620707-7f1c-4b42-8738-b1f5e8dafb62`
ran at **12:02:09Z–12:02:12Z**, passed the same NFS4/hard-link/rename/cleanup
checks and stopped with HTTP 200. The 243-byte readback SHA-256 was
`0b1ef36a88c946873bdc0799c2227c3f0dd3893e1d0d912e88a1ead35837ea63`.
Both protected rows remain READY with their original versions after verification.

Two additional fresh sessions tested A rejecting B and B rejecting A. Each
performed a successful filesystem control, then six rejected requests (other
run, wrong project, execution, binding, nonce and unsupported diagnostic command),
then another successful filesystem control. Both sessions stopped with HTTP 200.
AgentCore exposes these failures as `RuntimeClientError`, HTTP 424 wrapping
container HTTP 400; it does not expose the inner application error code. The
initial test expected that hidden code and failed its assertion; the retained
record documents this harness assumption. The corrected verification requires
the observed service envelope and successful before/after controls. No native
application code was changed for that transport behavior.

Six AWS principal-policy simulation requests / **18 resource evaluations** cover
both deployed roles and their attached permissions boundaries: own-AP mount/write
allowed; other-AP and no-AP mount/write explicitly denied; root access explicitly
denied. The filesystem's deny-only resource policy was checked in the configuration
review, not supplied to these simulations. This is not a physical cross-mount
attempt. A real unauthenticated GET of Run A's public API route returns **401**.
Authenticated nonmember/other-project membership checks remain unqualified.

Evidence under `directory-tagging-applied-20260928/` includes
`b-create-runtime-cloudtrail.json`, `b-workspace-ready.png`,
`role-isolation-simulation-summary.json`, `unauthenticated-api-proof.json` and
`final-ready-summary.json`. Sibling records are
`b-directory-tagging-independent-workspace-proof.json`,
`a-rejects-b-inner-code-not-exposed.json`, `a-rejects-b-scope-proof.json` and
`b-rejects-a-scope-proof.json`.

## Automatic recovery for new-role validation

The worker change handles the exact observed `ValidationException` from
`CreateAgentRuntime` only when its message names the expected role and that role's
IAM `CreateDate` is a valid Date with age **0 through 599,999 ms**. It preserves
PREPARING and lets the normal queue retry. Each attempt revalidates the role,
trust, tags, boundary and inline permissions. Unknown messages, other role names,
missing/invalid/future dates and roles at least ten minutes old retain their
previous failure behavior. The window uses IAM's creation time and does not reset
on retry. No permissions, lease/queue settings or model-execution budgets change.

The full native-control suite passes **195/195 tests** across five files;
the focused provisioner suite passes **75/75**. Tests include SQS retry-to-READY
with the same AP/role/client token, persistent failure at the window boundary,
invalid timestamps, other messages/operations and trust changes. Build, lint,
format, Terraform validation and the plan destruction guard pass.

**Applied deployment plan:** `/tmp/aidlc-native-role-propagation-dev.tfplan`.

Plan SHA-256:
`e15096210b9fbeea8921f5c00b073d162cc5f029846f83246fef6f4270b8e098`

The only AWS update is the provisioner Lambda code. Three local packaging
resources are replaced; no IAM, runtime image, API, EFS or network update is
planned. The exact planned ZIP was built locally and contains only `worker.mjs`,
matching the tested bundle:

- ZIP SHA-256: `9300e70213cbf18a059326d5772a3ae6e9f36c77910d1b12f7ccb37b3985ddb2`.
- Bundle SHA-256: `64119956314c756013986f8f8cfc3d1d1f9c839e1b018210034485177c370918`.
- ZIP path: `terraform/builds/665e00d0b360209b584ffdfe12069fc6ef5452843118cbde37647e9b52090963.zip`.

Only the provisioner and its test file differ from the prior 596-file source
freeze. The targeted plan has 29 deferred checks; its computed Lambda code
metadata is not proof of the new deployed bytes. The deployed-byte comparison
and fresh-run automatic recovery result are recorded below.

Parent review passed **10/10 checks**. Independent review passed **16/16 checks**
with **zero blockers**, including an independent decode of the saved binary,
the complete compiled change, the exact archive bytes and the current source
freeze. These are local reviews; they do not qualify the new retry behavior live.

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-role-propagation-dev.tfplan \
  --skip-seed
```

The repair evidence directory is `role-propagation-repair-20260928/`, containing
`plan.json`, `archive-proof.json`, `source-freeze.json`,
`native-control-tests.json`, build/lint/format and Terraform checks,
`parent-review.json`, `review/final-review.json` and `review/review.md`.

## Applied role recovery and fresh run C

On 28 September, Terraform state **1140** and the provisioner Lambda's
**Successful** update were verified. Downloaded deployed ZIP bytes match
`9300e70213cbf18a059326d5772a3ae6e9f36c77910d1b12f7ccb37b3985ddb2`;
its sole `worker.mjs` matches
`64119956314c756013986f8f8cfc3d1d1f9c839e1b018210034485177c370918`.
The update was last modified at **12:28:01Z**. No source or deployment change
was made during the following test.

A fresh authenticated UI draft C was created with the same pinned public
Codex/v2.9.0 package. One Prepare action was submitted at **12:36:07.580Z**.
Its execution is `31a0e69c-7c35-4209-bce6-4e9b6cf0c0bc`, binding
`78e1dd59-778e-45c2-b487-e5e14443ecfc`.

At **12:39:09Z**, CreateAgentRuntime returned the exact same-role
`ValidationException`, request `01b342e6-56b0-4e29-9669-65401d129d62`.
The protected row remained **PREPARING**, version **6**, fence **2**, with the
allocated role and AP intact. At **12:42:09Z**, the next automatic queue attempt
created the runtime, request `52fd9e9c-7de9-460e-bf8b-0f3252064d65`.
CloudTrail records identical CreateAgentRuntime request parameters across both
attempts, including the role, client token, image, mount and environment. No
manual retry, permission change or role replacement occurred.

C reached **READY**, version **12**, fence **5**, at **12:48:11.849Z**:

- Runtime: `native_c23411226b4a320211cf74ad0536dc0c-Jz2BUn9TT0`, version **1**.
- Endpoint: `run_c23411226b4a320211cf74ad0536dc0c`.
- Role: `arn:aws:iam::746558295630:role/native-runs/native_c23411226b4a320211cf74ad0536dc0c`.
- AP: `fsap-0ae3ab2b00ba0e3a2`, filesystem `fs-0dbff85b86169efdc`.
- Root: `/runs/c23411226b4a320211cf74ad0536dc0c8b744ab08fb536a33718c626535f4760`.
- Image: `sha256:de8baffcfe5144fc7912389231f86091f8c06742b2eea44b9e60e01122e99920`.

Preparation took **724.269 seconds** from the UI action. The current queue
uses three-minute retry intervals; this is workspace setup latency, not model
execution time. The observed three-minute successful retry is not a general
IAM propagation deadline.

A fresh independent session
`native-independent-760a0d82-1058-4b53-a7a5-d2c8034363b4` ran at
**12:48:25.591Z–12:48:28.246Z**. It passed NFS4 write/readback, hard-link,
atomic-rename and cleanup checks, then stopped with HTTP 200. The 243-byte
readback hash was
`f7aee9c8d8417d8086c377d235083efce9f2af453c304733882dc67b3ba60ba4`.
The authenticated UI shows Workspace ready and keeps model/human actions disabled.

An independent live configuration review passed **21/21 checks** with no
mismatches. Its 17 read-only AWS calls verify C's role/trust/tags/boundary and
inline permissions, EFS AP/root/owner/encryption/policy/network, and final READY
runtime/endpoint image, mount, environment and version. The snapshots are
time-separated; this review does not replace the actual filesystem invocation
or establish physical cross-mount denial.

Evidence is under `role-propagation-applied-20260928/` in the existing external
evidence directory: `deployment-proof.json`, `worker-function.json`,
`c-create-runtime-cloudtrail.json`, `c-worker-log-first-role.json`,
`ui-test-actions.json`, `c-workspace-ready.jpg`,
`review/live-configuration.json` and `review/live-review.md`. Sibling records
`c-role-attempt-binding.json`, `c-automatic-create-binding.json`,
`c-ready-check-binding.json` and `c-role-recovery-independent-workspace-proof.json`
preserve the state transitions and independent filesystem result.

## Fresh run D and completed retry checks

D was deliberately staged with two creation forms sharing one draft UUID and
a retained DRAFT status page. Reopening an existing creation URL only performs
GET recovery, and a freshly loaded READY page hides Prepare; those paths cannot
exercise the duplicate POSTs.

The authenticated initial Create returned **201** at **12:41:37Z**. One Prepare
was requested at **12:42:31.898Z**. D is execution
`bc968771-33f2-41e0-a5d9-45500f124f29`, binding
`855f63ff-ca74-4271-8553-579c34b3ced1`.

D independently reproduced the exact new-role error at **12:45:33Z**, request
`cc9016b9-5bad-46d5-96b1-69e4a9efdd68`. It stayed PREPARING and automatically
created its runtime at **12:48:34Z**, request
`80d007c6-2d14-467c-a5a2-e11fc6bedf88`. CloudTrail again shows identical
CreateAgentRuntime parameters across rejection and success. No manual retry
was needed to reach **READY**, version **12**, fence **5**, at
**12:54:36.195Z** — **724.297 seconds** after Prepare.

- Runtime: `native_7f278791c5bc02d82cc00a567f9682ef-38jmSQAYoW`, version **1**.
- Endpoint: `run_7f278791c5bc02d82cc00a567f9682ef`.
- Role: `arn:aws:iam::746558295630:role/native-runs/native_7f278791c5bc02d82cc00a567f9682ef`.
- AP: `fsap-007c5010973fec4d7`, filesystem `fs-0dbff85b86169efdc`.
- Root: `/runs/7f278791c5bc02d82cc00a567f9682ef0e7469a96a6aa562d53b2e0ab929c02b`.

After READY, the retained forms submitted the exact original Create payload
and another Prepare:

| Action | API result | Request ID | Protected record |
| --- | --- | --- | --- |
| Duplicate Create, 12:55:09Z | 200 READY | `f2e47aaf-5a15-49cd-ae61-880b6f75418f` | Entire row unchanged |
| Repeat Prepare, 12:55:22Z | 200 READY | `f0a33798-6402-4c8b-9289-79f39286bbca` | Entire row unchanged |

The before/after rows are deeply equal, including all resource identifiers,
package/image pins, version/fence and timestamps. Their canonical JSON SHA-256
is `cf73e0657c1b28ef6e999f03b20351c5b57c34c037da5ed204ae79f6be8bbf9b`.
Both UI actions resolve to the same READY intent. API access logs confirm
the POST status codes at those action timestamps; they record route templates
and omit concrete project/intent path IDs. This is retry acceptance against
an already completed run, not a concurrent race or forced lost-response test.

D's fresh independent filesystem session
`native-independent-a67fb2d0-0f3f-40d3-9dc3-7fac72941005` ran at
**12:55:31.156Z–12:55:33.538Z**, passed NFS4 write/readback, hard-link, rename
and cleanup checks, and stopped with HTTP 200. The 243-byte readback hash is
`77b1a05b3fe4866cc5407b3aeaa05e0858e5a2e5953f89d7d950d5c305061c2c`.

Evidence in `role-propagation-applied-20260928/`: `d-create-runtime-cloudtrail.json`,
`d-replay-api-proof.json`, `d-replay-row-proof.json`, `ui-test-actions.json`,
`cd-worker-log-complete.json` and `d-ready-after-replays.jpg`. Sibling records
`d-ready-before-replays-binding.json`, `d-after-duplicate-create-binding.json`,
`d-after-repeat-prepare-binding.json` and
`d-role-recovery-independent-workspace-proof.json` hold the unchanged rows
and separate filesystem result.

## Authenticated nonmember reads and UI denial handling

On 28 September the user signed in with a separate account that is not a
flappy-bird member. The visible account differed from the earlier member.
The following real authenticated reads were denied:

| UI action | API route | Result |
| --- | --- | --- |
| Open run C, 13:35:13Z | GET native intent item | 403, 77-byte error response |
| Open original run A, 13:38:30Z | GET native intent item | 403, 77-byte error response |
| Open native draft entry, 13:38:30Z | GET native intent collection/capability | 403, 77-byte error response |

The existing-run pages show **Native intent access denied**, with no private
title, prompt, package details or execution/preparation controls. The draft
entry shows the denial and no creation form or Create button. API Gateway access
logs confirm 403 for the item and collection routes, correlated by UI action
time; those logs contain route templates rather than concrete execution IDs.
The account switch also took the previously open D page to login. No live
account-switch disclosure was observed.

Code review found a separate stale-display case: a page that had already
loaded a run kept its details after a later denied refresh, poll or Prepare
response. `NativeIntentPage.tsx` now clears those details on typed
401/403/404 errors and synchronously invalidates outstanding requests. Late
successes, errors and Prepare completion handlers cannot restore the old view
or overwrite the denial. Polling stops. A new explicit Refresh can recover
through a fresh authorized response; network/503 failures retain the last
confirmed data and normal retry behavior. Authentication/session handling is
unchanged.

The updated page passes **29 focused tests** and **48 related native UI tests**
across three files. Full frontend TypeScript/production build, formatting and
lint pass. Independent source/evidence review passed **10/10 checks** with no
blockers. An earlier build ran while the test file was still being written and
reported unused test helpers; the completed test file passes the final build.
The local frontend continues to show the authenticated denial after the fix.
No backend or Terraform change was made for this correction.

Limits: previously loaded content followed by denial, response races and
recovery are **local component regressions**, not a live membership-revocation
experiment. Direct unauthorized POST requests, another enabled project's
boundary, physical cross-mount denial and shared-file permissions remain
unqualified. Blocking the draft form does not establish direct POST denial.

Evidence under the external `nonmember-access-20260928/` directory:
`native-api-access-denials.json`, `ui-denial-proof.json`,
`a-access-denied.jpg`, `c-access-denied.jpg`, `native-ui-tests-vitest.json`,
`frontend-build.json`, `format.json`, `lint.json` and `final-review.json`.
The additional C tab was closed before the final locator pass; the earlier C
snapshot and screenshot are retained. The final locator check and screenshot
use the original A page.

## Next live verification

1. Complete the [preparation latency improvement](native-workspace-latency.md)
   before the first agent turn. Short readiness retries are deployed at state
   1141 and verified on E/F: **4:22 and 4:16**, approximately 64% faster than
   the earlier 12-minute runs. Both hit a ten-second first-invocation deadline,
   then recovered automatically; fresh-session filesystem checks also passed.
    The worker-only diagnostic-budget follow-up is deployed at **1142** with
    matching bytes and 16 deployment checks. G/H take **4:18 and 4:14**, but
    both first invocations still exceed 20 seconds and recover automatically.
    Fresh-session filesystem proofs pass and stop with HTTP 200. The
    time-correlated AWS latency samples are **51.833 and 50.470 seconds**,
    beyond the 30-second worker window. On 29 September the user selected only
    the timeout repair and deferred pre-provisioning. The reviewed 90-second
    worker / 80-second diagnostic / 540-second queue plan passes 294 tests and
    both 21-check reviews. It is applied at **1143**: 15 parent and 18 independent
    deployment checks pass. Fresh I/J reach READY in **98.968/101.093 seconds**
    with no first-invocation abort or long recovery wait. Independent filesystem
    sessions pass and stop with HTTP 200; the 40-check measurement review passes.
    This loop is complete. Continue the existing UI/graph slice.
2. Complete direct unauthorized POST and other-enabled-project API checks,
   live membership-revocation behavior and physical filesystem isolation.
3. Continue to one model turn, durable first-question/file publication and
   shared viewing. Protected human actions, cold recovery, all-four integrated
   acceptance and broader private/provider coverage remain separate work.

Local tests and infrastructure configuration checks cannot substitute for the
remaining live isolation, API and model/publication checks.
