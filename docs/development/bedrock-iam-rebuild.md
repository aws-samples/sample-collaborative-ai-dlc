# Bedrock IAM on the authentication foundation

This replaces the implementation in PR #452 and is based on the authentication foundation in PR #487. The IAM delta is reviewed separately from the foundation.

IAM is a registered provider. Its code lives in provider-owned files, and each deployable adds it with one line in its composition root; no foundation module, foundation test or Terraform file changes. See [Adding an authentication provider](agent-authentication-foundation.md#adding-an-authentication-provider).

| Deployable        | Provider files                                                                                      | Root                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Shared            | `agent-auth-bedrock-iam-schema.js` (`BEDROCK_IAM_MODE`), `bedrock-iam.js` (setup/CloudShell)        | `lambda/shared/agent-auth-modes.js`                       |
| Credential broker | `bedrock-iam-provider.js` (adapter, renewal policy, errors), `bedrock-iam.js` (STS)                 | `lambda/credential-broker/agent-broker-providers.js`      |
| Runtime           | `bedrock-iam-runtime-provider.js`, `bedrock-iam-material.js`, `bedrock-iam.js` (session, discovery) | `lambda/agentcore/runtime-auth-providers.js`              |
| Settings          | `authentication-iam-settings.js` (draft, `defaults`/`setup`/`verify` actions)                       | `lambda/agents/authentication-settings-providers.js`      |
| Frontend          | `components/settings/agent-auth/bedrock-iam/` (wizard, API client, `bedrockIamUi`)                  | `frontend/src/components/settings/agent-auth/registry.ts` |

Wire names that shipped only to the review environment were replaced by the foundation's generic contracts: the wizard calls `POST /agents/authentication-setup` with `mode: 'iam'`, **Test connection** uses the generic `verify-connection` command and grant purpose, and reviews use `connection-draft` and inherited `space-selection` candidates. The IAM renewal protocol (`renew-bedrock-credentials`, `renewalToken`, audience `aidlc-bedrock-credential-renewal-v2`, fixed eight-hour ceiling) and the broker's top-level `iamCredentials`/`renewalToken`/`renewalExpiresAt` fields are unchanged; the foundation broker now signs renewals from IAM's declared policy.

## Feature transfer

| Existing IAM behavior                                                        | Foundation implementation                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Platform IAM, space overrides, inheritance, personal IAM prohibited          | Mode catalog, versioned connections, metadata selection and reviewed atomic activation                |
| Administrator setup wizard, ExternalId, cross-account and cross-region roles | Validated IAM configuration, generated policies/CloudShell commands, signed connection verification   |
| Claude Code, OpenCode and Codex; Kiro independent                            | Trusted credential environment passed to existing CLI drivers; separate Kiro key bindings             |
| Runtime model discovery in the inference account/region                      | Paginated discovery through the invocation's HTTP credential provider                                 |
| Five-minute handoff and fixed eight-hour renewal authority                   | Existing signed grant protocol plus a separate IAM renewal audience, with connection/execution checks |
| Hourly STS credentials, proactive renewal and transient retries              | IAM adapter under the generic credential session; refresh five minutes early, retry every 30 seconds  |
| Hard expiry despite hung refresh and process cancellation                    | Foundation session expiry timer and CLI process-group termination                                     |
| Background jobs and parked conversation resume                               | Foundation reference ownership; fresh grants/endpoints per resumed invocation                         |
| Application AWS identity for built-in MCP                                    | Foundation runtime-owned MCP bridge, without restoring application credentials into CLI environments  |
| Fresh one-shot working directory                                             | Foundation one-shot directory creation before spawning                                                |

No old IAM records or existing runs need migration. No duplicate lifecycle manager, runtime AWS credential snapshot, old IAM binding reader or legacy renewal protocol was introduced. Deployment scripts are unchanged.

## Verification

The regression tests cover:

- A persistent Node child with the real AWS SDK HTTP credential provider and one Bedrock client, advancing simulated time through four refreshes over 3 hours 40 minutes. Each subsequent signed request uses the renewed access key and the same process ID.
- Concurrent refresh coalescing, transient retries, endpoint authorization, separate invocation tokens, clean endpoint disposal and detached ownership.
- Cancellation of the CLI and its process group on expiry, including a broker refresh that never resolves, and the non-sliding eight-hour limit.
- Broker rejection of tampered grants, audience substitution, altered role/region and revoked connections; exact STS role, ExternalId and restrictive session policy.
- Atomic connection activation, stale-review rejection, platform/space selection, inheritance, personal key suppression and independent Kiro credentials.
- Administrator authorization, wizard verification, preview/apply separation, concrete proposed role display and mode changes.
- Runtime qualification and verification support before a verification grant is issued.

These tests use real local HTTP, the SDK provider, child processes and DynamoDB Local. AWS STS/inference responses and elapsed hours are simulated; this is not a claim of a live multi-hour Bedrock run. The setup wizard's live connection check validates assumption and discovery after deployment. Model invocation qualification for each CLI remains a deployment check.
