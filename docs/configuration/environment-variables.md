# Environment Variables

This page documents all environment variables for the backend server and frontend application.

## Backend variables

Backend environment variables are set in `apps/spec-editor/.env.local`. Copy the example file to get started.

```bash
cp apps/spec-editor/.env.local.example apps/spec-editor/.env.local
```

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_SERVER_PORT` | `3001` | Port for the Express WebSocket server |
| `DATA_DIR` | current directory | Directory where the SQLite database file is stored |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CODE_USE_BEDROCK` | - | Set to `1` to use Anthropic Claude via Amazon Bedrock |
| `AWS_ACCESS_KEY_ID` | - | AWS access key (or use any AWS credential method) |
| `AWS_SECRET_ACCESS_KEY` | - | AWS secret key |
| `AWS_REGION` | - | AWS region for Amazon Bedrock (for example, `us-east-1`) |

### GitHub

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | - | Personal access token for GitHub API. Enables issue creation, status sync, and repo cloning with authentication |
| `GITHUB_OAUTH_CLIENT_ID` | - | OAuth app client ID for the GitHub OAuth flow |
| `GITHUB_OAUTH_CLIENT_SECRET` | - | OAuth app client secret |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `COGNITO_USER_POOL_ID` | - | Amazon Cognito User Pool ID. When not set, auth is bypassed locally |
| `COGNITO_DOMAIN` | - | Amazon Cognito hosted UI domain |
| `COGNITO_CLIENT_ID` | - | Amazon Cognito app client ID |
| `COGNITO_CLIENT_SECRET` | - | Amazon Cognito app client secret |
| `WS_TICKET_SECRET` | - | Secret for signing WebSocket tickets (minimum 32 characters). When not set, WebSocket ticket verification is disabled |

### Document storage (production)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCUMENTS_BUCKET` | - | Amazon S3 bucket name for document storage |
| `CLOUDFRONT_DOMAIN` | - | Amazon CloudFront distribution domain |
| `CLOUDFRONT_KEY_PAIR_ID` | - | Amazon CloudFront key pair ID for signed URLs |
| `CLOUDFRONT_PRIVATE_KEY` | - | Amazon CloudFront private key for signed URLs |

## Frontend variables

Frontend environment variables are set in `frontend/.env`. These variables use the `VITE_` prefix and are embedded into the frontend build at compile time.

### Automatic generation

After deploying the infrastructure, run the following command to generate `frontend/.env` from Terraform outputs.

```bash
./scripts/generate-env.sh dev
```

This script reads values from Terraform outputs and writes them to `frontend/.env`. You must deploy the infrastructure before running this command.

### Manual configuration

To configure manually, copy the example file and edit the values.

```bash
cp frontend/.env.example frontend/.env
```

The following table describes the frontend environment variables.

| Variable | Description | How to obtain |
|----------|-------------|---------------|
| `VITE_AWS_REGION` | AWS region (for example, `us-east-1`) | Set to the region where you deployed |
| `VITE_AWS_USER_POOL_ID` | Amazon Cognito User Pool ID | `terraform output user_pool_id` |
| `VITE_AWS_USER_POOL_CLIENT_ID` | Amazon Cognito App Client ID | `terraform output user_pool_client_id` |
| `VITE_API_BASE_URL` | Amazon API Gateway endpoint URL | `terraform output api_gateway_url` |
| `VITE_WEBSOCKET_URL` | WebSocket API endpoint | `terraform output websocket_api_endpoint` |
| `VITE_YJS_SERVER_URL` | Yjs collaboration server URL (via Amazon CloudFront) | `wss://<cloudfront_domain>/yjs` |
| `VITE_ENVIRONMENT` | Environment name (`development` or `production`) | Set based on your deployment |

### Example values

```bash
VITE_AWS_REGION=us-east-1
VITE_AWS_USER_POOL_ID=us-east-1_aBcDeFgHi
VITE_AWS_USER_POOL_CLIENT_ID=1abc2def3ghi4jkl5mno6pqr7s
VITE_API_BASE_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/dev
VITE_WEBSOCKET_URL=wss://ws123abc.execute-api.us-east-1.amazonaws.com/dev
VITE_YJS_SERVER_URL=wss://d1234abcdef.cloudfront.net/yjs
VITE_ENVIRONMENT=development
```

!!! warning "Rebuild required"
    Frontend environment variables are embedded at build time. After changing any `VITE_*` variable, you must rebuild and redeploy the frontend for changes to take effect.

## Local development

For basic local development, you do not need to set any environment variables. The defaults work out of the box.

- Auth is bypassed when `COGNITO_USER_POOL_ID` is not set
- WebSocket tickets are not verified when `WS_TICKET_SECRET` is not set
- The database is created automatically in the current directory
- The server runs on port 3001

The only variable you might want for local development is `GITHUB_TOKEN` if you want to use the GitHub integration features.

For AWS deployment, see [Setup](../getting-started/setup.md) for complete setup instructions.
