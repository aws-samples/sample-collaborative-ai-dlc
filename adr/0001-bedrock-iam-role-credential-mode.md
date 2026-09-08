# ADR-0001 — IAM role (STS) as a Bedrock credential mode

|                 |                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Proposed — **§3, §5 and §6 are partially superseded** by [the spec](../specs/bedrock-iam-role-credential-mode/design.md): v1 ships no refresh grant, no broker refresh action and no credential-helper binary. This ADR remains the record of why those alternatives were considered. |
| **Date**        | 2026-09-06                                                                                                                                                                                                                                                                            |
| **Base commit** | `8e67ac5` (upstream `main`) — every `file:line` citation below is valid at this commit                                                                                                                                                                                                |
| **Supersedes**  | The `bedrock-auth-method` global SSM selector shipped in fork PR #1 (deleted, not replaced)                                                                                                                                                                                           |
| **Scope**       | `lambda/shared`, `lambda/credential-broker`, `lambda/agentcore`, `lambda/agents`, one Terraform IAM statement, one frontend card                                                                                                                                                      |

## 1. Context

### What ships today

Upstream #405 replaced the deployment-wide Bedrock secret with a three-scope credential hierarchy:

| Fact                                                                                                                                                        | Evidence                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Precedence is `user → space → platform`, first configured wins per provider                                                                                 | `lambda/shared/agent-credentials.js:9` (`AGENT_CREDENTIAL_SOURCES`), `resolveEffectiveCredentialBindings` |
| A provider is one table row: SSM parameter name, input field, "set" field, env var                                                                          | `lambda/shared/agent-credentials.js:22` (`PROVIDER_CONFIG`)                                               |
| A **credential broker** is the sole IAM principal permitted to read credential material; API Lambdas deliberately have no `ssm:GetParameter` on those paths | `lambda/credential-broker/`, `aws_iam_role.credential_broker` in `terraform/modules/api/lambda/main.tf`   |
| The broker validates a signed, short-lived grant and rejects a `projectId` that does not match the execution record                                         | `authorizeAgentCredentialRequest`, `verifyIssuedAgentCredentialGrant`                                     |
| Auth is resolved **per invocation**; the base environment is scrubbed of credential variables each time                                                     | `lambda/agentcore/auth-resolver.js` header, `cleanBaseEnv`, assignment at `:196`                          |
| The grant is destroyed before the command handler runs                                                                                                      | `lambda/agentcore/http-server.js:107` — `delete handlerPayload.agentCredentialGrant`                      |
| Each Bedrock CLI copies the bearer token into its own environment if present                                                                                | `lambda/agentcore/cli/drivers.js:69` (claude), `:156` (opencode), `:227` (codex)                          |
| Cost shown in-product is **not billing data** — it is token counts × Price List prices cached in SSM                                                        | `lambda/shared/model-pricing.js`; nothing under `lambda/` calls Cost Explorer or CUR                      |

The space is a genuine tenant boundary: spaces carry `owner`/`admin`/`member` roles enforced in Neptune traversals, a space is invisible without membership, and platform-wide administration is a separate Cognito group (`lambda/shared/authz.js` — `PLATFORM_ADMIN_GROUP`).

### The requirement

Separate teams share one installation. Bedrock capacity for the agentic coding CLIs is consumed from **one central Bedrock account**, which may be the same account the platform is deployed into **or** a different one — customers deploy this into their own environments, so both must work. Each team additionally has its own application account(s), which are **deployment targets only and are not in the inference path**. A globally defined Bedrock integration must exist, and a space must be able to override it.

### Explicitly out of scope

Cost-allocation-tag activation, AWS Budgets, per-space role minting, per-space model allowlists, a CUR export, and an in-product billed-cost view. Tag-based showback performed by the customer in their own account is sufficient. Role ownership and external-ID rotation depend on the customer's organisation and are not the platform's decision.

### Why not application inference profiles

An application inference profile wraps **one specific model**, so the profile count is spaces × models × versions. AWS's own guidance warns that "profile count can increase quickly, especially when new model versions require new profiles" and steers users toward Projects, which this platform cannot reach because the CLIs call `bedrock-runtime`. Decisively: Claude Code invokes opus, sonnet and haiku within a single stage without being asked, so any per-model construct is a treadmill. AWS documentation also contradicts itself on whether an application inference profile works with `InvokeModelWithResponseStream` and Chat Completions, and 19 of 23 observed calls in this deployment were streaming. Principal-based attribution makes that contradiction irrelevant.

## 2. Decision

Add an **IAM role mode** to the existing `bedrock` credential provider. Nothing else.

"Central default plus per-space override" is the existing `platform → space` precedence; no new plane, page or hierarchy is introduced. The feature is a second mode in the two credential cards that already exist.

Five decisions follow:

1. **The broker performs the `AssumeRole`, not the container.** The broker is already the sole reader of credential material and already validates a signed grant against the execution record, so it is already the trusted resolver. It resolves a role ARN into temporary credentials instead of a path into a token.
2. **The value stays in the existing single SSM parameter.** Either today's plain bearer string, or JSON `{"roleArn": "...", "externalId": "..."}`. Every existing value is a plain string and remains a bearer token, so this is backwards compatible by construction — no new parameter path, no new IAM path pattern, no new hierarchy scope. `isConfiguredCredentialValue` (non-empty, not `placeholder`) is unchanged.
3. **Same-account and cross-account are one code path.** The only difference is the customer-written trust policy.
4. **Attribution v1 is `RoleSessionName` only.** No session tags.
5. **The role's own permissions keep the proven provider-family grant** — invoke-only, geo-scoped inference profiles, region-wildcarded foundation-model ARNs fenced by `StringLike` on `bedrock:InferenceProfileArn`. No narrower allowlist.

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
2. The broker calls `sts:AssumeRole` with `RoleSessionName = aidlc-<spaceId>`, the binding's `ExternalId`, and `DurationSeconds = 3600`.
3. Credentials enter the CLI environment through the existing `envForAuth` seam and are cached for the session lifetime — which is exactly what AWS prescribes for a gateway.

Consequences of broker-side assumption:

- **The AgentCore execution role needs zero IAM changes** — no `bedrock:InvokeModel`, no `sts:AssumeRole`. The container cannot assume anything; it receives credentials exactly as it receives a bearer token today. This is materially stronger than fork PR #1, which put the Bedrock grant on the container's own role.
- **The trust policy names one principal** — the broker role — so a customer allowlists a single ARN.
- The container already invokes the broker on every invocation (`invokeCredentialBroker` in `lambda/agentcore/clients.js`), so **no new IAM on the AgentCore role is required for refresh either**.

Trust policy, same account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<platform-account>:role/collaborative-ai-dlc-credential-broker-<env>"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Trust policy, cross account — the external ID is **mandatory** here, per the confused-deputy guidance:

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
      "Condition": { "StringEquals": { "sts:ExternalId": "<platform-generated-value>" } }
    }
  ]
}
```

### The `sts:AssumeRole` resource problem

The broker cannot know customer role ARNs at deploy time, so its policy needs `Resource: "*"` for `sts:AssumeRole`. A reviewer will flag this, so state it plainly: **the effective control is the target roles' trust policies** — the broker can only assume a role that explicitly names it, and those policies are owned by the customer, not the platform. To let an operator narrow it anyway, expose a Terraform variable `bedrock_assumable_role_arns` (default `["*"]`) that becomes the statement's `Resource`. Operators who know their ARNs get least privilege; nobody is blocked by not knowing them.

## 3. Fix A — the credential-refresh design

### 3.0 Why refresh is needed at all

An intent is **many** credentials, not one. `run-stage-start` dispatches the CLI as a detached background job and returns in milliseconds; the orchestrator then suspends on a durable callback at zero compute. Auth is resolved per invocation. So intent duration is irrelevant — the unit at risk is the longest **single stage attempt**, and the platform permits 8 hours for one (`lambda/v2-orchestrator/index.js:1545` — `STAGE_CALLBACK_TIMEOUT = { hours: 8 }`).

Two verified facts make naive re-minting impossible today:

- `AGENT_CREDENTIAL_GRANT_TTL_SECONDS = 300` (`lambda/shared/agent-credential-grants.js:8`), enforced at **both** signing and verification (`claims.expiresAt - claims.issuedAt > AGENT_CREDENTIAL_GRANT_TTL_SECONDS`).
- The grant is deleted from the handler payload before the handler runs (`http-server.js:107`).

That is a deliberate one-shot authorization: resolve the secret, then destroy the means to resolve it again.

### 3.1 The refresh-scoped grant claim

Add a **second purpose namespace** rather than a new auth mode. `purpose` is currently drawn from `AGENT_AUTH_MODES`, and `auth-resolver.js` asserts `brokerResult.purpose !== authMode`; a refresh purpose is not an invocation auth mode and must not be usable as one.

```js
// lambda/shared/agent-credential-grants.js
export const BEDROCK_ROLE_REFRESH_PURPOSE = 'bedrock-role-refresh';
export const AGENT_CREDENTIAL_GRANT_PURPOSES = Object.freeze([
  ...Object.values(AGENT_AUTH_MODES),
  BEDROCK_ROLE_REFRESH_PURPOSE,
]);

export const AGENT_CREDENTIAL_GRANT_TTL_SECONDS = 300; // unchanged
export const BEDROCK_ROLE_REFRESH_TTL_SECONDS = 8 * 60 * 60; // == STAGE_CALLBACK_TIMEOUT

const ttlCeilingFor = (purpose) =>
  purpose === BEDROCK_ROLE_REFRESH_PURPOSE
    ? BEDROCK_ROLE_REFRESH_TTL_SECONDS
    : AGENT_CREDENTIAL_GRANT_TTL_SECONDS;
```

Both the sign-time guard and the verify-time guard consult `ttlCeilingFor(purpose)`. Every existing grant class keeps its 300-second ceiling by construction, so no current grant becomes weaker. The refresh ceiling equals the stage-callback timeout deliberately: a grant that outlives the longest legitimate stage is dead authorization.

Additional constraints enforced in `normalizedClaims` when `purpose === BEDROCK_ROLE_REFRESH_PURPOSE`:

| Constraint                                                           | Rationale                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionId` **required** (nullable today)                          | There is no execution to re-validate without it                                                                                                                                                                                       |
| `projectId` **required**                                             | The tenant boundary and the server-side binding lookup key                                                                                                                                                                            |
| `stageInstanceId` **required** (new claim field)                     | Pins the grant to one stage attempt, so it dies with the attempt rather than living for the whole execution                                                                                                                           |
| Exactly **one** binding, `provider === 'bedrock'`, `mode === 'role'` | **The most important constraint.** A refresh grant must never be redeemable for a bearer token: a bearer token needs no refresh, and a long-lived grant redeemable for a long-lived secret is a strict downgrade of the current model |

Everything else — HMAC-SHA256 over base64url claims, `version`/`audience` pinning, `timingSafeEqual`, 8 KiB token cap, 30-second clock skew, the secret loaded from SSM with a 32-byte minimum — is reused unchanged.

**Where it is minted:** by the orchestrator, alongside the existing invocation grant, and only when the resolved `bedrock` binding is role mode.

**Where it travels:** `http-server.js:305` wires `handlers.runStageStart = (p, context) => createRunStageStart({ runStage: (q) => handlers.runStage(q, context) })(p)`. The resolved auth `context` is closed over and reaches the detached job. So the refresh grant rides in `context`, exactly like the resolved environment does today — **not** in the handler payload, which keeps the `http-server.js:107` discipline intact. No new plumbing.

**How the helper reads it:** as an environment variable (`AIDLC_BEDROCK_REFRESH_GRANT`) in the CLI process environment, inherited by the `credential_process` child. Never an argv (visible in `/proc`), and never a file on `/mnt/workspace`, which **persists across containers** and would let material outlive the session that earned it.

The honest characterisation of what this costs: a longer-lived reusable authorization now exists inside the container. It is not a credential; it yields exactly the credentials that process already holds, for the same space, and it goes inert when the execution leaves an active state. **It adds duration, not scope.**

### 3.2 The broker redemption check

Use a **distinct broker action**, `refresh-bedrock-role-credentials`, separate from `resolve-agent-credentials`. The existing action returns secret values; this one returns STS credentials. Conflating them is how a refresh caller would accidentally receive a bearer token.

Redemption sequence, in order, all failures returning an allowlisted code and no provider-derived text:

1. `verifyIssuedAgentCredentialGrant` — signature, version, audience, purpose, TTL ceiling, expiry, clock skew.
2. Reject unless `purpose === BEDROCK_ROLE_REFRESH_PURPOSE`.
3. `GetCommand(executionMetaKey(executionId), { ConsistentRead: true })` on `V2_PROCESS_TABLE`. Reject if absent, if `execution.projectId !== claims.projectId`, or if `!CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(execution.status)`. That set (`{'CREATED','RUNNING'}`) already exists at `lambda/credential-broker/index.js:23` and is already used this way by the source-control path at `:87` — the agent-credential path simply does not use it yet. **This is the revocation mechanism:** parking, failing, completing or cancelling an execution makes every outstanding refresh grant inert within one refresh cycle.
4. Re-resolve the binding **server-side** from `claims.projectId`, reading SSM now rather than trusting anything in the grant. A space that changes its role, or rotates its external ID, takes effect on the next refresh.
5. Reject with `BEDROCK_ROLE_BINDING_CHANGED` if the freshly-read binding is no longer role mode. The helper surfaces this as a hard failure rather than continuing on stale credentials.
6. `AssumeRole`: `RoleSessionName = aidlc-<spaceId>` (≤64 chars, `[\w+=,.@-]`), `ExternalId` from the binding, `DurationSeconds = 3600`.
7. Return only `{ AccessKeyId, SecretAccessKey, SessionToken, Expiration }`.
8. Extend `loggableAgentCredentialErrorCode` with the new codes, preserving the existing allowlist discipline.
9. Audit at INFO on success: `{ grantId, executionId, projectId, stageInstanceId }`. `grantId` makes a refresh chain traceable in CloudWatch and an anomalous redemption rate visible.

**Deliberately omitted: a redemption counter.** An 8-hour stage refreshing at ~55-minute intervals redeems roughly nine times. A hard cap would need a DynamoDB counter and a write per refresh, and the grant's own expiry plus the execution-status check already bound the exposure in both time and validity. Recorded as an open decision rather than a silent choice.

Credential safety, restated as requirements:

- STS credentials are never persisted; minted per refresh, held in process environment only.
- Never written to `/mnt/workspace`.
- Never logged. The repository's existing redaction fixture (the deliberate fake `AKIA…` negative control) must be extended to cover `AWS_SESSION_TOKEN` and `AWS_SECRET_ACCESS_KEY`.
- The **role ARN is not a secret** and should be echoed back to the UI. The **external ID is not a secret either** — AWS says so in terms: "AWS does not treat the external ID as a secret … The external ID for a role can be seen by anyone with permission to view the role." Store it as `SecureString` (encryption at rest is free) but return it to any principal that may modify the binding, idempotently rather than once, because an operator has to paste it into a trust policy and must be able to re-read it to reconcile or recover. Both values are nonetheless tenant-identifying, so neither belongs on the lower-privilege agent settings read that any authenticated user can call; that surface keeps the "set / not set" shape. The bearer token and Kiro key remain genuine secrets and are never returned at any scope.

### 3.3 The single credential-helper contract

One executable, `/opt/aidlc/bin/aidlc-bedrock-credentials`, emitting the **standard `credential_process` payload**:

```json
{
  "Version": 1,
  "AccessKeyId": "…",
  "SecretAccessKey": "…",
  "SessionToken": "…",
  "Expiration": "2026-09-06T03:11:23Z"
}
```

All three Bedrock CLIs consume that one format (probe 2, §4.2):

| CLI                     | Wiring                                                                                           | Refresh behaviour                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code 2.1.246** | `awsCredentialExport` in the per-stage settings file, **without** `awsAuthRefresh`               | Runs at session start and on each credential reload. With a valid ISO-8601 `Expiration` it caches until five minutes before that time, then re-runs the command. Accepts this flat shape as of 2.1.181; `Expiration` honoured as of 2.1.176; standalone `awsCredentialExport` as of 2.1.206 — the pinned version clears all three |
| **OpenCode 1.17.20**    | `credential_process` in a written AWS config file, selected by `AWS_CONFIG_FILE` + `AWS_PROFILE` | AWS SDK JS provider chain re-invokes the helper on expiry                                                                                                                                                                                                                                                                         |
| **Codex 0.145.0**       | Same file, same mechanism                                                                        | AWS SDK for Rust provider chain, same behaviour                                                                                                                                                                                                                                                                                   |

```ini
[profile aidlc]
credential_process = /opt/aidlc/bin/aidlc-bedrock-credentials
region = <BEDROCK_REGION>
```

Written per stage to a non-persistent path with mode `0600` — never `/mnt/workspace`.

Helper requirements:

- Reads `AIDLC_BEDROCK_REFRESH_GRANT` plus the broker function name and region from the environment.
- Invokes the broker with `{ action: 'refresh-bedrock-role-credentials', grant }`, reusing `lambda/agentcore/clients.js`'s existing `invokeCredentialBroker` rather than a second implementation.
- On success prints the JSON above and exits 0.
- On failure prints **nothing** to stdout, one allowlisted code to stderr, exits non-zero. A partial or malformed object must never be printed, because a CLI may cache it.
- **Never blocks on input and must return fast.** Claude Code times out a chain resolve after 60 seconds, and its documentation names a `credential_process` helper waiting for input it cannot receive as the cause. A Lambda invoke is ~1 s.
- Stateless and idempotent; no caching in the helper — the CLIs cache.
- `CLAUDE_CODE_SKIP_AWS_CRED_CACHE` must **not** be set; it would invoke the helper on every request.

### 3.4 Prerequisite: the capabilities defect

`lambda/agentcore/commands/capabilities.js:21` maps claude/opencode/codex to `AWS_BEARER_TOKEN_BEDROCK` and computes `available = installed && authed`. The role path deliberately sets no bearer token, so all three Bedrock CLIs report unavailable and the UI gates them out — selecting role mode would disable exactly the CLIs it enables. `authed` must become "bearer **or** session credentials present", derived from the environment that actually exists rather than from a marker variable. This is phase-0 work, not optional.

### 3.5 Prerequisite: the UI equates "configured" with "a secret is set"

The same defect class as §3.4 exists in the frontend, verified at this commit. `frontend/src/components/settings/AgentCredentialScopeCard.tsx:174` computes

```js
const configuredCount =
  Number(Boolean(settings?.bedrockBearerTokenSet)) + Number(Boolean(settings?.kiroApiKeySet));
```

and line 244 passes `isSet={Boolean(settings?.bedrockBearerTokenSet)}`. So "configured", the provider count, and the platform-fallback hint are all derived from _a secret being present_. A role binding is a non-secret ARN, so a space that configures one would render as having no credentials — the same shape of bug as the capabilities defect, in a different layer.

Both cards need a mode-aware notion of configured. Note also that `bedrockBearerTokenSet` is the API contract field name, generated from `PROVIDER_CONFIG[...].setField`; role mode should add a mode discriminator rather than overload that boolean, so the meaning of the existing field never changes for existing clients.

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

### 4.2 Probe 2 — all three CLIs support a refreshable credential source

| CLI                     | Result                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenCode 1.17.20**    | Downloaded artifact sha256 `0a41572e…d86d9afc` is **byte-identical to the Dockerfile's pinned digest**, so this is the exact binary in the image. Contains `credential_process` ×7, `AWS_CONTAINER_CREDENTIALS_FULL_URI` ×5, `…RELATIVE_URI` ×5, `AWS_WEB_IDENTITY_TOKEN_FILE` ×3, `sso_start_url` ×10                                    |
| **Codex 0.145.0**       | `aarch64-unknown-linux-musl`, statically linked, stripped. `credential_process` ×7, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_SHARED_CREDENTIALS_FILE` ×2, `AWS_WEB_IDENTITY_TOKEN_FILE`, plus `aws-sdk` ×53, `sigv4` ×21, `AWS4-HMAC-SHA256`, `Bedrock` ×77 — it signs SigV4 against Bedrock through the Rust SDK's full provider chain |
| **Claude Code 2.1.246** | Pinned version exceeds every documented minimum for `awsCredentialExport`                                                                                                                                                                                                                                                                 |

This refutes the prior working assumption that Codex might be bearer-token only, and it is why fix A needs no per-CLI logic.

**Limit of the method:** string presence proves the provider is compiled into the binary and reachable. It does not prove a refresh executes correctly inside this container, which can only be tested once the helper exists. Classified as verified-by-artifact, not verified-by-execution.

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

|       | Mechanism                                                                                                                           | Ceiling                            | Verdict                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| **A** | Refreshable credential source: one helper, `awsCredentialExport` + `credential_process`                                             | Unbounded (refreshes indefinitely) | **Design target.** Probe 2 removed the only blocking risk                 |
| **B** | `DurationSeconds=3600`, expiry surfaced as a first-class stage failure so the orchestrator's existing retry mints fresh credentials | Exactly 3600 s (probe 1)           | **Ship underneath A.** With p99 at 20 minutes this is rare and survivable |
| **C** | `AssumeRoleWithWebIdentity` — not chaining, honours `MaxSessionDuration` up to 12 h                                                 | 12 h, no refresh mechanism needed  | **Documented, not built**                                                 |

**Build B first, then layer A on top.** B is a few lines and converts a mysterious mid-stage death into a legible, automatically retried failure, so role mode is never _broken_ by expiry at any point in the rollout — only occasionally slower. A then makes it rare enough to ignore.

C is rejected for a reason that comes from the project's own goal: it requires every customer bringing a role to register an OIDC provider and write a federated trust policy instead of pasting one role ARN. That is a large regression in setup simplicity, and it is additionally unverified whether AgentCore exposes a usable OIDC token. It remains the correct escape hatch for anyone who genuinely needs single stages beyond 8 hours.

**Role mode is strictly worse than a bearer token on reliability** — a bearer token never expires. That is the price of temporary credentials. The hierarchy mitigates it without any extra mechanism: a space that values marathon stages over short-lived credentials simply stays on a bearer token, per space, with no platform decision required.

## 6. Change inventory

| File                                                            | Change                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lambda/shared/agent-credentials.js`                            | Parse the binding value as bearer-or-role; add the three AWS credential env names to `AGENT_CREDENTIAL_ENV_NAMES` so `cleanBaseEnv` scrubs them per invocation |
| `lambda/shared/agent-credential-grants.js`                      | Refresh purpose, purpose-aware TTL ceiling, `stageInstanceId` claim, role-mode-only binding constraint                                                         |
| `lambda/credential-broker/index.js`                             | New `refresh-bedrock-role-credentials` action; execution-status + `projectId` re-validation; server-side binding re-resolution; `AssumeRole`; new error codes  |
| `lambda/agentcore/auth-resolver.js`                             | Set three env vars instead of one when the broker returns credentials; carry the refresh grant in the invocation context                                       |
| `lambda/agentcore/cli/drivers.js`                               | Write the AWS config file; set `AWS_CONFIG_FILE`/`AWS_PROFILE` for OpenCode and Codex; set `awsCredentialExport` for Claude Code                               |
| `lambda/agentcore/commands/capabilities.js`                     | `authed` = bearer **or** session credentials (§3.4)                                                                                                            |
| `lambda/agentcore/Dockerfile`                                   | Install the credential helper                                                                                                                                  |
| `lambda/agents/index.js` (settings API)                         | Accept a role ARN + optional external ID; return a mode alongside the existing `*Set` booleans; echo the ARN, mask the external ID                             |
| `frontend/src/components/admin/AgentCredentialsCard.tsx`        | Platform-scope card — the central default (§3.5)                                                                                                               |
| `frontend/src/components/settings/AgentCredentialScopeCard.tsx` | Space- and user-scope card — the override (§3.5)                                                                                                               |
| `terraform/modules/api/lambda/main.tf`                          | One `sts:AssumeRole` statement on the broker role, resource from `bedrock_assumable_role_arns`                                                                 |
| —                                                               | **No change to the AgentCore execution role.** No new SSM parameter paths. `bedrock-auth-method` is deleted                                                    |

## 7. Well-Architected alignment

**Security — the strongest gain.** Replacing a long-lived shared bearer token with short-lived STS credentials is SEC02's "use temporary credentials". Least privilege is served twice: the invoke-only, family-scoped, condition-fenced grant, and a container that holds no assume capability at all. The external ID addresses the confused-deputy problem. Blast radius is bounded by resolving the binding server-side from the broker's verified claim. _Tradeoffs:_ a new cross-account trust relationship; a new secret (the external ID); and `sts:AssumeRole` with a wide default resource, mitigated as described in §2.

**Cost Optimization.** COST03 is met at the mechanism level: identity reaches Bedrock as `RoleSessionName=aidlc-<spaceId>`, so CloudTrail and invocation logs carry the tenant boundary from day one, and the customer opts into dollars on their own schedule. _Tradeoff:_ native attribution delivers aggregated dollars per usage type per day, never a per-request row, so per-intent cost remains app-computed.

**Operational Excellence.** A role ARN is non-secret, auditable in CloudTrail and diffable in IaC, unlike a rotating opaque token. Model access, guardrails and quotas consolidate in one account. _Tradeoffs:_ a new cross-account dependency; drift risk between the platform's binding and the role's real state — which argues for a bind-time "test this binding" preflight (a bare `AssumeRole`, no invoke) so misconfiguration surfaces at save time rather than mid-stage.

**Reliability — weakest pillar.** Expiry is a failure mode the bearer token does not have (§5). And the central account is a shared failure domain: **Bedrock quotas are per account, per model, per region**, so one team's runaway intent can throttle every other team. Per-space roles would not have fixed this. What does, and what this design enables at no extra cost: a space can override with a role in its own account, which carries its own quota. The override is the noisy-neighbour escape hatch.

## 8. Consequences

**Positive.** No long-lived Bedrock secret in the default path. Zero IAM change to the AgentCore execution role. Same-account and cross-account on one code path. No per-tenant provisioning. Model-churn-proof. Backwards compatible: existing bearer bindings keep working, role mode is opt-in per scope, no migration. Kiro is unaffected (its own namespace and `KIRO_API_KEY`).

**Negative.** A new expiry failure mode. A longer-lived reusable authorization inside the container (duration, not scope). A new cross-account trust relationship and external ID to operate. `sts:AssumeRole` with a wide default resource. Two cost numbers will coexist and will **not** match — the in-app Price List estimate and any CUR-derived figure diverge structurally (cache-read/write token pricing, cross-region routing, streaming accounting, cache staleness, savings plans), so the in-app figure must be relabelled as an estimate.

**Neutral.** Showback needs no platform UI in v1: the platform's only job is to emit correct identity, so there is no new API, no new authorization surface, and no cross-tenant leak to defend. Cost-allocation tags are not retroactive, so a customer's per-space series begins when they activate it.

## 9. Open decisions

1. **Redemption counter on refresh grants** — recommended omitted for v1 (§3.2). Adopt if an auditor requires a hard cap.
2. **`BEDROCK_ROLE_REFRESH_TTL_SECONDS`** — proposed 8 h to match `STAGE_CALLBACK_TIMEOUT`. A shorter ceiling (say 2 h) would bound exposure further at the cost of failing stages the platform otherwise permits.
3. **Value encoding** — JSON in the existing parameter. Alternatives: sniffing for an `arn:` prefix (no room for an external ID), or a second parameter (new path, new IAM pattern, more change).
4. **Bind-time preflight** — worth building in v1? It converts a class of mid-stage failure into an input-validation error.
5. **`bedrock_assumable_role_arns` default** — `["*"]` for usability, or force operators to enumerate.
6. **Does the user scope keep its precedence?** Left unchanged deliberately. A member with a personal role binding uses it in every space they belong to, and with cross-account roles that bills their account for another team's work. This is _not new_ — a personal bearer token already bills whatever account issued it — so role mode introduces no new defect, only a more visible one. Changing precedence would be a behaviour change to shipped functionality in service of a cost report that is descoped.

## 10. Verification plan

Nothing here may be claimed without evidence:

1. **Helper round-trip in the real container** — the one thing probe 2 could not establish. Prove each of the three CLIs invokes the helper and completes a Bedrock call on the returned credentials.
2. **Refresh across an expiry boundary** — force a short `DurationSeconds` and prove a stage survives at least one refresh, with the `grantId` audit line confirming re-redemption.
3. **Negative controls, each expected to fail closed:** a refresh grant naming a bearer binding; a grant whose `projectId` differs from the execution; a grant redeemed after the execution leaves `CREATED`/`RUNNING`; a grant redeemed after the space switches back to a bearer token; a grant past `expiresAt`.
4. **Cross-tenant probe** — a container in space A must not obtain space B's credentials even when naming B's identifiers.
5. **Redaction** — session token and secret key absent from every log group.
6. **Capabilities** — all three Bedrock CLIs report `available: true` on the role path while the startup log confirms the bearer is omitted.
7. **UI** — a space configured with a role ARN and no secret renders as configured, in both the admin and space cards (§3.5).
8. **`RoleSessionName` reaches the record** — confirm `aidlc-<spaceId>` appears in CloudTrail and in model invocation logs for a chained session. Currently **assumed**: that Bedrock attributes usage to the final signing principal in a chained-role call.

## 11. References

- [Track usage and costs in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html) — mechanism comparison and the "attribution behind an LLM gateway" pattern
- [IAM principal attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html) — `RoleSessionName`, session tags, CUR 2.0 caller-identity export
- [Application inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) · [Best practices for cost attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-best-practices.html)
- [Role chaining one-hour limit](https://repost.aws/knowledge-center/iam-role-chaining-limit) · [Passing session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [Access to AWS accounts owned by third parties (external ID)](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) · [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [Claude Code on Amazon Bedrock — advanced credential configuration](https://docs.anthropic.com/en/docs/claude-code/amazon-bedrock) — `awsCredentialExport`, `awsAuthRefresh`, caching and the 60 s chain-resolve timeout
- [Sourcing credentials with an external process](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sourcing-external-process.html) — the `credential_process` payload contract
- [Activating user-defined cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html) — for the customer runbook, not for the platform to run
- [Well-Architected Security Pillar SEC02](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_unique.html) · [Cost Optimization COST03](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/cost-effective-resources.html)
