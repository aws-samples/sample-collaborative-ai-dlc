# Security

## Authentication

AIDLC Collaborative uses JWT-based authentication with AWS Cognito as the default provider.

### HTTP requests

All API routes are wrapped with `withAuth()`, a higher-order function that:

1. Extracts the JWT from the `Authorization` header
2. Verifies it against the Cognito User Pool
3. Resolves the user's permissions for the requested resource
4. Returns 401 (no token) or 403 (insufficient role) on failure
5. Passes the authenticated user to the route handler

### WebSocket connections

WebSocket connections use a ticket-based system because the WebSocket protocol does not support custom HTTP headers in the browser:

1. Client requests a ticket via `POST /api/auth/ws-ticket`
2. Server signs a short-lived JWT with `WS_TICKET_SECRET`
3. Client connects with `?ticket=...` query parameter
4. Server verifies the ticket during the HTTP upgrade

Tickets carry: user ID, connection type (chat or collab), project role, and expiration.

### Local development bypass

When `COGNITO_USER_POOL_ID` is not set, all auth checks are bypassed. This is the default for local development.

## Authorization

### Role-based access control

Two levels of roles:

- **Org roles**: owner, admin, member
- **Project roles**: admin, editor, viewer

Permission resolution: explicit project role first, then org role fallback, then deny.

### Enforced boundaries

| Action | Required role |
|--------|--------------|
| Read specs | viewer or above |
| Edit specs | editor or above |
| Send chat messages | editor or above |
| Start agents | editor or above |
| Manage members | admin or above |
| Delete org | owner only |

### WebSocket enforcement

Viewer role restrictions are enforced server-side:

- Chat WebSocket rejects messages from viewers
- Collab WebSocket rejects write operations from viewers (Yjs sync protocol level)

## Agent isolation

Each agent runs in its own git worktree:

- Agents cannot modify the main branch directly
- Agents work on dedicated feature branches
- Multiple agents run in parallel without interference
- Failed agents leave no trace on the main branch

## Secret management

- `WS_TICKET_SECRET` signs WebSocket tickets
- `COGNITO_CLIENT_SECRET` authenticates with Cognito
- `GITHUB_TOKEN` / OAuth credentials authenticate with GitHub
- All secrets are stored in `.env.local` (not committed to git)
- In production, secrets are stored in AWS Secrets Manager and injected via ECS task definitions

## Network security (production)

The Terraform infrastructure sets up:

- VPC with public and private subnets
- ALB with HTTPS termination
- Security groups restricting access
- CloudFront distribution for the frontend
- ECS tasks in private subnets with NAT gateway for outbound access
