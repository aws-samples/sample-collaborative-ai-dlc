# Prerequisites

Before you begin, install and verify the following tools.

## Local development

To run AIDLC Collaborative locally, install the following tools.

| Tool        | Version     | Purpose                                                      |
| ----------- | ----------- | ------------------------------------------------------------ |
| **Node.js** | 22 or later | Runtime for the frontend and Lambda functions                |
| **npm**     | 10 or later | Package manager (ships with Node.js)                         |
| **Git**     | 2.x         | Repository cloning and branch management for agent execution |

Run the following commands to verify your local development environment.

```bash
node --version   # Expected output: v22.x or later
npm --version    # Expected output: 10.x or later
git --version    # Expected output: 2.x
```

## AWS deployment

To deploy AIDLC Collaborative to AWS, install the following additional tools. For detailed deployment instructions, see [Setup](setup.md).

| Tool                                                                                                                  | Version        | Purpose                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| [Terraform](https://developer.hashicorp.com/terraform/install)                                                        | 1.4 or later   | Infrastructure provisioning                                                        |
| [AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | v2             | AWS resource management and credential handling                                    |
| [Docker](https://docs.docker.com/get-docker/) (default)                                                               | 20.10 or later | Lambda packaging and container builds; alternatives use the override documented below |

Run the following commands to confirm the default Docker-based deployment tools are installed. If you use an alternative container runtime, follow the section below instead of the Docker verification command.

```bash
terraform --version  # Expected output: v1.4 or later
aws --version        # Expected output: aws-cli/2.x
docker --version     # Expected output: Docker version 20.10 or later
```

### Using an alternative container runtime

Docker is the default container runtime; no configuration is needed when the `docker` CLI and standard Docker socket are available. Two independent settings control the runtime:

- `CONTAINER_RUNTIME` (default: `docker`) — the CLI name the installer's prerequisite check looks for.
- `DOCKER_HOST` — the Docker Engine API socket that Terraform's `kreuzwerker/docker` provider connects to when it builds and pushes the container images.

Because the image build talks to the Docker Engine API socket (rather than shelling out to a CLI), **any runtime that exposes such a socket works**. Point `DOCKER_HOST` at the runtime's socket and the build behaves exactly as it does with Docker.

| Runtime | Docker API socket | Status |
| --- | --- | --- |
| Docker (default) | standard `/var/run/docker.sock` | Supported |
| Podman | derived at runtime (see below) | Verified end-to-end |
| Rancher Desktop (dockerd/moby mode) | `~/.rd/docker.sock` | Verified end-to-end |
| Colima | `~/.colima/default/docker.sock` | Compatible (same mechanism) |
| OrbStack | `~/.orbstack/run/docker.sock` | Compatible (same mechanism) |

Podman example:

```bash
# macOS
podman machine start
export CONTAINER_RUNTIME=podman
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

# Rootless Linux (after starting `podman system service`)
export CONTAINER_RUNTIME=podman
export DOCKER_HOST="unix://$(podman info --format '{{.Host.RemoteSocket.Path}}')"
```

Rancher Desktop example (set the container engine to **dockerd (moby)** in Rancher Desktop settings):

```bash
export CONTAINER_RUNTIME=docker      # Rancher provides a docker-compatible CLI
export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
```

!!! warning "Finch and CLI-only build tools are not supported"

    Setting `CONTAINER_RUNTIME=finch` only makes the installer's prerequisite check look for the `finch` CLI. Finch does not expose a Docker Engine API socket by default, so there is no socket for `DOCKER_HOST` to use and the Terraform image build cannot run. The same applies to daemonless/CLI-only build tools such as Buildah, nerdctl, Kaniko, and BuildKit. Use Docker, Podman, or another socket-based runtime from the table above.

You must also have an AWS account with permissions to manage the following services.

| Category      | Services                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Compute       | AWS Lambda, Amazon ECS with Fargate (Yjs collaboration server), Amazon Bedrock AgentCore (agent runtime)           |
| Networking    | Amazon VPC, Amazon API Gateway (REST and WebSocket), Amazon CloudFront, Elastic Load Balancing                     |
| Storage       | Amazon S3, Amazon DynamoDB, Amazon Neptune                                                                         |
| Security      | Amazon Cognito, AWS Identity and Access Management (IAM), AWS Secrets Manager, AWS Systems Manager Parameter Store |
| Integration   | Amazon Elastic Container Registry (Amazon ECR)                                                                     |
| Observability | Amazon CloudWatch Logs                                                                                             |

## Optional tools

The following are optional. Set them up to enable additional features.

| Item                    | Purpose                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS credentials**     | Required for large language model (LLM) features through [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)                   |
| **Provider OAuth apps** | GitHub / GitLab / Jira Cloud OAuth apps enable code-host and tracker integration — see [Setup → Configure provider OAuth apps](setup.md#configure-provider-oauth-apps) |
| **Custom domain**       | An ACM certificate in `us-east-1` covering the hostname, or a Route53 hosted zone for Terraform to request one — see [Setup → Custom domain](setup.md#custom-domain)   |
| **Enterprise SSO**      | An OIDC/SAML application in the external IdP and, for OIDC, a Secrets Manager client secret — see [Enterprise SSO](enterprise-sso.md)                                  |

## Agent authentication

Agents authenticate using API keys configured through the platform UI. The platform supports two options:

An agent CLI cannot reach its model until an effective credential is configured — the Bedrock AgentCore runtime has no IAM-role fallback. A user can provide a personal credential in **Account Settings**, a space owner/admin can provide a shared credential in **Space Settings → Agent**, or a platform admin can provide a fallback in **Admin → Agents**. Resolution is independent per provider and follows `personal > space > platform`.

### Kiro CLI API key (required for the Kiro CLI driver)

Kiro API keys are turned **off by default**. A Kiro administrator must first enable them in the Kiro console (**Settings → Kiro settings → Enable users to generate API keys → On**). Users can then sign in to the Kiro portal and generate a key. See the [Kiro API keys documentation](https://kiro.dev/docs/enterprise/governance/api-keys/) for details.

Save the key as the **Kiro API Key** at the intended personal, space, or platform scope. AgentCore resolves the selected opaque binding for each invocation and provides the value to Kiro as `KIRO_API_KEY`.

### Amazon Bedrock API key (required for Claude Code, OpenCode, and Codex setups)

Generate an Amazon Bedrock API key in the AWS Console (**Amazon Bedrock → API keys → Generate long-term API key**, scoped to your account and region). Save it as the **Bedrock Bearer Token** at the intended personal, space, or platform scope. AgentCore injects the selected value for that invocation as `AWS_BEARER_TOKEN_BEDROCK`.

This token is required for Claude Code, OpenCode, and Codex agents: the Bedrock AgentCore runtime's IAM role intentionally has no Amazon Bedrock model-invocation permissions, so there is no IAM-role fallback. Agents authenticate to Bedrock exclusively through this token.

For Codex, additionally enable access to the OpenAI models (`openai.gpt-5.*`) in the Bedrock console for your Region — Codex uses Bedrock's OpenAI-compatible Responses API, and the models are Region-limited. See [Use Codex with Amazon Bedrock](https://help.openai.com/en/articles/20001252-use-codex-with-amazon-bedrock). (GPT models are also available through Kiro, but Kiro accesses them via its own API key — no Bedrock model access is involved there.)

### Where these values are stored

All credentials are stored in **AWS Systems Manager Parameter Store** as `SecureString` parameters:

- Platform: `/<project_name>/<environment>/<credential-name>`
- Space: `/<project_name>/<environment>/projects/<project-id>/agent-credentials/<credential-name>`
- Personal: `/<project_name>/<environment>/users/<user-id>/agent-credentials/<credential-name>`

The credential name is `bedrock-bearer-token` or `kiro-api-key`. An unset platform credential holds the literal value `placeholder`, which the platform treats as "not configured"; clearing a space or personal credential deletes that scoped parameter so resolution can fall through.

## AWS credentials for deployment

AIDLC Collaborative infrastructure still requires valid AWS credentials for deployment and AWS resource management. Agent CLI model calls do not use ambient AWS credentials; they use the effective Kiro or Bedrock key selected through the hierarchy above.

Without an effective agent credential, users can still browse the application and edit draft intents, but credential-backed AI composition, Quorum assists, and intent start are unavailable.
