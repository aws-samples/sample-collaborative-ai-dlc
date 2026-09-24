# Bedrock IAM

IAM enables Claude Code, OpenCode, and Codex through a dedicated inference role. Kiro keeps its own API key. Platform administrators choose the mode in **Admin → Agents → Platform Agent Credentials**.

| Scope    | Keys mode             | IAM mode                                                |
| -------- | --------------------- | ------------------------------------------------------- |
| Platform | Fallback Bedrock key  | Default inference role and region                       |
| Space    | Shared key override   | Platform role or an administrator-selected space role   |
| Personal | Personal key override | Uses space/platform IAM; personal roles are unavailable |

## Configure a role

Deploy with the existing scripts:

```sh
./scripts/deploy-terraform.sh review && ./scripts/deploy-frontend.sh review
```

Managed environments must run an image with IAM authentication support. Publish an updated environment where necessary. The runtime reports protocol 2 and the `keys` and `iam` modes; the control plane checks support before granting access, probing the selected runtime if its recorded qualification is missing or does not include the requested mode.

1. Select **IAM**, then **Set up Bedrock IAM**.
2. Enter the inference account, region, role name or path, and optional ExternalId. The inference account and region can differ from the application, within the same AWS partition.
3. For a new role, run the generated CloudShell commands in their indicated accounts. For an existing role, select **I already have an inference role**, then **Continue to connection test**. This skips the AWS setup step. The trust policy names the credential broker; the broker policy allows assumption of that exact inference role.
4. Choose **Test connection**. This checks STS assumption and paginated Bedrock model discovery from the runtime. It does not invoke a model or prove model entitlements/Mantle access.
5. Choose **Review connection change**, inspect the proposed role, region and impact, then **Apply reviewed change**.
6. Select models available in the inference account and region. The policy supports Bedrock Runtime inference for Claude Code/OpenCode and Bedrock Mantle for Codex.

An existing role that passes the connection test can proceed directly to review. If the test fails, the wizard shows permission help: required role trust and inference permissions, plus application-side permission to assume the role. Your AWS administrator can compare these with the existing policies and add missing access while retaining existing permissions. The application access command is optional when that permission is already configured. Copy and download controls are available in the help.

The application generates IAM setup documents; it does not modify AWS IAM itself. The broker needs STS access, and the runtime needs access to the broker and inference endpoints.

In **Space Settings → Agent**, platform administrators can **Set space IAM role** or **Change space IAM role**. **Use platform IAM role** reviews removal of the override. Space owners who are not platform administrators cannot configure, verify, or clear IAM roles. Personal Bedrock keys are disabled in IAM mode; Kiro remains independently configurable.

Switching back to **Keys** also requires review. Saved Bedrock keys become applicable again. An IAM role or mode change affects future selections; a started invocation retains its versioned connection.

## Renewal and expiry

The broker redeems a signed five-minute handoff grant, checks the pinned connection and execution, and assumes the exact role with an inference-only session policy. The resulting STS credentials last up to one hour. Renewal uses a separate signed audience bound to that connection, purpose, project and execution, with a fixed eight-hour deadline measured from the original grant. Renewal cannot switch roles, retrieve keys, or slide that deadline.

Each invocation's generic credential session owns an authenticated loopback AWS container-credential endpoint. Claude Code, OpenCode and Codex use their credential providers to acquire fresh credentials while the same process continues. STS credentials and renewal tokens stay in memory. Only the local endpoint and its random authorization token enter the trusted credential environment. The built-in MCP bridge retains application AWS identity in the runtime; it is not passed through the CLI.

Renewal starts five minutes before STS expiry. Transient failures retry every 30 seconds while credentials remain valid. Invalid grants, revoked connections and access denial stop renewal immediately. An independent timer cancels the invocation at STS expiry even if renewal hangs, or at the fixed eight-hour authorization limit. Cancellation force-stops the session's CLI process group, including tool descendants. The normal stage failure path reports credential unavailability and attempts its existing persistence/checkpoint work. There is no role fallback or automatic agent restart.

Detached work retains the same credential session until it finishes. A later invocation, including an answer to a parked conversation, redeems a fresh handoff grant and gets a fresh endpoint for the pinned connection. It does not reuse expired STS credentials or extend an earlier invocation's renewal token.

Revocation is checked against the stored connection on each redemption and renewal. AWS permissions and trust can also be revoked. Application selection changes do not revoke already-issued STS credentials; their AWS validity and the runtime's invocation cancellation remain distinct boundaries.

## Foundation records

IAM uses non-secret, immutable connection revisions, policy records, space selections, impact reviews and audit records in the existing authentication control table. Reviewed activation writes the new connection and selection in one conditional transaction. Concurrent work or configuration changes invalidate stale reviews.

API keys retain their SSM SecureString paths. No configuration or run migration from the superseded IAM branch is provided. That branch's `authType: iam`, SSM mode settings and renewal protocol are not supported here.
