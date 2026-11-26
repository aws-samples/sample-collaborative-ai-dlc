# Native debug preferences: deployment checkpoint

25 September 2026 — `feat/native-aidlc-execution`.

This verification loop implements the user's platform preferences for optional
debug snapshots and conversation archives: **off by default**, with **7 days**
default retention. Required recovery state for unfinished or resumable runs is
independent of both settings. No application time, token or spending cutoff was
requested. This deployment does not enable native intents or archive capture.

## Implemented and locally verified

- Platform Administration → Agents has a **Native execution debug archives**
  card. Retention remains editable while archiving is off.
- Existing platform-admin authorization protects updates through
  `GET/PUT /agents/settings`. Both fields are validated before writes; omitted
  fields preserve existing values.
- Preferences use two SSM String parameters under the existing settings prefix:
  `native-debug-archives-enabled` and `native-debug-archive-retention-days`.
  The plan adds exactly those two parameter resources to the existing settings
  Lambda policy.
- The UI requires explicit, valid fields from the server before editing. After
  saving, it reads both values back and requires an exact match before showing
  **Saved**. Missing support, failed readback or mismatched values cannot produce
  a false success.
- The authenticated local browser exercised the old deployed backend: the card
  reported unavailable settings and disabled editing. No preference was written.

Verification: **139 backend tests** across settings and native routing guards,
**38 frontend tests**, full frontend typecheck and production build, five
affected Lambda builds, and Terraform validation passed. An ARM64 local image
build and offline smoke checked all four harness versions, the unchanged Kiro
correction and rejection of native fallback to the shared runtime. These checks
do not establish deployed save/reload behavior or real native-run isolation.

Additional local foundations reject native routing through the platform runtime
resolver and require a control-owned runtime binding. The binding reader checks
deployment identity and execution-derived runtime/role/endpoint names. A reviewed
EFS root-length defect was corrected to 70 characters. The real provisioner must
still verify the actual runtime, role, access point, filesystem/root and pinned
image/endpoint relationships before publishing a binding. The reader alone
cannot establish that AWS isolation exists.

## Image retention correction

The first settings plan would replace a registry-image resource whose prior
state had `keep_remotely=false`. The provider would attempt to delete the old
image, which may still be pinned by a runtime or recoverable run. Merely setting
the replacement's flag to true would not fix destruction using the old state.

The replacement plan uses a declarative `removed` block with `destroy=false`
for the old image-build module and creates the renamed module with
`keep_remotely=true`. The saved plan explicitly **forgets** the two old build
records without destroying their objects. Future image replacements preserve
remote images. The core repository already has no lifecycle expiry policy;
registry-aware cleanup remains tracked separately in issue #427.

This requires Terraform **1.7 or later**; the local version is 1.16.4.
Installer checks and prerequisite documentation use the same minimum.
The deployment inspector now rejects core registry-image deletion when the
**prior** state does not retain it. Five regression tests cover destructive
replacement, missing prior retention, retained replacement, non-destructive
forgetting and initial/in-place updates.

## Applied plan and live verification

The user applied `/tmp/aidlc-native-debug-settings-retained-dev.tfplan`.
This is a historical evidence reference, not a plan to apply again.

SHA-256:
`ead7163270c305182551a6c8fcb1092437e88c48a37c9699f1489a680bc9e112`

The plan contains:

- Three updates: the agents/settings Lambda, its existing SSM IAM policy and
  the existing AgentCore runtime's image artifact.
- Two old image-build records forgotten without destruction; two retained
  image-build resources created.
- Three replacements of local Lambda packaging/build records.
- No EFS, network, runtime-role, runtime-environment, runtime-lifecycle or
  persistent-data change. Native start remains disabled.

Parent review passed **27/27** checks; independent review passed **43/43**.
Both verified the exact saved plan and frozen sources. The deployment inspector
rejects the superseded image-deleting plan and accepts this retained plan.
Four focused installer prerequisite tests also passed, including rejection of
Terraform 1.6.9 and acceptance of 1.7.0 through preflight. Official Terraform
1.7.0 source confirms whole-module removal support; the actual plan was built
with installed Terraform 1.16.4.

The image update is an existing Terraform dependency of the settings Lambda.
It uses the locally verified source hash
`bfa03785a58e88fac71caf0373f8fb088f1a05ad`, tag `c51c88df75a44e90`.
Live verification checked the ECR manifest digest and deployed Lambda package;
a local Docker image digest was not used as a substitute.

The user-operated deployment command was:

```sh
AWS_PROFILE=solution bash scripts/deploy-terraform.sh dev \
  --phase apply \
  --plan-file /tmp/aidlc-native-debug-settings-retained-dev.tfplan \
  --skip-seed
```

The script repeats the destruction check and resolves ECR credentials at apply
time. The plan is scoped to this verification loop, not the full dirty branch.
The discussions/intents/projects/orchestrator Lambda changes are not all
deployed by this plan. Do not use the superseded `aidlc-native-debug-settings`
or `aidlc-native-ui-settings` plans. If state or build inputs change before
apply, regenerate and review the plan.

No apply, image push or new model invocation was performed while preparing this
checkpoint. The local frontend remains running at port 5173.

## Live results on 25 September

Independent live review passed **40/40 checks**. AgentCore runtime **111** is
READY and DEFAULT serves version 111. Terraform state serial is **1122**; its
computed runtime version still reports 110, so the live control API is the
version authority for this check.

The actual new image digest is
`sha256:03f02e979aa4918d3c5fb49853b90a86816f6a7cda8d96761b7d7772c62c71e2`.
The previous tag `15c34685dcbc7627` and digest
`sha256:e94288d20697036bffb1668ae36d042f823635ac3e31220cee7947916c070b72`
remain in ECR. The new image resource has `keep_remotely=true`; the old module
records were forgotten without deleting the image.

The deployed agents Lambda is Active/Successful. Its downloaded `index.mjs`
has SHA-256
`ccce7d4f5f36a1d2652a1b47cc24d006e9bf7676a8edd7f9fcd344c8d669c069`.
The exact settings policy and unchanged runtime role, EFS, network, environment
and lifecycle were checked.

In the authenticated local browser, the card loaded **off / 7**, saved
**on / 8**, retained those values after reload, then saved and reloaded
**off / 7** again. Independent SSM readback confirmed both restored values,
each at parameter version 2. No model or runtime session was invoked.

The next visible loop is a real native draft whose dedicated runtime and EFS
workspace become ready. Model dispatch remains disabled while that isolation
and retry path is verified. First-question publication follows that check.

Archive capture/retention cleanup, protected human actions, execution fencing,
real per-run provisioning and cold recovery remain implementation and live
qualification work. Saving these preferences does not complete those features.

Detailed local evidence is outside the repository in
`/tmp/aidlc-plan-tools/native-intent-slice-20260925/`: source freezes, test/build
logs, image smoke, saved-plan reviews and the pre-deployment browser screenshot.
Live evidence is in
`/tmp/aidlc-plan-tools/native-debug-settings-applied-20260925/`, including the
40-check independent review, browser round-trip and restored SSM readback.
