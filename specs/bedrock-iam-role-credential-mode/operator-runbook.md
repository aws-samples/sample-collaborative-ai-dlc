# Bedrock role mode: operator runbook

Day-two operation of the [IAM-role credential mode](design.md). Setting a binding up is
[operator-trust-policies.md](operator-trust-policies.md); this is what to watch, what to
believe, and what each signal means once it is running.

Every command below is written against a deployment named `collaborative-ai-dlc` in
environment `dev`. Substitute your own project name and environment.

## Choose the administrator credential mode

Amazon Bedrock has one effective credential mode per space. A platform administrator selects the
default under **Admin → Agents**; a space owner or administrator may configure a space override on
the space's **Agent credentials** card. The effective-status panel names both the mode and the scope
that controls it.

| Selection                                 | Supported scopes             | What the runtime receives                                                                                                | When to use it                                                    |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **IAM Role** (recommended)                | Platform or space            | An invocation-only loopback container-credentials URI and token; never the role ARN, refresh grant, or static STS values | AWS-hosted Bedrock workloads that can use short-lived credentials |
| **API Key** (deprecated, still supported) | Platform, space, or personal | The effective Bedrock API key                                                                                            | Existing deployments or workloads that cannot use an IAM role     |

The mode is authoritative, not another item in API-key precedence:

- A **space IAM role** overrides the platform Bedrock binding and every personal Bedrock API key in
  that space.
- A **platform IAM role** controls Bedrock in every space that does not have its own space IAM role.
  Stored space and personal Bedrock API keys in those spaces remain encrypted in SSM but are
  **inactive**: they are not resolved, injected, or deleted. A space API key cannot bypass an
  inherited platform role. Configure a space IAM role, or have a platform administrator switch the
  platform back to API Key mode.
- The existing Bedrock parameter stores either a role binding or an API key. Selecting IAM Role
  therefore replaces an API key at the **same** scope; only keys at covered lower scopes remain
  stored but inactive. Switching that scope back to API Key replaces the role and requires entering
  a new key. Once no role covers a space, the normal personal → space → platform API-key precedence
  applies again.
- **Kiro is unchanged.** Kiro always uses its separate API key with personal → space → platform
  precedence. IAM Role is not offered for Kiro, and changing the Bedrock mode neither disables nor
  rewrites any Kiro key.

Personal settings never offer IAM Role. A personal Bedrock key may remain stored and can still
serve a space that is not covered by IAM. For any space controlled by a space or platform role, that
personal key is inactive; the effective-status readout identifies the authoritative scope rather
than treating the stored key as usable.

## Render and install the role policies

Render policy documents from the Terraform state of the deployed environment; do not retype the
broker principal or policy resources. These outputs are non-secret:

```bash
terraform -chdir=terraform output -raw credential_broker_role_arn
terraform -chdir=terraform output -raw bedrock_role_grant_policy_json \
  > bedrock-role-permissions.json
terraform -chdir=terraform output -raw bedrock_role_same_account_trust_policy_json \
  > bedrock-role-trust.json
terraform -chdir=terraform output -raw bedrock_role_cross_account_trust_policy_template_json \
  > bedrock-role-cross-account-trust-template.json
terraform -chdir=terraform output bedrock_assumable_role_arns
```

The grant is the permission policy for the role being assumed. The trust document names only the
credential-broker role; never name the AgentCore execution role. Configure AWS credentials in your
terminal first (`aws configure` or `aws sso login`), select the profile for the account that owns the
Bedrock role, and create the role and inline grant:

```bash
export BEDROCK_PROFILE='<profile-for-the-Bedrock-account>'
export ROLE_NAME='aidlc-bedrock-inference'

aws iam create-role \
  --profile "$BEDROCK_PROFILE" \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://bedrock-role-trust.json
aws iam put-role-policy \
  --profile "$BEDROCK_PROFILE" \
  --role-name "$ROLE_NAME" \
  --policy-name aidlc-bedrock-invoke \
  --policy-document file://bedrock-role-permissions.json
```

For an existing role, use `aws iam update-assume-role-policy` for the trust document and
`aws iam put-role-policy` for the permission document. The default broker allowlist accepts role
names matching `aidlc-bedrock-*`; confirm the rendered `bedrock_assumable_role_arns` output before
choosing another name. The complete policy rationale and supported session-name conditions are in
[operator-trust-policies.md](operator-trust-policies.md).

### Cross-account bootstrap

A cross-account role follows the same broker path but must require the platform-generated external
ID. Its bootstrap is intentionally two-pass:

1. Render the permission policy and cross-account trust template in the platform deployment.
2. In the Bedrock account, create the role with the rendered template still containing the literal
   `${BEDROCK_EXTERNAL_ID}` placeholder and attach the permission policy. The placeholder cannot
   match a real request, so the role is not assumable yet.
3. In the platform UI select **IAM Role**, enter only the role ARN, and save. The preflight rejects
   this first save and returns the external ID generated for that platform or space binding.
4. Replace the placeholder, update the role's trust policy, and save the same role binding again:

   ```bash
   export BEDROCK_EXTERNAL_ID='<value-returned-by-the-platform>'
   sed "s|\${BEDROCK_EXTERNAL_ID}|${BEDROCK_EXTERNAL_ID}|g" \
     bedrock-role-cross-account-trust-template.json > bedrock-role-trust.json
   aws iam update-assume-role-policy \
     --profile "$BEDROCK_PROFILE" \
     --role-name "$ROLE_NAME" \
     --policy-document file://bedrock-role-trust.json
   ```

5. After IAM propagation, save again and run a stage. CloudTrail in the Bedrock account should show
   an assumed-role session named `aidlc-<projectId>`.

The platform, not the customer, generates the external ID. It is stable across ordinary saves and
role-ARN changes at that scope; this release has no in-place external-ID rotation operation. Reveal
the current value from the authorized credential card instead of trying to rotate it by re-saving.
Same-account roles use `bedrock_role_same_account_trust_policy_json` and need no external ID.

### Understand the bind-time preflight

Saving a role binding asks the broker to perform one constrained `AssumeRole` before persisting the
binding. It catches an ARN outside `bedrock_assumable_role_arns`, a rejected trust relationship, and
an invalid mandatory session ceiling without sending credentials to a runtime. It has deliberate
limits:

- It is a point-in-time input check, not the security boundary. Every stage start and every refresh
  re-reads the binding and reapplies the mandatory ceiling before assuming the role.
- It performs no Bedrock model invocation. A pass does not prove that the attached role permission,
  SCPs, Region/model availability, quotas, or a selected model ID will permit an invocation.
- STS returns the same `AccessDenied` class for an incorrect broker principal, external ID,
  session-name condition, missing role, and several IAM propagation states. The UI lists candidates
  to check; it cannot truthfully identify which one is wrong.
- A space binding is probed as `aidlc-<projectId>`. A platform binding uses `aidlc-preflight`, so a
  trust policy restricted with `StringEquals` to one space is unsuitable at platform scope.
- An available negative verdict blocks the save. If the broker transport itself is unavailable,
  the save proceeds so an outage of the checker does not prevent configuration; the next stage then
  resolves normally and fails closed if the binding is unusable.
- IAM and SSM are eventually consistent. A newly corrected policy or binding may need a short delay
  before the next preflight or credential resolution observes it.

## Verify credential refresh and stage resume

Role chaining still limits each STS session to 3600 seconds, but that limit does not limit a
stage to one hour. A role-mode stage receives an invocation-scoped, token-protected loopback
container-credentials endpoint. The CLI's AWS SDK requests credentials from that endpoint and
requests replacements as its cached session approaches expiry. Each request redeems the same
bounded, audience-separated refresh grant through the credential broker, which re-checks the
active execution, project, stage, callback, current role binding, and mandatory session-policy
ceiling before assuming the role again.

Refresh happens **inside the running stage**. A stage can cross multiple STS expirations without
restarting the CLI, replaying the stage, or losing work already performed. There is no automatic
whole-stage credential retry.

If refresh revalidation or role assumption fails, the credential broker writes only its allowlisted
code to its `request denied` log. The loopback provider deliberately does not return or retain that
code or the broker exception: it responds with non-cacheable HTTP 503 and
`{"error":"credential refresh unavailable"}`. If the SDK exhausts its own request retries and the CLI
exits, the durable stage reason is normally `cli_nonzero_exit`. Refresh mode clears the fixed
`credentialExpiresAt` value when it installs the container provider, so an old initial expiry cannot
misclassify that later exit as `credential_expired`. The implementation does **not** currently
propagate a typed `credential_expired` or `credential_resolution_failed` reason from the loopback
refresh path. This observability limit does not replay the stage; the failed attempt remains failed.

A gate or user-answer wait stores no STS credentials, endpoint URL, authorization token, or
refresh grant in durable state. The completed stage's endpoint is revoked and its in-memory
credential material is scrubbed. When execution resumes, the next stage receives a newly issued
refresh grant, a new endpoint token, and newly assumed credentials, regardless of how long the
intent waited.

Operationally, verify these invariants:

- a stage lasting longer than one hour remains one stage attempt while the broker records more
  than one successful role assumption;
- a request to the old endpoint after a stage completes returns not found;
- a resumed stage uses a different endpoint token and a fresh role session;
- a forced refresh refusal returns the sanitized, non-cacheable 503 while the corresponding
  credential-broker log records the allowlisted cause; and
- if that refusal makes the CLI exit, the stage normally records `cli_nonzero_exit` and is never
  replayed automatically.

## Reading a broker resolution code

The credential broker logs an allowlisted code and never provider text, because an STS or SSM
message can name the caller session, target role, or parameter path. How that code reaches durable
stage state depends on when resolution failed:

- **Before the CLI starts**, AgentCore refuses the dispatch and the orchestrator durably records
  `credential_resolution_failed`. The uppercase broker code remains in the credential-broker
  `request denied` log rather than in the stage failure text.
- **During a running stage**, the loopback provider reduces the failure to the sanitized 503 above.
  The broker log still carries the allowlisted code, but the stage normally records
  `cli_nonzero_exit` if the CLI exits.

Use the code from the credential-broker log to choose the operator action:

| Code                                 | Meaning                                       | Action                                                                                              |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `BEDROCK_ROLE_ASSUME_DENIED`         | The trust policy rejected this deployment     | Check the principal, session-name condition, and external ID                                        |
| `BEDROCK_ROLE_ASSUME_THROTTLED`      | STS throttled the `AssumeRole`                | Wait for STS; the SDK may retry the refresh request, but the orchestrator does not replay the stage |
| `BEDROCK_ROLE_BINDING_INVALID`       | The stored value is not a valid role binding  | Re-save the binding; this normally implies a hand-edited SSM parameter                              |
| `AGENT_CREDENTIAL_STORE_THROTTLED`   | SSM throttled the parameter read              | Wait for SSM recovery, then start or resume a stage                                                 |
| `AGENT_CREDENTIAL_STORE_UNAVAILABLE` | The parameter could not be read at all        | Check broker permissions and the KMS key                                                            |
| `BEDROCK_ROLE_RESOLUTION_FAILED`     | Any other allowlisted role-resolution failure | Correlate the broker log by execution, project, and action                                          |

A **cleared** binding is not a store failure: a deleted parameter reports the provider as
_missing_. Initial dispatch then fails closed without a credential; a refresh after a binding is
cleared follows the generic 503 and `cli_nonzero_exit` path described above.

### Timing, propagation, and revocation limits

- **A binding change takes effect on the next credential resolution, not immediately.** That
  may be a refresh in the active stage or the first resolution of a resumed stage. SSM itself is
  eventually consistent, so a save is _usually_ visible within seconds and is not promised to be.
- **A role deleted or a trust policy narrowed mid-intent surfaces at the next refresh or stage
  start.** The refresh path reports the generic 503 and normally `cli_nonzero_exit`; initial stage
  resolution reports `credential_resolution_failed`. An already-minted session remains usable
  until its own expiry.
- **An already-minted credential outlives a revoked binding by up to 3600 s.** This is an
  accepted risk: there is no in-flight revocation in v1. If you need a hard cut, delete or
  narrow the role's trust policy in the Bedrock account — that stops the next mint immediately
  and does not depend on the platform.

## Attributing Bedrock spend

Attribution is `RoleSessionName` only, composed server-side as `aidlc-<projectId>`. No cost
allocation tag is activated, no CUR export is created and no budget is created by this
platform — those are yours to set up, and this section is how to use them once you have.

**What is verified:** a chained `AssumeRole` followed by `InvokeModel` is attributed in
CloudTrail to the final chained session, with the session name carrying the identity. Probed
live in `eu-central-1`.

**What is assumed:** that _billing_ aggregates by the same identity CloudTrail reports. It is
the natural reading of the caller-identity dimension, but it is inference rather than
something this project measured, so verify it against your own bill before relying on
showback numbers.

With CUR 2.0 enabled and queryable (Athena or Redshift), Bedrock line items carry the
invoking identity, so spend per space is a group-by on the session name:

```sql
SELECT
  regexp_extract(line_item_resource_id, 'aidlc-[0-9a-f-]{36}') AS space,
  SUM(line_item_unblended_cost)                                AS cost
FROM   cur2
WHERE  line_item_product_code = 'AmazonBedrock'
  AND  billing_period = '2026-09'
GROUP BY 1
ORDER BY cost DESC
```

The exact column carrying the identity differs between CUR schema versions and between the
Bedrock line-item types (on-demand invocation versus provisioned throughput), so treat the
`regexp_extract` above as the shape of the query rather than a drop-in. Find the identity
column in your own export first, then group by it.

Two limits worth stating plainly:

- **Concurrent stages in one space are indistinguishable.** The session name identifies the
  _space_, not the stage, deliberately (`req-session-name-attribution`). You cannot attribute
  spend to a stage, only to a space.
- **The session name is identical for a space-scope and a platform-scope binding**, because it
  identifies the space either way. So CloudTrail cannot tell you _which scope's_ binding was
  used for an invocation. If you need that distinction, bind different roles.

### Model invocation logging is not enabled

The platform does not enable Bedrock model invocation logging, and this is deliberate
(`con-invocation-logging-off`). It is an account-wide setting that captures every user's
prompts and completions, so turning it on is an operator decision with a data-handling
consequence, not a platform default.

The practical effect: **you cannot see which model ids a CLI actually reached** without it.
Claude Code fans out to several models within one stage, so a grant scoped to a single model
id would fail in ways the platform cannot show you — which is why the grant is written as
provider-family patterns (`req-model-grant-families`) rather than an enumerated list. If you
need direct model-level evidence, enable invocation logging knowingly and for a bounded
window.

## The bearer token is deprecated

An Amazon Bedrock API key remains fully supported and existing deployments are untouched. It
is nonetheless **deprecated in favour of role mode**, for one reason: it is a long-lived
secret that must be stored, rotated and protected, where an IAM role needs no stored secret at
all and mints short-lived credentials per invocation.

Both cards label it as such. There is no removal date and no forced migration; a scope holding
a bearer token keeps working exactly as before. To migrate, save a role binding in the same
scope — one parameter holds the Bedrock value, so saving the role **replaces** the token, and
both cards warn about that before you do it.

The distinction lives entirely inside the stored value, never in the provider name, so a future
non-AWS provider (LiteLLM, with an API key and base URL) arrives as a new provider beside
`kiro` rather than as a third Bedrock mode.

## Codex on Bedrock

Codex runs end to end on role-mode credentials: four consecutive stages at `exitCode=0` on
`global.openai.gpt-5.6-sol`, parking at a human gate, verified in dev on Codex 0.153.4. It took
the Runtime provider, a supported version, a global CRIS model id, and the `project/default` Runtime grant to get there.

Two defects were reproduced here and both are now fixed; this section records what they were,
because the symptom is easy to misread as a credential fault.

1. **Codex used the wrong endpoint.** Codex 0.145.0 with `model_provider = amazon-bedrock`
   targets `https://bedrock-mantle.<region>.api.aws/openai/v1/responses`. Measured: Mantle in
   eu-central-1 serves **no** model id at all — every id 404s, Anthropic included — while
   `us-east-1` serves the GPT-5.6 family. Overriding only that provider's `base_url` to the
   runtime host does not work either: it still signs SigV4 for service `bedrock-mantle`, and
   the runtime endpoint answers `401 Credential should be scoped to correct service: 'bedrock'`.
   The fix is the separate `amazon-bedrock-runtime` provider, which requires Codex >= 0.149.1 —
   hence the pinned version moved to 0.153.4.
2. **GPT-5.6 is reachable only through a cross-Region inference profile.** On the runtime
   endpoint the bare `openai.gpt-5.6-sol` is refused with `Invocation of model ID ... with
on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference
profile`, so `global.openai.gpt-5.6-sol` is the servable form. Note this is the exact
   opposite of Mantle, which wants the bare id — the endpoints disagree, so a model id is only
   correct relative to a provider.

The open design question in earlier drafts — whether the OpenAI-compatible path forces a
Bedrock API key, which role mode deliberately does not provide — is **resolved: it does not**.
The runtime provider signs SigV4 and resolves the SDK-standard container provider from
`AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN`, taking its Region from
`AWS_REGION`. AgentCore supplies that pair only to the selected top-level CLI; no `AWS_PROFILE`,
`~/.aws/config`, static STS variables, or Codex-specific derived key is required. MCP children receive
neither the invocation-specific endpoint nor its token.

That path needs one grant the model statements do not cover: `bedrock:InvokeModel` on
`arn:aws:bedrock:<region>:<account>:project/default`, the resource the OpenAI-compatible APIs
authorize against. Without it every call fails `401` naming that resource even though the model
itself is allowed.

### Data residency, which is a decision rather than a defect

`global.` profiles route to commercial Regions worldwide, so Codex prompt content can leave the
deployment's Region. There is no `eu.openai.*` profile — only `global.openai.gpt-5.6-{sol,
terra,luna}` — so an EU-residency-constrained deployment cannot use GPT-5.6 on any route today.
The endpoint, billing, quota and CloudWatch/CloudTrail records stay in the deployment Region
either way. The Anthropic models behind Claude Code and OpenCode are unaffected: they use
`eu.anthropic.*` profiles and stay in-Region.

Do not add `bedrock-mantle:CreateInference`, a `bedrock-mantle` project ARN, or a derived
Codex API key as a fallback. Supported Codex versions authenticate the Runtime endpoint directly
with the same SDK credential source as the other Bedrock CLIs. The administrator must decide
whether global CRIS routing satisfies the deployment's data-residency policy before enabling
Codex; if it does not, leave Codex unconfigured.
