# Security

## Scope

Collaborative AI-DLC is an **open-source demo application** published as an
AWS Sample. It is designed for learning, experimentation, and evaluation — not
for production use without additional hardening.

The security posture targets: *a customer deploying this in their own AWS
account should not be exposed to vulnerabilities the documentation didn't warn
them about.*

## What Is Hardened

The following security controls are in place at release:

| Control | Evidence |
|---------|----------|
| Cognito SRP authentication (no plaintext passwords) | `ALLOW_USER_SRP_AUTH` only |
| Optional TOTP MFA on Cognito User Pool | `mfa_configuration = "OPTIONAL"` |
| Neptune IAM auth + audit logging | `iam_database_authentication_enabled = true` |
| S3 public access blocked, OAC on CloudFront | All three buckets |
| CORS origin allowlist on all Lambda responses | `CORS_ALLOWED_ORIGINS` env var |
| GitHub tokens stored in SSM SecureString (KMS at rest) | OAuth callback flow |
| Yjs ALB internal with CloudFront VPC Origin | No direct internet access to ALB |
| Cognito JWT required on Yjs WebSocket upgrade | `lambda/yjs-server/server.js` upgrade handler validates ID token before handshake |
| Cognito User Pool restricted to admin-created users | `admin_create_user_config { allow_admin_create_user_only = true }` disables public SignUp API |
| TLS everywhere (HTTPS, WSS) | CloudFront viewer-protocol-policy |
| Gremlin bytecode API (injection-resistant) | All 20 Neptune clients |
| HMAC-signed OAuth state with 10-min expiry | CSRF protection on GitHub callback |
| Sensitive data stripped from CloudWatch logs | No full-event logging |
| Generic 500 error responses (no stack traces, no endpoints) | All Lambda handlers |
| Agent state and review status are system-write-only | Sprint PUT / Review PUT |
| SigV4 authentication on all Neptune clients | Including phases Lambda |
| SSM parameter name format validation | Path traversal prevention |
| Git token in remote URL scoped to ephemeral ECS container | Token available only during agent session |
| Refresh token validity reduced to 7 days | Cognito User Pool Client |
| Minimum password length 12 + complexity requirements | Cognito User Pool |
| Per-function least-privilege IAM roles (5 roles, not 1 shared) | `terraform/modules/api/lambda/main.tf` |
| TLS enforced on every S3 bucket (`aws:SecureTransport=false` deny) | All four buckets |

## Known Limitations and Accepted Risks

The findings below were identified during the threat model review and are
**intentionally deferred** for this release. Each is documented here so
deployers can make informed decisions.

### Single-Tenant Authorization Model

**What:** All authenticated Cognito users have full CRUD access to all projects
in the deployment. Only the `projects`, `users`, and `agents` Lambdas verify
project membership via the `HAS_MEMBER` graph edge. The remaining ~20 entity
Lambdas (sprints, requirements, tasks, reviews, artifacts, etc.) skip this check.

**Why this is acceptable for a demo:**
Every customer deploys their own instance in their own AWS account with their
own Cognito User Pool. They create and control every user. In this single-tenant
model, cross-project access within the same deployment is a feature, not a
vulnerability — all users belong to the same organization.

**If you need multi-team isolation:** deploy separate instances, or implement
the shared `authz.js` middleware described in the threat model (P0-01).

**Threat model reference:** P0-01, P0-14

### WebSocket Event Visibility

**What:** Any authenticated user can subscribe to any project's real-time
events (agent status changes, phase transitions, Q&A notifications) via
the WebSocket API. The `$connect` handler does not verify project membership.

**Why this is acceptable for a demo:**
Same reasoning as above — single-tenant deployment. The events are operational
status updates, not sensitive document content. A membership check on
`$connect` is recommended before any multi-tenant use.

**Threat model reference:** P0-04, P0-11

### Yjs ID Token in CloudFront Access Logs

**What:** The Yjs WebSocket upgrade requires a Cognito ID token passed as a
query string (`?token=<jwt>`). CloudFront standard access logging is enabled on
this distribution and forwards the full query string to the S3 access log
bucket, so each Yjs WebSocket upgrade request writes the (1-hour-lived) ID
token into an access log line.

**Why this is acceptable for a demo:**
Access logs are written to an S3 bucket that blocks public access and is
scoped to the deployer's AWS account. The token expires in 60 minutes, so the
replay window is bounded. Browsers have no API to send custom headers on a
WebSocket, and a Sec-WebSocket-Protocol subprotocol trick was rejected as
more fragile. For a demo, query-string transport is the same trade-off as the
existing Cognito-authorized API Gateway WebSocket (`realtime.ts` passes the
same token the same way).

**If you need to eliminate the exposure:** disable CloudFront logging on the
`/yjs/*` behavior, or add a token-exchange endpoint that mints a short-lived
signed cookie and rework the Yjs client to rely on cookie-based auth.

**Threat model reference:** P0-03

### Agent Graph Access Scope

**What:** AI agents have read/write access to the entire Neptune graph, not
just their assigned sprint or project. The MCP tools (`find_nodes`,
`update_node`, `add_edge`) operate globally.

**Why this is acceptable for a demo:**
Exploiting this requires prompt injection — a malicious repository must
contain crafted instructions that cause the LLM to issue cross-project graph
operations via MCP tools. This is an indirect attack with low probability in
a controlled demo environment. The blast radius is limited to data within the
same deployment (which, in the single-tenant model, belongs to the same org).

**If you process untrusted repositories:** add sprint/project scoping to the
MCP tools as described in the threat model (P0-05).

**Threat model reference:** P0-05

### Git Token Transit Exposure

**What:** GitHub access tokens are stored securely at rest (SSM SecureString)
but transit through DynamoDB job payloads and ECS container environment
variables when dispatching agents.

**Why this is acceptable for a demo:**
Both DynamoDB and ECS are protected by IAM within your AWS account. The token
is not exposed to end users or external networks. This is a defense-in-depth
gap, not a direct exposure. The recommended production fix is to pass only the
SSM parameter name in job payloads and resolve the token at execution time.

**Threat model reference:** P0-12

### ECS Worker IAM Permissions

**What:** The ECS task role for agent workers includes `dynamodb:Scan` on the
agent-pool table, which is broader than needed (`GetItem`/`UpdateItem` on the
worker's own record would suffice).

**Why this is acceptable for a demo:**
Agent workers are controlled infrastructure, not user-facing components. The
pool table contains worker metadata and job assignments — not user data. This
is a least-privilege refinement, not an exploitable vulnerability.

**Threat model reference:** P0-13

### Legacy Plaintext Token Fallback

**What:** `resolveGitToken()` falls back to reading `item.accessToken` from
DynamoDB if no SSM parameter reference exists. This path exists for backward
compatibility with development installations.

**Action required before production:** Remove the fallback. It is marked
`TODO(pre-release)` in `lambda/shared/git-token.js`.

**Threat model reference:** P0-06

## Recommended Hardening Before Production Use

The following are not included in the demo but are recommended for any
production deployment:

| Recommendation | Effort | Cost |
|---------------|--------|------|
| Add project membership checks to all entity Lambdas | 3-4 days | $0 |
| Scope MCP tools to current sprint/project | 1-2 days | $0 |
| Add Content-Security-Policy headers via CloudFront | 2-4 hours | $0 |
| Enable WAF on CloudFront and API Gateway | 2-4 hours | $5-20/mo |
| Run containers as non-root (`USER node` in Dockerfiles) | 1 day | $0 |
| Migrate token storage to httpOnly cookies | 4 hours | $0 |
| Enable Cognito Advanced Security (adaptive auth) | Low | ~$0.05/MAU |
| Enable GuardDuty on the AWS account | Low | $1-10/mo |

## Rotating and Revoking GitHub Tokens

The application stores a per-user GitHub OAuth access token in AWS Systems
Manager Parameter Store (SSM) as a `SecureString` (KMS-encrypted at rest).
A user connects their GitHub account via the OAuth authorization flow
exposed by the `github` Lambda. The token is never exposed to the browser,
never written to CloudWatch logs, and never persisted in DynamoDB in
plaintext.

A stored token may need to be rotated or revoked if: the user changes or
revokes their GitHub personal access, the deployer suspects the underlying
AWS account has been compromised, or a security advisory is published
against the GitHub OAuth app credentials stored in AWS Secrets Manager.

### Revoke a single user's token

1. Identify the user's Cognito `sub` claim (visible in the Cognito User
   Pool console or via the application's admin panel).
2. Delete the SSM parameter at path
   `/<project_name>/<environment>/git-token/<sub>`:
   ```sh
   aws ssm delete-parameter \
     --name "/<project_name>/<environment>/git-token/<sub>"
   ```
3. Delete the corresponding item from the `git-connections` DynamoDB
   table (partition key = `sub`). The application detects missing
   connections and re-prompts the user to re-authorize on next GitHub
   action.
4. Ask the user to also revoke the token on the GitHub side at
   https://github.com/settings/applications so the token is invalidated
   even if an attacker already held a copy.

### Rotate a user's token

The application does not implement background token refresh. Rotation is
user-driven: the user disconnects their GitHub account in the UI (or the
deployer follows the revocation procedure above) and then re-runs the
"Connect GitHub" flow, which performs a fresh OAuth authorization and
writes a new token to SSM.

### Rotate the OAuth app credentials (deployer action)

The GitHub OAuth application's `client_id` and `client_secret` are stored
in AWS Secrets Manager under the secret name passed as the
`github_oauth_secret_name` Terraform variable. To rotate:

1. Generate new credentials in the GitHub OAuth app settings at
   https://github.com/settings/developers (Reset client secret).
2. Update the secret value in AWS Secrets Manager. The JSON payload uses
   the keys `client_id` and `client_secret`.
3. Previously issued user tokens remain valid on the GitHub side until
   they expire or are revoked. After a credential-compromise incident you
   should revoke every user token (emergency wipe below) and force
   re-authorization.

### Emergency wipe (all users)

If every user token must be invalidated at once, delete every parameter
under the prefix `/<project_name>/<environment>/git-token/` and truncate
the `git-connections` DynamoDB table. Users will be re-prompted to
re-authorize on their next GitHub action.
