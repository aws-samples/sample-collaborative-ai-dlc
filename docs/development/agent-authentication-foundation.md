# Agent authentication foundation

This document records the foundation contracts and operations described in
[the accepted implementation plan](agent-authentication-foundation-plan.md).

## Delivery and upgrade

The foundation ships **Keys** and the existing separate Kiro integration. IAM and
LiteLLM are represented by validated contracts and extension tests, but cannot be
selected in settings. Their production providers, configuration flows and
qualification belong to the following IAM and LiteLLM changes.

Deployment preserves existing platform, space and personal secret paths. No
credential copy, bulk execution rewrite, mode switch or administrator migration
is performed. A missing policy means revision zero, Keys mode and the historical
platform Bedrock connection.

Existing `provider: bedrock` bindings always mean bearer keys. Started executions
without a binding use their historical platform key. New drafts select their
identity when an operation starts. Missing credentials on a pinned reference fail
closed and never fall back to another scope.

The broker accepts version-one grants alongside version-two grants. Version-two
bindings require published runtime authentication capability evidence; missing
evidence is treated as unsupported. Publishing an image does not replace an
already running runtime session. Existing sessions can continue using their
legacy bindings.

## Owners and records

| Owner                                          | Contract                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lambda/shared/agent-auth-catalog.js`          | Dependency-free identifiers, mechanisms, scopes, connection validation and safe display metadata         |
| `lambda/shared/agent-key-repository.js`        | Existing SSM paths and key storage; the old `agent-credentials.js` module remains a compatibility facade |
| `lambda/shared/agent-connection-repository.js` | Policy, immutable connection revisions, review records, selection reservations and audit writes          |
| `lambda/shared/agent-credential-service.js`    | Selection and invocation grant preparation for API and orchestration callers                             |
| `lambda/shared/agent-binding-selection.js`     | Policy-aware selection inside the metadata broker                                                        |
| `lambda/shared/agent-auth-redemption.js`       | Broker-only redemption adapters and validation of pinned connection references                           |
| `lambda/agentcore/credential-session.js`       | Invocation ownership, refresh, cancellation, detached-work retention and disposal                        |
| `lambda/agentcore/cli/backend-adapters.js`     | Backend-specific endpoint/model configuration independent of process launching                           |
| `lambda/shared/agent-auth-changes.js`          | Review, inventory classification, stale-review checks and activation                                     |

Authentication control records use the existing process table:

- `AGENTAUTH#POLICY / META` contains `mode`, `defaultConnectionId`, `revision` and
  `activityRevision`. `pendingReview` identifies an interrupted credential write.
- `AGENTAUTH#CONNECTION#<id> / REV#<revision>` contains an immutable connection
  definition and secret reference. `META` identifies its current revision/state.
- `AGENTAUTH#REVIEW#<id> / META` contains the proposed change, reviewing actor,
  policy/activity revisions, inventory fingerprint, timestamp and expiry. Large
  drill-down lists are returned to the reviewing browser, not stored in one
  DynamoDB item.
- `AGENTAUTH#AUDIT / REV#<revision>` records the applied revision and actor.
- `AGENTAUTH#SELECTION#<id>` reserves a selected identity while the execution record
  is being prepared. Such records are explicitly classified as uncertain work.
- `AGENTAUTH#INVOCATION#<id>` records an active invocation independently of the
  parent intent's status. Its lifetime includes detached Composer, Quorum and
  stage jobs. Heartbeats distinguish observed activity from stale evidence.

Only ephemeral selection and completed invocation records set `agentAuthTtl`.
Terraform enables TTL for that attribute; historical execution records do not
acquire an expiry.

A version-two binding pins `connectionId`, `connectionRevision`, `policyRevision`,
backend, mechanism, scope and complete non-secret configuration. Space and personal
bindings also identify their space or owner. Grants contain these references,
purpose, space, execution and short-lived authorization; they contain no key or
OAuth refresh token.

Legacy key rotation replaces the value at the existing reference. It preserves
the logical connection and is visible on the next invocation. Clearing the value
prevents future acquisition through that reference. This is distinct from
creating a replacement connection, which gets an immutable definition and its own
secret reference. Retiring a definition for new work retains access for pinned
work; revoking it denies subsequent redemption.

## Selection and configuration

Keys retain personal → space → platform precedence. Kiro retains the same
precedence independently of the platform mode. The future IAM contract permits
space/platform roles, with role management restricted to platform administrators.
Personal OAuth and IAM identities are rejected.

The LiteLLM contract resolves a complete connection before applying a personal
API-key override. Endpoint, issuer, client, audience and scopes form its
destination identity. An inherited token or personal key cannot be silently used
with a different gateway or IdP configuration. Arbitrary configuration fields and
secret fields in public configuration are rejected.

Platform and space administrators may manage space keys. Public settings expose
the platform mode, inheritance, readiness and effective connection information.
Intent configuration displays the pinned connection and explains that it can
differ from defaults used for new work.

## Reviewed changes

The credential cards preview replacement and clearing before exposing **Apply
reviewed change**. Mode changes use the same service. Reviews expire after ten
minutes and bind the actor, candidate configuration, revisions and material
inventory. A changed candidate or changed work requires another review.

Inventory enumerates all pages, reads authoritative execution records, and
includes spaces, existing credential scopes, published environment revisions,
drafts, failed/parked work, pending selections and auxiliary invocations. It
reports:

| Outcome                                 | Interpretation                                        |
| --------------------------------------- | ----------------------------------------------------- |
| Continues with existing identity        | The pinned definition and credential access remain    |
| Uses new configuration on next start    | Unpinned work resolves configuration later            |
| Next invocation or renewal loses access | The reviewed operation clears a referenced credential |
| Needs reconnect or credential repair    | The connection is revoked or needs repair             |
| Cannot yet determine                    | Activity or identity evidence is insufficient         |

The report deliberately does not claim complete live accounting for older
runtimes. Already issued credentials can keep working after a reference is
cleared; their external expiry/revocation is independent of these controls.
Healthy heartbeat timestamps do not by themselves invalidate a review.

Activation uses conditional writes. A credential update first reserves its
reviewed revision; selection and redemption through the affected credential are
held until the write finishes. Unrelated credentials remain usable. SSM writes are
idempotent for the reviewed value, and an interrupted write retains its review
for retry. Re-entering the same value and reviewing it again recovers that pending
review. A different value cannot finish it. Duplicate successful submissions
return the already applied revision.

API keys are validated against the SSM standard-parameter size before reserving
a change. Mode changes do not authorize clearing previous credentials.

## Runtime boundary

The launcher constructs a child environment from an explicit ambient allowlist
and invocation configuration. It removes application AWS keys, profiles,
container credential endpoints, web-identity sources and inherited process
injection settings. Default AWS credential/config files point to `/dev/null` and
EC2 metadata discovery is disabled. Only a credential adapter can introduce an
invocation's inference IAM credentials or its dedicated credential file.

The runtime owns the built-in application MCP server process and its AWS identity.
Each materialization creates a private Unix socket with a fixed server command
and trusted execution scope. Claude Code, Kiro, OpenCode and Codex receive a
standard stdio relay to that socket. The relay cannot select another command or
scope and has no AWS client imports. Tests perform MCP initialization, tool
listing and a scoped tool call through all four native configuration shapes.
Concurrent invocations use separate Claude/Kiro MCP files and Codex homes, and
each session removes its own configuration when finished. Explicit CLI
conversation-store locations remain available for parked-run resume.

Custom MCP servers keep their explicitly configured secrets. Reserved inference,
application credential and runtime control variables cannot be used as custom
secret references; custom child configurations also scrub credential inheritance.

This is a credential-delivery boundary, not a host sandbox. Arbitrary same-UID
native code is not isolated from the host by environment sanitation or socket
permissions alone.

Synchronous and standalone commands own a credential session. Detached jobs retain
it until completion. Sessions do not share credentials or cancellation state.
Refresh and hard expiry have independent timers: a stuck refresh cannot extend
authorization. Cancellation terminates the child and is reported as
`credential_unavailable`, including conflict resolution and one-shot work.
Mechanisms provide their lifetime policy; the foundation imposes no universal
IAM-style authorization ceiling.

## OAuth extension contract

`agent-oauth-contract.js` validates separate machine (`client_credentials`) and
user-sign-in (`authorization_code`) results, their issuer/audience/client, expiry
and subject identity. User sign-in requires an authorized space/platform
administrator and explicit consent that the space's runs share the connection.
A token-shaped value does not select an OAuth flow.

The coordinator uses a durable DynamoDB lease through
`agent-oauth-state-repository.js`. Provider code supplies token acquisition and
an encrypted, immutable secret repository. Refresh writes a new secret first,
then conditionally promotes its reference using connection version, lease owner,
identity and subject checks. Losing a race removes the unreferenced secret.
Revocation and subject substitution prevent commit. An expired lease with an
unknown token-rotation outcome requires reconnect instead of replaying a
potentially consumed refresh token.

Tests run two coordinator instances against the same DynamoDB state. These are
controlled extension-contract tests, not qualification of a customer's IdP.
The LiteLLM provider must qualify its real grant, PKCE/state handling for user
sign-in, scopes, gateway acceptance, encrypted token storage and reconnect UX.
A replacement subject needs a new connection identity; it must not take over
existing runs.

## Validation and deployment

Run the repository checks from the checkout:

```sh
npm ci
npm --prefix frontend ci
npm test
npm --prefix frontend test
npm --prefix frontend run build
npm run lint
npm run format:check
npm run secretlint
npm run dep:check
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
terraform -chdir=terraform fmt -check -recursive
```

Use the existing deployment configuration and AWS profile for the intended
environment. For example, after reviewing a dev deployment plan:

```sh
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/agent-auth-foundation.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/agent-auth-foundation.tfplan
./scripts/deploy-frontend.sh dev
```

The backend change includes metadata-broker DynamoDB access, a read-only
parameter-name inventory permission, agents API policy/review access and the
ephemeral-record TTL attribute. It does not grant application AWS credentials to
CLI processes.

After deployment, verify existing platform/space/personal keys, a new stage and
Composer request, a parked execution resume, and an older runtime session. Review
a key rotation, create intervening work to confirm stale-review rejection, then
apply a fresh review. Check that the policy remains Keys and that IAM/LiteLLM
remain unavailable. Local tests and Terraform validation do not establish that a
live AWS deployment or real-model invocation has succeeded.
