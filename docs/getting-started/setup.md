# Setup

This guide takes you from zero to a running instance of AIDLC Collaborative. The platform requires AWS infrastructure for authentication, APIs, and agent execution, so setup involves both local configuration and cloud deployment.

## Clone the repository

```bash
git clone https://github.com/aws-samples/sample-collaborative-ai-dlc.git
cd sample-collaborative-ai-dlc
```

## Deploy the AWS infrastructure

### Bootstrap the Terraform state backend

The bootstrap script creates an Amazon S3 bucket for Terraform state storage. Run it once per environment.

```bash
export AWS_PROFILE=your-profile-name
./scripts/bootstrap.sh dev
```

This creates an S3 bucket with a unique name and updates `terraform/environments/dev/backend.tf` with the bucket reference.

### Configure the Terraform variables

```bash
cp terraform/environments/dev/terraform.tfvars.example terraform/environments/dev/terraform.tfvars
```

Edit `terraform/environments/dev/terraform.tfvars` to set your configuration.

| Variable | Description |
|----------|-------------|
| `project_name` | Resource naming prefix |
| `environment` | Environment name (`dev` or `prod`) |
| `vpc_cidr` | VPC CIDR block |
| `neptune_instance_class` | Neptune instance size |
| `agent_pool_size` | Number of agent workers |

### Deploy infrastructure

```bash
./scripts/deploy-terraform.sh dev
```

The deployment takes 15-30 minutes. Neptune DB cluster creation takes the longest.

After deployment, configure agent authentication in the platform UI by entering either a Kiro CLI API key or Bedrock credentials (for Claude Code / OpenCode setups). Check the agent pool DynamoDB table or ECS task logs to confirm agents are authenticated and ready.

### Configure GitHub OAuth

Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and store the credentials:

```bash
aws secretsmanager update-secret \
  --secret-id collaborative-ai-dlc-dev-github-oauth \
  --secret-string '{"client_id":"your_client_id","client_secret":"your_client_secret"}'
```

Set the **Authorization callback URL** to your CloudFront domain followed by `/api/auth/callback/github`.

### Create users

Get the User Pool ID and create a user:

```bash
cd terraform/environments/dev
terraform output user_pool_id

aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <user-pool-id> \
  --username user@example.com \
  --group-name approver
```

Available groups:

| Group | Permissions |
|-------|-------------|
| `member` | View and edit specs, run agents |
| `approver` | Member permissions plus approve phase transitions |
| `owner` | Full access including project settings |

## Set up the frontend

### Install dependencies

```bash
cd frontend
npm install
```

### Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with values from your Terraform deployment.

### Deploy to S3 and CloudFront

```bash
cd ..
./scripts/deploy-frontend.sh dev
```

This builds the frontend, uploads it to S3, and invalidates the CloudFront cache.

### Access the application

```bash
cd terraform/environments/dev
terraform output cloudfront_domain_name
```

Open the domain in your browser to reach the sign-in page.

## Local frontend development

For iterating on the frontend locally (while connected to the deployed AWS backend):

```bash
cd frontend
npm run dev
```

This starts the Vite development server on `http://localhost:5173`.

## Updating a deployment

| What changed | Command |
|-------------|---------|
| Backend (Lambda, agents, infra) | `./scripts/deploy-terraform.sh dev` |
| Frontend only | `./scripts/deploy-frontend.sh dev` |

## Destroy infrastructure

To remove all deployed resources:

```bash
./scripts/destroy.sh dev
```

!!! danger "Data loss"
    This permanently deletes all data including DynamoDB tables, Neptune databases, and S3 buckets. This action cannot be undone.

To also remove the Terraform state bucket (created during bootstrap):

```bash
grep bucket terraform/environments/dev/backend.tf
aws s3 rb s3://<bucket-name> --force
```

## Troubleshooting

**Terraform init fails with backend errors**

Make sure the bootstrap script completed successfully and that `backend.tf` contains the correct bucket name.

**ECS tasks fail to start**

Check CloudWatch Logs for the ECS service. Common issues: missing IAM permissions, ECR image not found, resource limits exceeded.

**Frontend shows authentication errors**

Verify User Pool ID and App Client ID match Terraform outputs, and that the user exists in the correct group.

**GitHub integration not working**

Check that the OAuth callback URL matches your CloudFront domain and that Secrets Manager contains valid credentials.
