# AI-DLC: Collaborative AI-Driven Development Lifecycle

[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](LICENSE)
[![Contributing](https://img.shields.io/badge/Contributing-Guide-blue.svg)](CONTRIBUTING.md)

AI-DLC is a platform where humans and AI agents collaborate on software development through a shared, structured workflow. You define what you want built. AI agents plan, implement, and review it. Everything -- requirements, design decisions, tasks, code -- is connected in a graph so nothing gets lost between intent and implementation.

> [!IMPORTANT]
> V1 sprints are view-only in v2. To continue running an active v1 sprint, use the frozen [v1.1.0 release](https://github.com/aws-samples/sample-collaborative-ai-dlc/releases/tag/v1.1.0). Upgrade after that sprint is complete.

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

You need an AWS account with permissions to manage VPC, ECS, ECR, Lambda, API Gateway, DynamoDB, Neptune, S3, CloudFront, Cognito, Bedrock AgentCore, Secrets Manager, and IAM.

## Getting Started

The managed installer is the primary deployment path. It keeps tagged source checkouts under `${XDG_DATA_HOME:-~/.local/share}/collaborative-ai-dlc`, persistent Terraform configuration under `${XDG_CONFIG_HOME:-~/.config}/collaborative-ai-dlc`, and switches the `current` link only after a deployment succeeds.

Download and inspect the installer, then run it:

```bash
curl -fsSLo /tmp/aidlc-install.sh \
  https://raw.githubusercontent.com/aws-samples/sample-collaborative-ai-dlc/main/scripts/install.sh
less /tmp/aidlc-install.sh
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment dev \
  --admin <administrator-email>
```

The password prompt is silent. The permanent Cognito password is sent directly to Cognito and is never written to installer configuration. After installation, sign in at the URL reported by `status`:

```bash
bash /tmp/aidlc-install.sh status
```

### Versions, Adoption, and Updates

Stable releases are selected by default. Prerelease tags such as `v2.1.0-rc.1` are shown only when requested and are never selected as the default:

```bash
bash /tmp/aidlc-install.sh versions
bash /tmp/aidlc-install.sh versions --include-prereleases
bash /tmp/aidlc-install.sh install --version 2.0.0 ...
```

Adopt an existing v1 deployment before updating it. The source checkout must contain the deployment's `terraform/environments/<environment>.tfvars` and `<environment>.s3.tfbackend` files:

```bash
bash /tmp/aidlc-install.sh adopt \
  --source /path/to/existing-v1-checkout \
  --environment dev \
  --profile <aws-profile> \
  --admin <existing-administrator-email>

bash /tmp/aidlc-install.sh update --version 2.0.0
```

An update backs up Terraform state, rejects unexpected destruction of Cognito, Neptune, S3, or persistent DynamoDB resources, deploys infrastructure, grants the existing administrator `platform-admin`, and deploys the frontend. Removal of the retired v1 ECS agent runtime and agent-pool table is expected. If any step fails, `current` remains on the working version. Application-data backup beyond Terraform state remains the operator's responsibility. Downgrades require `--allow-downgrade`.

### Advanced Manual Deployment

The environment argument is a logical deployment name such as `dev`; it is not an AWS profile. Set credentials and region through the AWS CLI environment, and use matching backend and tfvars filenames:

```bash
export AWS_PROFILE=<aws-profile>
export AWS_REGION=<aws-region>

./scripts/bootstrap.sh dev
cp terraform/environments/dev.tfvars.example terraform/environments/dev.tfvars
# Set aws_region = "<aws-region>" in terraform/environments/dev.tfvars.

./scripts/deploy-terraform.sh dev
./scripts/deploy-frontend.sh dev
```

`bootstrap.sh` writes `terraform/environments/dev.s3.tfbackend`. Infrastructure deployment reads that backend file and `terraform/environments/dev.tfvars`, regardless of the AWS profile name. For an approval boundary between planning and applying:

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

### Post-install Configuration

The installer creates the first Cognito user and grants `platform-admin` for v2 (`owner` for v1.1.0). Additional users and administrators are managed in **Admin → User Management**.

Configure agent authentication in **Admin → Agent Settings**: enter a Bedrock bearer token for Claude Code/OpenCode or a Kiro API key. Agent credentials are separate from the Cognito login created during installation.

### Configure Provider OAuth Apps

The platform integrates with external providers as **code hosts** (GitHub, GitLab) and **issue trackers** (GitHub Issues, GitLab Issues, Jira Cloud) so a sprint can be started from a tracker issue. For each provider you want to enable, register an OAuth app with it, then paste the credentials into the **Admin → Tracker OAuth Apps** panel in the deployed app.

For GitHub and GitLab a single OAuth app serves both the code host and that provider's issue tracker — you register it once. Jira Cloud is a tracker only.

All providers are optional. Skip a section if you don't need that provider; the corresponding **Connect** buttons in the UI will stay disabled.

#### GitHub (code host + GitHub Issues)

GitHub supports two platform-wide authentication modes, switchable at runtime in **Admin → GitHub Integration**:

- **OAuth mode** (default): each user connects their own GitHub account; commits, PRs and comments are attributed to that user.
- **GitHub App mode**: the platform authenticates as a GitHub App installation (a bot); users don't connect personal accounts, and the repo picker lists the repositories the App is installed on.

For **OAuth mode**:

1. Open [GitHub Developer Settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   (Choose an **OAuth App**, _not_ a GitHub App — this mode expects OAuth App semantics.)
2. Use:
   - **Homepage URL**: `https://<your-cloudfront-domain>`
   - **Authorization callback URL**: `https://<your-cloudfront-domain>/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**.
4. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → GitHub Issues**. Paste both values and click **Save**.

For **GitHub App mode**:

1. Create a [GitHub App](https://github.com/settings/apps) with repository permissions **Contents: Read & write**, **Pull requests: Read & write**, and **Issues: Read-only**. No callback URL or webhook is needed.
2. Generate a **private key** (PEM) and note the **App ID**.
3. Install the App on the organization/repositories the platform should access, and note the **Installation ID** (the number at the end of the installation's settings URL).
4. In the deployed app, open **Admin → GitHub Integration**, paste the App ID, Installation ID and private key, select **GitHub App (bot)** and click **Save**. The platform validates the configuration live against GitHub before the mode switches.

#### GitLab (code host + GitLab Issues)

1. Open [GitLab → User Settings → Applications](https://gitlab.com/-/user_settings/applications) → **Add new application**.
2. Use:
   - **Redirect URI**: `https://<your-cloudfront-domain>/gitlab/callback`
   - **Scopes**: `api` and `read_user`
   - Leave **Confidential** enabled.
3. Save, then copy the **Application ID** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → GitLab Issues**. Paste both values and click **Save**.

#### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `offline_access` (required so refresh tokens are issued — don’t skip this)
3. Under **Authorization**, set the callback URL to `https://<your-cloudfront-domain>/trackers/callback/jira-cloud`.
4. Open the **Settings** tab of your app and copy the **Client ID** and **Client Secret**.
5. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → Jira Cloud**. Paste both values and click **Save**.

Users then connect their personal accounts from the project-creation flow (GitHub/GitLab) or **Project Settings → Trackers** (Jira) for any project that needs the integration. The Jira Cloud and GitLab Issues tracker integrations are read-only — no issue comments or status changes are pushed back.

You can rotate credentials later by entering new values into the same form; clicking **Save** overwrites the previously stored secret.

<details>
<summary>CLI fallback (for fully-automated deploys)</summary>

The Admin UI is a wrapper around AWS Secrets Manager. If you'd rather populate the secrets in your provisioning pipeline, write the same JSON shape directly:

```bash
aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw gitlab_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw jira_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'
```

</details>

### Manual User Creation

Create users in the Cognito User Pool. The User Pool ID is available via `terraform output user_pool_id` from the `terraform/` directory.

Platform-wide administration (the **Admin** page: user management, agent settings, tracker OAuth apps, GitHub auth mode, migrations — plus workflow and building-block authoring) requires membership in the Cognito `platform-admin` group. Add at least one administrator:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $(terraform -chdir=terraform output -raw user_pool_id) \
  --username <username> \
  --group-name platform-admin
```

Group membership is read from the ID token — users need to sign out and back in after being added. Once the first administrator exists, additional admins can be granted or revoked from the UI under **Admin → User Management** (the CLI is only needed to bootstrap the first one).

### Manual Frontend Deployment

```bash
./scripts/deploy-frontend.sh dev
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
