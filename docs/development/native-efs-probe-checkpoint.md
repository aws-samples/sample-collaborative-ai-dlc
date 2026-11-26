# Native EFS verification checkpoint

25 September 2026 — `feat/native-aidlc-execution`.

Status: **Runtime 110 deployment and live source/version/mount verification passed.**
State is **1118**, with `/mnt/native` on EFS and `/mnt/workspace` retained.
The scoped discovery policy is unchanged. Earlier filesystem diagnostics proved
hard links, symlinks, rename, directory sync, executable permissions and a
**1 GiB + 8 MiB** write/sync/readback, including matching checksums and cleanup. Signed AI-DLC setup also
passed on EFS for all four harnesses. The mount-check and setup-timeout
corrections and subsequent shell/local-home/Tini fixes are deployed, with actual
source hashes verified. Historical runtime-106 all-four setup passed **16 commands/67
checks**, versus 13 commands in the earlier shared-install diagnostic. On runtime
106, Codex and Kiro had partial interaction results; Claude hit a version blocker and
OpenCode passed the scoped same-session question/answer/follow-up experiment.
The applied EFS, shell-reaper and
[CLI compatibility plans](native-interaction-probe.md#cli-compatibility-deployment--applied-and-verified-historical)
are historical. The [SessionEnd timeout correction](native-interaction-probe.md#sessionend-timeout-correction--applied-and-verified-historical)
is also applied and verified, with no EFS, IAM or network change.
**There is no current apply target.** Runtime 110 additionally passed Kiro's
same-session question/answer/follow-up loop with complete user/assistant replay;
all **54 deployment checks** passed and the test session was stopped. EFS, IAM
and network configuration stayed unchanged. See the [current interaction result](native-interaction-probe.md#runtime-110--current-kiro-verification).
Project-versus-run isolation for real UI execution remains a user decision.

## Runtime 108 — historical verification

The user applied the SessionEnd plan. Runtime **108 READY**, state **1113**,
image tag **`b8093b6cda50899e`**, digest
`sha256:5625e1b29ba228593851f2ca90b763a6c2084ca970bfad5bf7b658445e54e780`,
and all **25/25 independent deployment checks** passed. The frozen `b95f3916...`
interaction source, live Claude/Codex versions, both Codex overrides, Tini,
UID 1000, launcher and `/mnt/native` NFS match expectations. All four Lambda
code/environment comparisons passed; filesystem, IAM and network configuration
are retained.

Terraform's computed runtime version and intents/environment-control metadata
remain **107**, while the control API confirms **108** and the correct image.
Version-pinned consumers are not established to use 108 by those metadata records.

Claude probe **`f4b6d405-4e6e-4430-8716-b925d31f6383`** passed four setup
commands/16 checks, confirmed generated SessionEnd **`timeout: 30`**, and completed
the same-session title question/Blue Lake answer/follow-up loop. Only Q1 records
**`X. Other - Blue Lake`**; Q2–Q4 remain blank. Both turns exited 0 with cleanup.
Native and structured session **`677c3f28-eb23-4027-b809-20154cdcb0e9`** remains
bound to intent UUID **`01a0d366-41e9-7684-8d54-2148e9b09920`**.

`session-end.last` advanced **12:37:18Z → 12:39:45Z**; the bound intent's audit
contains **1 → 2 `SESSION_ENDED` records**, with no end-hook cancellation/drop.
`SESSION_RESUMED` at **12:38:30Z** records `Source: resume` and the same session.
The runtime session was stopped with **HTTP 200 at 12:40:53Z**. This closes the
bounded SessionEnd correction; independent two-turn review passed **37/37 checks**
and no further deployment is required.
Nine ignored Claude permission entries persist. Shared UI, isolated approvals,
project isolation, cold recovery and Kiro history/model fidelity remain open.

See the [historical interaction checkpoint](native-interaction-probe.md#runtime-108--historical-verification)
and `/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/`:
[deployment review](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/deployment-independent-review.json),
[verification summary](/tmp/aidlc-plan-tools/native-sessionend-applied-20260924/verification-summary.md),
`claude-two-turns.json`, `claude-two-turns-extracted.json`, before/after question
and audit Markdown, `claude-session-stop.json`, `live-source-review.json` and
`live-source-and-mount.json`.

## Runtime 107 — historical interaction results

The user applied the compatibility plan. Runtime **107 READY**, state **1111**
and image tag **`7020eeb9b852efb2`** passed **25/25 independent deployment
checks**. Actual sources, Claude 2.1.257, Codex 0.145.0 and both Codex
question-tool overrides, Tini, UID 1000 and `/mnt/native` NFS were verified.
The four affected Lambda code/environment comparisons also passed.

At that deployment, Terraform's computed version and intents/environment-control
metadata remained **106**; the control API confirmed **107** and the expected image digest.
This metadata lag does not establish a different deployed image.

Claude verification passed four setup commands/16 checks and the scoped
same-session native title question/Blue Lake answer/follow-up loop. Q2–Q4 remain
blank, both turns exited cleanly, and the session was stopped with HTTP 200 at
**11:38:29Z**. The API version blocker is resolved, but nine ignored permission
entries and a cancelled SessionEnd hook were recorded in both runtime-107 turns.
Runtime 108 subsequently verified native end-hook completion without cancellation;
the permission warning remains. Codex passed four setup commands/18 checks
and the same-session title question/answer/follow-up loop. Only Blue Lake was
answered; Q2–Q5 remain blank, both turns are clean, and the prior unsupported
input-tool error is absent. Its session was stopped at **11:58:50Z**.
Both runtime-107 model sessions are stopped; setup totals 8 commands/34 checks.
Shared native UI, isolated approvals, project isolation and cold
recovery remain open, as do Kiro history resume and exact model fidelity. See the
[historical interaction verification](native-interaction-probe.md#runtime-107--historical-interaction-results)
and `/tmp/aidlc-plan-tools/native-compat-live-20260924/`:
`deployment-independent-review.json`, `live-source-review.json` and
`live-source-and-mount.json`.

## Runtime 106 — historical interaction boundary

The **10:01:12Z** deployment review verified image `59d8f47b...`, Tini/user
identity, local home, launcher, EFS mount and dependent Lambda updates. Codex
resumed the same native session to record **`X. Blue Lake`** in Q1; both turns
exited 0 with confirmed cleanup. Q2–Q4 remain blank, and exec mode rejected
`request_user_input`, so their delivery and full Codex qualification remain open.
The session was stopped with HTTP 200 at **10:20:50Z**.

The post-turn diagnostic measured **6.918 ms** for a login shell versus
**6,534.280 ms** for the bind hook, with unchanged session/pin metadata and
removed cache/home. The first module-loading failure yielded no measurements.
This demonstrates hook-path overhead, not EFS causality. Storage placement is
unchanged; project isolation, human approvals and cold recovery remain unqualified.
Kiro returned its title question, recorded Blue Lake and returned Q2/Q3 through
the same native question file, with both turns clean. Two different session IDs
and separate JSONL logs leave conversation-history resume unqualified; the legacy
SQLite store is empty. Its `auto` model-selection warning leaves exact model
fidelity open. Kiro was stopped with HTTP 200 at **10:48:49Z**. Claude passed
setup but received API 400 requiring a newer CLI. OpenCode passed setup, returned
the title question, recorded **`X. Other: Blue Lake`** in the native file on EFS,
and returned a follow-up question. Both turns exited 0 with cleanup and empty
diagnostics; structured events and the native session file confirm the same
conversation. Q2–Q4 remain blank. OpenCode was stopped with HTTP 200 at
**11:06:54Z**; those four runtime-106 disposable sessions were stopped.
Codex's two overrides and Claude 2.1.257 were subsequently deployed through
the compatibility plan and verified on runtime 107. Kiro flags and storage
placement are unchanged.

See the [historical interaction results](native-interaction-probe.md#runtime-106--historical-interaction-results)
and `/tmp/aidlc-plan-tools/native-roundtrip-verify-20260924/`:
`deployment-review.json`, `codex-two-turns.json`,
`codex-title-question-before-answer.md`, `codex-title-question-after-answer.md`,
`codex-session-stop.json`, `latency-diagnostic-result-2.json`,
`kiro-two-turn-review.json`, `kiro-resume-independent-review.json`,
`opencode-two-turn-review.json`, `opencode-session-stop.json` and
`compat-plan-review.json`. The interaction checkpoint links the actual Codex
and Kiro before/after question files.

## Initial deployment plan — partially applied, do not reuse

Saved plan: `/tmp/aidlc-native-efs-dev.tfplan`, generated at
`2026-09-24T07:22:39Z` against state serial **1098**.

SHA-256: `2865fabbbd9b6af3685d8acdbacf91ec0d8d8e1acf9d51b222283f848820ea96`.

All **24 plan review checks passed**. The plan reports **25 additions,
7 changes and 17 replacements/deletions**:

- Seven new AWS resources: an encrypted EFS filesystem, access point, two mount
  targets, a security group, an IAM role policy and a filesystem policy.
- One new local Terraform configuration guard.
- Seventeen replacements: two Docker image records and fifteen generated
  Lambda build records. No AWS resource is deleted or replaced.
- Seven updates: the AgentCore runtime and six Lambda functions. Four managed
  environment bundles include the protected native-setting prefix; the native
  package worker rebuild is triggered by the native-directory source hash and
  its compiled bundle is byte-identical to the deployed archive. The intents
  function and environment control functions receive updated core image/runtime
  metadata.

The only input-variable change from the previous recovery plan is
`enable_native_efs_probe = true`. It is also set in this checkout's ignored
`terraform/environments/dev.tfvars` to preserve the test mount on subsequent
deployments. The repository default remains false. Existing package-worker
settings, including 8192 MiB RAM, are retained.

This plan partially applied and is superseded by the permission recovery below.
Its local tests did not establish the runtime's discovery-permission
requirements; passing them was not evidence that the runtime could attach EFS.

## Runtime discovery permission correction

The runtime update returned HTTP 400 with request ID
`ebdf081c-6ddb-4dd0-898b-fbad2c3e16fd`, requiring
`elasticfilesystem:DescribeAccessPoints` and
`elasticfilesystem:DescribeMountTargets` on the execution role.

Independent reads after the failure established:

- Terraform state serial **1101**.
- Filesystem `fs-01b6309c0d0296e44`, access point
  `fsap-05535595aafeedfa7` and both mount targets are **available**.
- The role's `native-efs-probe` policy grants only `ClientMount` and
  `ClientWrite`; the two discovery actions are absent.
- AgentCore runtime **103** is **READY** with only `/mnt/workspace`.

The correction adds a separate discovery statement for the two required
actions on the exact filesystem and access-point ARNs. It does not attach
NFS-only conditions to control-plane requests. The existing mount/write
statement and filesystem policy are retained.

The current [AWS service authorization data for EFS](https://servicereference.us-east-1.amazonaws.com/v1/elasticfilesystem/elasticfilesystem.json)
lists both `file-system` and `access-point` resources for both discovery
actions. The API references describe the corresponding
[access-point lookup](https://docs.aws.amazon.com/efs/latest/ug/API_DescribeAccessPoints.html)
and [mount-target lookup](https://docs.aws.amazon.com/efs/latest/ug/API_DescribeMountTargets.html).
These support resource-specific permissions rather than a wildcard grant.

Read-only AWS IAM simulation passed **10 scenarios covering 25 resource
decisions**: the original discovery denial, corrected discovery access,
unrelated-resource denials, valid mount/write access, and denials for missing
NFS context, other access points/filesystems, insecure transport, access outside
mount targets and root access. The simulation evaluates the role policy; it
does not deploy the policy or prove that AgentCore mounts the filesystem.
Terraform validation also passes with zero errors and the same two existing
DynamoDB deprecation warnings.

Recovery evidence is under
`/tmp/aidlc-plan-tools/native-efs-permissions-20260924/`.

### First permission recovery plan — partially applied, do not reuse

Saved plan: `/tmp/aidlc-native-efs-permissions-dev.tfplan`, generated at
`2026-09-24T07:48:19Z` against state serial **1101**.

SHA-256: `7e916673ac19e37b3ccf165eb7bc63c34230e8c1c6830506285f032e980c6eae`.

All **19 recovery-plan checks passed**. The plan contains **0 additions,
4 updates and 5 pending cleanup deletions**:

- Update the runtime's EFS role policy with the discovery grant.
- Complete the previously planned AgentCore image/mount update.
- Complete the pending intents environment update and managed-environment
  control Lambda bundle/environment update from the original plan.
- Clean up three superseded Lambda build records and the two superseded Docker
  image/registry resources left over from that plan. Their deletion scope is
  unchanged. The registry resource retains its existing `keep_remotely=false`
  behavior; this review does not assert that old remote images are retained.

There is no new image build/push or EFS resource change. The runtime references
the image already pushed during the partial deployment. All deployment
variables and the original mount/write grant are unchanged. The exact planned
role policy matches the candidate evaluated by AWS IAM simulation.

The role-policy update succeeded, but the runtime update failed again. This
plan and `/tmp/aidlc-native-efs-dev.tfplan` are now stale.

## Live role verification after the second rejection

CloudTrail records the successful `PutRolePolicy` at **07:57:16Z** and the failed
`UpdateAgentRuntime` at **07:57:18Z** on 24 September. The runtime request ID is
`8cb37f10-b386-47e0-ab02-6ab79c2619cf`. The same-second runtime-role
`DescribeAccessPoints` event reports `AccessDenied`.

**The denied event has `requestParameters: null`.** It does not prove that
AgentCore made an unfiltered request. An earlier investigation summary
normalized null to an empty object; that inference was retracted.

Independent reads confirmed that the intended role has both scoped discovery
actions, the runtime uses that role, and no permissions boundary is attached.
At **08:10:02Z**, a credential-free bootstrap created a disposable runtime 103
session and a fixed read-only diagnostic issued real EFS requests using the
runtime role. Model credentials remained in AWS and no model ran.

| Actual request | Result |
| --- | --- |
| `DescribeAccessPoints` by the configured access-point ID | HTTP 200; expected access point returned |
| `DescribeAccessPoints` by the configured filesystem ID | HTTP 200; expected access point returned |
| `DescribeMountTargets` by the configured filesystem ID | HTTP 200; both mount targets returned |
| `DescribeMountTargets` by the configured access-point ID | HTTP 200; both mount targets returned |
| Unfiltered access-point listing | HTTP 403 |
| Mount-target lookup without a resource ID | HTTP 400; invalid request |

CloudTrail independently confirms that the successful access-point lookups
used `assumed-role/collaborative-ai-dlc-agentcore-dev/BedrockAgentCore-...`,
including the expected request IDs and resource filters.

These results establish that the scoped policy works for the configured
resources. They do not reveal the failed validator's request shape or prove
why the immediate update was denied. IAM propagation is plausible given the
two-second interval. The next controlled test therefore retries the runtime
update with **no IAM policy change**. A proposed wildcard discovery grant was
not selected and has not been deployed.

The second partial apply left Terraform state at serial **1102**. Evidence is
under `/tmp/aidlc-plan-tools/native-efs-validator-20260924/`, particularly
`runtime-efs-read-result.json` and `runtime-probe-identity-evidence.json`.

### Retry with the existing policy — applied and verified

Saved plan: `/tmp/aidlc-native-efs-retry-dev.tfplan`, generated at
`2026-09-24T08:13:26Z` against state serial **1102**.

SHA-256: `929c206a290e9b161d160f36831e193d9045e6c3f5d1a99b0927268f6b35c780`.

All **17 review checks passed**. The plan contains **0 additions, 3 updates
and 5 pending cleanup deletions**. It finishes the runtime update and the
pending intents/control Lambda changes. Cleanup matches the earlier
user-applied plan, including its existing Docker registry deletion behavior.
All IAM and EFS resources are `no-op`, and the runtime image, mounts and
environment match the previously reviewed configuration.

The user applied this plan. At **08:23:58Z**, independent reads established:

- Runtime **104**, READY, updated at **08:18:41Z**, with image
  `sha256:81f30e4399bba22b1fc204195396895888b3133b52ac1ed0831f3f6b89a8acb2`.
- Both mount configurations, role, image and environment match the reviewed
  plan; EFS and both mount targets are available.
- The exact scoped discovery policy is unchanged. No wildcard grant was needed.
- Terraform state serial **1103**, no deposed records, and all three planned
  updates match state, including the two Lambda bundles/environments.

This establishes that scoped permissions are sufficient and supports a
transient explanation for the earlier rejection. It does not prove the exact
cause. The applied retry plan is historical evidence, not a new apply target.

### Actual mount behavior and filesystem proof

The first filesystem diagnostic stopped before creating files. AgentCore
exposes **two mountinfo entries at `/mnt/native`**: a backing overlay (`0:22`)
and its NFS overmount (`0:51`). Our exact-one-path check incorrectly rejected
this valid layout. The path's actual `lstat` device was `51` and `statfs` type
was NFS (`0x6969`). The corrected check selects the unique entry matching the
actual device, then requires a direct writable NFS mount. A hidden NFS entry
under a visible overlay, incorrect device and ambiguous matching entries are
still rejected. Both the operator and runtime required this correction.

A subsequent report was rejected by the operator validator, with cleanup
initially unconfirmed. A separate read confirmed its directory was absent.
Inspection then reproduced Node returning high-bit EFS inode IDs as signed
bigints. The operator now renders inode evidence as unsigned 64-bit decimal;
inode/device equality checks still use the exact original bigint values.
The lost report cannot establish that run's outcome or exact failure cause.

The final standard operator invocation used session
`aidlc-native-efs-probe-581b58af-e006-46e8-b1ed-b1cac19fc4fc`.
Its filesystem work finished in **7,775 ms**:

| Check | Live result |
| --- | --- |
| Hard link | Same inode/device; link count 2 |
| Symlink | Target and content match |
| Rename | Replacement observed intact; directory synced |
| Executable | Mode 0700; execution succeeds |
| Capacity | 1,082,130,432 bytes written, synced, allocated and read back |
| SHA-256 | `c3f1468726d71bb72a75c45990310c8b25774aa593627dbe79bd160e7f3704ba` on write and read |
| Cleanup | Synthetic directory and bulk file removed |

Evidence is under `/tmp/aidlc-plan-tools/native-efs-verify-20260924/`:
`deployment-review.json`, `mount-inspection.json`, `filesystem-result.json`,
`second-probe-cleanup.json` and `inode-inspection.json`. No model ran.
These filesystem results do not establish cold recovery, project isolation,
multi-writer safety or native question/answer behavior.

### Actual AI-DLC installation and configuration on EFS

The real signed v2.9.0 package passed installation and configuration for all
four harnesses: **13 setup commands and 67 filesystem checks**, with all five
package hashes and explicit GitHub attestation verification passing.
Installation and projects were on EFS; active homes were on local disk.

| Harness | Filesystem checks | Project pin | Harness configuration |
| --- | --- | --- | --- |
| Codex | 18 passed | 15.864 s | 26.029 s |
| Claude | 16 passed | 19.705 s | 20.522 s |
| Kiro | 17 passed | 15.227 s | 21.340 s |
| OpenCode | 16 passed | 13.952 s | 21.079 s |

The first attempt exceeded the diagnostic's 120-second installation timeout.
A controlled retry succeeded: the shared installation took **137.343 seconds**
and the entire all-four check took **316.384 seconds**. Both attempts removed
their EFS and local synthetic directories. No additional filesystem
incompatibility was observed. The native interaction launcher now allows
**300 seconds per setup command** based on this measurement; the separately
configured model-turn timeout is unchanged.

PATH-related doctor warnings and Codex hook-trust warnings remain recorded.
The configured harness invocation still needs live SessionStart/hook evidence;
installation does not qualify those behaviors. No model ran. Evidence:
`initialization-summary.json`, `initialization-result.json` and
`initialization-attempt1-result.json` in the verification directory above.

### Mount-check and setup-timeout corrections — applied and verified

Saved plan: `/tmp/aidlc-native-efs-mount-fix-dev.tfplan`, generated at
`2026-09-24T08:41:30Z` against state serial **1103**.

SHA-256: `c82344311817d44070e22ad8e23b6179d7c2eb47bb064a38f2ff8f111d8459e0`.

All **18 scope checks and eight regeneration checks passed**. An independent
review also passed on the preceding plan with the same resource scope.
Terraform reports **5 additions, 5 updates and 5 deletions**:

- The additions/deletions replace two Docker image records and three local
  package-worker build records. Existing `keep_remotely=false` registry cleanup
  remains; old remote-image retention is not asserted.
- AgentCore changes its image only. IAM, EFS, networking, mount paths, runtime
  environment and user-selected worker settings are unchanged.
- Intents, environment control and tool-control Lambda environment maps receive
  dependent image metadata. Those generated maps resolve at apply time and
  require live comparison afterward.
- The native package worker rebuilds because its source hash includes the
  native directory. Its fresh compiled bundle is byte-identical to the archive
  matching the deployed code hash: SHA-256
  `d4ae7a7cd42af8f8c6f2853b6fe1d53986af2cebef29ba618175508d431701f8`.
- No AWS persistent resource is created, deleted or replaced. Terraform
  configuration and input variables exactly match the prior reviewed retry.

The plan selected image tag `c5bcef5101df9be9`; its pushed digest was verified
after application below.
The local ARM64 image built successfully and contains the exact corrected guard
(source SHA-256
`697f710f53d8de10b05614b7a6a3862b90d165c5e0e6bbbd88ad4d24136a4a18`).
The actual proposed guard also passed a read-only command against the live
AgentCore EFS mount. This diagnostic did not replace the running application.
The final image also contains the setup-timeout correction (interaction source
SHA-256 `05e4c95938171c4c793b03901c6509494feb8fa77e89e90e0270fe45f64b481a`).

The final timeout-only regeneration used `-refresh=false` after the preceding
full-refresh plan and fresh state/runtime reads. All mutable runtime settings,
configuration, variables and planned resource actions match that review.
Cached runtime version/timestamp differ from the full-refresh plan; the locked
provider schema confirms both are computed-only fields. At that review, the
control API independently reported **104 READY**, while saved provider state
still contained version 103. The final deployed version was subsequently
verified through the control API.

Correction validation: **85 runtime/mount/HTTP tests and 21 operator tests
passed**. The built image accepts captured live mount evidence and rejects an
actual local bind directory. Lint, formatting and whitespace checks pass;
Terraform validation has zero errors and the same two existing warnings.

The user applied this final plan. At **09:02:15Z**, deployment verification
established:

- Runtime **105 READY**, using tag `c5bcef5101df9be9` and matching image digest
  `sha256:59714fd45d9cf7e7f2aa85b68b558b532a4a95adf2ee3101c54a1589549064ae`.
- Terraform state serial **1105**, with no deposed records.
- Code/environment comparisons passed for all four updated Lambda functions:
  native package worker, intents, environment control and tool control.
- Native probe and EFS-required flags remain enabled. The live corrected guard
  accepts `/mnt/native` as `nfs4`.
- Actual runtime source hashes match the reviewed guard (`697f710f...`) and
  interaction launcher (`05e4c959...`), whose full hashes are recorded above.

Evidence is under `/tmp/aidlc-plan-tools/native-model-verify-20260924/`:
`deployment-review.json`, `live-source-and-mount.json`, `runtime.json` and
`state.json`. Runtime/state evidence contains private environment data and
should not be copied into public reports. The applied plan is historical
evidence, not a new apply target.

At the runtime-105 handoff, Codex probe `092774ba-48fe-4834-abe0-772701c38204`
reported **INITIALIZING**. It subsequently timed out and was stopped; that
history is recorded in the interaction checkpoint. The runtime-106 section
above records the later two-turn result and remaining delivery limitation.

## Deployment scope

The existing `/mnt/workspace` managed session mount and platform execution path
remain in place. A separate `/mnt/native` EFS access point holds only synthetic
native probe workspaces. Native AI-DLC installation files and projects go
there; harness binaries stay in the image and active homes/databases stay local.

The native probe checks for a direct, writable NFS mount at `/mnt/native`
before creating its workspace and again before the answer turn. A missing
mount fails with `native_efs_mount_unavailable`; it must not silently use a
local backing directory. This check establishes mount behavior. The deployed
runtime configuration and EFS resources establish the access-point identity.

This is a runtime-wide test mount, not a project isolation design. It contains
no real project data. A fresh UUID claims a new directory with exclusive
creation; a cold process cannot reuse an existing native probe workspace.
Production writer fencing, project isolation and consistent harness recovery
exports remain separate qualification work.

## Verification sequence after deployment

1. **Passed:** read the deployed runtime configuration, image digest, EFS access-point
   ownership, mount targets and security groups. Verify the existing managed
   mount remains configured and only the native test path points to EFS.
2. **Passed:** run the operator filesystem diagnostic in a fresh disposable session.
   Require hard links, symlinks, rename, permissions and an actual write,
   sync and readback of more than 1 GiB. Remove the bulk test file afterward.
   This diagnostic makes no model call.
3. **Historical runtime-106 partial Codex interaction passed:** the first question
   returned and its answer was recorded in the same native session, but
   next-question delivery remains unqualified. Both Codex turns are finished
   and their session is stopped; do not reuse it.
4. **Historical runtime-107 compatibility deployment verified:** the Codex/Claude fixes
   are applied, with 25 independent deployment checks passed. Fresh Claude
   passed the scoped same-session question/answer/follow-up loop and was
   stopped; its SessionEnd cancellation was subsequently resolved on runtime 108.
   Codex also passed the
   same-session question/answer/follow-up loop and was stopped at 11:58:50Z.
   Historical Kiro file-based continuation and OpenCode's same-session loop
   remain recorded above; Kiro history resume/model fidelity remain unqualified.
   A successful installer or process exit does not qualify native question/answer behavior.
5. **Runtime-108 SessionEnd correction verified:** all 25 deployment checks
   passed. Claude setup passed 4 commands/16 checks with generated timeout 30.
   Its same-session question/answer/follow-up and both native end-hook
   health/audit writes passed, without cancellation/drop; the session is stopped.
   The permission warning remains, and broader pilot qualification is open.
6. Use those results to implement and verify native cold recovery. The current
   probe still reports `recovery: not-tested` and refuses cold workspace reuse.

If mounting fails, use the deployed resource state and command diagnostics to
fix that specific failure before adding more execution code.

The operator diagnostic uses the deployed runtime ARN:

```sh
node scripts/native-efs-probe.mjs \
  --profile solution --expected-account 746558295630 \
  --runtime-arn arn:aws:bedrock-agentcore:us-east-1:746558295630:runtime/collaborative_ai_dlc_agentcore_dev-as8Fm8FMKE
```

It establishes a fresh session using a fixed credential-free status request,
then runs a fixed command. It accepts no arbitrary command, mount path or test
size. Its evidence includes the command-source hash, runtime session, primitive
results, bytes written/read, checksum and cleanup outcome. Interrupted runs
report unconfirmed cleanup and the test directory when known; they do not
claim a passing result or retry automatically.

## Local validation

The runtime tests cover missing/read-only/local mounts, symlink redirects,
continued separation of local harness state from the working directory, and
refusal to continue or write evidence after losing the mount. Managed
environment recipes cannot override the native mount path or EFS requirement.

- **110 focused tests passed:** 59 runtime/mount/HTTP tests, 33 managed
  environment tests and 18 operator diagnostic tests.
- **Six Terraform mock-plan scenarios passed**, covering the disabled default,
  valid dev configuration and invalid prerequisites.
- Repository Terraform validation passed with zero errors and two existing
  DynamoDB key deprecation warnings. Provider versions remain unchanged.
- The Linux ARM64 image built successfully. Running its actual probe against
  a plain local `/mnt/native` bind mount produced `native_efs_mount_unavailable`,
  zero model calls and zero created files. Its UID/GID are 1000:1000, matching
  the EFS access point.
- Environment and native package-worker bundles compile; targeted lint,
  formatting and whitespace checks passed.

Local evidence is stored under
`/tmp/aidlc-plan-tools/native-efs-20260924/`. Local Docker filesystem checks
cannot prove AgentCore EFS mount behavior, throughput, or cold recovery.
