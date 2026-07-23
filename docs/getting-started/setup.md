# Setup

This guide takes you from zero to a running instance of AIDLC Collaborative. The platform requires AWS infrastructure for authentication, APIs, and agent execution, so setup involves both local configuration and cloud deployment.

!!! warning "V1 sprints in v2"

    V1 sprints are view-only in v2. Continue active v1 work with the frozen [v1.1.0 release](https://github.com/aws-samples/sample-collaborative-ai-dlc/releases/tag/v1.1.0), then upgrade after the sprint is complete.

## Managed installation

Download and inspect the installer, then run it with your AWS profile, region, environment, and first administrator:

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

The password prompt is silent and the permanent password is never stored. The installer keeps immutable tagged checkouts under the XDG data directory, keeps Terraform configuration under the XDG config directory, and only changes `current` after infrastructure, administrator setup, and frontend deployment all succeed.

Use the same script to inspect or update the deployment:

```bash
bash /tmp/aidlc-install.sh status
bash /tmp/aidlc-install.sh versions
bash /tmp/aidlc-install.sh update
```

Preview and stable tags are listed by default. Install and update select the highest version by SemVer precedence unless `--version` is explicit; stable `2.0.0` supersedes `2.0.0-preview0`. Downgrades still require `--allow-downgrade`.

### Test an unreleased branch

Testers can explicitly track `aidlc-v2` before a release tag exists:

```bash
curl -fsSLo /tmp/aidlc-install.sh \
  https://raw.githubusercontent.com/aws-samples/sample-collaborative-ai-dlc/aidlc-v2/scripts/install.sh

bash /tmp/aidlc-install.sh install \
  --ref aidlc-v2 \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment v2-test \
  --admin <administrator-email>
```

This is a non-release mode. The installer resolves the branch to an immutable commit snapshot, records the tracked branch, and follows newer branch commits when `update` runs. Normal installations continue to require immutable version tags.

### Adopt an existing v1 deployment

The existing checkout must contain its environment's `.tfvars` and `.s3.tfbackend` files:

```bash
bash /tmp/aidlc-install.sh adopt \
  --source /path/to/existing-v1-checkout \
  --environment dev \
  --profile <aws-profile> \
  --admin <existing-administrator-email>

bash /tmp/aidlc-install.sh update --version 2.0.0
```

The update backs up Terraform state and rejects plans that unexpectedly destroy Cognito, Neptune, S3, or persistent DynamoDB resources. Retiring the v1 ECS agent runtime and agent-pool table is expected. The existing administrator receives `platform-admin`. If an update fails, `current` still points to the previous working release.

## Advanced manual installation

Clone the repository and set the AWS profile and region independently from the logical deployment environment:

```bash
git clone https://github.com/aws-samples/sample-collaborative-ai-dlc.git
cd sample-collaborative-ai-dlc
export AWS_PROFILE=<aws-profile>
export AWS_REGION=<aws-region>
```

Bootstrap creates `terraform/environments/dev.s3.tfbackend`. The environment argument is `dev`, not the AWS profile:

```bash
./scripts/bootstrap.sh dev
cp terraform/environments/dev.tfvars.example terraform/environments/dev.tfvars
# Set aws_region = "<aws-region>" in dev.tfvars.
./scripts/deploy-terraform.sh dev
```

To review a saved plan before applying:

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

The deployment takes 15-30 minutes. Neptune DB cluster creation takes the longest.

### Bootstrap the first platform administrator

The **Admin** page (user management, agent settings and default models, provider OAuth/App configuration, migrations) and workflow/building-block authoring require membership in the Cognito **`platform-admin`** group. Bootstrap the first administrator via the CLI (users must sign out and back in to pick up the group); afterwards, additional admins can be granted or revoked in the UI under **Admin → Users**:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $(terraform -chdir=terraform output -raw user_pool_id) \
  --username <username> \
  --group-name platform-admin
```

### Configure provider OAuth apps

The platform integrates with external providers as code hosts (GitHub, GitLab, Bitbucket) and issue trackers (GitHub Issues, GitLab Issues, Bitbucket Issues, Jira Cloud) so an intent can be started from a tracker issue. For each provider you want to enable, register an OAuth app and paste the credentials into **Admin → Trackers** in the deployed app.

For GitHub and GitLab a single OAuth app serves both the code host and that provider's issue tracker. Jira Cloud is a tracker only. All providers are optional — skip a section if you don't need that provider; the corresponding **Connect** buttons in the UI stay disabled with a hint pointing to this admin panel.

#### GitHub (code host + GitHub Issues)

Configure OAuth and GitHub App independently. They remain enabled simultaneously, and each project chooses its authentication type.

For **GitHub OAuth**:

1. Open [GitHub Developer Settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   Choose an **OAuth App**, _not_ a GitHub App — this mode expects OAuth App semantics.
2. Set:
   - **Homepage URL**: `https://<your-cloudfront-domain>`
   - **Authorization callback URL**: `https://<your-cloudfront-domain>/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → GitHub Issues**. Paste both values and click **Save**.

The connection requests `repo`, `workflow`, and `read:user`. Existing users must click **Reauthorize GitHub** after upgrading from a version that did not request `workflow`; GitHub requires that scope before the engine can push changes under `.github/workflows/`.

For **GitHub App**:

1. Create a [GitHub App](https://github.com/settings/apps) with repository permissions **Contents: Read & write**, **Pull requests: Read & write**, **Issues: Read & write**, and metadata read access. No callback URL or webhook is needed. **Workflows: Read & write** is recommended but optional — without it a binding still verifies, but the agent cannot create or modify files under `.github/workflows/` and the project settings page shows a warning.
2. Generate a **private key** (PEM) and note the **App ID**.
3. Install the App on each personal account or organization whose repositories projects may bind.
4. In the deployed app, open **Admin → Source Control → GitHub**, paste the App ID and private key, then click **Save**. Installation IDs are discovered per repository when a project is bound.

### Project-bound source control

Existing projects must be explicitly bound by an owner/admin before intents can run against their repositories. During a credential incident, invalidate the affected project bindings (or revoke the token at the provider) — unbound or invalid bindings block repository-backed starts via the launch guard.

#### GitLab (code host + GitLab Issues)

1. Open [GitLab → User Settings → Applications](https://gitlab.com/-/user_settings/applications) → **Add new application**.
2. Set:
   - **Redirect URI**: `https://<your-cloudfront-domain>/gitlab/callback`
   - **Scopes**: `api` and `read_user`
   - Leave **Confidential** enabled.
3. Save, then copy the **Application ID** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → GitLab Issues**. Paste both values and click **Save**.

GitLab's `api` scope includes repository writes, including changes to `.gitlab-ci.yml`; there is no separate workflow-file scope. Connections missing `api` are reported as requiring reauthorization.

#### Bitbucket (code host + Bitbucket Issues)

1. Open **Bitbucket → Workspace settings → OAuth consumers → Add consumer**.
2. Set:
   - **Callback URL**: `https://<your-cloudfront-domain>/bitbucket/callback`
   - **Permissions**: Account (Read), Repositories (Read & Write), Pull requests (Read & Write).
   - Leave **This is a private consumer** enabled.
3. Save, then copy the **Key** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → Bitbucket Issues**. Paste both values and click **Save**.

Bitbucket OAuth scopes are the singular scope names (`account`, `repository`, `repository:write`, `pullrequest`, `pullrequest:write`), requested automatically by the platform. Bitbucket access tokens are short-lived (~2h); the engine refreshes them just-in-time from the stored refresh token, so long-running construction jobs keep a valid token and users don't need to reconnect periodically.

#### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `offline_access` (required for refresh tokens — don't skip)
3. Under **Authorization**, set the callback URL to `https://<your-cloudfront-domain>/trackers/callback/jira-cloud`.
4. Open the **Settings** tab of the app and copy the **Client ID** and **Client Secret**.
5. In the deployed app, sign in and open **Admin → Trackers → Jira Cloud**. Paste both values and click **Save**.

Rotating credentials later is the same flow — paste new values and **Save** overwrites the stored secret.

??? info "CLI fallback for fully-automated deploys"

    The Admin UI is a wrapper around AWS Secrets Manager. To populate the secrets in your provisioning pipeline:

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

### Create users

Get the User Pool ID and create a user:

```bash
terraform -chdir=terraform output user_pool_id

aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <user-pool-id> \
  --username user@example.com \
  --group-name member
```

Available Cognito groups:

| Group               | Purpose                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-admin`    | Platform-wide administration: the **Admin** page (users, agent credentials and models, source control, trackers) and workflow/block authoring |
| `member`            | Regular platform user                                                                                                                         |
| `approver`, `owner` | Legacy v1 groups, kept for existing installs; no longer checked by the v2 authorization model                                                 |

Day-to-day access to a project's intents, discussions, and settings is governed by **project membership** (owner / admin / member roles managed per project in **Project Settings → Members**), not by Cognito groups — see [Projects and settings](../using-the-platform/projects.md).

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
terraform -chdir=terraform output -raw application_url
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

For managed installations, run `bash /tmp/aidlc-install.sh update`. It creates a Terraform state backup and applies the release safeguards automatically.

For advanced manual installations:

| What changed                    | Command                             |
| ------------------------------- | ----------------------------------- |
| Backend (Lambda, agents, infra) | `./scripts/deploy-terraform.sh dev` |
| Frontend only                   | `./scripts/deploy-frontend.sh dev`  |

### One-time tracker-data migration (only relevant for installs with pre-#194 data)

If you're upgrading an install that ran before issue #194 (tracker provider abstraction) landed, existing projects keep working without intervention — but to bind Jira (or any future tracker) to them, their sprint and project records need a one-time backfill onto the new polymorphic shape.

Operators have two equivalent paths, both idempotent:

- **Admin UI**: open **Admin → Trackers → Tracker Migration** in the deployed app. The card displays a live count of legacy projects + sprints; click **Migrate all** when ready.
- **CLI**: invoke the `migrate-tracker-fields` Lambda directly. Supports a dry-run for previewing.

  ```bash
  aws lambda invoke \
    --function-name "$(terraform output -raw migrate_tracker_fields_lambda_name)" \
    --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
  ```

Both paths share the same shared core, so the result is identical. Migration is **never** automatic — operators run it on demand. See [Git and Tracker Integration → Migrating from legacy issue integration](../using-the-platform/git-integration.md#migrating-from-legacy-issue-integration) for full context, including why nothing is removed and the migration tooling stays deployed permanently.

## Destroy infrastructure

For a managed installation:

```bash
bash /tmp/aidlc-install.sh destroy
```

For a local/manual checkout, pass any environment with matching `.tfvars` and `.s3.tfbackend` files:

```bash
./scripts/destroy.sh dev
./scripts/destroy.sh installer-test
```

!!! danger "Data loss"

    These commands permanently delete all application data including DynamoDB tables, Neptune databases, and S3 buckets. This action cannot be undone. Interactive runs require typing the environment name; use `--yes` only for deliberate automation.

Both paths back up Terraform state before destruction. Managed installs store the backup under the XDG data directory. Standalone runs use `${XDG_DATA_HOME:-~/.local/share}/collaborative-ai-dlc/backups` unless `AIDLC_BACKUP_DIR` is set. The backend state bucket is retained.

For standalone deployments whose environment files live outside the checkout:

```bash
AIDLC_CONFIG_DIR=/path/to/terraform-config \
  ./scripts/destroy.sh installer-test
```

To also remove the Terraform state bucket (created during bootstrap):

```bash
grep bucket terraform/environments/dev.s3.tfbackend
aws s3 rb s3://<bucket-name> --force
```

## Troubleshooting

**Terraform init fails with backend errors**

Make sure the bootstrap script completed successfully and that `terraform/environments/dev.s3.tfbackend` contains the correct bucket name.

**Yjs (ECS) tasks fail to start**

Check CloudWatch Logs for the Yjs collaboration server's ECS service. Common issues: missing IAM permissions, ECR image not found, resource limits exceeded.

**Frontend shows authentication errors**

Verify User Pool ID and App Client ID match Terraform outputs, and that the user exists in the correct group.

**Provider integration not working (GitHub, GitLab, or Jira)**

In the deployed app, open **Admin → Trackers**. Each provider should show **Configured**; if it shows **Not configured**, finish the OAuth-app setup and paste the credentials. Also confirm the OAuth app's **Authorization callback URL** matches the values listed above for your CloudFront domain — provider apps reject mismatched callbacks at sign-in time.
