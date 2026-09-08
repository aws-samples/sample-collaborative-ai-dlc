---
artifactType: design
title: Bedrock IAM-role credential mode
status: draft
baseCommit: 8e67ac5
---

# Design — Bedrock IAM-role credential mode

Rationale and alternatives live in [ADR-0001](../../adr/0001-bedrock-iam-role-credential-mode.md). This document is the design portion of the implementable contract. Every `file:line` citation is valid at pure upstream `8e67ac5`.

## Governing principle

**Bedrock is an AWS service, so AWS Well-Architected and IAM best practice govern it: IAM roles and short-lived STS credentials only.** Non-AWS model providers (Kiro today, LiteLLM later) use their own conventional pattern — an API key, plus a base URL where applicable — and are out of scope for the short-lived-credential rule.

AWS's [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) states that for workloads on AWS compute, _"there is no need to distribute long lived credentials … to your workloads running on AWS"_, and enumerates the exceptions where long-term credentials remain acceptable: workloads that cannot use IAM roles, third-party clients or vendors not hosted on AWS, CodeCommit and Keyspaces. **None applies here** — AgentCore is AWS compute and all three Bedrock CLIs use AWS SDKs. The bearer token is therefore not a defensible primary path for this deployment.

Supporting: [SEC02-BP02 Use temporary credentials](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_unique.html); [AGENTSEC03-BP03 least privilege with dynamic boundaries](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec03-bp03.html) — _"Scoping privilege at each identity layer, backing it with temporary credentials, and layering contextual IAM conditions limits the scope of any single compromised or misprompted call"_; [GENSEC01-BP01 least privilege to foundation model endpoints](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/gensec01-bp01.html).

## Document convention

At baseline `8e67ac5` the repository had no `specs/` directory and no documented spec process; this set establishes one. It therefore conforms to the platform's **own** machine-enforced artifact contract rather than an inherited convention:

| Convention                                           | Source                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| YAML frontmatter + markdown body                     | `lambda/shared/frontmatter.js` — `parseFrontmatter`                                                                      |
| At least two distinct `## ` H2 headings              | `lambda/shared/v2-sensor-contract.js:164` — `pass = h2Count >= 2`                                                        |
| Fenced YAML blocks with registry-defined field names | `lambda/shared/artifact-extractors.js` — `REGISTRY.requirements:92`, `REGISTRY.components:240`, `REGISTRY.decisions:279` |
| Rendered examples must parse back                    | `lambda/shared/test/artifact-structure-contract.test.js`                                                                 |

## Verified evidence

Established by execution or artifact inspection, not inference.

| ID                             | Statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `con-role-chaining-3600`       | `AssumeRole` from an assumed-role caller is role chaining, capped at exactly **3600 s**. `3600` succeeds; `3601`, `7200`, `43200` each return `ValidationError: The requested DurationSeconds exceeds the 1 hour session limit for roles assumed by role chaining`. The probe role permitted 43200, so the role was never the limiter                                                                                                                                                                                                                                                                                                                   | Live probe                                                                                                                                                                               |
| `con-chained-attribution`      | Bedrock and CloudTrail attribute an invoke to the **final** chained session. `identity.arn` = `…assumed-role/<role>/aidlc-<projectId>`, `principalId` = `AROA…:aidlc-<projectId>`, `sessionIssuer` = the role ARN. Visible in eu-central-1 in under 3 minutes; zero events in us-east-1                                                                                                                                                                                                                                                                                                                                                                 | Live probe + CloudTrail                                                                                                                                                                  |
| `con-session-name-fits`        | `aidlc-<projectId>` is 42 characters against the 64 limit, within the STS session-name charset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Live probe                                                                                                                                                                               |
| `con-tagsession-required`      | Session tags require `sts:TagSession` in the target trust policy; without it `AssumeRole` fails `AccessDenied … not authorized to perform: sts:TagSession`. This is why v1 passes no tags                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Live probe, matching AWS documentation                                                                                                                                                   |
| `con-cli-env-creds`            | Claude Code **2.1.246** and OpenCode **1.17.20** each complete a Bedrock call given only `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and a region, with `AWS_CONFIG_FILE=/dev/null`, `AWS_SHARED_CREDENTIALS_FILE=/dev/null`, no `AWS_PROFILE` and no bearer token. Codex **0.145.0** signs SigV4 with the same credentials (its 403 named the probe session verbatim)                                                                                                                                                                                                                                                            | Live probe at the pinned versions                                                                                                                                                        |
| `con-claude-model-fanout`      | Claude Code invokes models beyond the configured one. With `--model eu.anthropic.claude-sonnet-5`, CloudTrail recorded `eu.anthropic.claude-opus-5` and `eu.anthropic.claude-haiku-4-5-20251001-v1:0`, zero errors — while the CLI's own `modelUsage` reported only sonnet-5. Justifies `req-model-grant-families`                                                                                                                                                                                                                                                                                                                                      | Live probe + CloudTrail                                                                                                                                                                  |
| `con-gpt-global-cris-only`     | GPT models are available only via **global** CRIS. `global.openai.gpt-5.6-sol` succeeds on Converse; `eu.openai.gpt-5.6-sol` returns `ValidationException: The provided model identifier is invalid`; `list-inference-profiles` shows only `global.openai.gpt-5.6-{sol,terra,luna}`                                                                                                                                                                                                                                                                                                                                                                     | Live probe, positive and negative control                                                                                                                                                |
| `con-fm-fence-works`           | A bare foundation-model id resolves to direct FM invocation and is denied by the `StringLike` condition on `bedrock:InferenceProfileArn`: `openai.gpt-5.6-sol` → `AccessDenied on arn:aws:bedrock:eu-central-1::foundation-model/openai.gpt-5.6-sol`. The fence forces traffic through an inference profile, by design                                                                                                                                                                                                                                                                                                                                  | Live probe                                                                                                                                                                               |
| `con-codex-mantle`             | LEGACY. Codex 0.145.0 with `model_provider="amazon-bedrock"` calls `https://bedrock-mantle.<region>.api.aws/openai/v1/responses` and requires `bedrock-mantle:CreateInference` on `arn:aws:bedrock-mantle:<region>:<account>:project/*`. `bedrock:InvokeModel` does not authorize it. Superseded by `con-codex-runtime-provider`                                                                                                                                                                                                                                                                                                                        | Live probe (403 → 404 after granting)                                                                                                                                                    |
| `con-codex-model-missing`      | Mantle in eu-central-1 serves neither `openai.gpt-5.6-sol`, `global.openai.gpt-5.6-sol`, `gpt-5.6-sol` nor `anthropic.claude-sonnet-5` — each returns 404 _"The model does not exist"_. Mantle in `us-east-1` DOES serve the bare ids, so this is regional, not model-specific                                                                                                                                                                                                                                                                                                                                                                          | Live probe                                                                                                                                                                               |
| `con-codex-runtime-provider`   | Codex reaches Bedrock only through `model_provider="amazon-bedrock-runtime"` (needs >= 0.149.1; pinned 0.153.4), which signs SigV4 for service `bedrock` against `bedrock-runtime.<region>.amazonaws.com/openai/v1`. A custom provider cannot carry AWS auth (_"provider aws is only supported for `amazon-bedrock`"_), and overriding the legacy provider's `base_url` still signs for `bedrock-mantle` → _"401 Credential should be scoped to correct service: 'bedrock'"_                                                                                                                                                                            | Live probe on both pinned binaries                                                                                                                                                       |
| `con-codex-cris-required`      | On the runtime endpoint a bare `openai.gpt-5.6-sol` is refused (_"on-demand throughput isn't supported. Retry ... with the ID or ARN of an inference profile"_) while `global.openai.gpt-5.6-sol` succeeds — the exact opposite of Mantle, so a model id is only valid relative to a provider                                                                                                                                                                                                                                                                                                                                                           | Live probe                                                                                                                                                                               |
| `con-codex-project-grant`      | The OpenAI-compatible APIs authorize `bedrock:InvokeModel` against `arn:aws:bedrock:<region>:<account>:project/default` in addition to the model; without it every call returns 401 naming that resource                                                                                                                                                                                                                                                                                                                                                                                                                                                | Live probe with broker-minted credentials                                                                                                                                                |
| `con-codex-env-creds`          | The runtime provider resolves `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` with no `AWS_PROFILE` and no `~/.aws/config`, and takes its Region from `AWS_REGION` — so role mode needs no Bedrock API key                                                                                                                                                                                                                                                                                                                                                                                                                              | Live probe                                                                                                                                                                               |
| `con-mmds-chain-live`          | AgentCore exposes execution-role credentials through a MicroVM Metadata Service, and the platform **deliberately** forwards the container-credential chain variables to the reserved `aidlc` MCP child: _"The standard AWS credential-chain vars are forwarded to the RESERVED aidlc server ONLY so its SDK clients resolve credentials — static keys …, container-credentials URIs (the AgentCore runtime role), or web identity."_ AWS warns _"any code or actor running inside the VM can access these credentials"_. The chain is live and intentional; fail-closed therefore rests on the execution-role **policy**, not on the chain being absent | `lambda/agentcore/stage-materializer.js:455-478`; [AgentCore credentials management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/security-credentials-management.html) |
| `con-custom-server-excluded`   | The same comment states _"Custom servers NEVER get this list (a user-configured server must not silently inherit runtime credentials)"_ — the exclusion is already an intended in-tree property                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `lambda/agentcore/stage-materializer.js:462-465`                                                                                                                                         |
| `con-missing-value-is-missing` | `auth-resolver.js:190-191` does `const value = authorized.get(bindingKey(binding))?.value \|\| ''; if (!value) { missingProviders.push(...) }`. A broker result carrying no `value` is therefore treated as **missing**, so a role result cannot reuse the bearer shape without an explicit discriminator                                                                                                                                                                                                                                                                                                                                               | `lambda/agentcore/auth-resolver.js:190-191`                                                                                                                                              |
| `con-one-binding-per-provider` | `resolveEffectiveCredentialBindings` resolves **exactly one** binding per provider, first configured wins across `user → space → platform`. A CLI therefore never sees both a bearer and a role credential                                                                                                                                                                                                                                                                                                                                                                                                                                              | `lambda/shared/agent-credentials.js:224`                                                                                                                                                 |
| `con-session-name-condition`   | `sts:RoleSessionName` is a **trust-policy condition key** for `sts:AssumeRole`: _"Use this key to compare the session name that a principal specifies when assuming a role with the value that is specified in the policy … present in the request when the principal assumes the role using … any AWS STS `AssumeRole` API operation."_ AWS documents it with `StringLike` on a prefix. A customer can therefore scope one Bedrock role to named spaces with **no platform code**                                                                                                                                                                      | [IAM and AWS STS condition context keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html)                                                    |
| `con-user-scope-self-service`  | `PUT /users/me/agent-credentials` is gated **only** on an authenticated `credentialUserId` from Cognito claims — no `requirePlatformAdmin`, unlike the platform-scope handlers at `:624` and `:903`. Any authenticated user can therefore write a user-scope binding value                                                                                                                                                                                                                                                                                                                                                                              | `lambda/agents/index.js:355-390`                                                                                                                                                         |
| `con-broker-action-dispatch`   | The broker dispatches on `const action = event?.action \|\| 'source-control'`, and the settings path already reaches it through `readCredentialScopeStatusViaBroker`. A control-plane-only operation is an extension of an existing seam, not a new trust boundary                                                                                                                                                                                                                                                                                                                                                                                      | `lambda/credential-broker/index.js:167`; `lambda/agents/index.js:362`                                                                                                                    |
| `con-stage-reason-structured`  | Stage failures flow through `reconcileFailure` → `store.failRunningStageAttempt` carrying a structured `reason`, with existing constants such as `stage_dispatch_failed` and `stage_bad_callback_result`, and `failureReason` is persisted and rendered — _"a failure surfaces in the UI (status badge + failureReason)"_. Counting a new reason needs no bespoke log query and no new telemetry                                                                                                                                                                                                                                                        | `lambda/v2-orchestrator/index.js:398`, `:1597`, `:1600`, `:1659`, `:1675`                                                                                                                |
| `con-invocation-logging-off`   | Model invocation logging is **not configured** in eu-central-1 — `get-model-invocation-logging-configuration` returns empty. Per-request metadata tagging surfaces only in invocation logs, so it is unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                        | Live check                                                                                                                                                                               |
| `con-grant-ttl-300`            | Grant TTL is 300 s, enforced at **both** signing and verification. Justifies `req-grant-model-unchanged`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `lambda/shared/agent-credential-grants.js:8`                                                                                                                                             |
| `con-grant-destroyed`          | The grant is deleted from the handler payload before the handler runs. v1 preserves this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `lambda/agentcore/http-server.js:107`                                                                                                                                                    |
| `con-auth-context-seam`        | `handlers.runStageStart = (p, context) => createRunStageStart({ runStage: (q) => handlers.runStage(q, context), … })(p)` — four further keys elided. The resolved auth `context` is closed over and reaches the detached stage job, which is why per-invocation credentials reach a stage that outlives its invocation. Requires no change                                                                                                                                                                                                                                                                                                              | `lambda/agentcore/http-server.js:305-312`                                                                                                                                                |
| `con-stage-8h`                 | One stage attempt may legitimately run 8 hours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `lambda/v2-orchestrator/index.js:1545`                                                                                                                                                   |
| `con-stage-durations`          | Measured over the full 27-day log record: p50 5 min, p90 10 min, p99 20 min, maximum ~34 min — the worst observed stage used ~57 % of a 3600 s credential. **The maximum is a single outlier in a 27-day sample**, which is why `req-expiry-tripwire` exists                                                                                                                                                                                                                                                                                                                                                                                            | CloudWatch heartbeat analysis                                                                                                                                                            |
| `con-shared-quota`             | Bedrock quotas are per account, per model, per region — not per role. A space override into its own account is the only isolation lever, and its real cost is cross-account trust setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | AWS service quotas                                                                                                                                                                       |
| `con-pinned-versions`          | `CLAUDE_CODE_VERSION=2.1.246` (`lambda/agentcore/Dockerfile:36`), `OPENCODE_VERSION=1.17.20` (`:40`), `OPENCODE_SHA256=0a41572e…d86d9afc` (`:41`), `CODEX_VERSION=0.153.4` (`:53`). The OpenCode artifact tested was byte-identical to the pinned digest                                                                                                                                                                                                                                                                                                                                                                                                | Dockerfile + artifact inspection                                                                                                                                                         |
| `con-no-auth-method-selector`  | `bedrock-auth-method` exists nowhere at baseline `8e67ac5` — a repository search finds it only inside this spec set and its ADR, never in source, Terraform or Lambda code. It was a fork PR #1 artifact, so there is nothing to delete on the upstream baseline                                                                                                                                                                                                                                                                                                                                                                                        | Repository search                                                                                                                                                                        |

**Assumed, not verified.** That _billing_ aggregates by the chained session identity — AWS states the caller identity flows into Cost Explorer and CUR 2.0, but confirming it needs a CUR 2.0 caller-identity export and 24 hours, a customer-side action. That the CLIs accept env credentials **inside the AgentCore container** — verified at the CLI layer on darwin builds of the pinned versions; the container adds the MMDS chain, addressed by `req-execution-role-no-bedrock`. Streaming attribution — not directly testable here (CLI 2.36.36 lacks `invoke-model-with-response-stream`, boto3 absent); prior live evidence recorded 23 `InvokeModel`/`InvokeModelWithResponseStream` events all attributed to the AgentCore assumed-role session.

**Resolved, previously flagged unverified.** The [AIP page](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) is normative — _"Application inference profiles aren't supported by the Responses and Chat Completions APIs, on either endpoint … rejected with a 400 error"_ — so the comparison table on the IAM-principal page listing Chat Completions as AIP-supported is in error. Streaming is named for neither mechanism, so the earlier framing that this favoured principal attribution was overstated; the real resolution is that principal attribution is _"based on who made the call, not on API parameters"_. The same page confirms _"System, geographic, and global inference profiles work normally with all of these APIs."_

## Contracts

### Binding value

Stored in the existing `bedrock` parameter for the scope (`lambda/shared/agent-credentials.js:22` — `PROVIDER_CONFIG`, module-private; its derived `setField` name is the public API surface):

```json
{ "roleArn": "arn:aws:iam::111122223333:role/aidlc-bedrock-inference", "externalId": "<opaque>" }
```

Discrimination rule: a trimmed value starting with `{` **must** parse as an object carrying a valid `roleArn`, else the write is rejected. Anything else non-empty is a bearer token and is never parsed. Field rules are in `req-single-parameter-encoding`.

### Broker result

An explicit `kind` discriminator is mandatory, because `con-missing-value-is-missing` shows the resolver treats a valueless entry as a missing provider:

```json
{ "binding": { "provider": "bedrock", "source": "space" }, "kind": "bearer", "value": "<secret>" }
{ "binding": { "provider": "bedrock", "source": "space" }, "kind": "role",
  "credentials": { "AccessKeyId": "ASIA…", "SecretAccessKey": "…", "SessionToken": "…",
                   "Expiration": "2026-09-06T09:53:40Z" } }
```

### Environment set on the CLI, role mode

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, plus the region each `envForAuth` block already sets (`lambda/agentcore/cli/drivers.js:69`, `:156`, `:227`). `AWS_BEARER_TOKEN_BEDROCK` is **not** set. Written only into the per-invocation environment clone.

### Grant statements on the Bedrock role

`<bedrock-account>` is the account that **owns the role**, which under a central-Bedrock-account topology is not the platform account. Patterns, never enumerations — `con-claude-model-fanout` makes enumeration unworkable and `con-gpt-global-cris-only` fixes which prefixes are valid:

```
bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream
  arn:aws:bedrock:*:<bedrock-account>:inference-profile/eu.anthropic.claude-*
  arn:aws:bedrock:*:<bedrock-account>:inference-profile/global.anthropic.claude-*
  arn:aws:bedrock:*:<bedrock-account>:inference-profile/global.openai.gpt-*   ← no eu.openai exists

bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream
  arn:aws:bedrock:*::foundation-model/anthropic.claude-*
  arn:aws:bedrock:*::foundation-model/openai.gpt-*
  Condition StringLike bedrock:InferenceProfileArn = arn:aws:bedrock:*:<bedrock-account>:inference-profile/*

bedrock-mantle:CreateInference
  arn:aws:bedrock-mantle:*:<bedrock-account>:project/*                        ← Codex only
```

The broker's own policy, in the **platform** account, carries `sts:AssumeRole` with the resource from `bedrock_assumable_role_arns`.

### Trust policies handed to customers

The **recommended** template names the broker as principal and constrains the session name, which is what makes the role space-aware (`con-session-name-condition`). Cross-account adds the mandatory external ID, per the [external ID](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) and [confused deputy](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html) guidance:

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
        "StringEquals": {
          "sts:RoleSessionName": "aidlc-<projectId>",
          "sts:ExternalId": "<platform-generated-value>"
        }
      }
    }
  ]
}
```

Same-account may omit `sts:ExternalId`. Omitting the session-name condition is permitted and sometimes necessary (a role shared by many spaces, where `StringLike` on an enumerated set is the better form), but it means **any space that knows the role ARN can use it** — the platform cannot enforce that constraint from its side, and the ARN is not treated as a secret. This is the reason `req-role-credential-mode` keeps role bindings out of user scope, where per `con-user-scope-self-service` any authenticated user could name an ARN.

## Failure modes

| Condition                                                  | Required behaviour                                                                                                                                                   | Requirement                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Credential expires mid-stage                               | Reason `credential_expired`; retry resolves afresh; on budget exhaustion the stage ends FAILED with that reason                                                      | `req-expiry-failure-legible`       |
| Resolution fails or returns nothing                        | Reason `credential_resolution_failed`. The stage must not proceed. Fail-closed rests on the execution-role policy, since the container credential chain remains live | `req-execution-role-no-bedrock`    |
| `AssumeRole` denied, throttled or transient                | Typed allowlisted code; the stage retry is the recovery path                                                                                                         | `req-broker-credential-resolution` |
| SSM throttled, or a binding change not yet propagated      | Typed resolution failure; effect on next resolution, not immediate                                                                                                   | `req-resolution-resilience`        |
| Grant expires before the broker can resolve it             | Typed resolution failure, not a silent hang; the latency budget must fit the 300 s window                                                                            | `req-grant-model-unchanged`        |
| Trust policy omits the broker principal or the external ID | `AssumeRole` fails; with the preflight this surfaces at save time                                                                                                    | `req-binding-preflight`            |
| Binding revoked while a credential is live                 | Honoured for up to 3600 s. No in-flight revocation exists in v1; documented accepted risk                                                                            | `req-credential-safety`            |
| Malformed binding value                                    | Rejected at write time, never at stage time                                                                                                                          | `req-single-parameter-encoding`    |
| Two stages run concurrently in one space                   | Both share `RoleSessionName`, so CloudTrail cannot distinguish them. Accepted and stated                                                                             | `req-session-name-attribution`     |
| Model invoked that a narrower allowlist would exclude      | Cannot arise — no allowlist narrower than the provider family                                                                                                        | `req-model-grant-families`         |
| Codex invoked                                              | Fails on its own pre-existing defects, not on credentials                                                                                                            | `req-codex-scope`                  |
| One space exhausts account Bedrock quota                   | Not solvable here (`con-shared-quota`)                                                                                                                               | —                                  |

## Security handling

- **Least privilege at each layer.** The execution role gains nothing (`req-execution-role-no-bedrock`); the only new IAM is one `sts:AssumeRole` statement on the already-narrow broker role, resource-narrowed by default (`req-least-privilege-assume`); the Bedrock role itself is invoke-only, geo-scoped and condition-fenced (`con-fm-fence-works`).
- **The grant is advice; the session policy is the enforcement.** The permission policy this deployment renders is attached to a role in an account it does not manage, so nothing verifies the operator attached it — or that they attached nothing wider. Since any role matching `bedrock_assumable_role_arns` that trusts the broker is bindable by a space owner, an over-permissive role would deliver its extra permissions verbatim into a stage container that runs model-authored code. The broker therefore attaches a **session policy** on every `AssumeRole`, making effective permissions the intersection. Measured 2026-09-07 against a throwaway role holding the reference grant plus `s3:ListAllMyBuckets`: without the ceiling the S3 call succeeded; with it the S3 call was denied while `eu.anthropic.claude-sonnet-5` still invoked and a bare foundation-model id stayed denied, so `con-fm-fence-works` survives the intersection. The ceiling and the grant are two renders of ONE statement definition (`terraform/bedrock-role-grant.tf`), differing only in wildcarding the account, because a ceiling that lags the grant denies a call the documented grant permits — which is exactly what a hand-copied ceiling would have done when Codex's runtime provider added the `project/default` statement. It renders to ~1 KB against the 2048-character inline session-policy limit. An absent ceiling applies none rather than refusing to mint, matching the treatment of an empty assumable-role allowlist: a missing configuration means "unknown", not "deny everything". It does not close the MMDS execution-role chain (`con-mmds-chain-live`), which remains bounded by that role's policy holding nothing useful.
- **Short-lived only.** The invariants are enumerated in `req-credential-safety`, including that no role holds a credential-creation permission.
- **Honest blast radius.** `con-mmds-chain-live` means the container credential chain reaches the execution role and is _deliberately_ forwarded to the reserved MCP child. This design does not close that path; it changes what the path can reach, from a shared execution-role grant to a per-space, one-hour, invoke-only credential. The reduction is the security gain; containment of a compromised agent is not claimed.
- **Reserved MCP forwarding.** `lambda/agentcore/stage-materializer.js:466` forwards the three credential variables to the trusted `aidlc` bridge. Under role mode this carries live Bedrock credentials where the bearer never went. The custom-server exclusion (`con-custom-server-excluded`) is already intended in-tree and must be pinned by a test (`req-codex-scope`).
- **Confused deputy.** External ID mandatory cross-account, with the lifecycle in `req-external-id-lifecycle`.
- **Non-secret versus secret.** Neither the role ARN nor the external ID is a secret; AWS says so of the external ID in terms (`dec-external-id-not-secret`). Both are nonetheless **tenant-identifying**, so both are shown only on a read path gated to a principal that may modify the binding — which at every scope is the same principal that may overwrite it, so the gate costs nothing. The lower-privilege agent settings read, which any authenticated user can call, carries booleans only. The genuine secrets remain the bearer token and the Kiro key, which are never returned at any scope. `RoleSessionName` is non-secret but tenant-identifying, and appears in CloudTrail and logs by design.

## Observability

`con-invocation-logging-off` has three consequences, plus one separate finding:

- **CloudTrail is the attribution evidence path**, not the invocation log. `userIdentity.arn` carries `aidlc-<projectId>` and appeared within 3 minutes in the probe.
- **Per-request metadata tagging is unavailable**, so AWS-side per-intent cost detail is impossible until an operator enables invocation logging. The in-app token × Price List figure remains the only per-intent number and must stay labelled an estimate.
- **Enabling invocation logging is an operator decision, not a platform default** — it is account-wide per region and captures every user's prompts and completions.

Separately: **Codex/mantle traffic may have no CloudTrail evidence.** No `CreateInference` events were observed within ~2 minutes of the probe. Cause unresolved — lag, a different event name, or not a management event.

## Components

```yaml
components:
  - id: credential-broker
    name: Credential broker
    description: >-
      Resolves a role binding into temporary credentials. Already the sole IAM principal permitted
      to read credential material and already validates a verified projectId.
    responsibilities:
      - Discriminate a bearer value from a role object and return an explicit kind
      - Read the role ARN and external ID from SSM at resolution time
      - Compose RoleSessionName and AssumeRole with DurationSeconds 3600
      - Return only allowlisted error codes
    depends_on: []
  - id: auth-resolver
    name: Invocation auth resolver
    description: Branches on the result kind and sets three credential variables for a role result.
    responsibilities:
      - Scrub every credential variable from the base environment each invocation
      - Write credentials only into the per-invocation environment clone
      - Set no bearer variable on the role path
    depends_on:
      - credential-broker
  - id: cli-drivers
    name: CLI drivers
    description: Each envForAuth block forwards the three AWS variables when no bearer token is present.
    responsibilities:
      - Forward credentials without introducing per-CLI credential wiring
      - Leave the existing region resolution untouched
    depends_on:
      - auth-resolver
  - id: capabilities-command
    name: Capabilities command
    description: Availability derives from the resolved binding rather than from a bearer variable.
    responsibilities:
      - Report the three Bedrock CLIs available on the role path
      - Perform no AssumeRole
    depends_on: []
  - id: settings-api
    name: Agent settings API
    description: >-
      Accepts a role ARN and optional external ID; returns the mode fields. Delegates preflight to
      the broker rather than calling STS itself, so it acquires no new AWS permission.
    responsibilities:
      - Validate the binding value and reject a malformed write
      - Reject a role object written to a user-scope binding
      - Generate the external ID and expose only its set state
      - Recompute the legacy bearer boolean so its meaning is preserved
      - Request a broker preflight before persisting a role binding
    depends_on:
      - credential-broker
  - id: credential-cards
    name: Admin and space credential cards
    description: >-
      frontend/src/components/admin/AgentCredentialsCard.tsx and
      frontend/src/components/settings/AgentCredentialScopeCard.tsx.
    responsibilities:
      - Render a role-only scope as configured
      - Present role mode as recommended and the bearer field as deprecated
      - Show the role ARN and mask the external ID
    depends_on:
      - settings-api
  - id: broker-iam
    name: Broker IAM policy
    description: One sts:AssumeRole statement with a path-scoped default resource in the platform account.
    responsibilities:
      - Leave the AgentCore execution role untouched
    depends_on: []
  - id: execution-role
    name: AgentCore execution role
    description: Unchanged, and asserted by test to remain free of Bedrock, mantle and STS permissions.
    responsibilities:
      - Hold nothing useful so the live container credential chain is inert
    depends_on: []
  - id: grant-module
    name: Agent credential grant module
    description: Unchanged in v1. Listed so its immutability is explicit rather than incidental.
    responsibilities:
      - Keep the 300s ceiling and the one-shot authorization model
    depends_on: []
  - id: stage-failure-path
    name: Stage failure and retry path
    description: >-
      The orchestrator's stage-attempt reconciliation, which turns a credential failure into a typed
      reason and drives the existing retry.
    responsibilities:
      - Surface credential_expired and credential_resolution_failed distinctly
      - Terminate FAILED with the same reason when the retry budget is exhausted
    depends_on:
      - auth-resolver
```

## Open decisions

```yaml
decisions:
  - id: dec-v1-no-refresh
    title: v1 ships no credential refresh mechanism
    status: accepted
    context: >-
      Measured p50 5 min, p90 10 min, p99 20 min and maximum 34 min against a hard 3600s chaining
      cap, with an existing stage retry. Refresh was the largest part of the change surface and the
      whole source of a long-lived reusable authorization inside the container. The maximum is a
      single outlier in a 27-day sample.
    decision: Ship per-invocation credentials with expiry as a legible retry; add a tripwire and revisit on evidence.
    consequences: >-
      A stage exceeding roughly 55 minutes costs one full retry, losing the work already done. It
      also removes any need for a mode field on a grant binding, so the grant module is untouched.
  - id: dec-credential-delivery
    title: Environment variables, not a helper or a local endpoint
    status: accepted
    context: >-
      Verified sufficient for Claude Code 2.1.246 and OpenCode 1.17.20. A helper plus per-CLI config
      is exactly the wiring a future LiteLLM gateway would strand.
    decision: Set the three AWS variables per invocation and install nothing in the image.
    consequences: >-
      If refresh is ever needed, the loopback container-credentials endpoint is the preferred
      phase-4 mechanism because it is SDK-standard and keeps credentials out of the CLI environment.
  - id: dec-bearer-deprecated
    title: The bearer token is deprecated, not removed
    status: accepted
    context: AWS IAM best practice lists the exceptions permitting long-term credentials and none covers this workload.
    decision: Make role mode the recommended default and label the bearer path deprecated.
    consequences: Existing deployments keep working; the deprecation must be communicated in the UI and the runbook.
  - id: dec-explicit-discriminator
    title: The broker result carries an explicit kind field
    status: accepted
    context: >-
      auth-resolver treats an entry with no value as a missing provider, so shape-sniffing would
      silently drop every role result.
    decision: Add kind with value bearer or role and branch on it.
    consequences: A small contract addition, and the same lesson applied to the SSM value encoding.
  - id: dec-codex-scope
    title: Codex is out of the verified set for v1
    status: accepted
    context: >-
      Codex uses bedrock-mantle rather than bedrock-runtime, and mantle in this region serves none of
      the model ids tried. Its configured id is also a bare foundation-model id, which the grant
      fence deliberately denies.
    decision: Include the mantle grant statement, document Codex as unverified, and track both defects separately.
    consequences: Codex works the moment its defects are fixed, with no further IAM change.
  - id: dec-litellm-provider
    title: LiteLLM will be a new provider, not a third bedrock mode
    status: accepted
    context: >-
      LiteLLM is non-AWS, carries a non-secret base URL beside its secret, and has no IAM surface.
      Kiro is the in-tree precedent for a key-based provider.
    decision: Reserve a future litellm provider beside kiro and keep the CLI-to-provider map free of deeper Bedrock coupling.
    consequences: The static AGENT_CLI_PROVIDER map must eventually become binding-dependent; nothing in v1 makes that harder.
  - id: dec-value-encoding
    title: JSON in the existing SSM parameter
    status: accepted
    context: Alternatives were sniffing for an arn prefix, or adding a second parameter.
    decision: Store JSON in the existing parameter; a plain string remains a bearer token.
    consequences: >-
      No new path or IAM pattern and full backwards compatibility. A third credential mode is the
      trigger to replace shape-sniffing with an explicit discriminator field.
  - id: dec-external-id-scope
    title: External ID required cross-account, optional same-account
    status: accepted
    context: Confused deputy is a third-party problem, and a same-account trust policy already names only the broker role.
    decision: Require the external ID for cross-account bindings only.
    consequences: The simplest single-account deployment manages no additional value, and none is generated for it.
  - id: dec-external-id-not-secret
    title: The external ID is platform-generated, non-secret, and re-readable rather than shown once
    status: accepted
    context: >-
      req-external-id-lifecycle originally required the value never be returned to a client, which
      contradicted the bootstrap order in req-same-and-cross-account: an operator cannot write
      sts:ExternalId into a trust policy without seeing it. Resolving it needed AWS's own position
      rather than a preference. AWS states that the value "must be generated by Example Corp and not
      their customers", and separately that "AWS does not treat the external ID as a secret ... The
      external ID for a role can be seen by anyone with permission to view the role", contrasting it
      with an access key which cannot be viewed again
      (https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html).
      The protective property is that the ASSUMING party controls the value, not that it is hidden:
      the trust policy names the broker role as its only principal, so role ARN plus external ID is
      useless to any caller that is not the broker. Verified empirically that STS accepts the full
      documented charset including the underscore that base64url emits, an AssumeRole probe returning
      AccessDenied rather than ValidationError for each of the symbol classes, so the generator cannot
      produce a value the API rejects even though the user-guide prose omits underscore.
    decision: >-
      Generate the value platform-side, never accept a client-supplied one, and return it idempotently
      on any read gated to a principal that may modify the binding. Reject the show-once pattern.
    consequences: >-
      Bootstrap, rotation, disaster recovery and any later IaC reconciliation become plain reads.
      Show-once would have made each of them a rotation carrying the interim AssumeRole failure window,
      an availability cost paid for a confidentiality property AWS explicitly disclaims, and the cost
      would grow with the number of spaces an operator has to reconcile. The residual exposure is to a
      principal that can already overwrite the binding, so nothing is weakened. Operator-supplied
      external IDs are rejected outright as contrary to AWS guidance and to per-binding uniqueness.
      Noted for the future: AWS recommends one external ID per AWS account, which coincides with
      per-binding uniqueness while each space binds its own role, but diverges when many spaces share
      one role -- there the operator must enumerate each space's value in one trust policy, which the
      session-name condition already achieves, so a shared role should prefer a single
      platform-scope binding.
  - id: dec-external-id-storage
    title: The external ID lives in its own per-scope parameter, not only inside the binding
    status: accepted
    context: >-
      req-binding-preflight refuses to persist a binding whose AssumeRole fails, and
      req-same-and-cross-account's bootstrap order requires the operator to see the external ID
      before they can write the trust policy the preflight checks. If the value existed only inside
      the binding, the first (necessarily failing) cross-account save would discard it and the retry
      would generate a different one, so the trust policy the operator had just written would already
      be stale and the bootstrap would never converge.
    decision: >-
      Generate the value idempotently into a dedicated per-scope parameter — {prefix}/bedrock-external-id
      and {prefix}/projects/<projectId>/bedrock-external-id — and copy it into the binding value when a
      save succeeds. The binding remains the single value the broker reads, so resolution is unchanged.
    consequences: >-
      The value is stable across rejected saves, so the two-attempt cross-account bootstrap converges
      and recovery is a plain read. The parameter deliberately sits OUTSIDE the agent-credentials
      paths: the external ID is not a credential, so the settings API can read its own generated value
      back without gaining any read permission on credential material, and the broker's
      exclusive-read discipline for credentials is untouched. Costs one new SSM path and a small IAM
      statement. A generated value can outlive the binding it was made for; it is inert, and reusing
      it on a later binding for the same scope is the intended behaviour.
  - id: dec-user-scope-role-deferred
    title: Role bindings are deferred at user scope; user scope stays bearer-only in v1
    status: accepted
    context: >-
      Per con-user-scope-self-service, PUT /users/me/agent-credentials is gated only on
      authentication, so any member could name a role ARN, and per con-session-name-condition a
      customer trust policy that omits the session-name condition lets any space holding the ARN use
      the role. A user-scope role also has no coherent attribution story - cost lands in the account
      owning the user's role while the session name reports the space.
    decision: Reject a role object at user scope in v1; leave the user-scope bearer path untouched.
    consequences: >-
      Chosen because it is the reversible direction - permitting a scope later is backwards
      compatible, forbidding one later is a breaking change. Costs one validation rule instead of a
      third scope's UI and documentation. Revisit if a per-user billing requirement appears, by which
      time a gateway with per-user virtual keys is the better mechanism anyway.
  - id: dec-session-name-contract
    title: The session-name format becomes a customer-facing authorization contract
    status: accepted
    context: >-
      sts:RoleSessionName is a documented trust-policy condition key, so the recommended template can
      make one Bedrock role space-aware with no platform code. That is the only control that scopes a
      shared role to a space, and it is strictly better than the alternatives considered.
    decision: Recommend the condition in the trust-policy template and treat aidlc-<projectId> as stable.
    consequences: >-
      The format can no longer be changed silently - customer trust policies will depend on it, so a
      change is a breaking migration. This also constrains the gateway future: collapsing to a single
      platform role would break every trust policy carrying the condition, which must be planned for
      rather than discovered.
  - id: dec-assumable-role-default
    title: Path-scoped default for bedrock_assumable_role_arns
    status: accepted
    context: >-
      A bare wildcard would leave the target trust policy as the only control. The trust policy is
      inherently authoritative for BYOR, so this is defence in depth against the broker being induced
      to assume an unintended role, not the primary control.
    decision: Default to ["arn:aws:iam::*:role/aidlc-bedrock-*"], with a bare wildcard as a documented opt-out.
    consequences: >-
      Imposes a role naming convention on the central Bedrock team. If they cannot rename, they set
      the wildcard explicitly, which makes the looser posture a deliberate choice. A mismatch is
      cheap to diagnose because req-binding-preflight reports it at save time. Narrowing the account
      field to real account ids is documented rather than expressed as a second variable.
  - id: dec-binding-preflight
    title: The bind-time preflight ships in v1
    status: accepted
    context: >-
      Without it, a wrong trust policy, a missing external ID, a session-name mismatch or a role
      outside the allowlist is discovered by a failing stage, which then retries, re-runs the whole
      attempt, fails again and reports a typed reason with no cause detail by design. Cross-account
      BYOR setup is exactly where operators err, and this is a sample evaluated in the operator's own
      account. Per con-broker-action-dispatch it reuses a seam the settings path already has.
    decision: Promote to must-have and implement as a control-plane-only broker action.
    consequences: >-
      Highest operator pain avoided per line of code in this change, and it is what makes both the
      naming convention of dec-assumable-role-default and the optional session-name condition cheap
      to get wrong. It is an input check, not a security control - a trust policy can change later.
  - id: dec-invocation-logging
    title: The platform does not enable model invocation logging
    status: accepted
    context: It is account-wide per region and captures every user's prompts and completions.
    decision: Document it as an optional operator step; rely on CloudTrail for attribution evidence.
    consequences: Per-request metadata tagging and AWS-side per-intent cost detail are unavailable until an operator enables it.
  - id: dec-spec-location
    title: Spec and ADR live outside the published docs site
    status: accepted
    context: >-
      zensical.toml declares an explicit nav, so a file under docs/ is either published or orphaned.
      A spec under .kiro/ is worse still, because .gitignore excludes that directory outright.
    decision: >-
      Keep the three-file spec set under specs/ and the rationale ADR under adr/, both outside docs/
      and both tracked, so the published site and its nav are untouched.
    consequences: >-
      The design is not published with the product documentation until someone decides it should be.
      Anything written under .kiro/ would be uncommittable and therefore invisible to a contribution.
      AMENDED once role mode shipped: the published docs asserted "token auth is the only path" in
      four places, which this decision does not license, and an operator could not set a role up
      from published documentation at all. The operator PROCEDURE is therefore now published as
      docs/getting-started/bedrock-credentials.md with a zensical.toml nav entry, and the
      trust-policy templates moved there so only one copy exists. The spec set and the ADR stay
      outside docs/ as originally decided - publishing a runbook is not publishing a design.
```

Every decision is now accepted. The five previously-open items were resolved by verification rather than by preference: `dec-user-scope-role-deferred` and `dec-session-name-contract` follow from `con-user-scope-self-service` and `con-session-name-condition`; `dec-binding-preflight` from `con-broker-action-dispatch` making it cheap; `req-expiry-tripwire` from `con-stage-reason-structured` making it nearly free; and `dec-external-id-not-secret` from AWS's own documented position, which reversed the "never returned" property this spec originally asserted. The remaining judgement call is `dec-assumable-role-default`, which is a naming convention the central Bedrock team can override by setting the variable.

## Acceptance and verification

Per-requirement criteria are in the `requirements:` block of [requirements.md](requirements.md). These must be demonstrated end to end.

1. **In-container credential delivery** — Claude Code and OpenCode each complete a Bedrock call inside the AgentCore container using only the three environment variables.
2. **Fail-closed** — with resolution deliberately returning nothing, the stage fails, and neither the CLI nor the reserved MCP child invokes Bedrock under the execution-role identity.
3. **Attribution** — CloudTrail shows `aidlc-<projectId>` in `userIdentity.arn` for a stage's invocations.
4. **Negative controls, each failing closed** — a mismatched `projectId`; a malformed binding at write time; a role object written to a user-scope binding; a cross-account binding with no external ID; a role ARN outside `bedrock_assumable_role_arns`; a trust policy whose `sts:RoleSessionName` condition names a different space; an expired grant.
5. **Cross-tenant probe** — a container in space A cannot obtain space B's credentials even when naming B's identifiers.
6. **Redaction** — no session token or secret access key in any log group, and none under `/mnt/workspace`, after a full stage run.
7. **Capabilities** — all three Bedrock CLIs report `available: true` on the role path, with no `AssumeRole` in CloudTrail for the settings request.
8. **UI** — a role-only scope renders as configured in both cards, with the bearer field marked deprecated.
9. **Model fan-out** — a real Claude Code stage succeeds with the family-pattern grant, and CloudTrail confirms more than one model id.
10. **Bearer regression** — an existing bearer-configured space behaves exactly as before.
11. **Expiry** — a forced short credential produces `credential_expired`, one retry, and a tested terminal FAILED transition on exhaustion.

## References

- [operator-trust-policies.md](operator-trust-policies.md) — trust-policy templates and the binding bootstrap
- [operator-runbook.md](operator-runbook.md) — the expiry tripwire, failure-code triage, spend attribution, Codex status
- [ADR-0001](../../adr/0001-bedrock-iam-role-credential-mode.md) — rationale, alternatives, probe transcripts
- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) · [SEC02-BP02](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/sec_identities_unique.html) · [AGENTSEC03-BP03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec03-bp03.html) · [GENSEC01-BP01](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/gensec01-bp01.html)
- [AgentCore credentials management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/security-credentials-management.html) — the MMDS warning
- [IAM principal attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html) · [Application inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html)
- [Role chaining one-hour limit](https://repost.aws/knowledge-center/iam-role-chaining-limit) · [Pass session tags in AWS STS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html)
- [External ID](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) · [Confused deputy](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
