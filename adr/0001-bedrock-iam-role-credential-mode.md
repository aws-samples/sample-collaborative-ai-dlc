# ADR-0001 — IAM role (STS) as a Bedrock credential mode

|                 |                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Accepted — earlier no-refresh and helper proposals are superseded by the bounded loopback provider in §3.                        |
| **Date**        | 2026-09-06                                                                                                                       |
| **Base commit** | `8e67ac5` (upstream `main`) — every `file:line` citation below is valid at this commit                                           |
| **Supersedes**  | The `bedrock-auth-method` global SSM selector shipped in fork PR #1 (deleted, not replaced)                                      |
| **Scope**       | `lambda/shared`, `lambda/credential-broker`, `lambda/agentcore`, `lambda/agents`, one Terraform IAM statement, one frontend card |

## 1. Context

### What ships today

Upstream #405 replaced the deployment-wide Bedrock secret with a three-scope credential hierarchy:

| Fact                                                                                                                                                        | Evidence                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Kiro and bearer-only Bedrock use `user → space → platform`; a Bedrock role uses `space → platform` and overrides covered bearer keys                        | `lambda/shared/agent-credentials.js` (`resolveEffectiveCredentialState`)                                |
| A provider is one table row: SSM parameter name, input field, "set" field, env var                                                                          | `lambda/shared/agent-credentials.js:22` (`PROVIDER_CONFIG`)                                             |
| A **credential broker** is the sole IAM principal permitted to read credential material; API Lambdas deliberately have no `ssm:GetParameter` on those paths | `lambda/credential-broker/`, `aws_iam_role.credential_broker` in `terraform/modules/api/lambda/main.tf` |
| The broker validates a signed, short-lived grant and rejects a `projectId` that does not match the execution record                                         | `authorizeAgentCredentialRequest`, `verifyIssuedAgentCredentialGrant`                                   |
| Auth is resolved **per invocation**; the base environment is scrubbed of credential variables each time                                                     | `lambda/agentcore/auth-resolver.js` header, `cleanBaseEnv`, assignment at `:196`                        |
| The grant is destroyed before the command handler runs                                                                                                      | `lambda/agentcore/http-server.js:107` — `delete handlerPayload.agentCredentialGrant`                    |
| Each Bedrock CLI copies the bearer token into its own environment if present                                                                                | `lambda/agentcore/cli/drivers.js:69` (claude), `:156` (opencode), `:227` (codex)                        |
| Cost shown in-product is **not billing data** — it is token counts × Price List prices cached in SSM                                                        | `lambda/shared/model-pricing.js`; nothing under `lambda/` calls Cost Explorer or CUR                    |

The space is a genuine tenant boundary: spaces carry `owner`/`admin`/`member` roles enforced in Neptune traversals, a space is invisible without membership, and platform-wide administration is a separate Cognito group (`lambda/shared/authz.js` — `PLATFORM_ADMIN_GROUP`).

### The requirement

Separate teams share one installation. Bedrock capacity for the agentic coding CLIs is consumed from **one central Bedrock account**, which may be the same account the platform is deployed into **or** a different one — customers deploy this into their own environments, so both must work. Each team additionally has its own application account(s), which are **deployment targets only and are not in the inference path**. A globally defined Bedrock integration must exist, and a space must be able to override it.

### Explicitly out of scope

Cost-allocation-tag activation, AWS Budgets, per-space role minting, per-space model allowlists, a CUR export, and an in-product billed-cost view. Tag-based showback performed by the customer in their own account is sufficient. Role ownership remains the customer's decision. This release provides no in-place external-ID rotation operation; ordinary saves preserve the platform-generated value.

### Why not application inference profiles

An application inference profile wraps **one specific model**, so the profile count is spaces × models × versions. AWS's own guidance warns that "profile count can increase quickly, especially when new model versions require new profiles" and steers users toward Projects, which this platform cannot reach because the CLIs call `bedrock-runtime`. Decisively: Claude Code invokes opus, sonnet and haiku within a single stage without being asked, so any per-model construct is a treadmill. AWS documentation also contradicts itself on whether an application inference profile works with `InvokeModelWithResponseStream` and Chat Completions, and 19 of 23 observed calls in this deployment were streaming. Principal-based attribution makes that contradiction irrelevant.

## 2. Decision

Add an **IAM role mode** to the existing `bedrock` credential provider. Nothing else.

"Central default plus per-space override" uses the existing scopes but is mode-aware: the nearest supported Bedrock role (`space → platform`) is authoritative, while bearer-only Bedrock and Kiro retain `user → space → platform`. A space role overrides a platform role; a space bearer key does not. Covered bearer keys remain encrypted for rollback instead of silently overriding IAM. No new plane, page or hierarchy is introduced.

Six decisions follow:

1. **The broker performs the `AssumeRole`, not the container.** The broker is already the sole reader of credential material and already validates a signed grant against the execution record, so it is already the trusted resolver. It resolves a role ARN into temporary credentials instead of a path into a token.
2. **The value stays in the existing single SSM parameter.** Either today's plain bearer string, or JSON `{"roleArn": "...", "externalId": "..."}`. Every existing value is a plain string and remains a bearer token, so this is backwards compatible by construction — no new parameter path, no new IAM path pattern, no new hierarchy scope. `isConfiguredCredentialValue` (non-empty, not `placeholder`) is unchanged.
3. **Same-account and cross-account are one code path.** The only difference is the customer-written trust policy.
4. **Attribution v1 is `RoleSessionName` only.** No session tags.
5. **The role's own permissions keep the proven provider-family grant** — invoke-only, geo-scoped inference profiles, region-wildcarded foundation-model ARNs fenced by `StringLike` on `bedrock:InferenceProfileArn`. No narrower allowlist.
6. **Supported Codex versions use Bedrock Runtime, not Mantle.** Codex >= 0.149.1 (0.153.4 pinned) uses `model_provider="amazon-bedrock-runtime"` and signs requests to the Bedrock Runtime OpenAI-compatible endpoint. The grant includes `bedrock:InvokeModel` on `project/default`; no `bedrock-mantle` action or resource is required or emitted. GPT-5.6 is available only through a `global.openai.*` CRIS profile, so whether Codex is enabled is an administrator data-residency decision.

### Why `RoleSessionName` and not session tags

Passing session tags requires `sts:TagSession` in the target role's trust policy. Since customers write that policy, unconditional session tags would fail closed on every role that omits the permission. `RoleSessionName` requires nothing, needs no activation, and lands in CloudTrail and model invocation logs. Removing tags removes a failure mode rather than losing a capability. A customer who wants dollars per space activates IAM-principal cost allocation tags and a CUR 2.0 caller-identity export **in their own account, on their own schedule**, with no platform involvement.

### Architecture

| Account                   | Role in this design                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Platform account          | AgentCore, Lambdas, Neptune, the broker                                                                             |
| Central Bedrock account   | Bedrock inference role(s), model access, guardrails, quotas. **The bill.** May be the same account as the platform. |
| Team application accounts | Not in the inference path. Deployment targets only.                                                                 |

Per-stage identity flow:

1. The stage dispatch resolves the space's `bedrock` binding **server-side** from the verified `projectId`. The container never names its own role ARN — that single rule is what prevents a compromised agent in space A invoking and billing as space B.
2. The broker calls `sts:AssumeRole` with `RoleSessionName = aidlc-<projectId>`, the binding's `ExternalId`, and `DurationSeconds = 3600`.
3. The initial role result establishes the credential kind, then AgentCore discards its static STS values before the CLI starts. The selected top-level CLI receives only `AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN`; its AWS SDK polls the loopback provider for one-hour sessions throughout the active stage.

Consequences of broker-side assumption:

- **The AgentCore execution role needs zero IAM changes** — no `bedrock:InvokeModel`, no `sts:AssumeRole`. The selected CLI receives only invocation-scoped access to the loopback provider; all MCP children are denied that endpoint and token. This is materially stronger than fork PR #1, which put the Bedrock grant on the container's own role.
- **The trust policy names one principal** — the broker role — so a customer allowlists a single ARN.
- The container already invokes the broker on every invocation (`invokeCredentialBroker` in `lambda/agentcore/clients.js`), so **no new IAM on the AgentCore role is required for refresh either**.

Trust policy, same account. The default `StringLike` condition admits every project and the `aidlc-preflight` probe used for a platform-scope binding; operators can instead render `StringEquals` entries for a closed set of project IDs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<platform-account>:role/collaborative-ai-dlc-credential-broker-<env>"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringLike": {
          "sts:RoleSessionName": "aidlc-*"
        }
      }
    }
  ]
}
```

Trust policy, cross account — the external ID is **mandatory** here, per the confused-deputy guidance, and the session-name condition remains mandatory:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<platform-account>:role/collaborative-ai-dlc-credential-broker-<env>"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringLike": {
          "sts:RoleSessionName": "aidlc-*"
        },
        "StringEquals": {
          "sts:ExternalId": "<platform-generated-value>"
        }
      }
    }
  ]
}
```

### The `sts:AssumeRole` resource problem

The broker cannot know every customer role ARN at deploy time, so its `sts:AssumeRole` policy uses the configurable `bedrock_assumable_role_arns` resource list. The default is `["arn:aws:iam::*:role/aidlc-bedrock-*"]`; operators may enumerate stricter ARNs, while a deliberate `["*"]` override remains documented for deployments that cannot adopt the naming convention. The target role's trust policy remains the final authorization boundary.

## 3. Credential-refresh decision

This section supersedes the earlier proposal to ship one static 3600-second role session per stage, classify expiry after the CLI exited, and rely on whole-stage retry. No automatic whole-stage retry exists, and replay could duplicate side effects. It also supersedes the proposed helper binary, `awsCredentialExport`, `credential_process`, and per-stage AWS configuration files. The accepted design is the bounded loopback container-credentials provider below.

### 3.0 Why refresh is needed at all

An intent is **many** credentials, not one. `run-stage-start` dispatches the CLI as a detached background job and returns in milliseconds; the orchestrator then suspends on a durable callback at zero compute. Auth is resolved per invocation. So intent duration is irrelevant — the unit at risk is the longest **single stage attempt**, and the platform permits 8 hours for one (`lambda/v2-orchestrator/index.js:1545` — `STAGE_CALLBACK_TIMEOUT = { hours: 8 }`).

Two verified facts made naive re-minting impossible through the original one-shot path:

- `AGENT_CREDENTIAL_GRANT_TTL_SECONDS = 300` (`lambda/shared/agent-credential-grants.js:8`), enforced at **both** signing and verification (`claims.expiresAt - claims.issuedAt > AGENT_CREDENTIAL_GRANT_TTL_SECONDS`).
- The grant is deleted from the handler payload before the handler runs (`http-server.js:107`).

That remains a deliberate one-shot authorization for ordinary invocation grants: resolve the credential, then destroy the means to resolve it again. Refresh therefore uses a separate, narrower grant class rather than extending the invocation grant.

### 3.1 The audience-separated refresh grant

The implementation uses a dedicated grant envelope, not another invocation-grant purpose.
`BEDROCK_ROLE_REFRESH_GRANT_AUDIENCE` is distinct from
`AGENT_CREDENTIAL_GRANT_AUDIENCE`, so neither verifier accepts the other grant class. Existing
invocation grants keep their 300-second ceiling; refresh grants are capped at eight hours, matching
`STAGE_CALLBACK_TIMEOUT`.

A refresh grant is role-only and binds all of the following: `executionId`, `projectId`,
`stageInstanceId`, callback token, effective binding source, and `kind=role`. It has no fixed
redemption counter, because a legitimate eight-hour stage can need roughly nine one-hour sessions.
The broker instead revalidates active execution state and the current binding on every redemption.

The orchestrator mints the grant only for a role-mode stage and sends it in the trusted
`run-stage-start` payload. AgentCore consumes and deletes that payload field while registering an
invocation-specific loopback route. The grant stays in the server-side registration; it is never
placed in the CLI environment, argv, a config file, or `/mnt/workspace`. The CLI receives only the
opaque provider URL and authorization token. This adds bounded duration to the existing authority,
not broader scope.

### 3.2 The broker redemption check

Use a **distinct broker action**, `refresh-bedrock-role-credentials`, separate from `resolve-agent-credentials`. The existing action returns secret values; this one returns STS credentials. Conflating them is how a refresh caller would accidentally receive a bearer token.

Redemption sequence, in order, with broker-boundary failures reduced to allowlisted codes and no provider-derived text. Those broker codes are for internal audit and tests; the loopback endpoint deliberately does not expose them to the CLI:

1. `verifyIssuedBedrockRoleRefreshGrant` — signature, version, distinct refresh audience, expiry, clock skew and eight-hour TTL ceiling.
2. Reject a missing project, execution, stage, callback, binding source, or `kind=role` claim before any credential lookup.
3. Read `executionMetaKey(executionId)` consistently from `V2_PROCESS_TABLE`. Reject if absent, if `execution.projectId !== claims.projectId`, if the stage/callback no longer matches, or if `!CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(execution.status)`. Parking, failing, completing or cancelling the execution makes every outstanding refresh grant inert on the next request.
4. Re-resolve the binding **server-side** from `claims.projectId`, reading SSM now rather than trusting anything in the grant. A space that changes its role takes effect on the next refresh. The platform-generated external ID remains stable across ordinary saves; this release provides no in-place rotation operation.
5. Reject with `BEDROCK_ROLE_BINDING_CHANGED` if the freshly-read binding is no longer role mode. The loopback provider surfaces only a sanitized failure and never continues on stale credentials.
6. Re-read and validate the mandatory session-policy ceiling, then call `AssumeRole`: `RoleSessionName = aidlc-<projectId>` (≤64 chars, `[\w+=,.@-]`), `ExternalId` from the binding, `DurationSeconds = 3600`. Missing, malformed or over-broad ceiling configuration fails before STS.
7. Return only `{ AccessKeyId, SecretAccessKey, SessionToken, Expiration }`.
8. Extend `loggableAgentCredentialErrorCode` with the new codes, preserving the existing allowlist discipline.
9. Audit at INFO on success: `{ grantId, executionId, projectId, stageInstanceId }`. `grantId` makes a refresh chain traceable in CloudWatch and an anomalous redemption rate visible.

**Deliberately omitted: a redemption counter.** An 8-hour stage refreshing at ~55-minute intervals redeems roughly nine times. A hard cap would need a DynamoDB counter and a write per refresh, while grant expiry, active-stage validation, binding re-resolution, and endpoint revocation already bound exposure in time and validity.

Credential safety, restated as requirements:

- STS credentials are never persisted or placed in a child-process environment; the loopback provider serializes them directly to the SDK and scrubs mutable references.
- The refresh grant remains server-side, while the selected CLI receives only the opaque provider URL and token.
- Never written to `/mnt/workspace`.
- Never logged; redaction fixtures cover the session token, secret key, endpoint token, and refresh grant.
- The **role ARN is not a secret** and should be echoed back to the UI. The **external ID is not a secret either** — AWS says so in terms: "AWS does not treat the external ID as a secret … The external ID for a role can be seen by anyone with permission to view the role." Store it as `SecureString` (encryption at rest is free) but return it to any principal that may modify the binding, idempotently rather than once, because an operator has to paste it into a trust policy and must be able to re-read it to reconcile or recover. Both values are nonetheless tenant-identifying, so neither belongs on the lower-privilege agent settings read that any authenticated user can call; that surface keeps the "set / not set" shape. The bearer token and Kiro key remain genuine secrets and are never returned at any scope.

### 3.3 The loopback container-credentials contract

AgentCore runs a separate HTTP server bound only to `127.0.0.1`. Every role-mode stage registration
gets an unguessable path and authorization token. The selected top-level CLI receives:

- `AWS_CONTAINER_CREDENTIALS_FULL_URI` pointing to that invocation-specific route; and
- `AWS_CONTAINER_AUTHORIZATION_TOKEN` carrying the matching bearer token.

Each authenticated `GET` redeems the server-held refresh grant and returns the AWS container
credential shape: `AccessKeyId`, `SecretAccessKey`, `Token`, and `Expiration`, with `no-store` and
`no-cache` headers. The provider caches no STS material. Missing or wrong authorization returns 401,
a revoked or unknown route returns 404, and sanitized broker failures return 503.

The route and token are removed when the stage completes, fails, or is cancelled. Static
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` values obtained during initial
resolution are deleted before the CLI starts. Reserved and custom MCP children receive neither those
values nor the loopback route/token. The trusted `aidlc` bridge receives only the separate AgentCore
execution-role identity needed for DynamoDB and Neptune; that role is asserted to have no Bedrock or
STS permission. No helper binary, `credential_process`, `awsCredentialExport`, `AWS_PROFILE`, or
per-stage AWS config file is part of the final design.

### 3.4 Trust boundaries and operational limits

The refresh path does not give the container or CLI `sts:AssumeRole`. Its trust boundaries are:

- The orchestrator may mint a refresh grant only for the effective server-resolved Bedrock role binding and one exact execution, project, stage attempt, callback, and binding source. The distinct audience prevents an invocation grant from being used for refresh or a refresh grant from resolving a bearer secret.
- The credential broker remains the only principal that may call `sts:AssumeRole`. On every redemption it consistently re-reads execution and stage state, re-resolves the current binding from the project, validates that the binding still matches the grant, and revalidates the mandatory session-policy ceiling before contacting STS.
- AgentCore stores the refresh grant only in the in-memory route registration. The top-level CLI sees an opaque loopback URL and bearer token, not the grant, role ARN, external ID, or STS values. Reserved and custom MCP children see none of the refresh authority. The AgentCore execution role has neither Bedrock inference nor `sts:AssumeRole` permission.
- The provider binds a separate server to `127.0.0.1`, uses an unguessable route and token per invocation, accepts only authenticated `GET` requests, and rechecks that the registration is still active after an in-flight broker call before releasing credentials.

Its operational limits are explicit:

- Role chaining still limits each STS session to 3600 seconds. Refresh makes that a session lifetime rather than a stage lifetime; it does not increase `DurationSeconds`.
- Grant expiry is the stage callback deadline, capped at eight hours. There is no renewal after that absolute deadline and no fixed redemption counter; the absolute deadline, exact active-stage check, current-binding check, mandatory ceiling, and endpoint lifecycle are the bounds.
- The route is revoked and its in-memory grant/token references are cleared when the detached stage job settles, before its job slot is released. Completing, failing, cancelling, parking, or otherwise leaving the exact active stage also makes broker redemption fail closed.
- A gate or user-answer wait stores no STS credential, refresh grant, provider URL, or endpoint token. The next active stage receives a newly resolved binding and newly minted authority.
- A broker failure becomes a sanitized, retryable HTTP 503 body (`credential refresh unavailable`) at the loopback boundary. The endpoint does not propagate the broker's typed code, and refresh mode clears the initial `credentialExpiresAt`; if the SDK exhausts its retries and the CLI exits, current stage reconciliation normally records `cli_nonzero_exit`, not `credential_expired` or `credential_resolution_failed`. No path automatically replays the stage.

### 3.5 Resolved integration constraint: capabilities

`lambda/agentcore/commands/capabilities.js` originally equated Bedrock authentication with `AWS_BEARER_TOKEN_BEDROCK`, which would have gated out all three role-enabled CLIs. The implementation instead derives availability from the providers resolved for the invocation, independent of bearer-token or static-credential presence.

### 3.6 Resolved integration constraint: configured-state UI

The original settings UI derived "configured", the provider count, and the platform-fallback hint only from secret-presence booleans. A role binding is a non-secret ARN, so that contract would have rendered IAM mode as unconfigured. The final UI and read contract are mode-aware: `bedrockBearerTokenSet` retains its bearer-only meaning, while separate effective-mode and role-status fields represent IAM configuration without overloading the existing boolean contract.

## 4. Probe results

Three probes were run on 2026-09-06 against a development account in `eu-central-1`.

### 4.1 Probe 1 — the role-chaining cap is real and the boundary is exactly 3600

`AssumeRole` called with assumed-role credentials is role chaining. A throwaway, permission-less role with `MaxSessionDuration=43200` was created, called from an assumed-role principal, then deleted.

```
DurationSeconds=3600   → 2026-09-06T03:11:23+00:00   (success, exactly +1h)
DurationSeconds=3601   → ValidationError: The requested DurationSeconds exceeds
DurationSeconds=7200   →   the 1 hour session limit for roles assumed by role chaining.
DurationSeconds=43200  → (same)
```

The role permitted 12 hours, so the role was never the limiter — the caller's credential type was. **There is no middle ground to negotiate:** 3600 works, 3601 does not. Both the broker Lambda role and the AgentCore execution role are assumed roles, so this applies wherever the assume is performed. Verified by execution, not inference.

### 4.2 Probe 2 — all three CLIs support the SDK container provider

The original artifact probe established that each CLI uses an AWS SDK credential chain. The final
implementation uses the chain's standard container-provider inputs rather than a custom helper or
per-CLI config file:

| CLI                     | Final role-mode wiring                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code 2.1.246** | Receives the invocation-specific full URI and token; the Bedrock SDK refreshes through the loopback provider                                 |
| **OpenCode 1.17.20**    | Receives the same pair; its AWS SDK provider chain refreshes through the loopback provider                                                   |
| **Codex 0.153.4**       | Receives the same pair; `amazon-bedrock-runtime` signs for service `bedrock` and completes role-mode stages with `global.openai.gpt-5.6-sol` |

Driver and active-stage tests pin identical delivery for all three CLIs, repeated refresh across
multiple expirations, endpoint revocation, and exclusion from every MCP child. No CLI-specific
credential adapter remains.

### 4.3 Probe 3 — 30 days was already the entire record

The runtime log group has no retention limit, but its `creationTime` is ≈2026-08-10, about 27 days before the probe. A 90-day query therefore returns the same data as a 30-day query; there is no deeper history to widen to. Stage duration was derived from the background job's heartbeat log, which beats every 60 s and logs every 5th beat.

```
214 stages with ≥5 heartbeats
p50  5 beats (~5 min)
p90 10 beats (~10 min)
p99 20 beats (~20 min)
max 30 beats (~30–34 min)   ← one stage, code-generation
tail ≥15 beats: 15 stages — 14 code-generation, 1 build-and-test
```

The worst observed stage consumed **~50–58 % of a 3600 s credential**. That rests on a single outlier in a 27-day sample, against a platform ceiling of 8 hours. Enough to ship on; not enough to design on.

## 5. Expiry options A / B / C

|       | Mechanism                                                                                                 | Verdict                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **A** | Token-protected loopback AWS container-credentials provider backed by an audience-separated refresh grant | **Selected and implemented.** Refreshes inside one active CLI process without replay        |
| **B** | Let the one-hour credential expire and replay the entire stage with newly resolved credentials            | **Rejected.** No automatic whole-stage retry exists, and replay can duplicate side effects  |
| **C** | `AssumeRoleWithWebIdentity` to avoid the role-chaining cap                                                | **Not built.** It would require customer OIDC-provider setup and a different trust contract |

A is the final design. The hard 3600-second STS chaining limit remains, but it is a session limit,
not a stage limit: the CLI obtains successive sessions through the same invocation-scoped provider.
A refresh failure is sanitized to a retryable HTTP 503 for the SDK. If the SDK exhausts its
retries and the CLI exits, stage reconciliation normally records `cli_nonzero_exit`; it does not
currently preserve the broker's typed refresh code. It never triggers automatic whole-stage replay.

## 6. Change inventory

| File                                        | Change                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `lambda/shared/agent-credentials.js`        | Parse bearer-or-role bindings and scrub static STS variables from every invocation base environment                                   |
| `lambda/shared/agent-credential-grants.js`  | Add a distinct refresh audience, eight-hour ceiling, and role-only stage-bound claims                                                 |
| `lambda/credential-broker/index.js`         | Revalidate execution, binding, and mandatory ceiling for `refresh-bedrock-role-credentials` before each `AssumeRole`                  |
| `lambda/agentcore/http-server.js`           | Host the loopback provider, register/revoke per-invocation routes, and scrub returned STS material                                    |
| `lambda/agentcore/cli/drivers.js`           | Forward only the provider full URI and authorization token to the selected top-level Bedrock CLI                                      |
| `lambda/agentcore/stage-materializer.js`    | Deny static Bedrock credentials and refresh authority to all MCP children; restore only execution-role identity to the trusted bridge |
| `lambda/agentcore/commands/capabilities.js` | Derive availability from resolved binding state rather than bearer-token presence                                                     |
| `lambda/agents/index.js` and credential UI  | Expose and configure mode-aware role status without exposing secrets                                                                  |
| Terraform                                   | Grant broker-only `sts:AssumeRole`, render the mandatory session ceiling and trust documents, and emit Runtime-only model permissions |
| —                                           | **No Bedrock or STS permission on the AgentCore execution role. No helper binary or per-stage AWS credential file.**                  |

## 7. Well-Architected alignment

**Security — the strongest gain.** Replacing a long-lived shared bearer token with short-lived STS credentials is SEC02's "use temporary credentials". Least privilege is served twice: the invoke-only, family-scoped, condition-fenced grant, and a container that holds no assume capability at all. The external ID addresses the confused-deputy problem. Blast radius is bounded by resolving the binding server-side from the broker's verified claim. _Tradeoffs:_ a new cross-account trust relationship; an operator-managed, tenant-identifying external ID (stored as `SecureString`, but not treated by AWS as a secret); and broker `sts:AssumeRole` access to the configured role-name/ARN allowlist, mitigated as described in §2.

**Cost Optimization.** COST03 is met at the mechanism level: identity reaches Bedrock as `RoleSessionName=aidlc-<projectId>`, so CloudTrail and invocation logs carry the tenant boundary from day one, and the customer opts into dollars on their own schedule. _Tradeoff:_ native attribution delivers aggregated dollars per usage type per day, never a per-request row, so per-intent cost remains app-computed.

**Operational Excellence.** A role ARN is non-secret, auditable in CloudTrail and diffable in IaC, unlike a rotating opaque token. Model access, guardrails and quotas consolidate in one account. _Tradeoffs:_ a new cross-account dependency; drift risk between the platform's binding and the role's real state — which argues for a bind-time "test this binding" preflight (a bare `AssumeRole`, no invoke) so misconfiguration surfaces at save time rather than mid-stage.

**Reliability.** The refresh path converts one-hour STS expiry from a stage boundary into a renewable SDK credential source. A failed refresh still fails closed, but the current loopback boundary exposes only a sanitized 503 and stage reconciliation normally records a generic CLI failure rather than the broker's typed reason. The central account remains a shared failure domain: **Bedrock quotas are per account, per model, per region**, so one team's runaway intent can throttle every other team. Per-space roles would not have fixed this. What does, and what this design enables at no extra cost: a space can override with a role in its own account, which carries its own quota. The override is the noisy-neighbour escape hatch.

## 8. Consequences

**Positive.** No long-lived Bedrock secret in the default path. Zero IAM change to the AgentCore execution role. Same-account and cross-account on one code path. No per-tenant provisioning. Model-churn-proof. Backwards compatible: existing bearer bindings keep working, role mode is opt-in per scope, no migration. Kiro is unaffected (its own namespace and `KIRO_API_KEY`).

**Negative.** A new expiry failure mode. A longer-lived reusable authorization inside the container (duration, not scope). A new cross-account trust relationship and external ID to operate. `sts:AssumeRole` with a wide default resource. Two cost numbers will coexist and will **not** match — the in-app Price List estimate and any CUR-derived figure diverge structurally (cache-read/write token pricing, cross-region routing, streaming accounting, cache staleness, savings plans), so the in-app figure must be relabelled as an estimate.

**Neutral.** Showback needs no platform UI in v1: the platform's only job is to emit correct identity, so there is no new API, no new authorization surface, and no cross-tenant leak to defend. Cost-allocation tags are not retroactive, so a customer's per-space series begins when they activate it.

## 9. Open decisions

The refresh-delivery mechanism is no longer open: the loopback container provider, eight-hour grant
ceiling, no fixed redemption counter, bind-time preflight, and path-scoped assumable-role default are
implemented. Remaining operator choices are policy choices rather than product gaps: narrow the role
allowlist further if desired, decide whether global CRIS routing meets data-residency requirements,
and decide whether to enable account-wide Bedrock invocation logging.

## 10. Verification plan

Nothing here may be claimed without evidence:

1. **Container-provider delivery** — all three Bedrock drivers receive only the invocation-specific
   full URI and authorization token; no static STS variables reach the CLI.
2. **Refresh across expiry** — one active stage crosses multiple credential expirations without
   restarting the CLI or replaying the stage.
3. **Negative controls** — wrong token, revoked route, expired or cross-audience grant, project/stage
   mismatch, inactive execution, changed binding, and missing or invalid session ceiling all fail closed;
   broker failures are reduced to the generic loopback 503 and are never documented as typed stage outcomes.
4. **MCP isolation** — neither reserved nor custom MCP children receive the selected Bedrock
   credential or refresh authority; the trusted bridge's execution role remains Bedrock-inert.
5. **Gate resume** — no temporary credential, endpoint token, URL, or refresh grant is durable while
   waiting, and the next stage receives fresh authority.
6. **Redaction** — session token, secret key, endpoint token, and refresh grant are absent from logs
   and `/mnt/workspace`.
7. **Codex Runtime** — pinned Codex uses `amazon-bedrock-runtime`, `global.openai.*`, and the
   `project/default` grant, with no Mantle permission.
8. **Attribution** — `aidlc-<projectId>` reaches CloudTrail and model-invocation records.

## 11. References

- [Track usage and costs in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html) — mechanism comparison and the "attribution behind an LLM gateway" pattern
- [IAM principal attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html) — `RoleSessionName`, session tags, CUR 2.0 caller-identity export
- [Application inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) · [Best practices for cost attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-best-practices.html)
- [Role chaining one-hour limit](https://repost.aws/knowledge-center/iam-role-chaining-limit) · [Passing session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [Access to AWS accounts owned by third parties (external ID)](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) · [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [Activating user-defined cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html) — for the customer runbook, not for the platform to run
- [Well-Architected Security Pillar SEC02](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_unique.html) · [Cost Optimization COST03](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/cost-effective-resources.html)
