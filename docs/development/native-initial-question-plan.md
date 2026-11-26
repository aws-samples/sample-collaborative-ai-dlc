# Native composer interactions in the intent page

30 September 2026 — the composer deployment is verified on state **1164** and
runtime **116**. A fresh native draft displays the actual plan-selection question,
retains it after reopening, and publishes 16 verified files. No answer was
submitted. The [live checkpoint](native-composer-checkpoint.md) records timing,
evidence and the focused follow-up plan for the missing response graph node.
Live reply/continuation and cold session recovery remain unqualified.

The user selected the **native intent page** for AI-DLC's composer proposals
and questions. After Start, the actual coding harness runs the native workflow;
its completed user-facing messages appear in that page. A member can reply
there to continue the same native session.

## Local verification checkpoint — 29 September

- Full native regression: **4,639 tests across 89 files**.
- Frontend: **251 tests across 8 files**, typecheck, lint, formatting and final
  production build. The development fixture transport is absent from the
  production bundle.
- A composed test runs the real executor, supervisor, protected store, API and
  immutable storage validators with an inert harness subprocess. It preserves
  the table and question after large tool output, records one member reply,
  recovers a lost delivery acknowledgement and runs exactly two turns in the
  same attempt, epoch and native session. Prior immutable content stays readable.
- Runtime fixtures cover all four harnesses. Independent review closed five
  collector issues, including Claude deferred/aborted results, informational
  frames after a result, incomplete final text, identity types and JSON grammar.
  All **11 independent collector cases** pass against the frozen source.
- The final ARM64 image smoke passes as UID 1000, with all four pinned CLI
  versions and **10 production source hashes** matching the checkout.
- Browser verification uses the actual native page with explicitly synthetic
  data: table/question display, reply acceptance, retained text on transport
  failure, retry, graph labels and graph-to-response navigation pass.

Evidence is under `/tmp/aidlc-plan-tools/native-composer-20260929/`.
These are local checks. The preview is `frontend/native-interaction-preview.html`;
the earlier stopped live draft is unchanged. The separate 30 September live
checkpoint above now verifies the real first question. It also found that the
preview supplied a response graph node absent from the deployed graph builder;
the focused follow-up correction addresses that production gap.

## Original deployment handoff — applied 30 September

Saved plan: `/tmp/aidlc-native-composer-dev.tfplan`, based on dev state **1157**.
SHA-256:
`be883e153c61bfcd802909ddf4adbb1d7e4b01abcce3d93ab3623a11bb04beb1`.

The plan changes 46 AWS resources: 16 creates, 29 updates and replacement of the
API Gateway deployment. It adds authenticated interaction/reply routes and their
CORS/permissions, updates the runtime image and Lambda dependency closure, and
adds Neptune `DeleteDataViaQuery` to the trusted projector's existing cluster
scope. No persistent resource is destroyed. Prior remote Docker images remain
retained. All **32 referenced Lambda archives** and **643 frozen source inputs**
are verified. Independent final review passes **163/163 checks**. Of those
archives, 29 are byte-identical to the prior build and only the three expected
native controller bundles differ. No apply or image push was performed during
preparation.

From the repository, the user deploys:

```bash
env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock AWS_PROFILE=solution AWS_REGION=us-east-1 bash scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-native-composer-dev.tfplan --skip-seed
```

After apply, verify deployed Lambda hashes, the published image and runtime
version consumers. Use a fresh native draft with the authorized “Fix the pipe
visualization” request. Preserve the earlier stopped/failed drafts. Stop at
the first real composer question and check exact content, reload durability
and graph navigation before asking the user to supply the next answer.

## Why the adapter needs to change

The exact v2.9.0 package can ask for workflow selection before an intent exists.
Composer subsequently presents a proposed grid and asks for a choice in
ordinary assistant messages. It does not require an intent question file at
that point. Our classifier recognizes only file-backed stage questions.
Checking the engine once before the model runs would therefore leave the
composer conversation unsupported.

The initial read-only engine prototype remains useful compatibility evidence,
but is superseded as the primary integration path. Do not invent question
files, choose `poc` or `compose` automatically, or interpret arbitrary assistant
prose as a verified approval gate.

The [first-turn checkpoint](native-first-turn-checkpoint.md) records the live
stopped run and the exact-package reproductions. Its prompt is present and
hash-verified. The live transcript was not retained; the exact live model
sequence remains unconfirmed. Separate local fixes address Codex's explicit
`$aidlc` skill invocation and the trusted graph projector's scoped permission.

## Runtime and durable content

1. Preserve the user's exact initial request and the pinned package, application
   source, harness, model, credential binding and isolated EFS workspace.
2. Collect the harness's **completed, user-visible assistant messages** in order.
   A composer table may precede its final question; retaining only the last
   sentence would lose the decision's context. Tool output and reasoning are
   excluded. Completion, session identity and harness errors are checked.
3. Collect messages independently from bounded diagnostic stdout. Large tool
   output must not hide the later question. Enforce message storage bounds
   without terminating a running model or presenting a silently truncated
   proposal as answerable.
4. Publish the current filesystem snapshot, then an immutable interaction
   referencing that publication. No fake file is necessary when the initial
   turn has not created workflow artifacts.
5. The trusted controller verifies the interaction's exact bytes, attempt,
   epoch, native session, package and publication before attaching it to the
   execution. `AWAITING_USER` means control returned to the person; it does
   not certify a native gate or declare workflow completion.

Interactions are required run content outside the checkout and Git, in the
existing private, versioned publication bucket. They are independent of
optional debug conversation archives. The debug default remains off. A public
API view contains messages and content identity, without storage pointers,
credentials or runtime ownership data.

Existing file-backed stage questions retain their stricter evidence checks.
Existing schema-1 file publications remain readable, including stopped runs.
Each new turn receives a monotonically increasing publication/interaction
sequence; cancellation remains a separate epoch fence.

## Protected replies and serial continuation

The REST reply contains exactly:

```json
{
  "requestId": "<UUID v4, reused when retrying this reply>",
  "interactionId": "<immutable interaction SHA-256>",
  "contentSha256": "<displayed ordered-message content SHA-256>",
  "text": "<member's exact reply, at most 16 KiB UTF-8>"
}
```

The API derives the actor from Cognito and checks current project membership.
The protected controller binds a single response to the exact current
interaction and records its author. Neither the runtime nor graph data can
create a human response. A duplicate identical request is idempotent; competing
replies, stale content, cancellation and caller-supplied authority are rejected.

Continuation retains the original starter's credential binding and pinned
configuration. The worker verifies authority again before delivery. One
execution lease permits one serial turn; answering does not open another
attempt or increment the cancellation epoch. Runtime delivery has its own
idempotency and prior-interaction checks.

Warm continuation must resume the existing harness session. If its process or
session ownership cannot be verified, stop with an explicit recovery condition.
Do not silently start a replacement writer against the workspace. Durable
messages and replies alone do not qualify recovery of local harness history;
that recovery remains a separate acceptance requirement.

## Existing UI and graph

The native Overview displays the ordered assistant messages and composer
tables. Its ordinary reply box is available only for a verified current
interaction in `AWAITING_USER`. It preserves an unsent reply and reuses the
request ID after an uncertain network result. Access denial and route/session
changes clear protected content and invalidate late responses.

The user may answer a composer request in ordinary text. Explicit platform
approval actions, advanced edits, per-unit PRs and deletion remain disabled.
The UI does not infer approval from assistant wording or route native replies
through the current backend's stage gate controls.

Graph projection references the immutable interaction without linking it to
a nonexistent Artifact. Selecting it opens the native Overview. Existing
published files still open through their exact publication identity. The
trusted projector has graph access; the native runtime does not.

The page currently presents the latest completed interaction and its accepted
reply. Older publications, interactions and accepted replies are retained in
immutable storage/protected records; a browsable full conversation timeline
is not implemented by this slice.

## Verification sequence

1. Local storage and REST checks: ordered text/table round-trip, exact scope
   and digests, body bounds, malformed data, member/nonmember behavior and
   revocation. These tests exercise the storage bytes and authentication
   boundary, not live model behavior.
2. Integrated controller/runtime tests: duplicates and lost acknowledgements,
   competing replies, stale references, changed credentials, cancellation,
   publication history, large preceding tool output, incomplete/error turns
   and unknown session recovery.
3. Frontend component/service checks, typecheck and production build. Inspect a
   composer proposal and reply on the actual native page using local fixtures.
4. Build the ARM64 image and Lambda artifacts; review the saved Terraform plan,
   verify every referenced archive and preserve persistent resources. The user
   performs deployment.
5. Verify deployed bytes and a fresh same-task native draft. The first live run
   stops at its visible question. Check exact content, reload durability and
   graph navigation before requesting a real member reply.
6. The user supplies the reply. Verify one continuation in the same session and
   the next native question/artifact. Repeat qualification for all four
   harnesses before claiming all-four acceptance.

There is no application model timeout added by this change. The earlier
preparation timeout fix and deferred pre-provisioning remain separate work.
