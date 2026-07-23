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

| Tool                                                                                                                  | Version        | Purpose                                         |
| --------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------- |
| [Terraform](https://developer.hashicorp.com/terraform/install)                                                        | 1.0 or later   | Infrastructure provisioning                     |
| [AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | v2             | AWS resource management and credential handling |
| [Docker](https://docs.docker.com/get-docker/)                                                                         | 20.10 or later | Lambda packaging and container builds           |

Run the following commands to confirm your deployment tools are installed.

```bash
terraform --version  # Expected output: v1.0 or later
aws --version        # Expected output: aws-cli/2.x
docker --version     # Expected output: Docker version 20.10 or later
```

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

## Agent authentication

Agents authenticate using API keys configured through the platform UI. The platform supports two options:

An agent CLI cannot reach its model until its credential is configured — the Bedrock AgentCore runtime has no IAM-role fallback — so set the relevant value below in **Admin → Agents** before starting agents for a project.

### Kiro CLI API key (required for the Kiro CLI driver)

Kiro API keys are turned **off by default**. A Kiro administrator must first enable them in the Kiro console (**Settings → Kiro settings → Enable users to generate API keys → On**). Users can then sign in to the Kiro portal and generate a key. See the [Kiro API keys documentation](https://kiro.dev/docs/enterprise/governance/api-keys/) for details.

In the platform settings, enter this key as the **Kiro API Key**. The AgentCore runtime reads it at container startup and provides it to Kiro-driven agents as the `KIRO_API_KEY` environment variable.

### Amazon Bedrock API key (required for Claude Code, OpenCode, and Codex setups)

Generate an Amazon Bedrock API key in the AWS Console (**Amazon Bedrock → API keys → Generate long-term API key**, scoped to your account and region). In the platform settings, enter this key as the **Bedrock Bearer Token**. The platform stores it and provides it to agent containers as the `AWS_BEARER_TOKEN_BEDROCK` environment variable.

This token is required for Claude Code, OpenCode, and Codex agents: the Bedrock AgentCore runtime's IAM role intentionally has no Amazon Bedrock model-invocation permissions, so there is no IAM-role fallback. Agents authenticate to Bedrock exclusively through this token.

For Codex, additionally enable access to the OpenAI models (`openai.gpt-5.*`) in the Bedrock console for your Region — Codex uses Bedrock's OpenAI-compatible Responses API, and the models are Region-limited. See [Use Codex with Amazon Bedrock](https://help.openai.com/en/articles/20001252-use-codex-with-amazon-bedrock).

### Where these values are stored

Both credentials are stored in **AWS Systems Manager Parameter Store** as `SecureString` parameters: `/<project_name>/<environment>/bedrock-bearer-token` and `/<project_name>/<environment>/kiro-api-key`. An unset credential holds the literal value `placeholder`, which the platform treats as "not configured." Saving an empty value in the platform settings resets the parameter to `placeholder` rather than deleting it.

## AWS credentials for LLM features

AIDLC Collaborative uses [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html) to access Claude models. You must have valid AWS credentials with Amazon Bedrock access in your environment.

If you don't have AWS credentials, the platform still starts. You can browse the UI and create projects and intents. However, the agent features return a connection error until credentials are configured.
