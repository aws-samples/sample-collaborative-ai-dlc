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

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `project_name`           | Resource naming prefix             |
| `environment`            | Environment name (`dev` or `prod`) |
| `vpc_cidr`               | VPC CIDR block                     |
| `neptune_instance_class` | Neptune instance size              |
| `agent_pool_size`        | Number of agent workers            |

### Deploy infrastructure

```bash
./scripts/deploy-terraform.sh dev
```

The deployment takes 15-30 minutes. Neptune DB cluster creation takes the longest.

After deployment, configure agent authentication in the platform UI by entering either a Kiro CLI API key or Bedrock credentials (for Claude Code / OpenCode setups). Check the agent pool DynamoDB table or ECS task logs to confirm agents are authenticated and ready.

### Configure tracker OAuth apps

The platform integrates with external trackers (GitHub Issues, Jira Cloud) so a sprint can be started from a tracker issue. For each tracker you want to enable, register an OAuth app with the provider and paste the credentials into **Admin → Tracker OAuth Apps** in the deployed app.

Both providers are optional. Skip a section if you don't need that tracker — the corresponding **Connect** buttons in the UI will stay disabled with a hint pointing to this admin panel.

#### GitHub Issues

1. Open [GitHub Developer Settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   Choose an **OAuth App**, _not_ a GitHub App — the flow expects OAuth App semantics.
2. Set:
   - **Homepage URL**: `https://<your-cloudfront-domain>`
   - **Authorization callback URL**: `https://<your-cloudfront-domain>/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**.
4. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → GitHub Issues**. Paste both values and click **Save**.

#### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `offline_access` (required for refresh tokens — don't skip)
3. Under **Authorization**, set the callback URL to `https://<your-cloudfront-domain>/trackers/callback/jira-cloud`.
4. Open the **Settings** tab of the app and copy the **Client ID** and **Client Secret**.
5. In the deployed app, sign in and open **Admin → Tracker OAuth Apps → Jira Cloud**. Paste both values and click **Save**.

Rotating credentials later is the same flow — paste new values and **Save** overwrites the stored secret.

??? info "CLI fallback for fully-automated deploys"
The Admin UI is a wrapper around AWS Secrets Manager. To populate the secrets in your provisioning pipeline:

    ```bash
    aws secretsmanager put-secret-value \
      --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
      --secret-string '{"client_id":"...","client_secret":"..."}'

    aws secretsmanager put-secret-value \
      --secret-id $(terraform -chdir=terraform output -raw jira_oauth_secret_name) \
      --secret-string '{"client_id":"...","client_secret":"..."}'
    ```

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

| Group      | Permissions                                       |
| ---------- | ------------------------------------------------- |
| `member`   | View and edit specs, run agents                   |
| `approver` | Member permissions plus approve phase transitions |
| `owner`    | Full access including project settings            |

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

| What changed                    | Command                             |
| ------------------------------- | ----------------------------------- |
| Backend (Lambda, agents, infra) | `./scripts/deploy-terraform.sh dev` |
| Frontend only                   | `./scripts/deploy-frontend.sh dev`  |

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

**Tracker integration not working (GitHub or Jira)**

In the deployed app, open **Admin → Tracker OAuth Apps**. Each provider should show **Configured**; if it shows **Not configured**, finish the OAuth-app setup and paste the credentials. Also confirm the OAuth app's **Authorization callback URL** matches the values listed above for your CloudFront domain — provider apps reject mismatched callbacks at sign-in time.
