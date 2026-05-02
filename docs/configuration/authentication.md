# Authentication

AIDLC Collaborative uses a provider-agnostic authentication system. The default provider is AWS Cognito, but it can be swapped for any OIDC-compatible provider.

## Local development

By default, auth is completely bypassed in local development. When `COGNITO_USER_POOL_ID` is not set, the system:

- Skips all token verification
- Creates a local user identity based on the name you enter
- Grants full access to all resources

No configuration needed to get started.

## AWS Cognito setup

For production or testing with real auth:

### 1. Deploy the Cognito infrastructure

```bash
cd infra/terraform
terraform apply
```

This creates the User Pool, App Client, and hosted UI.

### 2. Bootstrap the first admin

```bash
npx tsx scripts/seed-admin.ts \
  --email admin@example.com \
  --org "My Organization" \
  --org-slug my-org
```

This creates the first organization and admin user in both Cognito and the database.

### 3. Set environment variables

```bash
COGNITO_USER_POOL_ID=us-east-1_abc123
COGNITO_DOMAIN=your-domain.auth.us-east-1.amazoncognito.com
COGNITO_CLIENT_ID=your-client-id
COGNITO_CLIENT_SECRET=your-client-secret
WS_TICKET_SECRET=a-random-string-at-least-32-characters
```

## WebSocket authentication

Real-time features (chat, collaboration) use WebSocket connections that cannot carry HTTP headers. AIDLC Collaborative uses a ticket-based system:

1. The browser requests a short-lived ticket via `POST /api/auth/ws-ticket`
2. The server signs the ticket with `WS_TICKET_SECRET`
3. The browser connects to the WebSocket with the ticket as a query parameter
4. The server verifies the ticket on upgrade

Tickets carry the user ID, role, and connection type (chat or collab).

## Role-based access control (RBAC)

AIDLC Collaborative has two levels of roles:

### Organization roles

| Role | Description |
|------|-------------|
| **owner** | Full control, including org deletion and owner management |
| **admin** | Manage members, projects, and settings |
| **member** | Access assigned projects only |

### Project roles

| Role | Description |
|------|-------------|
| **admin** | Manage project settings, members, and repos |
| **editor** | Create and edit specs, run decompose, start agents |
| **viewer** | Read-only access (enforced on both HTTP and WebSocket) |

### Permission resolution

1. Check for an explicit project role
2. Fall back to org role (owner/admin maps to project admin)
3. Deny access if neither exists

## Swapping auth providers

The auth system is built on a provider-agnostic interface (`AuthProvider`). To use a different OIDC provider (Auth0, Keycloak, Okta):

1. Implement the `AuthProvider` interface in `packages/auth/src/providers/`
2. The interface requires: `verifyToken`, `getLoginUrl`, `getLogoutUrl`, `exchangeCode`, `refreshToken`, `createUser`, `disableUser`
3. Set `AUTH_PROVIDER` to the name of your provider

See `packages/auth/src/types.ts` for the full interface definition.
