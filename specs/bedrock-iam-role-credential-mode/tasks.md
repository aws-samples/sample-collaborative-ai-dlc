---
artifactType: tasks
title: Bedrock IAM-role credential mode
status: draft
baseCommit: 8e67ac5
---

# Tasks — Bedrock IAM-role credential mode

This is the implementation plan for the [design](design.md), traced back to the [requirements](requirements.md). Phases are ordered so that **each one leaves the system coherent and is independently shippable**, with the irreducible risk first. Operator documentation is written where it is needed rather than deferred to the end, because a trust-policy template is a prerequisite for testing role mode at all, not a write-up of it.

## Implementation plan

### Phase 0 — unblock

Ships alone, changes nothing for bearer users, and removes the gate that would otherwise report the three Bedrock CLIs unavailable under role mode.

- [x] 1. Fix `lambda/agentcore/commands/capabilities.js:21` so availability derives from the resolved binding rather than from the `AWS_BEARER_TOKEN_BEDROCK` marker variable. Completion: all three Bedrock CLIs report `available: true` when the resolved binding is usable, no `AssumeRole` appears in CloudTrail for a capabilities request, and a missing `KIRO_API_KEY` still reports Kiro unavailable.
      _Requirements: req-capabilities-authed_

### Phase 1 — the credential path, platform scope, same account

The narrowest change that produces a real role-mode invocation, and where all the risk lives. Configured through the API; no UI yet. The typed failure reasons belong here rather than later: a legible credential failure is the tool used to build the rest, not a follow-up to it.

- [x] 2. In `lambda/shared/agent-credentials.js`, discriminate the bearer value from the role value and add the three AWS names to `AGENT_CREDENTIAL_ENV_NAMES`. Completion: a trimmed value beginning with an opening brace parses as an object carrying a valid `roleArn` else the write is rejected, any other non-empty value is treated as a bearer token and not parsed, and `cleanBaseEnv` scrubs `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` from the base environment every invocation.
      _Requirements: req-role-credential-mode, req-single-parameter-encoding, req-credential-delivery-env_

- [x] 3. In `lambda/credential-broker/index.js`, perform `AssumeRole` for a role binding, compose `RoleSessionName` as `aidlc-<projectId>`, return the `kind`-discriminated result, and add the four error codes to the allowlist. Completion: the role ARN and external ID are read from SSM at resolution time, `DurationSeconds` is 3600 and not configurable, no `Tags` parameter is sent, a role result carries `credentials` with `AccessKeyId`, `SecretAccessKey`, `SessionToken` and `Expiration` and no `value` field, and failures return one of `BEDROCK_ROLE_BINDING_INVALID`, `BEDROCK_ROLE_ASSUME_DENIED`, `BEDROCK_ROLE_ASSUME_THROTTLED` or `BEDROCK_ROLE_RESOLUTION_FAILED` with no STS or provider error text logged or returned.
      _Requirements: req-broker-side-assume, req-broker-credential-resolution, req-session-name-attribution, req-session-name-trust-condition_

- [x] 4. In `lambda/agentcore/auth-resolver.js`, branch on `kind` and set the three variables into the invocation clone for a role result. Completion: the three variables are written only into the per-invocation environment clone and never into `process.env`, `AWS_BEARER_TOKEN_BEDROCK` is not set on the role path, and the resolver never infers the shape from field presence.
      _Requirements: req-credential-delivery-env, req-broker-credential-resolution_

- [x] 5. In `lambda/agentcore/cli/drivers.js`, forward the three variables in each `envForAuth` block when no bearer token is present. Completion: each of the three `envForAuth` blocks forwards `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` when no bearer is present, the existing region resolution is untouched, and nothing is installed into the agent image for this feature.
      _Requirements: req-credential-delivery-env_

- [x] 6. In the `lambda/v2-orchestrator` stage failure path, add the `credential_expired` and `credential_resolution_failed` reasons plus the tested terminal transition. Completion: an expired credential terminates the stage with reason `credential_expired`, a failed resolution with reason `credential_resolution_failed`, the retry resolves credentials afresh through the normal invocation path reading the existing durable stage-attempt retry budget, and on budget exhaustion the stage ends FAILED carrying the same reason with that terminal transition tested.
      _Requirements: req-expiry-failure-legible_

- [x] 7. In `lambda/agents/index.js`, add binding validation only, including the user-scope rejection, plus the recomputed `bedrockBearerTokenSet` so the existing cards do not report a role-only scope as unconfigured. Completion: validation lives in the settings write path so a malformed value can never reach a stage, `roleArn` matches `^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+` and is at most 2048 characters, `externalId` when present is 2 to 1224 characters matching `[\w+=,.@:/-]*`, a role object written to a user-scope binding is rejected with a typed error naming the unsupported scope, and `bedrockBearerTokenSet` is recomputed as configured AND not parseable as a role object.
      _Requirements: req-single-parameter-encoding, req-role-credential-mode, req-configured-semantics_

- [x] 8. In `terraform`, add `sts:AssumeRole` on the broker role with the `bedrock_assumable_role_arns` default, the Bedrock role grant per `req-model-grant-families`, and a test asserting the execution role holds no Bedrock, mantle or STS action. Completion: `bedrock_assumable_role_arns` defaults to `["arn:aws:iam::*:role/aidlc-bedrock-*"]` with a bare wildcard as a documented opt-out, the grant covers the Anthropic and OpenAI inference-profile patterns including `global.openai.gpt-*` with no `eu.openai` pattern, foundation-model ARNs are region-wildcarded and fenced by a `StringLike` condition on `bedrock:InferenceProfileArn`, a `bedrock-mantle:CreateInference` statement scoped to `project/*` is present, and a test asserts the execution role policy contains no `bedrock`, `bedrock-mantle` or `sts` action and that a stage whose resolution produced nothing fails rather than invoking.
      _Requirements: req-least-privilege-assume, req-model-grant-families, req-execution-role-no-bedrock_

- [x] 9. Confirm the agent credential grant module is not modified. Completion: `agent-credential-grants.js` is unchanged, `AGENT_CREDENTIAL_GRANT_TTL_SECONDS` remains 300 for every purpose, no binding carries a mode field so `normalizeCredentialBinding` needs no change, the grant is still deleted from the handler payload before the handler runs, no new grant purpose is introduced, and broker resolution including the STS round trip completes inside the 300s grant window on a cold start with a first-expiring grant surfacing as a typed resolution failure.
      _Requirements: req-grant-model-unchanged_

- [x] 10. Write the two trust-policy templates, including the `sts:RoleSessionName` condition, and surface the broker role ARN in the docs. Completion: the recommended template includes a `sts:RoleSessionName` condition with `StringEquals` for one space and `StringLike` for a documented set, the `aidlc-<projectId>` format is documented as stable with changing it a breaking change requiring a migration note, omitting the condition is documented as letting any space holding the ARN use the role, and the gateway-migration consequence is recorded.
      _Requirements: req-session-name-trust-condition, req-session-name-attribution_

### Phase 2 — the operator surface

Everything a customer touches, and the point at which role mode becomes usable without the API.

- [x] 11. In `lambda/agents/index.js`, add `bedrockMode`, `bedrockRoleArn`, `bedrockExternalIdSet`, external-ID generation and the bootstrap ordering. Completion: every scope status response adds `bedrockMode` with value bearer or role or null and `bedrockExternalIdSet` as a boolean, `bedrockRoleArn` as string or null is added only on a response gated to a principal that may modify that binding, the external ID is generated from a CSPRNG with at least 128 bits of entropy unique per binding of a space to a role, a client-supplied external ID is refused, the value is stored SecureString and returned idempotently on every gated read rather than once at generation (`dec-external-id-not-secret`), no external ID is generated for a same-account binding by default, a test asserts a role binding yields `bedrockBearerTokenSet` false, `bedrockMode` role and a populated `bedrockRoleArn`, and a test asserts the lower-privilege agent settings read — reachable by any authenticated user — returns neither the external ID nor the role ARN.
      _Requirements: req-configured-semantics, req-external-id-lifecycle_

- [x] 12. In `lambda/credential-broker/index.js`, add the control-plane preflight action. Completion: saving a role binding attempts an `AssumeRole` and reports a typed failure without persisting an unusable binding, the preflight runs in the broker with no `sts:AssumeRole` added to any other role, it performs no model invocation, it names the cause category without echoing provider text distinguishing a missing principal, a failed external ID, a session-name condition mismatch and a role outside the allowlist, it is not invoked in a loop, and it is documented as an input check and not a security control.
      _Requirements: req-binding-preflight_

- [x] 13. Update both credential cards for mode-aware `configured`, role recommended, bearer deprecated, ARN shown, external ID revealable. Completion: a scope with a role binding and no secret reports configured in both `frontend/src/components/admin/AgentCredentialsCard.tsx` and `frontend/src/components/settings/AgentCredentialScopeCard.tsx`, role mode is presented as recommended and the bearer field labelled deprecated with a one-line reason, the role ARN is shown, and the external ID is presented as copyable rather than write-only because an operator must paste it into a trust policy — masked by default with an explicit reveal, since it is non-secret but tenant-identifying (`dec-external-id-not-secret`). Both cards already sit behind a gate that permits modifying the binding, so neither needs a new one.
      _Requirements: req-configured-semantics, req-bearer-deprecated_

- [x] 14. Implement the space-scope override and the cross-account path with a required external ID. Completion: a space-scope role binding overrides the platform binding for that space only, a role ARN in the platform account resolves without an external ID, a role ARN in another account resolves with an external ID and is rejected without one, and the broker role ARN is surfaced in the admin UI so an operator can paste it into a trust policy.
      _Requirements: req-same-and-cross-account_

- [x] 15. Document the external-ID bootstrap and rotation, including the interim `AssumeRole` failure window. Completion: the bootstrap order is documented as generate the external ID, surface it to the operator, operator writes the trust policy, save the binding, preflight; rotation is documented as generate, operator updates the trust policy, save, preflight, with the interim `AssumeRole` failure window stated; the value is documented as non-secret per AWS and therefore re-readable by an authorized operator rather than shown once, with recovery from a lost value being a plain read and not a rotation; and the shared-role case is documented, where several spaces using one role would each carry a distinct external ID that the trust policy must enumerate, so a single platform-scope binding is preferred and the session-name condition already provides the per-space scoping.
      _Requirements: req-external-id-lifecycle, req-same-and-cross-account_

### Phase 3 — hardening and the evidence base

Nothing here blocks a customer, and all of it protects the design's assumptions.

- [x] 16. Count the `credential_expired` reason and record the trigger in the runbook. Completion: the `credential_expired` reason is countable over a time window without a bespoke log query, a non-zero count is documented as the trigger to revisit `dec-v1-no-refresh`, the runbook states the trigger, and no new telemetry pipeline, metric namespace or duration histogram is introduced.
      _Requirements: req-expiry-tripwire_

- [x] 17. Add typed SSM and STS throttling failures and document the propagation behaviour. Completion: SSM throttling and STS throttling both surface as typed resolution failures rather than generic errors, a binding change takes effect on the next resolution subject to SSM propagation documented rather than promised as immediate, and a role deleted or a trust policy changed mid-stage surfaces as a typed failure on the next resolution.
      _Requirements: req-resolution-resilience_

- [x] 18. Add the custom-server MCP exclusion test, the no-credential-material-under-`/mnt/workspace` test, the no-secret-in-any-log-group test, and the bearer regression test. Completion: `con-custom-server-excluded` is pinned by a test, no credential material is present under `/mnt/workspace` after a role-mode stage asserted for the per-stage `CODEX_HOME` and any written CLI config path, no session token or secret access key is left in any log group after a full stage run, a test asserts `AWS_BEARER_TOKEN_BEDROCK` is unset on the role path, and an existing bearer-configured space behaves exactly as before, with a negative test proving the reserved MCP child cannot invoke Bedrock when resolution returned nothing.
      _Requirements: req-credential-safety, req-codex-scope, req-execution-role-no-bedrock, req-litellm-seam_

- [x] 19. Write the CUR 2.0 caller-identity runbook, the invocation-logging caveat, the bearer deprecation notice, and the Codex-unverified record. Completion: Codex is documented as unverified end-to-end with both defects recorded separately and no acceptance criterion depending on a successful Codex invocation, the mantle grant statement is present so Codex works the moment its defects are fixed, the up-to-3600s revoked-binding window is documented as an accepted risk, and the bearer-versus-role distinction stays inside the binding value and never in the provider name with `AGENT_CLI_PROVIDER` gaining no additional hardcoded dependence on Bedrock.
      _Requirements: req-codex-scope, req-credential-safety, req-bearer-deprecated, req-litellm-seam_

### Phase 4 — evidence-gated, may never ship

Entered only if the Phase 3 counter is non-zero.

- [ ] 20. If and only if the Phase 3 `credential_expired` counter is non-zero, reopen `dec-v1-no-refresh` and build a loopback container-credentials endpoint plus a bounded refresh grant. Completion: Phase 4 exists only if Phase 3 evidence reopens `dec-v1-no-refresh`; otherwise this task is not entered.
      _Requirements: req-expiry-tripwire_

## Untouched, deliberately

The following are deliberately left unmodified in v1:

- `agent-credential-grants.js`
- the AgentCore execution role's IAM
- the `http-server.js` payload-deletion discipline and the `:305` context seam
- the credential hierarchy and its precedence
- the SSM path scheme
- Kiro's provider
- `model-resolver.js`
- the in-app cost computation
- the published documentation site
