<div align="center">

<h1 align="center">
<a href="https://aws-samples.github.io/sample-collaborative-ai-dlc/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/hero-light.png" />
    <img src="docs/assets/readme/hero-light.png" alt="Collaborative AI-DLC — several people working on the same intent at the same time" width="560" />
  </picture>
</a>
</h1>

<h3>Your whole team and their coding agents, building in one live workspace.</h3>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT--0-EAB308.svg" alt="MIT-0 license" /></a>
  <a href="https://aws-samples.github.io/sample-collaborative-ai-dlc/"><img src="https://img.shields.io/badge/Docs-GitHub%20Pages-2563EB.svg" alt="Documentation" /></a>
  <a href="https://github.com/aws-samples/sample-collaborative-ai-dlc/releases"><img src="https://img.shields.io/github/v/release/aws-samples/sample-collaborative-ai-dlc?include_prereleases&label=release&color=F59E0B" alt="Latest release" /></a>
</p>

<p>
  <a href="#watch-collaborative-ai-dlc">Video</a> ·
  <a href="#why-collaborative-ai-dlc">Why</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">Workflow</a> ·
  <a href="https://aws-samples.github.io/sample-collaborative-ai-dlc/">Docs</a>
</p>

</div>

Collaborative AI-DLC is where a team of humans collaborates in real time with multiple remote coding agents, following the structured AI-DLC methodology. It is an early-preview AWS sample you deploy into **your own AWS account**: it runs the agents you already use — Kiro, Claude Code, OpenCode, Codex — in isolated cloud sessions and walks every intent through a governed lifecycle — requirements, human approval gates, parallel implementation, pull request, and a traceability graph the whole team can read.

> [!NOTE]
> **[AI-DLC](https://github.com/awslabs/aidlc-workflows)** is the AI-Driven Development Life Cycle methodology: phases, stages, artifacts, agent personas, and human validation gates. **Collaborative AI-DLC** is this platform: a shared orchestration and governance layer over those existing coding agents, not another coding assistant.

## Watch Collaborative AI-DLC

<p align="center">
  <a href="https://aws-samples.github.io/sample-collaborative-ai-dlc/overview-video/">
    <img src="docs/assets/readme/collaborative-ai-dlc-overview-poster.jpg" alt="Scenes from the Collaborative AI-DLC overview: intent creation, human collaboration, traceability, agent execution, review, and delivery" width="800" />
  </a>
  <br /><strong>See humans and remote coding agents build together in under five minutes.</strong>
  <br /><sub>Click the preview to watch the full overview on the documentation site.</sub>
</p>

When an agent session ends, the reasoning goes with it. Requirements sit in one document, the "why" scrolls away in chat, and the pull request shows the diff rather than the decisions behind it. Collaborative AI-DLC keeps intent, questions, approvals, design decisions, code, and cost linked in one graph for the whole team.

## Why Collaborative AI-DLC

|                                                                                                                                         |                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Human approval gates**](https://aws-samples.github.io/sample-collaborative-ai-dlc/concepts/execution/#human-gates-park-and-resume)   | An ambiguous decision parks the run. The agent resumes only after a person answers in the UI — execution state is preserved, not restarted.    |
| [**Real-time collaboration**](https://aws-samples.github.io/sample-collaborative-ai-dlc/using-the-platform/real-time-collaboration/)    | Any number of teammates can edit, discuss, and resolve the same intent at the same time. Presence and selections sync over Yjs and WebSockets. |
| [**Requirement-to-code traceability**](https://aws-samples.github.io/sample-collaborative-ai-dlc/concepts/)                             | Typed graph relationships link requirements, questions, decisions, artifacts, and the code structure they produced.                            |
| [**Cost and execution visibility**](https://aws-samples.github.io/sample-collaborative-ai-dlc/using-the-platform/intent-observability/) | Stage duration, sensor verdicts, token usage, and cost per stage, intent, and project — computed from live model pricing.                      |

<p align="center">
  <img src="docs/assets/readme/traceability-graph.png" alt="The intent graph: requirements, questions, decisions, and code structure linked by typed relationships around one intent" width="100%" />
  <br /><strong>Every requirement leads back to code.</strong>
  Typed relationships link requirements, questions, decisions, and the code structure they produced — one navigable graph per intent.
</p>

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/human-gate-card.png" alt="An agent's structured question waiting at a human gate" width="100%" />
      <br /><strong>The agent stops before guessing.</strong>
      <br />Ambiguity becomes a structured question. Execution stays parked until a person decides.
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/live-collaboration-card.png" alt="A team member's session showing a colleague's message in the shared intent discussion" width="100%" />
      <br /><strong>Your whole team, one intent.</strong>
      <br />However many people join, presence, discussions, and selections stay in sync — and land in the intent graph.
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/assets/readme/cost-observability-card.png" alt="Usage and activity panel: input tokens, output tokens, total tokens, and cost for one intent" width="100%" />
  <br /><sub>Cost is computed per stage from live model pricing, then aggregated for the whole intent.</sub>
</p>

<details>
<summary><strong>Watch the 15-second run</strong> — intent, human gate, plan approval, pull request, traceability graph</summary>

<p align="center">
  <a href="docs/assets/readme/demo.gif">
    <img src="docs/assets/readme/demo-poster.png" alt="Preview of the fifteen-second demo: the generated pull request with intent, changes, and traceability sections" width="720" />
  </a>
  <br />
  <sub>Click the preview to play the capture (2.4 MB GIF).</sub>
</p>

</details>

## Quickstart

The managed installer is the primary deployment path. Download it, **inspect it**, then run it:

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

Behind an HTTP proxy, export the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` variables before downloading and running the installer; it forwards them (lowercase variants included) to the Docker Buildx builds, and `TF_VAR_docker_build_args` overrides auto-detection. Proxy values are hidden in Terraform CLI output but remain in saved plans and state, so keep the state backend encrypted and access-restricted.

The password prompt is silent. The permanent Cognito password is sent directly to Cognito and is never written to installer configuration. After installation, sign in at the URL reported by:

```bash
bash /tmp/aidlc-install.sh status
```

Then configure agent credentials in **Admin → Agents** (a Bedrock API key for Claude Code / OpenCode / Codex, or a Kiro API key) and follow [Your first intent](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/first-intent/).

> [!WARNING]
> **This deploys real AWS infrastructure into your account**: VPC, Neptune, ECS Fargate, Lambda, API Gateway, DynamoDB, S3, CloudFront, Cognito, Bedrock AgentCore, ECR, and Secrets Manager. Some of these resources bill while idle (Neptune and the Fargate collaboration server in particular), and agent runs incur Bedrock model-invocation charges on top. Deployment takes 15 to 30 minutes. Tear everything down with the [destroy command](#destroy-infrastructure) when you're done evaluating.

## How it works

Work is organized around **intents**. An intent is a title and a prompt (a feature, a bugfix, a whole greenfield system) scoped to a project. Starting an intent executes a workflow whose stages progress through three phases: **Inception** (requirements, user stories, units of work), **Construction** (parallel per-unit implementation lanes), and **Delivery** (fan-in, build and test, pull request).

1. **Create an intent.** Write a prompt, or import a tracker issue (GitHub Issues, GitLab Issues, Jira Cloud). Pick a scope such as feature, bugfix, or greenfield.
2. **Start it.** A durable orchestrator compiles the pinned workflow into an execution plan and walks its stages. Each stage runs a headless agent CLI in an isolated Bedrock AgentCore session; agents write typed artifacts into the graph through MCP tools, and the engine owns all git operations.
3. **Collaborate.** Answer clarifying questions, approve gates, discuss artifacts in threads, and steer the run with course corrections, all in real time.
4. **Observe.** Watch live progress on the intent workbench, drill into per-stage sensors, durations, token usage, and cost, and explore the traceability graph.
5. **Review.** On success the platform opens a pull request (GitHub, Bitbucket) or merge request (GitLab) from the intent branch. Review the code alongside the intent's artifacts and metrics.

Three orthogonal safety nets verify every stage: deterministic **sensors**, an LLM **reviewer** agent, and **human validation gates**. See the [architecture overview](https://aws-samples.github.io/sample-collaborative-ai-dlc/concepts/architecture/) for the full system diagram.

## Documentation

Full documentation lives at [aws-samples.github.io/sample-collaborative-ai-dlc](https://aws-samples.github.io/sample-collaborative-ai-dlc/).

| Section                                                                                                       | What it covers                                                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Prerequisites](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/prerequisites/)     | Required tools, AWS permissions, agent authentication                       |
| [Setup](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/setup/)                     | Managed and manual installation, custom domains, users, provider OAuth apps |
| [Your first intent](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/first-intent/)  | End-to-end walkthrough of one workflow run                                  |
| [Methodology](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/methodology/)         | The AI-DLC methodology and how the platform embeds it                       |
| [Methodology map](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/methodology-map/) | Upstream AI-DLC vocabulary mapped to platform concepts                      |
| [Concepts](https://aws-samples.github.io/sample-collaborative-ai-dlc/concepts/)                               | Founding principles, lifecycle, execution model, workflows and blocks       |
| [Architecture](https://aws-samples.github.io/sample-collaborative-ai-dlc/concepts/architecture/)              | Request path, agent runtime, data stores, end-to-end flow                   |
| [Using the platform](https://aws-samples.github.io/sample-collaborative-ai-dlc/using-the-platform/projects/)  | Projects, intents, discussions, git integration, observability, settings    |
| [Testing guide](https://aws-samples.github.io/sample-collaborative-ai-dlc/development/testing/)               | AgentCore test project and credentialed agent E2E                           |

## Prerequisites

| Tool      | Version       |
| --------- | ------------- |
| Node.js   | 22+           |
| Terraform | 1.4+          |
| AWS CLI   | v2            |
| Docker    | Recent stable |

You need an AWS account with permissions to manage VPC, ECS, ECR, Lambda, API Gateway, DynamoDB, Neptune, S3, CloudFront, Cognito, Bedrock AgentCore, Secrets Manager, Systems Manager Parameter Store, and IAM. See [Prerequisites](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/prerequisites/) for the full service list and verification commands.

Agent CLIs authenticate through credentials you configure after install, in **Admin → Agents**:

- **Amazon Bedrock API key** for Claude Code, OpenCode, and Codex. The AgentCore runtime's IAM role intentionally has no Bedrock model-invocation permissions; this token is the only path. For Codex, additionally enable the OpenAI models (`openai.gpt-5.*`) in the Bedrock console for your Region.
- **Kiro API key** for the Kiro CLI driver. A Kiro administrator must first enable API key generation in the Kiro console.

Both are stored as `SecureString` parameters in Systems Manager Parameter Store.

## Installation and operations

The managed installer keeps tagged source checkouts under `${XDG_DATA_HOME:-~/.local/share}/collaborative-ai-dlc`, persistent Terraform configuration under `${XDG_CONFIG_HOME:-~/.config}/collaborative-ai-dlc`, and switches the `current` link only after a deployment succeeds. Its `install.conf` is authoritative for the environment, region, and custom-domain settings: every install or update synchronizes those values into the managed `tfvars` and warns before replacing a differing existing assignment.

The [Quickstart](#quickstart) above covers the initial install. Everything below assumes the same downloaded and inspected `/tmp/aidlc-install.sh`.

### Custom domain (optional)

By default the application is served on the CloudFront-assigned `*.cloudfront.net` domain, which needs no certificate and no DNS. To use your own hostname, add either an existing certificate or a Route53 hosted zone:

```bash
# Bring your own certificate; manage DNS wherever you like.
bash /tmp/aidlc-install.sh install ... \
  --domain aidlc.example.com \
  --certificate-arn arn:aws:acm:us-east-1:111122223333:certificate/<id>

# Or let Terraform request the certificate and create the records.
bash /tmp/aidlc-install.sh install ... \
  --domain aidlc.example.com \
  --hosted-zone-id Z1234567890ABC
```

The certificate must be in `us-east-1` regardless of the deployment region, because CloudFront accepts viewer certificates from no other region. Add `--domain-alias` (repeatable) for additional hostnames, and `--no-domain` on `update` to remove a configured domain. The installer validates the certificate, hosted zone, and hostname availability before touching AWS.

See [Setup → Custom domain](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/setup/#custom-domain) for external-DNS records, the manual-path preflight checks, and what to update when adding a domain to a running deployment.

### Enterprise SSO (optional)

Enterprise deployments can federate one or more OIDC or SAML providers through the Cognito User Pool in `hybrid` or `sso-only` mode. Cognito remains the JWT issuer; external role claims are authoritative for federated users. Install in local mode first, register the callback URLs reported by the installer with the identity provider, then update the managed installation:

```bash
bash /tmp/aidlc-install.sh update \
  --version <current-version> \
  --auth-mode hybrid \
  --sso-config /path/to/providers.json
```

See [Enterprise SSO](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/enterprise-sso/) for Microsoft Entra ID, Okta, generic SAML, installer usage, and role mapping.

### Versions and updates

All tagged releases, including previews such as `v2.0.0-preview0`, are shown by default. With no explicit version, install and update select the highest tag by SemVer precedence, so a stable `v2.0.0` supersedes `v2.0.0-preview0`:

```bash
bash /tmp/aidlc-install.sh versions
bash /tmp/aidlc-install.sh install --version 2.0.0-preview0 ...
bash /tmp/aidlc-install.sh install --version 2.0.0 ...
bash /tmp/aidlc-install.sh update
```

Downgrades require `--allow-downgrade`.

### Adopt an existing v1 deployment

Adopt before updating. The source checkout must contain the deployment's `terraform/environments/<environment>.tfvars` and `<environment>.s3.tfbackend` files:

```bash
bash /tmp/aidlc-install.sh adopt \
  --source /path/to/existing-v1-checkout \
  --environment dev \
  --profile <aws-profile> \
  --admin <existing-administrator-email>

bash /tmp/aidlc-install.sh update --version 2.0.0
```

An update backs up Terraform state, rejects unexpected destruction of Cognito, Neptune, S3, or persistent DynamoDB resources, deploys infrastructure, grants the existing administrator `platform-admin`, and deploys the frontend. Removal of the retired v1 ECS agent runtime and agent-pool table is expected. If any step fails, `current` remains on the working version. Application-data backup beyond Terraform state remains the operator's responsibility. v1 work stays viewable but read-only after the upgrade.

### Destroy infrastructure

> [!CAUTION]
> **Destructive and irreversible.** These commands permanently delete all application data, including DynamoDB tables, the Neptune database, and S3 buckets.

For a managed installation:

```bash
bash /tmp/aidlc-install.sh destroy
```

The command requires typing the configured environment name; `--yes` is available for deliberate automation. It backs up Terraform state before destroying all application resources and data, then removes the managed `current` link. Local configuration, immutable checkouts, the state backup, and the Terraform state bucket are retained.

For a local/manual checkout:

```bash
./scripts/destroy.sh dev
```

To also remove the Terraform state bucket created during bootstrap:

```bash
grep bucket terraform/environments/dev.s3.tfbackend
aws s3 rb s3://<bucket-name> --force
```

## Advanced manual deployment

For operators who prefer to run Terraform directly instead of the managed installer. The environment argument is a logical deployment name such as `dev`; it is not an AWS profile. Set credentials and region through the AWS CLI environment, and use matching backend and tfvars filenames:

```bash
export AWS_PROFILE=<aws-profile>
export AWS_REGION=<aws-region>

./scripts/bootstrap.sh dev
cp terraform/environments/dev.tfvars.example terraform/environments/dev.tfvars
# Set aws_region = "<aws-region>" in terraform/environments/dev.tfvars.
# For a custom domain, set app_domain plus either acm_certificate_arn or
# route53_zone_id in the same file; the commented block there explains both.

./scripts/deploy-terraform.sh dev
./scripts/deploy-frontend.sh dev
```

`bootstrap.sh` writes `terraform/environments/dev.s3.tfbackend`. Infrastructure deployment reads that backend file and `terraform/environments/dev.tfvars`, regardless of the AWS profile name. On this manual path, nothing rewrites the tfvars; it is yours to edit. Manual deployments honor the same proxy variables documented in the [Quickstart](#quickstart); export them before `--phase plan`, because Terraform resolves `TF_VAR_docker_build_args` while planning and stores the value in the saved plan. `docker_build_args` can also be set in the `.tfvars` file. For an approval boundary between planning and applying:

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

The plan is rejected in both phases if it would destroy a Cognito user pool, Neptune cluster, S3 bucket, or DynamoDB table.

<details>
<summary>Variable overrides, environment variables, and manual-path caveats</summary>

Individual variables can be overridden without editing the file, repeating `--var` per variable:

```bash
./scripts/deploy-terraform.sh dev \
  --var app_domain=aidlc.example.com \
  --var route53_zone_id=Z1234567890ABC
```

`TF_VAR_*` environment variables will _not_ work for this: Terraform ranks `-var-file` above them, so any key already present in the tfvars silently wins. `--var` is passed as `-var`, which does outrank the file. It applies at plan time, so combining it with `--phase apply` is rejected; a saved plan already has its variables resolved.

Both deploy scripts are needed after a custom-domain change: Terraform updates the distribution and the OAuth redirect URIs, then the frontend has to be rebuilt because its endpoint URLs are inlined into the bundle at build time. `deploy-terraform.sh` prints the DNS records to create when `route53_zone_id` is empty.

The installer's custom-domain preflight checks do not run on this path. Terraform cannot verify a certificate's status, which hostnames it covers, or whether another distribution already claims your hostname. See [Setup → Custom domain → Without the installer](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/setup/#without-the-installer) for the commands to check by hand.

Useful environment variables when iterating:

| Variable              | Effect                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| `AIDLC_SKIP_NPM_CI=1` | Skips the root `npm ci` before planning; saves time on repeat runs                  |
| `AIDLC_KEEP_PLAN=1`   | Keeps the plan file after a successful apply                                        |
| `AIDLC_TFVARS_FILE`   | Path to an alternative `.tfvars`, overriding the `<environment>.tfvars` convention  |
| `AIDLC_BACKEND_FILE`  | Path to an alternative `.s3.tfbackend`                                              |
| `AIDLC_CONFIG_DIR`    | Directory holding `environments/`, for Terraform configuration outside the checkout |

</details>

## Post-install configuration

### Agent credentials

In local/hybrid mode, the installer creates the first Cognito user and grants `platform-admin` for v2 (`owner` for v1.1.0); in `sso-only` mode, administrator access comes from an external role mapping, and federated roles appear in **Admin → Users** as externally managed and read-only. Configure agent authentication in **Admin → Agents**: an Amazon Bedrock API key (as the Bedrock Bearer Token) for Claude Code, OpenCode, and Codex, or a Kiro API key for the Kiro driver. Agent credentials are separate from the Cognito login created during installation.

### Provider OAuth apps

The platform integrates with external providers as **code hosts** (GitHub, GitLab, Bitbucket) and **issue trackers** (GitHub Issues, GitLab Issues, Jira Cloud), so an intent can be started from a tracker issue. All providers are optional; skip any you don't need and the corresponding **Connect** buttons in the UI stay disabled.

For each provider you want to enable, register an OAuth app with it, then paste the credentials into **Admin → Trackers** (GitHub Issues, GitLab, Jira) or **Admin → Source Control** (Bitbucket, GitHub App) in the deployed app. For GitHub and GitLab a single OAuth app serves both the code host and that provider's issue tracker. Bitbucket registers a single OAuth app for repository access (code host only). Jira Cloud is a tracker only, and the Jira Cloud and GitLab Issues tracker integrations are read-only.

`<your-app-domain>` is the deployment's canonical hostname: the custom domain when one is configured, otherwise the CloudFront domain. The Admin page shows it, and each provider's setup guide shows the exact callback URL to copy. To read it directly: `terraform -chdir=terraform output -raw application_domain`.

| Provider     | Callback URL                                             | Scopes / permissions                                           |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------- |
| GitHub OAuth | `https://<your-app-domain>/github/callback`              | `repo`, `workflow`, `read:user`                                |
| GitLab       | `https://<your-app-domain>/gitlab/callback`              | `api`, `read_user` (Confidential enabled)                      |
| Bitbucket    | `https://<your-app-domain>/bitbucket/callback`           | Account (Read, Email), Repositories (R/W), Pull requests (R/W) |
| Jira Cloud   | `https://<your-app-domain>/trackers/callback/jira-cloud` | `read:jira-work`, `read:jira-user`, `offline_access`           |

GitHub also supports a **GitHub App** authentication type, configured independently in **Admin → Source Control → GitHub** with the App ID and private key; OAuth and App can be enabled simultaneously, and each project chooses its authentication type. Installation IDs are discovered per repository when a project is bound. See [Setup → Configure provider OAuth apps](https://aws-samples.github.io/sample-collaborative-ai-dlc/getting-started/setup/#configure-provider-oauth-apps) for the full step-by-step per provider, including GitHub App permissions and reauthorization notes.

You can rotate credentials later by entering new values into the same form; clicking **Save** overwrites the previously stored secret.

<details>
<summary>CLI fallback for fully-automated deploys</summary>

The Admin UI is a wrapper around AWS Secrets Manager. To populate the secrets in your provisioning pipeline, write the same JSON shape directly:

```bash
aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw gitlab_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw bitbucket_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'

aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw jira_oauth_secret_name) \
  --secret-string '{"client_id":"...","client_secret":"..."}'
```

</details>

### Users and administrators

Create users in the Cognito User Pool. The User Pool ID is available via `terraform output user_pool_id` from the `terraform/` directory.

Platform-wide administration (the **Admin** page: user management, agent settings, source control, trackers, migrations, plus workflow and building-block authoring) requires membership in the Cognito `platform-admin` group. Bootstrap the first administrator via the CLI:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $(terraform -chdir=terraform output -raw user_pool_id) \
  --username <username> \
  --group-name platform-admin
```

Group membership is read from the ID token, so users need to sign out and back in after being added. Once the first administrator exists, additional admins can be granted or revoked from the UI under **Admin → Users**. Day-to-day access to a project's intents, discussions, and settings is governed by per-project membership roles, not Cognito groups; see [Projects and settings](https://aws-samples.github.io/sample-collaborative-ai-dlc/using-the-platform/projects/).

### Frontend deployment and local development

```bash
./scripts/deploy-frontend.sh dev
```

This regenerates `frontend/.env` from Terraform outputs, builds, uploads to S3, and invalidates the CloudFront cache. To regenerate `.env` without building, which is what you want before `npm --prefix frontend run dev`:

```bash
./scripts/generate-env.sh dev
```

The application is available at its canonical URL:

```bash
terraform -chdir=terraform output -raw application_url
```

## Documentation site

Documentation is built with [Zensical](https://zensical.org/) and deployed to GitHub Pages. To serve locally:

```bash
uv sync --group docs
uv run zensical serve
```

To build:

```bash
uv run zensical build
```

## Testing and code quality

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

Contributors should also see the [testing guide](https://aws-samples.github.io/sample-collaborative-ai-dlc/development/testing/). It covers the disposable OIDC identity provider used to test enterprise SSO without a vendor tenant, the deterministic AgentCore test project, and the credentialed local agent lifecycle E2E:

```bash
npx vitest run --project=agentcore
BEDROCK_API_KEY=... KIRO_API_KEY=... ./scripts/agent-e2e-testing.sh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to participate.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting instructions. This is a sample project in early preview; review the code and the deployed infrastructure against your own requirements before using it with production repositories.

## License

This project is licensed under the [MIT-0 License](LICENSE).
