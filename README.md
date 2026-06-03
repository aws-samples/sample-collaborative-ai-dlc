# AI-DLC: Collaborative AI-Driven Development Lifecycle

[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](LICENSE)
[![Contributing](https://img.shields.io/badge/Contributing-Guide-blue.svg)](CONTRIBUTING.md)

AI-DLC is a platform where humans and AI agents collaborate on software development through a shared, structured workflow. You define what you want built. AI agents plan, implement, and review it. Everything -- requirements, design decisions, tasks, code -- is connected in a graph so nothing gets lost between intent and implementation.

## Why AI-DLC

**Requirements that trace to code.** Every requirement breaks into user stories, then tasks, then code files -- all linked in a graph database. When you change a requirement, you can see exactly what downstream work is affected.

**Agents that ask questions.** AI agents don't guess. When they need clarification during planning or implementation, they pause and ask. You answer in the UI, and the agent picks up where it left off. Human judgment stays in the loop without human bottlenecks.

**Parallel construction.** The platform models task dependencies explicitly. When construction starts, an orchestrator dispatches independent tasks to parallel agents, each working on its own branch. Tasks that depend on others wait until their dependencies are done. The result is a PR from sprint branch to main.

**Real-time collaboration.** Multiple users can edit the same requirement or story simultaneously with conflict-free resolution (Yjs/CRDT). Agent progress streams to the UI in real time -- you see what the agent is thinking and doing as it works.

**Three-phase lifecycle.** Inception (what and why), Construction (how), Review (did it work). Each phase produces artifacts in the graph, and phase transitions require human approval. The review agent evaluates code against the original requirements, not just code quality.

## Prerequisites

| Tool      | Version       |
| --------- | ------------- |
| Node.js   | 22+           |
| Terraform | 1.0+          |
| AWS CLI   | v2            |
| Docker    | Recent stable |

You need an AWS account with permissions to manage VPC, ECS, ECR, Lambda, API Gateway, DynamoDB, Neptune, S3, CloudFront, Cognito, EventBridge, Step Functions, Secrets Manager, and IAM.

## Getting Started

### 1. Create Terraform State Backend

This is a one-time setup. The bootstrap script creates the S3 bucket (with a random suffix for global uniqueness) and writes a `.s3.tfbackend` file:

```bash
export AWS_PROFILE=<your-profile-name>
export REGION=<your-region>
./scripts/bootstrap.sh <your-profile-name>
```

### 2. Configure Terraform Variables

```bash
cp terraform/environments/dev.tfvars.example terraform/environments/<your-profile-name>.tfvars
# Edit dev.tfvars with your desired region, etc.
```

### 3. Deploy Infrastructure

This builds all Lambda packages and provisions the full AWS stack (VPC, Neptune, DynamoDB, Cognito, API Gateway, ECS, S3, CloudFront, etc.):

```bash
./scripts/deploy-terraform.sh <your-profile-name>
```

After deployment, agent workers authenticate with Kiro CLI via device flow. Check the agent pool DynamoDB table or ECS logs for the auth URL and device code.

### 4. Configure Tracker OAuth Apps

The platform integrates with external trackers so a sprint can be started from a tracker issue (GitHub Issue, Jira issue). For each tracker you want to enable, register an OAuth app with the provider, then paste the credentials into the **Admin → Tracker OAuth Apps** panel in the deployed app.

Both providers are optional. Skip a section if you don't need that tracker; the corresponding **Connect** buttons in the UI will stay disabled.

#### GitHub Issues

1. Open [GitHub Developer Settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   (Choose an **OAuth App**, _not_ a GitHub App — the flow here expects OAuth App semantics.)
2. Use:
   - **Homepage URL**: `https://<your-cloudfront-domain>`
   - **Authorization callback URL**: `https://<your-cloudfront-domain>/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**.
4. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → GitHub Issues**. Paste both values and click **Save**.

#### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `offline_access` (required so refresh tokens are issued — don’t skip this)
3. Under **Authorization**, set the callback URL to `https://<your-cloudfront-domain>/trackers/callback/jira-cloud`.
4. Open the **Settings** tab of your app and copy the **Client ID** and **Client Secret**.
5. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → Jira Cloud**. Paste both values and click **Save**.

Users then connect their personal accounts from **Project Settings → Trackers** for any project that needs the integration. The Jira Cloud integration is read-only — no comments or status changes are pushed back to Jira.

You can rotate credentials later by entering new values into the same form; clicking **Save** overwrites the previously stored secret.

<details>
<summary>CLI fallback (for fully-automated deploys)</summary>

The Admin UI is a wrapper around AWS Secrets Manager. If you'd rather populate the secrets in your provisioning pipeline, write the same JSON shape directly:

```bash
aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw jira_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'
```

</details>

### 5. Create Users

Create users in the Cognito User Pool. The User Pool ID is available via `terraform output user_pool_id` from the `terraform/` directory.

### 6. Deploy Frontend

```bash
./scripts/deploy-frontend.sh <your-profile-name>
```

The application is available at the CloudFront domain:

```bash
cd terraform && terraform output cloudfront_domain_name
```

## Documentation

Documentation is built with [Zensical](https://zensical.org/) and deployed to GitHub Pages. The [architecture overview](docs/concepts/architecture.md) is a good starting point for a system-level view of the components.

To serve locally:

```bash
uv sync --group docs
uv run zensical serve
```

To build:

```bash
uv run zensical build
```

## Testing & Code Quality

Run the unit tests and generate a coverage report:

```bash
npm test                 # run all unit tests
npm run test:coverage    # run tests with a coverage report (HTML in coverage/)
```

Lint, format, and security checks:

```bash
npm run lint             # oxlint
npm run format:check     # oxfmt (use `npm run format` to apply fixes)
npm run secretlint       # scan the repo for committed secrets
npm run audit:prod:all   # npm audit on production deps for root + frontend (high+ severity)
npm run typecheck:frontend  # tsc -b on the frontend package
```

A pre-commit hook (managed by Husky + lint-staged) runs these checks plus Terraform formatting/linting and the affected unit tests before each commit. It is installed automatically by `npm install`. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to participate.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting instructions.

## License

This project is licensed under the [MIT-0 License](LICENSE).
