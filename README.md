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

| Tool | Version |
|------|---------|
| Node.js | 22+ |
| Terraform | 1.0+ |
| AWS CLI | v2 |
| Docker | Recent stable |

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

### 4. Configure GitHub OAuth

[Create a GitHub **OAuth App**](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) (not a GitHub App — the flow here expects OAuth App semantics). When prompted, use:

- **Homepage URL**: `https://$(terraform -chdir=terraform output -raw cloudfront_domain_name)`
- **Authorization callback URL**: `https://$(terraform -chdir=terraform output -raw cloudfront_domain_name)/github/callback`

Then store the OAuth App's credentials in the Secrets Manager secret that terraform created (replace `your_github_client_id` and `your_github_client_secret` with the actual values):

```bash
aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
  --secret-string '{"client_id":"your_github_client_id","client_secret":"your_github_client_secret"}'
```

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to participate.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting instructions.

## License

This project is licensed under the [MIT-0 License](LICENSE).