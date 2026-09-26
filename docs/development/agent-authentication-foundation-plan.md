# Agent authentication foundation

Implementation plan, updated September 24, 2026. Product decisions below reflect
the user's answers. Customer OAuth configurations remain an integration
qualification detail.

The delivery sequence is one foundation PR, a rebuilt Bedrock IAM PR based on it,
then a LiteLLM integration PR. The foundation includes backend, runtime, frontend,
and compatibility with existing credentials and intents. It is broader than a
behavior-preserving provider-registry extraction.

Reference: PR #452 and Jerome's comment, issue comment 5698564355.
Inspected foundation base: `a505a6043ad616cdd742e7be5cd472dbce698d14`.
Inspected IAM head: `8b7b2a9bfed48f25abc5a97c2780471fb4fa1f1f`.

## Confirmed requirements

| Area                   | Decision                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Foundation delivery    | One PR containing the complete agreed foundation                                                                                 |
| Platform selection     | One active mode: Keys, IAM, or LiteLLM                                                                                           |
| Space configuration    | Inherit platform defaults or override identity/role/key; LiteLLM endpoint and IdP may also be overridden                         |
| Mode enforcement       | A space cannot bypass the platform mode by selecting another backend or an incompatible credential                               |
| LiteLLM agents         | Claude Code, OpenCode, and Codex                                                                                                 |
| LiteLLM authentication | Tokens/keys, machine OAuth identities, and OAuth user sign-in                                                                    |
| Kiro                   | Keep its separate integration and credentials                                                                                    |
| IAM behavior           | Retain #452's role overrides, administrator controls, pinned bindings, renewal, and expiry handling                              |
| Upgrade approach       | Design for an additive upgrade with existing bindings and secret references retained; avoid requiring an administrator migration |
| Configuration changes  | Show the administrator the impact of mode changes and connection replacement/removal                                             |
| Personal credentials   | API keys in both Keys and LiteLLM modes; personal IAM and OAuth are excluded                                                     |
| Space permissions      | Platform and space administrators may manage space token/OAuth connections; IAM roles remain platform-admin-only                 |
| OAuth user sign-in     | Establishes a shared space connection used by the space's runs                                                                   |
| Frontend               | Include consistent administration, space configuration, and execution credential displays                                        |

Kiro retains its separate integration and existing personal/space/platform key
behavior.

## Findings that shape the design

- `lambda/shared/agent-credentials.js` combines CLI selection, provider definitions,
  scope precedence, SSM paths, storage operations, binding normalization, and display
  metadata.
- Agents, intents, discussions, and the orchestrator independently prepare grants.
  A registry alone would leave these callers owning credential policy.
- `lambda/agentcore/cli/drivers.js`, `stage-materializer.js`, `model-resolver.js`,
  and capability discovery contain Bedrock-specific configuration and model rules.
  LiteLLM therefore requires a backend/CLI boundary as well as an auth boundary.
- `cli/spawn.js` merges the ambient process environment into child environments.
  The built-in MCP server currently obtains application AWS credentials through
  the CLI. Merely moving these operations into a provider method does not fix
  the credential handoff.
- `lambda/shared/test/agent-credential-grants.test.js` directly tests signing and
  verification, but not the secret-loading and asynchronous issuance/verification
  wrappers.
- `listActiveExecutions` uses GSI3 and defaults to a 100-record limit. Configuration
  impact analysis needs complete pagination and authoritative rechecks.
- The active execution index covers CREATED, RUNNING, and WAITING. Draft
  conversations, retries of failed intents, and auxiliary invocations require
  separate consideration.
- The ordinary intent cancellation route rejects actively RUNNING intents.
  Do not use "stop all running work" as an assumed upgrade primitive.
- The runtime-session code documents that publishing a new image does not replace
  an already running session. Compatibility testing must cover old and new runtime
  versions coexisting.

## Architecture proposed for the foundation

### Separate mode, backend, mechanism, and client

The administrator sees the three product modes. Internally, the relationships are:

| Product mode           | Inference backend | Authentication                 |
| ---------------------- | ----------------- | ------------------------------ |
| Keys                   | Bedrock           | Existing bearer key behavior   |
| IAM                    | Bedrock           | Assumed-role credentials       |
| LiteLLM                | Customer gateway  | Token or the agreed OAuth flow |
| Separate Kiro settings | Kiro              | Existing Kiro key behavior     |

Selection for new work follows these rules:

- Keys: personal key, otherwise space key, otherwise platform key.
- IAM: space role, otherwise platform role; personal keys do not participate.
- LiteLLM: an applicable personal key for the effective gateway, otherwise the
  configured space token/OAuth connection, otherwise the platform connection.
- Kiro: existing personal, space, and platform key precedence.

LiteLLM spaces may select token or OAuth connections within the platform's
LiteLLM mode. Missing/revoked credentials for an already selected binding fail
closed; they do not cause fallback to another identity.

CLI adapters configure Claude Code, OpenCode, and Codex for the selected backend.
Authentication adapters obtain and maintain credentials. Scope resolution decides
which connection is authorized. These responsibilities have separate extension
points even when a feature ships them in one provider package.

The foundation represents and tests future modes. A mode becomes selectable only
when its real provider and required runtime capabilities have shipped.

### Establish explicit owners

| Component                           | Responsibility                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Shared contracts and catalog        | Validated identifiers, bindings, supported scopes, public capabilities, compatibility rules     |
| Credential service                  | Effective selection, pinning, connection status, grant preparation, mode enforcement            |
| Connection repository               | Versioned configuration and secret references; encapsulates current SSM paths                   |
| Broker implementations              | Verify authority, redeem credentials, refresh/revoke through the selected mechanism             |
| Runtime credential session          | Invocation-local credential delivery, expiry signal, cleanup, detached-work lifetime            |
| Backend/CLI adapters                | Endpoint and model configuration, auth transport, model discovery integration                   |
| Frontend descriptors and components | Consistent inheritance, status, connection actions, and safe display                            |
| Configuration change service        | Inventory, impact classification, reviewed revision changes, dependency-aware retirement, audit |

Keep the shared catalog free of workspace imports and privileged client
initialization. Broker-only dependencies and runtime lifecycle code remain behind
their process boundaries. Frontend descriptors contain public metadata only.

### Use durable connection references

Proposed records, with final field names to be settled during implementation:

- A platform policy records the selected mode, default connection, and revision.
- A connection records backend, mechanism, scope, non-secret configuration,
  configuration revision, and references to its secrets.
- A space either inherits the platform connection or references a permitted
  override for the selected mode. LiteLLM overrides can include endpoint and IdP.
- An execution binding pins the effective connection and relevant non-secret
  configuration revision. Authorization also binds purpose, space, execution,
  and personal owner where applicable.

Grant payloads and execution records do not contain API keys or OAuth refresh
tokens. Secret rotation and token refresh do not create a different execution
identity. Define explicitly how replacing a credential differs from refreshing
one, preserving #452's binding behavior.

Retain existing secret paths behind the repository. Decode old binding shapes
through compatibility adapters; create richer versioned records only where the
new configuration needs them. A new internal contract does not require rewriting
every stored binding or copying its secret.

Bind credential references to the connection's endpoint and applicable audience/
IdP configuration. A space endpoint override cannot silently send inherited
platform or personal credentials to a new destination. Require a matching
connection or explicit connection setup for the new endpoint.

Expose inheritance per field, but resolve a validated complete connection before
issuance. A partially overridden endpoint/IdP/client configuration must not yield
an accidental combination of unrelated identities.

### Centralize selection and issuance

Replace caller-specific preparation in agents, intents, discussions, and the
orchestrator with one service. Callers retain authorization for their operation
and supply trusted context. The service prepares the binding and grant; the
broker independently verifies them.

Cover normal stages, Composer, Quorum, discussion assistance, model discovery,
graph enrichment, conflict resolution, and parked-stage resume. Existing
executions use their pinned binding. Newly started executions use the current
platform policy and allowed scope override.

### Make credential lifetime generic

Use an invocation session with explicit prepared configuration, availability,
cancellation, and disposal. Detached jobs retain the session until their work
finishes. Concurrent invocations do not share tokens or cancellation state.

Static keys, IAM sessions, and OAuth access tokens can use the same lifecycle
without sharing issuance policies. Preserve IAM's current renewal timing and
non-sliding authorization limit in its provider configuration; do not impose
that limit on every future mechanism.

OAuth contracts must cover both machine identity acquisition and user sign-in,
expiry, refresh where the flow supports it, reconnect-required state, and
revocation. Credential refresh remains behind the broker boundary. A reconnect
or replacement identity must not silently change the identity of an existing run.

User sign-in creates a space-owned connection shared by that space's runs. The
connection flow must explicitly disclose this sharing and delegation. Only
authorized platform/space administrators establish or replace that connection.
Personal overrides use API keys, not personal OAuth connections.

Coordinate refresh across concurrent invocations and broker instances for the
same connection, including rotating refresh tokens. Persist refresh results with
ownership/version checks; an in-process promise alone is not sufficient.

The exact reusable OAuth implementation depends on customer IdP requirements.
Do not infer an OAuth flow from a token-shaped credential. Validate the generic
machine and user-sign-in contracts independently of a specific customer's IdP.

### Establish the runtime handoff

Construct child environments explicitly; launchers must not restore scrubbed
ambient credentials. Separate agent inference credentials, application runtime
identity, and custom MCP credentials.

Design the built-in application MCP access as a runtime-owned service or bridge
so the CLI does not carry the runtime AWS credential snapshot. Prove the selected
transport with all supported CLIs before committing to it.

Test the actual child environment and MCP configuration, including alternate AWS
credential sources and unexpected inherited values. State the limits of the
process isolation being provided; environment sanitation alone is not a host
sandbox.

## Work included in the single foundation PR

The following are implementation/review units within one PR:

1. Define contracts and record the accepted product and compatibility decisions.
2. Add the connection repository, catalog, and current Bedrock/Kiro key adapters.
3. Centralize binding selection and grant preparation across all entry points.
4. Add runtime sessions, backend/CLI adapters, and the application MCP boundary.
5. Update frontend APIs, administration, space inheritance, and intent displays.
6. Add configuration-change impact previews, revision-safe activation, and
   operator documentation.
7. Add behavioral, security-boundary, upgrade, and extension-contract coverage.

Expected code areas include shared credential modules, credential metadata and
redemption brokers, API/orchestration callers, AgentCore auth/CLI/MCP code, settings
components and services, and execution displays. Add infrastructure only where
the configuration control records or runtime boundary require it.

Keep provider-specific setup forms as explicit components behind the common
settings flow. Avoid designing an unrestricted schema-driven form framework.

## Compatible upgrade and informed configuration changes

### Upgrade without a separate migration

The user's follow-up clarified that preserving running intents removes the
motivation for an administrator migration. Adopt compatibility as the design
target:

1. Continue reading current SSM paths and existing binding shapes.
2. Treat legacy Bedrock bindings as key bindings. Changing the platform mode must
   not reinterpret an old `provider: bedrock` binding as IAM.
3. For older executions without a binding, preserve their historical platform-key
   semantics through a dedicated compatibility resolver. Do not resolve them
   against the currently selected mode.
4. Keep the current grant/redemption protocol usable by already running runtime
   sessions while adding a versioned protocol for new capabilities.
5. Keep the platform on its existing behavior after deployment until an
   administrator changes configuration.
6. Preserve old connection definitions and credential access while existing
   intents need them. A mode switch changes selection for new work; it does not
   revoke a pinned execution's authority.

Ship compatibility readers as part of the application. There is no bulk rewrite,
automatic credential-mode switch, or separate "migrate" button in this plan.
If implementation finds a concrete incompatibility that prevents this, return
with the specific impact and a revised proposal before introducing migration.

### Preview deliberate changes

The administrator reviews impact when changing mode or replacing/removing a
connection. Produce a timestamped, revision-bound report covering:

- Spaces and existing platform, space, and personal connections.
- Created, running, parked, and retryable intents and their pinned identities.
- Composer, Quorum, and other active invocation work that could be affected even
  when the parent intent is not marked RUNNING.
- Published environment versions and their support for the proposed configuration.
  Existing runtime sessions can continue on supported legacy bindings; a new
  binding must not be sent to an incompatible runtime.
- Drafts that will select credentials at their next operation.

Use paginated enumeration. Treat the active index as a discovery mechanism and
re-read authoritative records before applying a reviewed change. Add invocation
accounting where execution status cannot represent active work. Do not report a
complete live inventory when older runtimes do not supply sufficient evidence.

For each affected item, report one of:

| Outcome                                 | Meaning shown to the administrator                                               |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Continues with existing identity        | The change preserves the binding and required credential access                  |
| Uses new configuration on next start    | Applies to work that has not pinned an execution identity                        |
| Next invocation or renewal loses access | Clearing/revoking a referenced connection prevents future credential acquisition |
| Needs reconnect or credential repair    | The required connection cannot authorize the next operation                      |
| Cannot yet determine                    | The runtime or execution evidence is insufficient                                |

Show counts and a drill-down list with space, intent, current activity, identity,
reason, and required action. Separate configuration effects from ordinary external
credential expiry or revocation: compatibility is not a guarantee of eventual
model-call success.

The preview must not invent precise failure predictions for unobserved live work.
Distinguish an already issued token continuing to work from a future invocation
or refresh failing after a credential is cleared or revoked.

### Apply a reviewed change

- Prepare and validate candidate configuration before changing the active revision.
- Resolve and pin new work against a single policy revision. Use conditional
  writes/rechecks so a concurrent mode change cannot produce a mixed binding.
- Reject stale reviews when the proposed change or material impact changed.
- Retain old connections for pinned work. Distinguish retirement for new work from
  credential deletion or external revocation.
- Record who changed the policy and which revision became active. Make retries
  and duplicate submissions safe.
- Show the dependency impact of credential deletion/revocation. A mode switch
  alone is not authorization to clear the previous mode's credentials.

The same change service supports Keys, IAM, and LiteLLM. A forced-stop workflow is
not part of this foundation plan.

## Frontend behavior

- Platform administration selects one supported mode and configures the default
  connection. Show readiness and the effects of changing it.
- Space settings show the enforced platform mode, inherited connection, override
  permissions, effective identity, endpoint, and IdP. Platform values are the
  defaults; space overrides are explicit.
- OAuth-capable connections show connection state and the actions appropriate
  to the agreed flow. Secret values are never returned for display.
- Intent views show the effective or pinned connection and explain why it may
  differ from the platform's current default.
- Kiro remains separately configurable.
- Mode and connection-change screens show impact details and an explicit apply
  action. Upgrading the application does not require a migration page.
- Personal settings support API keys in Keys and LiteLLM modes, associated with
  the applicable gateway connection. They do not offer IAM or OAuth identities.

## Validation and completion criteria

- Existing key behavior is covered across platform/space/personal precedence.
  Personal LiteLLM keys apply only to the matching effective gateway.
- Grant tests cover secret loading and caching, issuance, verification, malformed
  bindings, audience/purpose mismatches, expired grants, and cross-space attempts.
- Static and expiring credential test implementations exercise the same session
  interface. IAM-derived fixtures cover renewal/cancellation requirements.
- Machine OAuth and user sign-in contracts are tested for expiry, refresh
  concurrency, reconnect, identity binding, and revocation, where applicable.
- Test multiple broker instances refreshing a shared space connection, refresh
  token rotation, authorization for connection changes, endpoint/IdP overrides,
  and rejection of a credential bound to a different gateway.
- An alternate-endpoint test backend exercises Claude Code, OpenCode, and Codex
  adapters without carrying Bedrock endpoint/model assumptions into them.
- Tests inspect launched child environments and built-in/custom MCP handoffs.
- Workflow coverage includes normal stages, parked resume, Composer, Quorum,
  capability/model discovery, enrichment, and conflicting concurrent invocations.
- Upgrade tests cover legacy binding shapes, executions without bindings,
  existing secret paths, old grants, and old/new runtimes coexisting.
- Change-impact tests cover more than 100 active executions, stale previews, new
  work appearing during review, paused/failed/draft intents, auxiliary work,
  credential retirement, and concurrent policy changes.
- Frontend tests verify inheritance, mode restrictions, reconnect states, impact
  explanations, stale-preview handling, and explicit administrator activation.
- Run the affected backend suites, frontend type checking/build/tests, lint,
  formatting, secret scanning, and dependency boundary checks. Validate
  infrastructure if changed.
- Adding another auth mechanism must not require provider branches in intents,
  discussions, orchestration, or generic process launchers. A new backend may add
  its own adapters, discovery, setup UI, and provider tests.

## Rebuilding IAM afterward

Retain role/region validation, platform-admin authorization, per-space role
overrides, signed renewal authority, inference-only sessions, refresh, expiry
failure reporting, paused-run resume, and the setup/verification UX from #452.

Place STS and role policy behavior in broker-side IAM code, local credential
delivery in the runtime implementation, and role configuration in the shared
settings flow. Keep current numeric lifetime policy unless a separate product
decision changes it.

Re-run IAM security/lifecycle tests and live qualification against the rebuilt
version. Preserve #452 as reference while the foundation is reviewed; do not
rewrite or replace the IAM branch during planning.

## Remaining integration qualification

Request representative customer OAuth IdPs/configuration shapes and the
authentication protocol used in front of their LiteLLM gateway. Both machine
identities and user sign-in, plus tokens/keys, are confirmed requirements.

The foundation can define and test those contracts with controlled endpoints.
Do not claim a customer IdP integration works until its actual flow, audience,
scopes, refresh behavior, and gateway acceptance have been qualified in the
LiteLLM implementation.
