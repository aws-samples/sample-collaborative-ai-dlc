# Bedrock IAM on the authentication foundation

This replaces the implementation in PR #452 and is based on the authentication foundation in PR #487. The IAM delta is reviewed separately from the foundation.

## Feature transfer

| Existing IAM behavior                                                        | Foundation implementation                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Platform IAM, space overrides, inheritance, personal IAM prohibited          | Mode catalog, versioned connections, metadata selection and reviewed atomic activation                |
| Administrator setup wizard, ExternalId, cross-account and cross-region roles | Validated IAM configuration, generated policies/CloudShell commands, signed connection verification   |
| Claude Code, OpenCode and Codex; Kiro independent                            | Trusted credential environment passed to existing CLI drivers; separate Kiro key bindings             |
| Runtime model discovery in the inference account/region                      | Paginated discovery through the invocation's HTTP credential provider                                 |
| Five-minute handoff and fixed eight-hour renewal authority                   | Existing signed grant protocol plus a separate IAM renewal audience, with connection/execution checks |
| Hourly STS credentials, proactive renewal and transient retries              | IAM adapter under the generic credential session; refresh five minutes early, retry every 30 seconds  |
| Hard expiry despite hung refresh and process cancellation                    | Independent generic session expiry timer and CLI process-group termination                            |
| Background jobs and parked conversation resume                               | Foundation reference ownership; fresh grants/endpoints per resumed invocation                         |
| Application AWS identity for built-in MCP                                    | Foundation runtime-owned MCP bridge, without restoring application credentials into CLI environments  |
| Fresh one-shot working directory                                             | Directory creation before spawning, covered by a real-child regression test                           |

No old IAM records or existing runs need migration. No duplicate lifecycle manager, runtime AWS credential snapshot, old IAM binding reader or legacy renewal protocol was introduced. Deployment scripts are unchanged.

## Verification

The regression tests cover:

- A persistent Node child with the real AWS SDK HTTP credential provider and one Bedrock client, advancing simulated time through four refreshes over 3 hours 40 minutes. Each subsequent signed request uses the renewed access key and the same process ID.
- Concurrent refresh coalescing, transient retries, endpoint authorization, separate invocation tokens, clean endpoint disposal and detached ownership.
- Cancellation of the CLI and its process group on expiry, including a broker refresh that never resolves, and the non-sliding eight-hour limit.
- Broker rejection of tampered grants, audience substitution, altered role/region and revoked connections; exact STS role, ExternalId and restrictive session policy.
- Atomic connection activation, stale-review rejection, platform/space selection, inheritance, personal key suppression and independent Kiro credentials.
- Administrator authorization, wizard verification, preview/apply separation, concrete proposed role display and mode changes.
- Runtime qualification before versioned grant issuance and a real-child one-shot working-directory check.

These tests use real local HTTP, the SDK provider, child processes and DynamoDB Local. AWS STS/inference responses and elapsed hours are simulated; this is not a claim of a live multi-hour Bedrock run. The setup wizard's live connection check validates assumption and discovery after deployment. Model invocation qualification for each CLI remains a deployment check.
