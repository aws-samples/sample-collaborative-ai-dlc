---
artifactType: requirements
title: Bedrock IAM-role credential mode
status: draft
baseCommit: 8e67ac5
---

# Requirements — Bedrock IAM-role credential mode

Rationale and alternatives live in [ADR-0001](../../adr/0001-bedrock-iam-role-credential-mode.md). This document is the requirements portion of the implementable contract; the design and tasks live beside it. Every `file:line` citation is valid at pure upstream `8e67ac5`.

> **This spec supersedes ADR-0001 §2 (the refresh sentences), §3 and §5–6 on v1 scope.** The ADR describes a v1 that includes a refresh-scoped grant, a broker refresh action and a credential-helper binary. Measured stage durations and the constraint to change as little as possible removed all of that from v1. Where the two disagree, this spec governs; the ADR remains the record of why the alternatives were considered.

## Scope

Add an **IAM role mode** to the existing `bedrock` credential provider in the `user → space → platform` hierarchy (`lambda/shared/agent-credentials.js:9`). "Central default plus per-space override" is that existing precedence; no new plane, page or hierarchy is introduced.

**In scope:** role-mode credential resolution for Claude Code and OpenCode; broker-side `AssumeRole`; same-account and cross-account; per-invocation credential delivery; deprecating the bearer path; correcting the "configured" semantics; the capabilities fix; the grant shape for both endpoint families.

**Out of scope, deliberately:** any refresh mechanism (no refresh grant, no broker _refresh_ action, no credential-helper binary, no redemption counter); **role bindings at user scope** (`dec-user-scope-role-deferred`); cost-allocation-tag activation; AWS Budgets; per-space role minting; per-space model allowlists; a CUR export; an in-product billed-cost view; `AssumeRoleWithWebIdentity`; enabling model invocation logging; and Codex end-to-end (`con-codex-mantle`, `con-codex-model-missing`).

A **control-plane-only** broker action for the bind-time preflight is in scope and is not a refresh action: it is unreachable from a container, mints nothing that leaves the control plane, and extends the existing `event.action` dispatch (`con-broker-action-dispatch`).

## Requirements

```yaml
requirements:
  - id: req-role-credential-mode
    title: Bedrock provider accepts an IAM role binding at space and platform scope
    category: functional
    priority: must-have
    description: >-
      The existing bedrock provider gains a role mode alongside the bearer token. Mode is a property
      of the stored binding value, not of the deployment. v1 permits role bindings at space and
      platform scope only; user scope stays bearer-only per dec-user-scope-role-deferred.
    acceptance_criteria:
      - WHEN a space sets no binding of its own THEN the system SHALL use the platform-scope role binding for that space
      - WHEN a space sets a space-scope role binding THEN the system SHALL override the platform binding for that space only
      - WHEN a role object is written to a user-scope binding THEN the system SHALL reject it at write time with a typed error naming the unsupported scope
      - WHEN an existing plain-string bearer value is resolved at any scope including user THEN the system SHALL continue to resolve it as a bearer token with no migration
      - THE SYSTEM SHALL introduce no new SSM parameter path and no new IAM path pattern
      - THE SYSTEM SHALL introduce no deployment-wide auth-method selector, and none exists at baseline per con-no-auth-method-selector
  - id: req-bearer-deprecated
    title: The bearer token becomes a deprecated legacy path
    category: constraint
    priority: must-have
    description: >-
      AWS IAM best practice enumerates the cases where long-term credentials remain acceptable and
      none covers this workload, so role mode is the recommended default.
    acceptance_criteria:
      - THE SYSTEM SHALL present role mode as recommended in both credential cards
      - THE SYSTEM SHALL label the bearer field deprecated with a one-line reason
      - THE SYSTEM SHALL break no existing deployment, keeping the bearer path working unchanged
      - THE SYSTEM SHALL contain no code path that mints, creates or rotates any long-lived credential
  - id: req-single-parameter-encoding
    title: Role bindings are stored in the existing single bedrock SSM parameter
    category: constraint
    priority: must-have
    description: >-
      The parameter holds either today's plain bearer string or a JSON object
      carrying roleArn and optional externalId. Every pre-existing value is a plain string and
      therefore still a bearer token, making this backwards compatible by construction.
    acceptance_criteria:
      - WHEN a trimmed value begins with an opening brace THEN the system SHALL parse it as an object carrying a roleArn, else the write SHALL be rejected
      - THE SYSTEM SHALL require roleArn to match ^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+ and be at most 2048 characters
      - WHEN externalId is present THEN the system SHALL require it to be 2 to 1224 characters and to match the STS ExternalId charset [\w+=,.@:/-]*
      - WHEN a non-empty value is any other shape THEN the system SHALL treat it as a bearer token and SHALL NOT parse it
      - THE SYSTEM SHALL leave isConfiguredCredentialValue semantics unchanged, meaning non-empty and not the literal placeholder
      - THE SYSTEM SHALL locate validation in the settings write path so a malformed value can never reach a stage
  - id: req-broker-side-assume
    title: The credential broker performs the AssumeRole, never the container
    category: functional
    priority: must-have
    description: >-
      The broker is already the sole IAM principal permitted to read credential material and already
      validates a signed grant against the execution record, so it is already the trusted resolver.
      Per con-role-chaining-3600 the 3600s duration is the hard chaining ceiling, not a choice.
    acceptance_criteria:
      - THE SYSTEM SHALL require the target role trust policy to name exactly one principal, the broker role ARN
      - THE SYSTEM SHALL never accept a role ARN from the container and SHALL resolve the binding server-side from the verified projectId
      - THE SYSTEM SHALL make the broker the single place that composes RoleSessionName as aidlc-<projectId>
      - THE SYSTEM SHALL set DurationSeconds to 3600 and SHALL NOT make it configurable, per the con-role-chaining-3600 ceiling
      - THE SYSTEM SHALL send no Tags parameter on AssumeRole, per con-tagsession-required
  - id: req-execution-role-no-bedrock
    title: The AgentCore execution role holds no Bedrock or STS permission
    category: non-functional
    priority: must-have
    description: >-
      Per con-mmds-chain-live the container credential chain reaches the execution role and is
      deliberately forwarded to the reserved MCP child, so it cannot be removed. Fail-closed
      therefore rests entirely on that role's policy holding nothing useful, which must be pinned by
      a test rather than assumed.
    acceptance_criteria:
      - THE SYSTEM SHALL keep the execution role policy free of any bedrock, bedrock-mantle and sts action
      - THE SYSTEM SHALL include a test that asserts the absence of those actions so a future change cannot reintroduce them
      - WHEN credential resolution produces nothing THEN the system SHALL fail the stage rather than invoke successfully
      - THE SYSTEM SHALL include a negative test proving the reserved MCP child cannot invoke Bedrock when resolution returned nothing
      - THE SYSTEM SHALL NOT claim in spec text that the credential chain is absent, only that the policy makes it inert
  - id: req-credential-delivery-env
    title: Credentials reach each CLI as three environment variables, per invocation
    category: functional
    priority: must-have
    description: >-
      No helper binary, no credential_process, no awsCredentialExport, no local credential endpoint.
      Per con-cli-env-creds this is verified sufficient for Claude Code and OpenCode at the
      con-pinned-versions builds, and per con-auth-context-seam the resolved context already reaches a
      detached stage job, so no plumbing change is needed for a stage that outlives its invocation.
    acceptance_criteria:
      - WHEN the broker returns a role result THEN auth-resolver SHALL set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN
      - THE SYSTEM SHALL write the three variables only into the per-invocation environment clone, never into process.env
      - THE SYSTEM SHALL make all three members of AGENT_CREDENTIAL_ENV_NAMES so cleanBaseEnv scrubs them from the base environment every invocation
      - THE SYSTEM SHALL have each of the three envForAuth blocks forward them when no bearer token is present
      - THE SYSTEM SHALL make a resolved binding either bearer or role and never both per con-one-binding-per-provider, so no driver-level precedence rule is needed
      - THE SYSTEM SHALL install nothing into the agent image for this feature
  - id: req-broker-credential-resolution
    title: The broker returns an explicitly discriminated result
    category: functional
    priority: must-have
    description: >-
      The only contract change. Per con-missing-value-is-missing the resolver treats a result with no
      value as missing, so shape-sniffing is unsafe and an explicit discriminator is required.
    acceptance_criteria:
      - THE SYSTEM SHALL have every credential entry carry kind with the value bearer or role
      - THE SYSTEM SHALL have a bearer entry keep its current value field and its current meaning
      - THE SYSTEM SHALL have a role entry carry credentials with AccessKeyId, SecretAccessKey, SessionToken and Expiration, and no value field
      - THE SYSTEM SHALL have the resolver branch on kind and never infer the shape from field presence
      - THE SYSTEM SHALL read the role ARN and external ID from SSM at resolution time, never from the request
      - WHEN resolution fails THEN the system SHALL return one of BEDROCK_ROLE_BINDING_INVALID, BEDROCK_ROLE_ASSUME_DENIED, BEDROCK_ROLE_ASSUME_THROTTLED or BEDROCK_ROLE_RESOLUTION_FAILED, added to the existing allowlist
      - THE SYSTEM SHALL log or return no STS or provider error text, only the allowlisted code
  - id: req-grant-model-unchanged
    title: The agent credential grant module is not modified
    category: constraint
    priority: must-have
    description: >-
      v1 adds no purpose, no claim field, no TTL change and no second redemption path. Verified
      possible because the grant authorizes which binding path may be read, while bearer-versus-role
      is a property of the value the broker reads downstream of the grant. The control-plane preflight
      action is outside the grant model entirely, since it is not container-reachable.
    acceptance_criteria:
      - THE SYSTEM SHALL leave agent-credential-grants.js unchanged
      - THE SYSTEM SHALL keep AGENT_CREDENTIAL_GRANT_TTL_SECONDS at 300 for every purpose, per con-grant-ttl-300
      - THE SYSTEM SHALL have no binding carry a mode field, so normalizeCredentialBinding needs no change
      - THE SYSTEM SHALL still delete the grant from the handler payload before the handler runs, preserving con-grant-destroyed
      - THE SYSTEM SHALL introduce no new grant purpose, and the preflight action SHALL require no grant because it is reachable only from the control plane
      - WHEN broker resolution runs including the STS round trip on a cold start THEN it SHALL complete inside the 300s grant window, and a grant that expires first SHALL surface as a typed resolution failure
  - id: req-model-grant-families
    title: The grant is provider-family scoped and covers both endpoint families
    category: functional
    priority: must-have
    description: >-
      Per con-claude-model-fanout no allowlist narrower than the provider family is viable. Per
      con-gpt-global-cris-only GPT is reachable only through global CRIS. Per con-codex-mantle Codex
      uses a different service namespace.
    acceptance_criteria:
      - THE SYSTEM SHALL grant Anthropic and OpenAI inference-profile patterns, including global.openai.gpt-*
      - THE SYSTEM SHALL grant no eu.openai pattern, because no such profile exists
      - THE SYSTEM SHALL region-wildcard foundation-model ARNs and fence them by a StringLike condition on bedrock:InferenceProfileArn
      - THE SYSTEM SHALL include a bedrock-mantle:CreateInference statement scoped to project/* for Codex
      - THE SYSTEM SHALL make every account id in the grant the account that owns the Bedrock role, which may differ from the platform account
      - THE SYSTEM SHALL introduce no per-space or per-model allowlist narrower than the provider family
  - id: req-same-and-cross-account
    title: Same-account and cross-account are one code path
    category: functional
    priority: must-have
    description: >-
      Customers deploy into their own environments, so the central Bedrock account may or may not be
      the platform account. The only difference is the customer-written trust policy.
    acceptance_criteria:
      - WHEN a role ARN is in the platform account THEN the system SHALL resolve it without an external ID
      - WHEN a role ARN is in another account THEN the system SHALL resolve it with an external ID and SHALL reject it without one
      - THE SYSTEM SHALL require the external ID for cross-account bindings and make it optional for same-account
      - THE SYSTEM SHALL surface the broker role ARN in the admin UI so an operator can paste it into a trust policy
      - THE SYSTEM SHALL surface the Bedrock role ARN of a binding only on a read path gated to a principal that may modify that binding, since it is non-secret but tenant-identifying and no lower-privilege surface needs it
      - THE SYSTEM SHALL document the bootstrap order as generate the external ID, surface it to the operator, operator writes the trust policy, save the binding, preflight
  - id: req-external-id-lifecycle
    title: The external ID is platform-generated, non-secret, and readable by an authorized operator
    category: non-functional
    priority: must-have
    description: >-
      Properties were previously asserted without saying who generates the value, when, or how
      rotation works. Rotation is a coordinated two-party change with a failure window.

      AWS is explicit that the platform must generate this value and that it is not a secret: "it must
      be generated by Example Corp and not their customers to ensure each external ID is unique", and
      "AWS does not treat the external ID as a secret ... The external ID for a role can be seen by
      anyone with permission to view the role"
      (https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html).

      The security property is therefore CONTROL of the value, not confidentiality: the trust policy
      names the broker role as its only principal, so the pair of role ARN and external ID is useless
      to any caller that is not the broker. An earlier revision of this requirement said the value is
      never returned to a client, which contradicted the bootstrap order in req-same-and-cross-account
      -- an operator cannot write sts:ExternalId into a trust policy without seeing it. The
      contradiction is resolved in favour of readability, because withholding the value buys no
      confidentiality that AWS claims for it while making bootstrap, rotation and recovery each
      require a rotation with the interim failure window below.
    acceptance_criteria:
      - THE SYSTEM SHALL generate the external ID from a CSPRNG with at least 128 bits of entropy, unique per binding of a space to a role
      - THE SYSTEM SHALL NOT accept a client-supplied external ID, because AWS requires the value to be controlled by the assuming party rather than the account owner
      - THE SYSTEM SHALL store it SecureString and SHALL return it only to a principal already authorized to modify that binding, idempotently on every such read rather than once at generation
      - THE SYSTEM SHALL report it only as set or not set on any read path reachable by a principal that cannot modify the binding, including the unauthenticated-scope agent settings read
      - THE SYSTEM SHALL keep it out of every log line, audit record and error message
      - THE SYSTEM SHALL NOT generate an external ID for a same-account binding by default, since dec-external-id-scope makes it unnecessary there and an unused stored value invites confusion
      - THE SYSTEM SHALL document rotation as generate, operator updates the trust policy, save, preflight, with the interim AssumeRole failure window stated
  - id: req-session-name-attribution
    title: Attribution is RoleSessionName only, composed in one server-side place
    category: functional
    priority: must-have
    description: >-
      Session tags would fail closed on any customer role whose trust policy omits sts:TagSession
      (con-tagsession-required). Per con-chained-attribution RoleSessionName is verified to reach
      CloudTrail for a chained session, which is the premise the whole showback model rests on.
    acceptance_criteria:
      - THE SYSTEM SHALL make the broker the only component that composes the session name
      - THE SYSTEM SHALL have no CLI driver and no container code compose or receive the mapping
      - THE SYSTEM SHALL keep RoleSessionName at most 64 characters and within the STS charset, which con-session-name-fits confirms for the current format
      - THE SYSTEM SHALL make the session name identify the space, not the stage, so concurrent stages in one space are indistinguishable in CloudTrail, stated rather than implied
      - THE SYSTEM SHALL activate no cost allocation tag, create no CUR export and create no budget
  - id: req-session-name-trust-condition
    title: The session-name format is a stability contract, because customers authorize on it
    category: constraint
    priority: must-have
    description: >-
      Per con-session-name-condition a customer can scope one Bedrock role to named spaces with a
      sts:RoleSessionName condition and no platform code. This is the only control that makes the
      trust policy space-aware, so it is the recommended default, and it turns the session-name
      format from an attribution detail into a customer-facing authorization contract.
    acceptance_criteria:
      - THE SYSTEM SHALL include a sts:RoleSessionName condition in the recommended trust-policy template, with StringEquals for one space and StringLike for a documented set
      - THE SYSTEM SHALL document the aidlc-<projectId> format as stable, and changing it SHALL be a breaking change requiring a migration note
      - THE SYSTEM SHALL document that omitting the condition lets any space holding the role ARN use the role, and that the platform cannot enforce it
      - THE SYSTEM SHALL name a session-name condition mismatch as a distinct likely cause in preflight failure guidance
      - THE SYSTEM SHALL record the consequence for a future gateway migration, since collapsing to one platform role would break every trust policy carrying this condition
  - id: req-configured-semantics
    title: Configured means a usable binding exists, not that a secret is set
    category: functional
    priority: must-have
    description: >-
      Two live instances derive configured from a secret being present, so a space holding a
      non-secret role ARN would render as having no credentials.
    acceptance_criteria:
      - WHEN a scope has a role binding and no secret THEN the system SHALL report it configured in both the admin and space cards
      - THE SYSTEM SHALL recompute bedrockBearerTokenSet as configured AND not parseable as a role object, preserving its meaning exactly
      - THE SYSTEM SHALL add bedrockMode with value bearer or role or null and bedrockExternalIdSet as a boolean to every scope status response
      - THE SYSTEM SHALL add bedrockRoleArn as string or null only on a response gated to a principal that may modify that binding, per req-same-and-cross-account
      - THE SYSTEM SHALL return the external ID value only on such a gated response and never on a lower-privilege one, per req-external-id-lifecycle
      - THE SYSTEM SHALL include a test asserting a role binding yields bedrockBearerTokenSet false, bedrockMode role and a populated bedrockRoleArn
      - THE SYSTEM SHALL include a test asserting the lower-privilege agent settings read returns neither the external ID nor the role ARN
  - id: req-capabilities-authed
    title: Capabilities answers from the resolved binding and never assumes a role
    category: functional
    priority: must-have
    description: >-
      lambda/agentcore/commands/capabilities.js:21 maps the three Bedrock CLIs to
      AWS_BEARER_TOKEN_BEDROCK and computes available as installed and authed, so role mode would
      gate out exactly the CLIs it enables. Minting to answer it would also mean an AssumeRole per
      settings render, which AWS warns can exceed STS request rate quotas.
    acceptance_criteria:
      - WHEN the resolved binding is usable THEN the system SHALL report all three Bedrock CLIs available true
      - THE SYSTEM SHALL produce no AssumeRole in CloudTrail for a capabilities request
      - THE SYSTEM SHALL leave Kiro unaffected, so a missing KIRO_API_KEY still reports unavailable
      - THE SYSTEM SHALL derive the answer from the resolved binding on the control plane, not from a marker variable in the container
  - id: req-expiry-failure-legible
    title: Credential expiry is a distinct, automatically retried stage failure
    category: functional
    priority: must-have
    description: >-
      There is no refresh mechanism in v1. Measured p99 stage duration is 20 minutes against a
      3600s credential, and the orchestrator already reconciles and retries failed stage attempts
      through the structured path of con-stage-reason-structured. Note con-stage-8h, one attempt may
      legitimately run 8 hours, so a long stage is not itself evidence of a fault.
    acceptance_criteria:
      - WHEN a credential expires THEN the system SHALL terminate the stage with reason credential_expired
      - WHEN a resolution fails THEN the system SHALL terminate the stage with reason credential_resolution_failed
      - THE SYSTEM SHALL make both reasons distinguishable in logs from a dead container and from a genuine agent failure
      - WHEN a stage retries THEN the system SHALL resolve credentials afresh through the normal invocation path
      - THE SYSTEM SHALL read the retry budget from the existing durable stage-attempt configuration and not reinvent it
      - WHEN the budget is exhausted THEN the system SHALL end the stage FAILED carrying the same reason, and that terminal transition SHALL be tested
      - THE SYSTEM SHALL document that a retry re-runs the whole stage attempt, so work before the expiry is lost
  - id: req-expiry-tripwire
    title: Credential expiry is counted, because it is the evidence that gates refresh
    category: functional
    priority: must-have
    description: >-
      Per con-stage-durations the no-refresh decision rests on a single outlier in a 27-day sample.
      Per con-stage-reason-structured the reason is already a persisted, UI-visible field, so counting
      the credential_expired reason measures the decision directly and costs almost nothing, which is
      why this replaced an earlier proposal to count stage attempts over a duration threshold.
    acceptance_criteria:
      - THE SYSTEM SHALL make the credential_expired reason countable over a time window without a bespoke log query
      - THE SYSTEM SHALL classify a stage failure that occurs after the resolved credential's own deadline as credential_expired, so the count does not depend on a CLI's stderr wording, which the platform does not control
      - THE SYSTEM SHALL accept that this can over-attribute a failure that happened after the deadline for an unrelated reason, because a false positive prompts a review while a false negative hides the evidence the decision rests on
      - THE SYSTEM SHALL document a non-zero count as the trigger to revisit dec-v1-no-refresh
      - THE SYSTEM SHALL state the trigger in the runbook, so the decision is revisited on evidence rather than after an incident
      - THE SYSTEM SHALL introduce no new telemetry pipeline, metric namespace or duration histogram for this
  - id: req-credential-safety
    title: Only short-lived credentials exist, and they are never persisted or logged
    category: non-functional
    priority: must-have
    description: >-
      Short-lived STS credentials are the only credential source, and no code path creates or
      persists any long-lived credential or logs any credential material.
    acceptance_criteria:
      - THE SYSTEM SHALL make sts:AssumeRole the only credential source, creating no access key, service-specific credential or API key
      - THE SYSTEM SHALL keep neither the broker role nor any platform role holding iam:CreateAccessKey or iam:CreateServiceSpecificCredential
      - THE SYSTEM SHALL keep credentials only in a per-invocation process environment
      - THE SYSTEM SHALL include a test asserting AWS_BEARER_TOKEN_BEDROCK is unset on the role path
      - THE SYSTEM SHALL leave no session token or secret access key in any log group after a full stage run
      - THE SYSTEM SHALL leave no credential material under /mnt/workspace after a role-mode stage, asserted for the per-stage CODEX_HOME and any written CLI config path
      - THE SYSTEM SHALL document the up-to-3600s window in which an already-minted credential outlives a revoked binding as an accepted risk
  - id: req-least-privilege-assume
    title: The broker's sts:AssumeRole resource is narrow by default
    category: non-functional
    priority: must-have
    description: >-
      The broker cannot know customer role ARNs at deploy time, but a wildcard default would leave
      the target trust policy as the only control.
    acceptance_criteria:
      - THE SYSTEM SHALL make a bedrock_assumable_role_arns variable the statement resource
      - THE SYSTEM SHALL set its default value to ["arn:aws:iam::*:role/aidlc-bedrock-*"]
      - THE SYSTEM SHALL keep a bare wildcard available as a documented explicit opt-out
      - THE SYSTEM SHALL document the default, the naming convention it implies and the reason where an operator will see it
  - id: req-litellm-seam
    title: Nothing forecloses a future LiteLLM provider
    category: constraint
    priority: must-have
    description: >-
      LiteLLM is non-AWS and will use the conventional API key plus base URL pattern as a new
      provider beside kiro, not a third mode of bedrock. The constraining seam is the static
      CLI-to-provider map, not the credential mechanism.
    acceptance_criteria:
      - THE SYSTEM SHALL keep the bearer-versus-role distinction inside the binding value and never in the provider name
      - THE SYSTEM SHALL introduce no new per-CLI credential wiring
      - THE SYSTEM SHALL have capabilities answer a binding-level question, so a key-based provider answers it the same way
      - THE SYSTEM SHALL add no additional hardcoded dependence on Bedrock to AGENT_CLI_PROVIDER
  - id: req-codex-scope
    title: Codex is out of the verified set for v1
    category: constraint
    priority: must-have
    description: >-
      Codex has two pre-existing defects unrelated to this change. Its credential path is verified,
      but it cannot complete a call in this region.
    acceptance_criteria:
      - THE SYSTEM SHALL include the mantle grant statement so Codex works the moment its defects are fixed
      - THE SYSTEM SHALL document Codex as unverified end-to-end, with both defects recorded separately
      - THE SYSTEM SHALL have no acceptance criterion in this spec depend on a successful Codex invocation
      - THE SYSTEM SHALL pin the custom-server exclusion of con-custom-server-excluded by a test
  - id: req-binding-preflight
    title: A binding is validated when it is saved
    category: functional
    priority: must-have
    description: >-
      A bare AssumeRole with no invoke, performed at save time, converts a class of mid-stage failure
      into an input-validation error. Per con-broker-action-dispatch it is a new control-plane broker
      action behind a seam the settings path already uses, so the agents Lambda needs no STS
      permission of its own and the number of principals able to assume a customer role stays at one.
    acceptance_criteria:
      - WHEN a role binding is saved THEN the system SHALL attempt an AssumeRole and report a typed failure without persisting an unusable binding
      - THE SYSTEM SHALL run the preflight in the broker, and SHALL add no sts:AssumeRole permission to any other role
      - THE SYSTEM SHALL perform no model invocation in the preflight
      - WHEN a preflight fails THEN the system SHALL name the cause category without echoing provider text, reporting a role outside the allowlist exactly and enumerating a missing principal, a failed external ID and a session-name condition mismatch as candidates with the value to check each against
      - THE SYSTEM SHALL NOT infer a cause from STS message text, because a wrong external ID, an omitted external ID, a session-name mismatch, an untrusted principal and a nonexistent role were MEASURED to return a byte-identical AccessDenied differing only in the resource ARN
      - WHEN the preflight itself cannot run THEN the system SHALL permit the save, because refusing a legitimate binding while the checker is unavailable is worse than persisting one whose failure is already legible
      - THE SYSTEM SHALL NOT invoke the preflight in a loop, since it shares the STS request-rate surface
      - THE SYSTEM SHALL document it as an input check and not a security control, because a trust policy can change after save
  - id: req-resolution-resilience
    title: Resolution-time dependencies have defined failure behaviour
    category: non-functional
    priority: must-have
    description: >-
      The broker now reads SSM and calls STS on every resolution, concurrently across stages.
    acceptance_criteria:
      - WHEN SSM throttling or STS throttling occurs THEN the system SHALL surface it as a typed resolution failure, not as a generic error
      - WHEN a binding changes THEN the system SHALL take effect on the next resolution, subject to SSM propagation, documented rather than promised as immediate
      - WHEN a role is deleted or a trust policy is changed mid-stage THEN the system SHALL surface a typed failure on the next resolution
```

## Requirement to phase

Every requirement lands in exactly one phase, so the phasing is checkable rather than asserted. `req-configured-semantics` is the only one that spans two, deliberately: Phase 1 takes the recomputation so the existing cards do not misreport a role-only scope, Phase 2 adds the new response fields and the UI affordances.

| Phase | Requirements                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `req-capabilities-authed`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1     | `req-role-credential-mode`, `req-single-parameter-encoding`, `req-broker-side-assume`, `req-broker-credential-resolution`, `req-credential-delivery-env`, `req-execution-role-no-bedrock`, `req-grant-model-unchanged`, `req-model-grant-families`, `req-session-name-attribution`, `req-session-name-trust-condition`, `req-least-privilege-assume`, `req-expiry-failure-legible`, `req-configured-semantics` (recomputation only) |
| 2     | `req-same-and-cross-account`, `req-external-id-lifecycle`, `req-binding-preflight`, `req-configured-semantics` (new fields and UI), `req-bearer-deprecated`                                                                                                                                                                                                                                                                         |
| 3     | `req-expiry-tripwire`, `req-resolution-resilience`, `req-credential-safety`, `req-codex-scope`, `req-litellm-seam`                                                                                                                                                                                                                                                                                                                  |
| 4     | none — Phase 4 exists only if Phase 3 evidence reopens `dec-v1-no-refresh`                                                                                                                                                                                                                                                                                                                                                          |

Two placements are worth justifying. `req-credential-safety` sits in Phase 3 because its content is assertions and redaction tests over behaviour Phase 1 and 2 build; the _design_ constraints it encodes are satisfied from Phase 1 onward. `req-litellm-seam` is also Phase 3, because it is a "do not make this worse" constraint verified by review rather than a unit of work — nothing in Phases 0 to 2 may violate it, and Phase 3 is where that is confirmed.
