# Native pinned-runtime deployment compatibility

Recorded 30 September 2026. This is separate from the recovery pilot's missing
S3 fence permission and the upstream AI-DLC plan-selection defect.

## Observed failure

Execution `cb6c2fdd-1cf7-46f3-844c-f81d223353b0` retains the reviewed image
`sha256:ffe68c138cb900a95ffcd82298852e0686c2c6462f03cb37dcdd11f4ad302329`.
During the recovery deployment, the credential service's global image setting
changed to
`sha256:a226eb964ae779ee64496f0bdbf481dee4e9025dcf5d642015c9018975d6c0ff`.
The old execution became `FAILED` with `native_execution_source_changed` at
08:16:08 UTC. Its accepted sequence-3 Compose reply remains pending and
read-only; its files and graph remain available. No replay or row reset was
performed.

The credential resolver compares the execution's pinned image against the
current deployment image. An offline reproduction using the real protected
row passes when the deployment image equals the old pin, and returns
`NATIVE_EXECUTION_CREDENTIALS_CHANGED` when only that image changes. CloudTrail
places the environment update before the failed reconciliation. The exact
live credential-denial reason was not logged, so the causal finding combines
that timing with the exact-row reproduction.

This check can also block a checkpointed run after a later deployment.
Checkpoint recovery alone does not solve deployment compatibility.

## Required follow-up

Define a trusted policy for retaining and authorizing previously approved,
immutable runtime images and their isolated targets. Preserve package, model,
source revision, execution identity and protected target checks. Do not
simply remove the comparison or let an agent choose another image.

Qualification must include an existing waiting run across a deployment,
credential renewal against its approved old target, recovery with its exact
checkpoint, rejection of changed/unapproved images and explicit image
revocation behavior. Revocation and support-window decisions still require
user discussion before implementation.

The current new draft is pinned to the deployed image. Its immediate S3 fix
changes only controller IAM, so it does not encounter this image transition.

Evidence:
`/tmp/aidlc-plan-tools/native-session-recovery-20260930/live-applied/legacy-investigation/diagnosis.json`.
