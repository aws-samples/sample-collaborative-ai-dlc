# Prerequisites

Before you begin, install and verify the following tools.

## Local development

To run AIDLC Collaborative locally, install the following tools.

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | 22 or later | Runtime for the frontend and Lambda functions |
| **npm** | 10 or later | Package manager (ships with Node.js) |
| **Git** | 2.x | Repository cloning and branch management for agent execution |

Run the following commands to verify your local development environment.

```bash
node --version   # Expected output: v22.x or later
npm --version    # Expected output: 10.x or later
git --version    # Expected output: 2.x
```

## AWS deployment

To deploy AIDLC Collaborative to AWS, install the following additional tools. For detailed deployment instructions, see [Setup](setup.md).

| Tool | Version | Purpose |
|------|---------|---------|
| [Terraform](https://developer.hashicorp.com/terraform/install) | 1.0 or later | Infrastructure provisioning |
| [AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | v2 | AWS resource management and credential handling |
| [Docker](https://docs.docker.com/get-docker/) | 20.10 or later | Lambda packaging and container builds |

Run the following commands to confirm your deployment tools are installed.

```bash
terraform --version  # Expected output: v1.0 or later
aws --version        # Expected output: aws-cli/2.x
docker --version     # Expected output: Docker version 20.10 or later
```

You must also have an AWS account with permissions to manage the following services.

| Category | Services |
|----------|----------|
| Compute | AWS Lambda, Amazon ECS with Fargate, AWS Step Functions |
| Networking | Amazon VPC, Amazon API Gateway (REST and WebSocket), Amazon CloudFront, Elastic Load Balancing |
| Storage | Amazon S3, Amazon DynamoDB, Amazon Neptune |
| Security | Amazon Cognito, AWS Identity and Access Management (IAM), AWS Secrets Manager, AWS Systems Manager Parameter Store |
| Integration | Amazon EventBridge, Amazon Elastic Container Registry (Amazon ECR), Amazon SQS |
| Observability | Amazon CloudWatch Logs |


## Optional tools

The following tools are optional. Install them to enable additional features.

| Tool | Purpose |
|------|---------|
| **AWS credentials** | Required for large language model (LLM) features through [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html) |
| **GitHub personal access token** | Enables pushing tasks as GitHub issues and syncing issue status |

## Agent authentication

Agents authenticate using API keys configured through the platform UI. The platform supports two options:

### Kiro CLI API key

In the platform settings, enter your Kiro CLI API key. Agent containers use this key to authenticate with the Kiro CLI during Construction.

### Amazon Bedrock API key (for Claude Code and OpenCode setups)

For agents using Claude Code or OpenCode with Amazon Bedrock, enter your Amazon Bedrock credentials (Access Key ID, Secret Access Key, Region) in the platform settings.

You can also use [AWS IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html), IAM roles, or any method supported by the [AWS SDK credential provider chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html).

## AWS credentials for LLM features

AIDLC Collaborative uses [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html) to access Claude models. You must have valid AWS credentials with Amazon Bedrock access in your environment.

If you don't have AWS credentials, the platform still starts. You can browse the UI, create organizations and projects, and manage specs. However, the large language model (LLM) chat and agent features return a connection error.
