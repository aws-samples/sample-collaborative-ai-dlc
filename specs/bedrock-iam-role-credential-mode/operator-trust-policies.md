# Bedrock role trust policies

Operator reference for the Bedrock IAM-role credential mode. The design and its rationale live in [design.md](design.md) beside this file and in [ADR-0001](../../adr/0001-bedrock-iam-role-credential-mode.md).

This file covers **setting a binding up**. Day-two operation — what to watch, how to attribute spend, and what each failure code means — is [operator-runbook.md](operator-runbook.md).

This file keeps the **rationale** for each choice. The operator **procedure** is now published on the documentation site (`docs/getting-started/bedrock-credentials.md`); `dec-spec-location` still keeps the spec set and the ADR out of `docs/`, because publishing a design is a separate decision from publishing a runbook.

## What you are configuring

Instead of storing a long-lived Bedrock API key, the platform stores a **role ARN**. At stage start
and on every refresh, the credential broker assumes that role after revalidating the active stage,
current binding, and mandatory session-policy ceiling. The selected top-level CLI receives only an
invocation-scoped loopback container-credentials URI and authorization token; its AWS SDK obtains
and refreshes one-hour STS sessions through that provider. Static STS values and refresh authority
are withheld from MCP children. You create the role; the platform never does, and cannot — the role
may live in a different AWS account, and its trust policy is your authoritative control over who may
assume it.

Two documents are needed on the role:

| Document                                     | Where it comes from                                    |
| -------------------------------------------- | ------------------------------------------------------ |
| Permission policy (what the role may invoke) | `terraform output -raw bedrock_role_grant_policy_json` |
| Trust policy (who may assume the role)       | The templates below                                    |

The one value both need is the broker's role ARN:

```bash
terraform -chdir=terraform output -raw credential_broker_role_arn
# arn:aws:iam::<platform-account>:role/collaborative-ai-dlc-credential-broker-dev
```

That is the **only** principal a trust policy has to name. The AgentCore execution role deliberately holds no Bedrock, `bedrock-mantle` or `sts` permission, and a test asserts it stays that way.

## Bootstrap order

Follow this order. Saving the binding before the trust policy exists produces an `AssumeRole` failure, which the bind-time preflight reports at save time instead of mid-stage.

1. Read the broker role ARN and the permission policy from the Terraform outputs above. The Admin → Agents and space Agent cards also show the principal to trust, so you can copy it from the UI.
2. Create the role in the Bedrock-owning account with that permission policy and one of the trust policies below.
3. **Same account as the deployment:** save the binding. That is the whole flow — no external ID exists or is needed.
4. **A different account:** save the binding once. The save is **rejected** because the trust policy cannot yet name an external ID nobody has seen, and the rejection **returns the external ID** the platform generated for this binding. Add it to the trust policy as an `sts:ExternalId` condition, then save again.
5. Confirm a stage runs. CloudTrail in the Bedrock account shows `aidlc-<projectId>` in `userIdentity.arn` within a few minutes.

The external ID is **stable across those save attempts**: it is generated once into its own per-scope parameter and copied into the binding when a save succeeds. So the trust policy you wrote against the first, rejected attempt stays valid, and you can read the value back at any time from the card or the settings response rather than rotating to rediscover it.

The binding value is stored in the existing `bedrock` SSM parameter, with the external ID attached **by the server** — never send one, and a client-supplied `externalId` is rejected outright. AWS requires the assuming party to control the value:

```json
{ "roleArn": "arn:aws:iam::111122223333:role/aidlc-bedrock-inference" }
```

Role bindings are accepted at **space and platform scope only**. A role object written to a user-scope binding is rejected at write time: that endpoint is gated only on authentication, so any member could otherwise name a role ARN for the platform to assume.

## Trust-policy templates

The templates are **published** in the product documentation, at
`docs/getting-started/bedrock-credentials.md` (Bedrock credential modes → Trust policy templates):
one role scoped to one space, one role shared by several spaces, and the cross-account form with
the external ID. They live there rather than here so an operator finds them without reading a
spec, and so there is exactly one copy to keep correct.

Same-account bindings may omit `sts:ExternalId`: the trust policy already names exactly one
principal, and the confused-deputy problem is a third-party one.

## The session-name format is a stability contract

`RoleSessionName` is `aidlc-<projectId>`, composed in exactly one place on the server (the credential broker) and never accepted from a container.

**Treat this format as stable.** Once a customer writes an `sts:RoleSessionName` condition, the format is load-bearing in their account: changing it would break every trust policy carrying the condition. Any change is therefore a **breaking change requiring a migration note**, not an internal refactor.

Two consequences worth recording:

- **Omitting the condition is permitted and sometimes necessary**, but it means _any space that knows the role ARN can use the role_. The platform cannot enforce that constraint from its side, and the ARN is not treated as a secret.
- **A future single-gateway migration would break these policies.** Collapsing to one platform-wide Bedrock role (for example behind a LiteLLM-style gateway) removes the per-space session name that these conditions match. That has to be planned for rather than discovered.

## Attribution and its limits

Attribution is `RoleSessionName` only — no session tags. Session tags would require `sts:TagSession` in your trust policy, so any role omitting it would fail closed.

- CloudTrail in the Bedrock account records `userIdentity.arn` as `…assumed-role/<role>/aidlc-<projectId>`, with `principalId` `AROA…:aidlc-<projectId>`.
- The session name identifies the **space, not the stage**. Two stages running concurrently in one space are indistinguishable in CloudTrail. This is accepted, not an oversight.
- Model invocation logging is not enabled by the platform. It is account-wide per region and captures every user's prompts and completions, so enabling it is an operator decision.

## Diagnosing an `AssumeRole` failure

The broker returns only an allowlisted code — never STS text, which can name the caller session and the target role.

**A role outside the assumable set is reported exactly**, because the platform decides that itself without calling STS. Everything else arrives as one category, `trust-policy-rejected`, and that is a property of STS rather than a shortcut: a wrong external ID, an omitted external ID, a session-name condition mismatch, an untrusted principal and a role that does not exist all return a **byte-identical `AccessDenied`**, differing only in the resource ARN. Measured against a throwaway role on 2026-09-06, including positive controls that succeeded once each condition was satisfied. Guessing a cause from message text would therefore be invention, so the preflight names every candidate instead and tells you the exact value to check each against.

Check them in this order:

| Likely cause                                    | What to check                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Trust policy does not name the broker principal | Compare against `terraform output -raw credential_broker_role_arn` exactly, including the environment suffix   |
| Session-name condition names a different space  | The condition value must match the session name the preflight reports for the space actually running the stage |
| External ID missing or mismatched               | Required for cross-account; read the current value from the card and compare, do not rotate to find out        |
| Role ARN outside the assumable set              | `terraform output bedrock_assumable_role_arns` — the default requires the role be named `aidlc-bedrock-*`      |
| Role or policy recently changed                 | IAM is eventually consistent; a fresh change can take a short time to take effect                              |

Two properties of the preflight worth knowing before you rely on it:

- **It is an input check, not a security control.** A trust policy can change the instant after it passes, which is why resolution re-checks on every stage. A binding that passed the preflight is not thereby guaranteed to work.
- **It fails open when it cannot run.** If the broker is unreachable, the save proceeds rather than being refused, because a checker being down is a worse reason to block a legitimate binding than persisting one whose failure is already legible as `credential_resolution_failed`.

A **platform-scope** binding is probed with the session name `aidlc-preflight` rather than a space's name, because it serves every space. A trust policy carrying `StringEquals` for one space therefore fails its preflight — correctly, since such a role cannot serve as a platform binding. Use `StringLike`, or bind the role at space scope.

### The role naming convention

The broker's `sts:AssumeRole` permission is scoped by `bedrock_assumable_role_arns`, defaulting to:

```hcl
bedrock_assumable_role_arns = ["arn:aws:iam::*:role/aidlc-bedrock-*"]
```

This imposes a naming convention on whoever owns the Bedrock account. It is defence in depth, not the primary control — the trust policy is authoritative — but a wildcard default would leave the trust policy as the _only_ control.

If the role cannot be renamed, opt out explicitly:

```hcl
bedrock_assumable_role_arns = ["*"]
```

Setting it makes the looser posture a deliberate, visible choice. Narrowing `iam::*` to real account ids is recommended for a known topology.

## External-ID lifetime and replacement

This release has **no in-place external-ID rotation operation**. Re-saving a binding — including saving a different role ARN at the same scope — reuses the platform-generated value in that scope's dedicated parameter. A save never overwrites or rotates it. If an operator loses the value, reveal the current value on the credential card instead of trying to replace it.

For a space-scope binding, the only supported lifecycle action that removes the external-ID parameter is deleting the **entire space**. Recreating that space creates a new scope and the first cross-account save generates a new external ID. This is destructive, clears all space-scoped agent credentials, and is not an in-place rotation workflow. Stop active stages first, recreate the space and binding, update `sts:ExternalId` in the role trust policy with the newly returned value, then save again and confirm the preflight. From deletion until the new trust policy and binding agree, new or resumed stages cannot assume the role; the orchestrator does not replay them automatically. An already-minted role session can remain valid for up to its remaining hour.

Platform scope cannot be deleted through the credential API, so this release provides no supported way to replace its external ID. Do not edit or delete the SSM parameter directly: the stored binding can retain the old value and become inconsistent with the trust policy. A future in-place rotation feature must be an explicit platform-admin-gated operation that coordinates generation, trust-policy update, binding replacement and preflight rather than making ordinary saves rotate implicitly.

### Same-account bindings

A fresh binding whose role lives in the platform account generates no external ID, and none is needed: the trust policy already names exactly one principal and the confused-deputy problem is a third-party one. If that scope later changes to a cross-account role, the first save generates an external ID when none exists; otherwise it reuses the preserved scope value. Add that returned value to the trust policy and save again.

### One role shared by several spaces

Each binding carries its own external ID, so if several spaces each bind the same role, the role's trust policy has to accept every one of their values. That grows with the number of spaces, and the `sts:RoleSessionName` condition already gives you per-space scoping. Prefer a single platform-scope binding for a shared role, and reserve space-scope bindings for spaces that genuinely need a different role. AWS's own recommendation is one external ID per AWS account, which is what a single platform-scope binding gives you.

## What happens when a credential expires

The top-level CLI uses an invocation-scoped loopback container-credentials endpoint. Its AWS
SDK obtains another one-hour role session through that endpoint whenever the cached session
expires, so the same stage process can continue across multiple expirations without replay.

When the stage ends, the endpoint token is revoked and credential material is scrubbed. No STS
credential or refresh authority is persisted while an intent waits at a gate or for a user
answer; the next stage starts with a newly issued refresh grant, endpoint token, and role
session. See [operator-runbook.md](operator-runbook.md#verify-credential-refresh-and-stage-resume)
for the operational checks and the up-to-3600s window in which an already-minted credential
outlives a revoked binding.
