# Agent authentication foundation

This document records the authentication foundation contracts, provider extension
points and deployment operations.

## Delivery and upgrade

The foundation ships **Keys** and the existing separate Kiro integration. IAM and
LiteLLM are registered as planned descriptors, so stored rows that name them keep
parsing. A mode becomes available, in settings and for selection, only when a
provider registers a real descriptor in its place. Their production providers,
configuration flows and qualification belong to the following IAM and LiteLLM
changes.

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
| `lambda/shared/agent-auth-protocol.js`         | Dependency-free identifiers, mechanisms and scopes                                                       |
| `lambda/shared/agent-auth-mode-registry.js`    | Mode descriptor validation and the catalog; each descriptor owns its connection configuration check      |
| `lambda/shared/agent-auth-catalog.js`          | Compatibility facade over the contracts and the mode host (`agent-auth-providers.js`)                    |
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
precedence independently of the platform mode. Every other available mode uses the
default selection: the space's connection when it was selected for the policy
mode, otherwise the policy's default connection. It must be a ready platform or
space connection of that mode, and a space connection must belong to that space.
The `assume-role` mechanism permits space/platform connections managed only by
platform administrators. Personal OAuth and IAM identities are rejected.

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

Deploy the caller policies with the code. Broker reservations require item writes
and condition checks; scoped settings reviews require queries, and returning a
space to inheritance requires deleting its selection. Terraform explicitly orders
the broker functions, agents role output, and runtime behind their required
policies so a scoped deployment includes these permissions.

After deployment, verify existing platform/space/personal keys, a new stage and
Composer request, a parked execution resume, and an older runtime session. Review
a key rotation, create intervening work to confirm stale-review rejection, then
apply a fresh review. Check that the policy remains Keys and that modes without a
registered provider remain unavailable. Local tests and Terraform validation do
not establish that a live AWS deployment or real-model invocation has succeeded.

## Provider boundaries

Each deployable composes its providers in one root: a file with static imports and
one frozen list. In each backend deployable, one foundation host reads the root,
validates it when the Lambda or image loads, and publishes the views existing
importers use. Duplicate ids, adapter keys, material types, renewal actions,
audiences or error codes fail initialization. The runtime and settings hosts also
refuse a provider for a mode that is not available, and registration tests check
that every available mode has broker adapters. Backend hosts build the same views
from an injected list. The frontend registry is a plain lookup; frontend tests mock
it, so no test asserts what a root contains.

| Root                                                      | Host (factory)                                                                          | Registers                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `lambda/shared/agent-auth-modes.js`                       | `agent-auth-providers.js` (`createAuthModeRegistry` from `agent-auth-mode-registry.js`) | Mode descriptors, bundled by every Lambda and the runtime image              |
| `lambda/credential-broker/agent-broker-providers.js`      | `agent-provider-registry.js` (`createBrokerProviderRegistry`)                           | Redemption adapters, renewal policy, verification, isolation, error codes    |
| `lambda/agentcore/runtime-auth-providers.js`              | `credential-material-registry.js` (`composeRuntimeAuthProviders`)                       | Advertised modes, material adapters, controlled env, capabilities, verifiers |
| `lambda/agents/authentication-settings-providers.js`      | `authentication-settings-service.js` (`providers` option)                               | Connection drafts and setup actions                                          |
| `frontend/src/components/settings/agent-auth/registry.ts` | The settings shells                                                                     | Setup component, noun and configuration summary                              |

Keys is registered in the shared, broker and runtime roots. Its settings flows are
the built-in credential routes and cards, so it has no settings or UI entry.

Bindings and capability contracts live in `agent-auth-contracts.js`. The selection
coordinator owns snapshot consistency, pending-change checks, and reservation. Keys
keeps its own strategy in `AUTH_SELECTION_STRATEGIES`; planned and
unregistered modes have no strategy and are refused. Kiro selection is independent
of the platform inference mode. Callers request the provider they use; capability
discovery requests both providers explicitly with `reserve: false`.

Broker adapters return material and its expiry. The host composes the versioned
credential lease: opaque typed material, optional credential expiry, an immutable
authorization deadline, and optional renewal authority. It signs and verifies
renewal tokens from the provider's declared policy, so the grant signing key never
reaches a provider. A provider's classifier sees only errors thrown by its own
adapters. Runtime material adapters translate the lease into invocation
configuration. Grant/context matching, session ownership, expiry cancellation, and
renewal identity checks remain generic. Legacy key responses retain the `value`
field for published runtimes. Foundation suites register fixture providers through
the roots and exercise renewal identity mismatch, unsupported material, error
scoping, discovery isolation, expiry, and a non-sliding deadline. These controlled
tests do not qualify a customer identity provider.

A CLI counts as authenticated only when the invocation prepared a lease for its
credential provider; ambient environment values never authenticate it. The runtime
advertises `agentAuthModes` and `agentAuthVerification` from its registered
providers; Lambdas qualify a runtime for a mode by that evidence.

Authentication settings orchestration lives in
`lambda/agents/authentication-settings-service.js`. HTTP routing and authorization
remain in `index.js`. The authentication-change preview accepts `policy-change`
(with `policy` as an input alias), `space-selection` with a null connection to
return a space to inheritance, and `connection-draft` for a mode whose provider
declares a draft. The service mints the reviewed `connection-create` itself; key
changes are reviewed through the credential routes. Provider setup steps use
`POST /agents/authentication-setup` with `{ mode, action, projectId? }`, for platform
administrators only. The pure `agent-auth-actions.js` planner decides policy transitions and activation
writes. `agent-auth-review-repository.js` executes them and owns review locking;
`agent-auth-inventory-repository.js` owns discovery and backfill. The connection
repository composes these stores behind its existing public interface.

## Scoped reviews

Personal and space reviews query strongly consistent scope reference partitions
in the process table. They re-read only referenced authoritative records and the
matching auxiliary execution prefixes. Personal fingerprints contain only that
user's identities, including when a discovery invocation uses several bindings.
Scoped HTTP reviews do not scan the process table, enumerate SSM scopes, enumerate
Neptune projects, or scan the environment registry. Platform reviews retain the
explicit global inventory path. Scoped revisions and activity counters prevent an
unrelated space change or selection from invalidating a personal review. Selection,
invocation accounting, and execution binding writes update references atomically.
References are discovery metadata; existing execution records and credential
bindings remain authoritative.

`scripts/deploy-terraform.sh` automatically initializes the additive scope index
on fresh installs and upgrades, after Terraform has deployed all writers. The
managed installer and deployment workflow use that script. Initialization runs
even with `--skip-seed`, is idempotent once the readiness marker exists, and a
failure fails the deployment before it reports success.

The initializer uses the deployment principal, which needs `dynamodb:GetItem`,
`dynamodb:Scan`, `dynamodb:PutItem` and `dynamodb:ConditionCheckItem` on the process
table. It reads non-secret records and writes references and the readiness marker.

If applying Terraform directly, initialize the index after the complete apply:

```sh
AWS_PROFILE=solution AWS_REGION=eu-central-1 \
  V2_PROCESS_TABLE=<review-process-table> \
  node scripts/initialize-agent-auth-inventory.mjs
```

Initialization indexes historical records without changing their bindings
or secrets. Scoped reviews fail closed until the initialization marker exists;
there is no fallback to a global scan from a personal request. Existing runtime
images do not gain new accounting behavior until republished. Scoped enumeration
has a 5,000-record safety limit applied to material records, after re-reading
the targets and excluding expired, finished and deleted work. Invocation completion
sets the same TTL on the invocation and its scope references in one transaction.
Succeeded, failed and cancelled executions remain rewindable and retain their
references; permanent intent deletion removes them atomically with execution META.
Historical dangling references do not consume the review limit. Probe deployments
with fresh AgentCore session IDs.

## Adding an authentication provider

A provider adds its own files plus an import and one list entry in each root it
needs. It does not edit hosts, handlers, services, selection, grants, the broker
entry, the runtime resolver, capabilities, Terraform, or foundation tests. The
fixed-list guards `lambda/shared/test/agent-auth-boundary.test.js` and
`frontend/src/components/settings/agent-auth/boundary.test.ts` report IAM names in
foundation modules and settings shells by file and line; keep a new provider's
names out of those files as well.

1. **Shared descriptor** (`lambda/shared/agent-auth-<id>-schema.js`). It imports only
   `agent-auth-protocol.js` and `agent-auth-mode-registry.js` and exports a
   `defineAuthMode` descriptor: `id`, `label`, `backend`, `mechanisms` and
   `normalizeConfiguration`, optionally `modelDiscovery` and `defaultConnectionId`.
   The normalizer receives `(configuration, { mechanism })`, builds on
   `normalizeConfigurationFields`, is pure, and throws `AGENT_AUTH_INVALID`. Its
   output is part of binding identity and must stay byte-stable. Root: replace the
   planned stub at its position in `agent-auth-modes.js`, or append a new mode.
2. **Broker provider** (`lambda/credential-broker/<id>-provider.js`). It declares an
   `id` and `adapters` keyed `'<backend>:<mechanism>'`, and optionally `renewal`,
   `verification`, `isolateCapabilityFailures`, `errorCodes`, `classifyError`,
   `createDependencies`. An adapter receives
   `{ ssm, connection, binding, claims, request, deps }`, where `request` is
   `resolve`, `renew` or `verify`, and returns `{ material, expiresAt }`. Create SDK
   clients in `createDependencies`, which runs once on first use, never at import.
   Root: `agent-broker-providers.js`.
3. **Runtime provider** (`lambda/agentcore/<id>-runtime-provider.js`). It declares an
   `id`, the `modes` it serves and `materials` keyed by material type, and optionally
   `controlledEnv`, `capabilities`, `verify` and `verificationFailures`. A material
   adapter maps `{ binding, material }` to `{ env?, credentialEnvironment? }` and may
   expose `createSession` to own a renewing session. Root:
   `runtime-auth-providers.js`, with a static import so `container-deps.test.js`
   checks the provider's packages against the image manifest. It cannot reach key
   storage, connection records or grant signing, even through a shared module
   (`npm run dep:check`). A space qualifies for the mode once its published runtime
   advertises it.
4. **Settings provider** (`lambda/agents/authentication-<id>-settings.js`). It
   declares a `mode`, and optionally a `draft` (`mechanism`, `prepare`) and named
   `actions`. An action is `async (input, ctx) => ({ statusCode, body })`; `ctx`
   carries `env`, `logger`, `projectId`, `runtimeTarget` and `verifyConnection`. It
   holds no AWS clients, grants, or repositories. Root:
   `authentication-settings-providers.js`.
5. **Frontend UI** (`frontend/src/components/settings/agent-auth/<id>/`). It imports
   only `contract.ts` and `services/agents.ts` and exports
   `{ mode, noun, Setup, summarize? }`. `Setup` receives `AgentAuthSetupProps`; its
   `onSubmit(configuration)` is previewed as a `connection-draft`. Setup steps call
   `agentsService.authenticationProviderAction`. Root: `registry.ts`.

The hosts enforce these contracts:

- **Renewal policy.** `renewal` declares `action`, `audience` and `ttlSeconds`.
  Renewal requests use the single neutral `grant` field; leases expose that token
  in `renewal.grant`. The action must be new to the
  broker, the audience distinct from the grant's and every other provider's, and
  the lifetime 1 to 86,400 seconds. The host issues the token on resolve, accepts
  the same token on renew, and fixes the authorization deadline at grant issue plus
  `ttlSeconds`. Material expiry can only shorten a lease. An adapter may return a
  whole lease only without renewal or a deadline.
- **Connection verification.** The broker provider declares `verification: true`;
  the runtime provider's `verify({ binding, env })` returns `verified` and an
  optional `code` and `error`, never a secret. The agents Lambda requires the mode
  in the runtime's `agentAuthVerification`, signs a `verify-connection` grant for
  the one unsaved binding, and checks it on the probed session. The broker redeems
  it with no connection read and no renewal, capped at the grant expiry. Messages
  for provider codes go in `verificationFailures`; foundation messages cannot be
  redefined.
- **Runtime authentication.** CLI availability follows prepared leases, so a
  provider sets no environment marker. A material adapter or its session may
  write only inference or AWS credential names the foundation already scrubs, or
  names in its provider's `controlledEnv`; any other name fails preparation with
  `AGENT_AUTH_LEASE_INVALID`. Controlled names are stripped from the ambient
  environment and the MCP bridge, set empty in every custom stdio MCP server, and
  reserved from custom MCP secret references.
- **Error codes.** `errorCodes` match `^[A-Z][A-Z0-9_]+$` and are disjoint from the
  base codes. A `classifyError` result outside them is ignored.

Put provider tests in new files. Compose explicit lists through the host
factories, or drive a handler with the helpers in `lambda/shared/test/helpers/`
(`auth-table.js`, `auth-modes.js`), `lambda/credential-broker/test/helpers/`,
`lambda/agentcore/test/helpers/` and `lambda/agents/test/helpers/settings-harness.js`.
The foundation's registration tests run over the real roots: every available mode
needs broker adapters for its mechanisms and a runtime advertisement, and every
settings provider needs an available mode. A missing entry fails there; do not edit
those tests to make it pass.

Add SDK clients to the consuming workspace at the root's `@aws-sdk/*` version, for
example `npm i @aws-sdk/client-sts@3.1092.0 -w lambda/credential-broker`, and run
`npm run sdk:check`. That check compares declared ranges only, so also confirm the
lockfile has no `node_modules/@aws-sdk/<client>/node_modules/@aws-sdk/core` entry
for the new client: a nested core ships a second SDK core in the bundle. The
runtime image installs only `lambda/agentcore/package.json`.

The runtime role denies `sts:AssumeRole` as general hardening: application
credentials cannot assume another role. Providers own any additional deployment
wiring they require, including exposing the broker principal for IAM trust setup.
Published Keys runtimes retain their existing top-level `value` response. There
is no deployed IAM wire contract on `main`; any compatibility for IAM review
environments belongs to the IAM provider change.

LiteLLM uses the same roots and contracts. It still needs foundation work that no
provider has needed yet:

- a slot/backend split, so a non-Bedrock binding can fill a CLI's inference slot
  (binding normalization, `connectionBinding`, grant provider order and a
  descriptor slot);
- a lease-selected inference backend in the runtime (lease adapters, one-shot,
  run-stage, conflict resolution, stage materialization and backend adapters);
- reviewed creation of secret-bearing connections and their state lifecycle
  (actions, activation, repository storage, `credentialChangeAffects` and
  invocation accounting);
- space-administrator authorization for provider actions and changes, which are
  platform-administrator-only today.
