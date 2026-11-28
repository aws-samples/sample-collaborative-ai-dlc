# Setup

This guide takes you from zero to a running instance of AIDLC Collaborative. The platform requires AWS infrastructure for authentication, APIs, and agent execution, so setup involves both local configuration and cloud deployment.

## Managed installation

Complete the [prerequisites](prerequisites.md) first. The installer creates the AWS infrastructure, your administrator account, and the web application.

Already have a deployment? See [Updating a deployment](#updating-a-deployment).

### 1. Download the installer

Download the script and read it before running it.

```bash
curl -fsSLo /tmp/aidlc-install.sh \
  https://raw.githubusercontent.com/aws-samples/sample-collaborative-ai-dlc/main/scripts/install.sh
less /tmp/aidlc-install.sh
```

### 2. Run the installer

**Optional (but recommended): customize settings before installing.** Create or edit the configuration file for your deployment (`dev` in this example):

```bash
mkdir -p ~/.config/collaborative-ai-dlc/terraform/environments
nano ~/.config/collaborative-ai-dlc/terraform/environments/dev.tfvars
```

Available settings are listed in the [configuration reference](#configuration-reference). If you changed the default configuration location, use the path described in [Installer files](#installer-files).

**Start the installation**

Replace the three placeholders below:

- `<aws-profile>`: the AWS CLI profile you configured in the prerequisites.
- `<aws-region>`: the AWS Region where you want to install the application, with the services required by the prerequisites.
- `<administrator-email>`: the email address you will use to sign in.

```bash
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment dev \
  --admin <administrator-email>
```

This example creates a deployment named `dev`. For production, replace `dev` with exactly [`prod`](#environment).

<span id="proxy-settings"></span>

If you are behind a proxy, set these variables before downloading or running the installer. Replace `http://proxy.example.com:8080` with your proxy address:

```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1

curl -fsSLo /tmp/aidlc-install.sh \
  https://raw.githubusercontent.com/aws-samples/sample-collaborative-ai-dlc/main/scripts/install.sh
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment dev \
  --admin <administrator-email>
```

The installer also uses these settings when building container images. Lowercase names such as `https_proxy` work too. The same applies when updating an installation.

The installer selects the newest available release, which may be a preview release. To choose a specific version, see [Choose a release version](#choose-a-release-version).

### 3. Set your password and sign in

Follow the installer's prompts. When it asks for your administrator password, type it and press **Enter**. The characters do not appear as you type, and the installer does not save the password.

When installation finishes, open the **Application URL** printed in the terminal. Sign in with the administrator email and password you supplied.

You can now [add users](#users-and-access) and [connect your Git and issue-tracking providers](#configure-provider-oauth-apps). The web application is already deployed; [frontend setup](#set-up-the-frontend) covers branding and local development.

<span id="terraform-variables-at-a-glance"></span>

## Configuration reference

All deployment inputs are listed below. Configure them in `~/.config/collaborative-ai-dlc/terraform/environments/<environment>.tfvars` for a [managed installation](#managed-installation), or `terraform/environments/<environment>.tfvars` in your repository checkout for a [manual installation](#advanced-manual-installation). Replace `<environment>` with your deployment name, such as `dev`. The managed path is the default; see [Installer files](#installer-files) if you changed it.

| Variable                                                                                      | Description                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`acm_certificate_arn`](#acm_certificate_arn)                                                 | Existing us-east-1 certificate for the application hostnames.                |
| [`agentcore_image_tag`](#agentcore_image_tag)                                                 | Use a pre-built AgentCore ECR image instead of a local build.                |
| [`aidlc_custom_source_gitlab_token_secret_arn`](#aidlc_custom_source_gitlab_token_secret_arn) | Token secret for importing private GitLab methodology releases.              |
| [`aidlc_custom_source_gitlab_url`](#aidlc_custom_source_gitlab_url)                           | GitLab origin for importing custom methodology releases.                     |
| [`aidlc_release_pinning`](#aidlc_release_pinning)                                             | Enable methodology-version selection for new intents.                        |
| [`aidlc_repo_ref`](#aidlc_repo_ref)                                                           | Upstream methodology ref used by the baseline seed and runtime.              |
| [`app_domain`](#app_domain)                                                                   | Canonical custom application hostname.                                       |
| [`app_domain_aliases`](#app_domain_aliases)                                                   | Additional hostnames served by the application distribution.                 |
| [`auth_access_token_validity_minutes`](#auth_access_token_validity_minutes)                   | Lifetime of newly issued Cognito access tokens.                              |
| [`auth_certificate_arn`](#auth_certificate_arn)                                               | Existing us-east-1 certificate for the managed-login hostname.               |
| [`auth_domain`](#auth_domain)                                                                 | Custom hostname to provision for Cognito managed login.                      |
| [`auth_domain_active`](#auth_domain_active)                                                   | Select the prepared custom hostname for login.                               |
| [`auth_id_token_validity_minutes`](#auth_id_token_validity_minutes)                           | Lifetime of Cognito ID tokens used by the web app.                           |
| [`auth_mode`](#auth_mode)                                                                     | Choose local login, enterprise SSO, or both.                                 |
| [`auth_refresh_token_validity_hours`](#auth_refresh_token_validity_hours)                     | How long Cognito permits token refresh after sign-in.                        |
| [`auth_route53_zone_id`](#auth_route53_zone_id)                                               | Hosted zone for the custom managed-login hostname.                           |
| [`aws_region`](#aws_region)                                                                   | AWS Region for the platform infrastructure.                                  |
| [`backup_retention_period`](#backup_retention_period)                                         | Days to retain automated Neptune backups.                                    |
| [`bedrock_gateway_disable_content_type_guard`](#bedrock_gateway_disable_content_type_guard)   | Relax Claude Code's streaming-header check for a gateway.                    |
| [`bedrock_gateway_url`](#bedrock_gateway_url)                                                 | Optional HTTPS Bedrock gateway for Claude Code in Keys mode.                 |
| [`bedrock_model`](#bedrock_model)                                                             | Primary Bedrock model and initial OpenCode model default.                    |
| [`bedrock_model_aliases`](#bedrock_model_aliases)                                             | Override the opus, sonnet, and haiku model targets.                          |
| [`bedrock_region`](#bedrock_region)                                                           | Region for Bedrock inference and model discovery.                            |
| [`codex_model`](#codex_model)                                                                 | Initial Codex-on-Bedrock default model.                                      |
| [`deletion_protection`](#deletion_protection)                                                 | Protect durable tables, Neptune, and Cognito from deletion.                  |
| [`disabled_clis`](#disabled_clis)                                                             | Agent CLIs unavailable for new intents at initial setup.                     |
| [`dns_role_arn`](#dns_role_arn)                                                               | Role to assume for application and login DNS records.                        |
| [`docker_build_args`](#docker_build_args)                                                     | Arguments, such as proxy settings, for local container builds.               |
| [`enable_engine_data`](#enable_engine_data)                                                   | Route runtime data and credential operations through verifying services.     |
| [`enable_instances_compute`](#enable_instances_compute)                                       | Enable AgentCore Instances capacity for managed environments.                |
| [`enable_mcp_gateway`](#enable_mcp_gateway)                                                   | Serve built-in MCP tools through a grant-verifying Gateway.                  |
| [`enable_waf`](#enable_waf)                                                                   | Enable WAF protections and the REST API origin-secret restriction.           |
| [`enforce_runtime_grants`](#enforce_runtime_grants)                                           | Reject legacy runtime requests and retire direct data permissions.           |
| [`environment`](#environment)                                                                 | Deployment name; only prod selects production behavior.                      |
| [`extra_tags`](#extra_tags)                                                                   | Additional AWS provider default tags.                                        |
| [`gitlab_instance_secrets`](#gitlab_instance_secrets)                                         | Register self-managed GitLab OAuth applications by hostname.                 |
| [`iam_permissions_boundary_arn`](#iam_permissions_boundary_arn)                               | Existing permissions boundary for deployment-created IAM roles.              |
| [`iam_role_path`](#iam_role_path)                                                             | Organization path for deployment-created IAM roles.                          |
| [`instances_allowed_instance_types`](#instances_allowed_instance_types)                       | Allowed x86_64 EC2 types for Instances capacity.                             |
| [`instances_allowed_instance_types_arm64`](#instances_allowed_instance_types_arm64)           | Allowed Graviton EC2 types for Instances capacity.                           |
| [`instances_workspace_gib`](#instances_workspace_gib)                                         | Persistent workspace size for new Instances capacity providers.              |
| [`kms_key_arn`](#kms_key_arn)                                                                 | Existing customer-managed encryption key for supported resources.            |
| [`lambda_vpc_scope`](#lambda_vpc_scope)                                                       | Choose which Lambda functions use the private VPC subnets.                   |
| [`mcp_gateway_custom_targets`](#mcp_gateway_custom_targets)                                   | Customer MCP endpoints, credentials, and space/stage/tool allow rules.       |
| [`neptune_apply_immediately`](#neptune_apply_immediately)                                     | Apply a Neptune resize now or at the maintenance window.                     |
| [`neptune_instance_class`](#neptune_instance_class)                                           | Capacity of the single Neptune database instance.                            |
| [`notification_event_bus_name`](#notification_event_bus_name)                                 | Name of the notification event bus to create.                                |
| [`notification_event_source`](#notification_event_source)                                     | Event source string that notification consumers match.                       |
| [`notification_events_enabled`](#notification_events_enabled)                                 | Publish platform activity to a new EventBridge bus.                          |
| [`powertools_log_event`](#powertools_log_event)                                               | Enable sanitized incoming API-event logging.                                 |
| [`powertools_log_level`](#powertools_log_level)                                               | Minimum severity for Powertools structured logs.                             |
| [`pr_title_tracker_key`](#pr_title_tracker_key)                                               | Prefix intent PR titles with their source Jira issue key.                    |
| [`project_name`](#project_name)                                                               | Resource-name prefix and Project tag for the deployment.                     |
| [`route53_zone_id`](#route53_zone_id)                                                         | Hosted zone for application DNS and optional certificate validation.         |
| [`runtime_mcp_credentials`](#runtime_mcp_credentials)                                         | Allow direct custom MCP servers or require Gateway targets.                  |
| [`skip_final_snapshot`](#skip_final_snapshot)                                                 | Skip the final Neptune snapshot during non-production teardown.              |
| [`sso_providers`](#sso_providers)                                                             | Enterprise OIDC/SAML providers, claims, and role/access mappings.            |
| [`vpc_block_public_access_exclusion`](#vpc_block_public_access_exclusion)                     | Allow CloudFront origin access and NAT egress under VPC Block Public Access. |
| [`yjs_image_tag`](#yjs_image_tag)                                                             | Use a pre-built Yjs ECR image instead of a local build.                      |
| [`yjs_scaling`](#yjs_scaling)                                                                 | Size, safeguard, and optionally autoscale collaboration workers.             |

## Advanced manual installation

Before deploying, review [production environment naming](#environment), [Public ECR permissions](#public-ecr-base-image-authentication), and any [proxy settings](#proxy-settings). To build images in CI, see [pre-built container images](#pre-built-container-images).

### 1. Clone the repository

Clone the repository and set the AWS profile and region independently from the logical deployment environment:

```bash
git clone https://github.com/aws-samples/sample-collaborative-ai-dlc.git
cd sample-collaborative-ai-dlc
export AWS_PROFILE=<aws-profile>
export AWS_REGION=<aws-region>
```

### 2. Configure the deployment

Bootstrap creates `terraform/environments/dev.s3.tfbackend` for the `dev` deployment:

```bash
./scripts/bootstrap.sh dev
cp terraform/environments/dev.tfvars.example terraform/environments/dev.tfvars
```

Edit `terraform/environments/dev.tfvars` using the [configuration reference](#configuration-reference).

### 3. Deploy the application

```bash
./scripts/deploy-terraform.sh dev
./scripts/deploy-frontend.sh dev
```

The deployment takes 15-30 minutes. Neptune DB cluster creation takes the longest.

Unlike the managed installer, nothing here rewrites `dev.tfvars` for you — it is yours to edit, and the scripts only read it.

### Review a plan before applying

Export proxy variables before running `--phase plan`. Terraform resolves
`TF_VAR_docker_build_args` while planning and stores the value in the saved
plan, so exporting or changing proxy variables before `--phase apply` has no
effect.

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

The plan is rejected if it would destroy a Cognito user pool, Neptune cluster, S3 bucket, or DynamoDB table. The check runs in both phases, so a saved plan is re-inspected before it is applied.

Manual deployments honor the same [proxy variables](#proxy-settings) documented for the managed
installer. You can also define `docker_build_args` in the `.tfvars` file.

### Deployment environment variables

These environment variables are useful when iterating:

| Variable                                                     | Effect                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| <code style="white-space: nowrap">AIDLC_SKIP_NPM_CI=1</code> | Skips the root `npm ci` before planning. Saves a lot of time on repeat runs when dependencies are current. |
| <code style="white-space: nowrap">AIDLC_KEEP_PLAN=1</code>   | Keeps the plan file after a successful apply instead of deleting it.                                       |
| <code style="white-space: nowrap">AIDLC_TFVARS_FILE</code>   | Path to an alternative `.tfvars`, overriding the `<environment>.tfvars` convention.                        |
| <code style="white-space: nowrap">AIDLC_BACKEND_FILE</code>  | Path to an alternative `.s3.tfbackend`.                                                                    |
| <code style="white-space: nowrap">AIDLC_CONFIG_DIR</code>    | Directory holding `environments/`, if you keep Terraform configuration outside the checkout.               |

### Skip updating built-in blocks and workflows

For infrastructure-only changes that do not modify the upstream AI-DLC pin,
baseline blocks, or default workflow, skip the post-apply reseed:

```bash
./scripts/deploy-terraform.sh dev --skip-seed
```

After Terraform applies, the deployment script initializes the scoped agent
authentication inventory on both fresh installs and upgrades. This idempotent
step also runs with `--skip-seed`; a failure fails deployment. If you apply
Terraform directly, follow the [inventory initialization instructions](../development/agent-authentication-foundation.md#scoped-reviews)
before saving personal or space credentials.

### Command-line overrides

To override without editing the file — useful for CI, throwaway environments, or trying a hostname before committing to it — pass `--var`, repeated per variable:

```bash
./scripts/deploy-terraform.sh dev \
  --var app_domain=aidlc.example.com \
  --var route53_zone_id=Z1234567890ABC
```

!!! warning "`TF_VAR_*` environment variables do not work here"

    Terraform ranks `-var-file` **above** `TF_VAR_*`, so any key present in your tfvars silently wins over the environment variable. Since `dev.tfvars.example` ships `app_domain = ""`, a copied tfvars always contains it — `TF_VAR_app_domain=…` would be ignored with no warning. `--var` is passed as `-var`, which does outrank the file.

`--var` applies at plan time only; a saved plan already has its variables resolved, so combining it with `--phase apply` is rejected rather than silently ignored. With `--phase plan` the override is baked into the plan file and carried through to the apply:

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan \
  --var app_domain=aidlc.example.com --var route53_zone_id=Z1234567890ABC
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

Keep `environment`, `project_name` and `aws_region` in the tfvars. The retired-v1-runtime cleanup step reads those three from the file directly and would not see a `--var` override.

Note that `deploy-frontend.sh` takes no `--var`: it reads Terraform outputs, so it always reflects whatever was actually applied.

### Set up the frontend

All commands in this section run from the repository root.

#### Install dependencies

<span id="local-frontend-development"></span>

Only needed for [local frontend development](../development/local-frontend.md) — `deploy-frontend.sh` runs `npm ci` itself.

```bash
npm --prefix frontend install
```

#### Configure environment variables

`deploy-frontend.sh` generates `frontend/.env` from Terraform outputs before every build, so there is normally nothing to do here. To generate it without building — which is what you want before `npm run dev` — run it directly:

```bash
./scripts/generate-env.sh dev
```

It requires `terraform/` to be initialized against the environment's backend, and refuses to run if the initialized backend belongs to a different environment.

The generated values all derive from one hostname, `application_domain` — the custom domain when one is configured, otherwise the CloudFront domain:

| Variable                       | Value                              |
| ------------------------------ | ---------------------------------- |
| `VITE_APP_ORIGIN`              | `https://<application_domain>`     |
| `VITE_API_BASE_URL`            | `https://<application_domain>/api` |
| `VITE_WEBSOCKET_URL`           | `wss://<application_domain>/ws`    |
| `VITE_YJS_SERVER_URL`          | `wss://<application_domain>/yjs`   |
| `VITE_AWS_REGION`              | `aws_region` output                |
| `VITE_AWS_USER_POOL_ID`        | `user_pool_id` output              |
| `VITE_AWS_USER_POOL_CLIENT_ID` | `user_pool_client_id` output       |
| `VITE_ENVIRONMENT`             | the environment argument           |

Because these are inlined at build time, changing the domain always requires a rebuild — see [Updating a deployment](#updating-a-deployment). `.env.example` exists for reference and for the rare case of pointing a local build at something Terraform doesn't know about.

#### Deploy to S3 and CloudFront

```bash
./scripts/deploy-frontend.sh dev
```

This regenerates `.env`, builds the frontend, uploads it to S3, and invalidates the CloudFront cache.

#### Branding

A deployment can carry its own logo, wordmark, colours and fonts without changing the source. Unset, the app looks as it does by default.

1. Put the assets in a folder outside the repository, for example `brand/` holding `brand.css`, `logo.svg`, `wordmark.svg`, `wordmark-dark.svg` and any fonts. Set `AIDLC_BRANDING_DIR` to it, and `deploy-frontend.sh` copies it to `/branding/` in the site.
2. Point the build at the files with these variables, exported when you run `deploy-frontend.sh`:

| Variable                   | Effect                                                                                          | Default           |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------- |
| `VITE_BRAND_STYLESHEET`    | stylesheet loaded after the app's own CSS, before the first paint                               | none              |
| `VITE_BRAND_WORDMARK`      | wordmark in the header and on the sign-in card, replacing the icon                              | none              |
| `VITE_BRAND_WORDMARK_DARK` | wordmark for the dark theme                                                                     | the wordmark      |
| `VITE_BRAND_LOGO`          | the app's mark: header icon when there is no wordmark, the Spaces page header, and the tab icon | `/logo.svg`       |
| `VITE_BRAND_NAME`          | alt text for the logo and wordmark                                                              | `AI-DLC`          |
| `VITE_BRAND_FAVICON`       | browser tab icon                                                                                | the logo          |
| `VITE_BRAND_TITLE`         | browser tab title                                                                               | the default title |

```bash
export AIDLC_BRANDING_DIR="$PWD/../brand"
export VITE_BRAND_STYLESHEET=/branding/brand.css
export VITE_BRAND_WORDMARK=/branding/wordmark.svg
export VITE_BRAND_WORDMARK_DARK=/branding/wordmark-dark.svg
export VITE_BRAND_LOGO=/branding/logo.svg
export VITE_BRAND_NAME="Example Corp"
./scripts/deploy-frontend.sh dev
```

The theme is CSS variables (`--primary`, `--background`, `--radius`, the sidebar and chart colours, and so on, defined on `:root` and `.dark` in `frontend/src/index.css`). A brand stylesheet overrides them with the same selectors: it loads later, so it wins. Tailwind's colour palette is CSS variables too (`--color-blue-500` and so on), so hard-coded colour classes can follow the brand as well. Relative `url()`s and `@import`s in the stylesheet resolve under `/branding/`.

The stylesheet blocks the first render for at most three seconds, so a missing file never stops the app loading. These are build-time settings, so changing them needs a rebuild.

#### Access the application

```bash
terraform -chdir=terraform output -raw application_url
```

Open the domain in your browser to reach the sign-in page.

## Users and access

The managed installer creates the first administrator. Use these steps to add users or bootstrap an administrator after a manual installation. For federated access, see [Enterprise SSO](#enterprise-sso).

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

Day-to-day access to a space's intents, discussions, and settings is governed by **space membership** (owner / admin / member roles managed per space in **Space Settings → Members**), not by Cognito groups — see [Spaces and settings](../using-the-platform/projects.md).

### Bootstrap the first platform administrator

The **Admin** page (user management, agent settings and default models, provider OAuth/App configuration, migrations) and workflow/building-block authoring require the **`platform-admin`** role. For local Cognito users, bootstrap the first administrator via the CLI (users must sign out and back in to pick up the group); afterwards, additional local admins can be granted or revoked in the UI under **Admin → Users**:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $(terraform -chdir=terraform output -raw user_pool_id) \
  --username <username> \
  --group-name platform-admin
```

Federated roles are mapped from the external IdP and cannot be changed in this
UI or with downstream Cognito group membership. See
[Enterprise SSO → Role and access mapping](enterprise-sso.md#role-and-access-mapping).

### Local user passwords

Users who sign in with a local Cognito account (`auth_mode` `local` or `hybrid`) manage their own password. Federated users manage theirs at the identity provider: Account Settings does not offer them a password change, and in `hybrid` mode the reset page tells them to use their identity provider.

- **Account Settings → Sign-in password** changes the password of the signed-in user. It requires the current password.
- **Forgot password?** on the sign-in page emails a verification code and sets a new password with it. An unknown address gets the same "code sent" response as an account with a verified email. An account without a verified email address gets an error that says so, which also confirms that the account exists.

New passwords must meet the user pool policy: at least 12 characters with lowercase and uppercase letters, a number, and one of Cognito's special characters.

A reset needs a verified email address. The installer creates the first administrator with one; when you create users with `aws cognito-idp admin-create-user`, set `email_verified=true`. After an operator runs `aws cognito-idp admin-reset-user-password`, Cognito emails the user a code, and their next sign-in with the old password opens the reset flow; **I already have a code** enters that code without requesting another one.

Codes are sent with Cognito's default email sender (`email_sending_account = "COGNITO_DEFAULT"`), which Amazon Cognito limits to 50 messages a day per account, invitations included. The auth module does not configure Amazon SES for the user pool, so that limit applies to every reset; once it is reached, reset requests fail until the quota resets.

## Configure provider OAuth apps

The platform integrates with external providers as code hosts (GitHub, GitLab, Bitbucket, AWS CodeCommit) and issue trackers (GitHub Issues, GitLab Issues, Jira Cloud) so an intent can be started from a tracker issue. For each OAuth provider you want to enable, register an OAuth app and paste the credentials into **Admin → Trackers** (GitHub Issues, GitLab, Jira) or **Admin → Source Control** (Bitbucket, GitHub App) in the deployed app. CodeCommit needs no OAuth app and no secret: a platform admin sets one shared connection to an IAM role in the repository account, and every space uses it (see [CodeCommit](#codecommit-code-host) below).

For GitHub and GitLab a single OAuth app serves both the code host and that provider's issue tracker. Bitbucket registers a single OAuth app for repository access (code host only). Jira Cloud is a tracker only. All providers are optional — skip a section if you don't need that provider; the corresponding **Connect** buttons in the UI stay disabled with a hint pointing to this admin panel.

`<your-app-domain>` below is the deployment's canonical hostname: the custom domain when one is configured, otherwise the CloudFront domain. The Admin page shows it at the top and each provider's setup guide shows the exact callback URL to paste, so copying from there is safer than assembling it by hand. Retrieve it directly with:

```bash
terraform -chdir=terraform output -raw application_domain
```

### GitHub (code host + GitHub Issues)

Configure OAuth and GitHub App independently. They remain enabled simultaneously, and each space chooses its authentication type.

For **GitHub OAuth**:

1. Open [GitHub Developer Settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   Choose an **OAuth App**, _not_ a GitHub App — this mode expects OAuth App semantics.
2. Set:
   - **Homepage URL**: `https://<your-app-domain>`
   - **Authorization callback URL**: `https://<your-app-domain>/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → GitHub Issues**. Paste both values and click **Save**.

The connection requests `repo`, `workflow`, and `read:user`. Existing users must click **Reauthorize GitHub** after upgrading from a version that did not request `workflow`; GitHub requires that scope before the engine can push changes under `.github/workflows/`.

For **GitHub App**:

1. Create a [GitHub App](https://github.com/settings/apps) with repository permissions **Contents: Read & write**, **Pull requests: Read & write**, **Issues: Read & write**, and metadata read access. No callback URL or webhook is needed. **Workflows: Read & write** is recommended but optional — without it a binding still verifies, but the agent cannot create or modify files under `.github/workflows/` and the space settings page shows a warning.
2. Generate a **private key** (PEM) and note the **App ID**.
3. Install the App on each personal account or organization whose repositories spaces may bind.
4. In the deployed app, open **Admin → Source Control → GitHub**, paste the App ID and private key, then click **Save**. Installation IDs are discovered per repository when a space is bound.

### GitLab (code host + GitLab Issues)

1. Open [GitLab → User Settings → Applications](https://gitlab.com/-/user_settings/applications) → **Add new application**.
2. Set:
   - **Redirect URI**: `https://<your-app-domain>/gitlab/callback`
   - **Scopes**: `api` and `read_user`
   - Leave **Confidential** enabled.
3. Save, then copy the **Application ID** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → GitLab Issues**. Paste both values and click **Save**.

GitLab's `api` scope includes repository writes, including changes to `.gitlab-ci.yml`; there is no separate workflow-file scope. Connections missing `api` are reported as requiring reauthorization.

### CodeCommit (code host)

Nothing to register and no secret to store, and no per-user step: one platform admin sets a single shared connection and every space uses it. Two roles are involved.

**The AWS admin, in the repository account**, creates one IAM role the platform assumes, and tags each repository to share. Terraform gives the credential broker, the source-control API and the `codecommit` connector Lambda permission to `sts:AssumeRole` **only when an `aidlc:*` external ID is presented**, and publishes those three execution role ARNs:

```bash
terraform -chdir=terraform output -raw codecommit_platform_principals
```

The principals, the deployment external ID (`aidlc:<uuid>`, created once by Terraform, never by the app), the trust policy and the permissions policy are all shown on **Admin → Source Control → AWS CodeCommit**, each with a copy button. Create the role in the repository account with:

- a **trust policy** naming those three principals and the external ID (same for every space — there is no per-user external ID any more):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "<credential-broker-role-arn>",
          "<source-control-role-arn>",
          "<codecommit-connector-role-arn>"
        ]
      },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "aidlc:<uuid>" } }
    }
  ]
}
```

- a **permissions policy** that keeps `codecommit:ListRepositories` on `"*"` (the only resource that action accepts) and gates every repository action on the `aidlc` tag. Do not grant `codecommit:*`: the platform never creates, renames or deletes a repository. The platform also narrows every call to a single repository ARN with a session policy, so the role policy is only the outer bound. The end-user side is described in [Git integration → CodeCommit](../using-the-platform/git-integration.md#codecommit).

<!-- codecommit-permissions-policy: generated by codeCommitTagPermissionsPolicy() in lambda/shared/codecommit-role.js; a test keeps it in sync -->

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRepositoriesInAccount",
      "Effect": "Allow",
      "Action": "codecommit:ListRepositories",
      "Resource": "*"
    },
    {
      "Sid": "UseTaggedRepositories",
      "Effect": "Allow",
      "Action": [
        "codecommit:GitPull",
        "codecommit:GitPush",
        "codecommit:GetRepository",
        "codecommit:GetBranch",
        "codecommit:ListBranches",
        "codecommit:GetFolder",
        "codecommit:GetFile",
        "codecommit:GetBlob",
        "codecommit:GetCommit",
        "codecommit:GetDifferences",
        "codecommit:GetMergeOptions",
        "codecommit:GetMergeCommit",
        "codecommit:GetMergeConflicts",
        "codecommit:ListPullRequests",
        "codecommit:GetPullRequest",
        "codecommit:GetCommentsForPullRequest",
        "codecommit:DescribePullRequestEvents",
        "codecommit:EvaluatePullRequestApprovalRules",
        "codecommit:GetPullRequestApprovalStates",
        "codecommit:CreatePullRequest",
        "codecommit:UpdatePullRequestStatus",
        "codecommit:UpdatePullRequestTitle",
        "codecommit:UpdatePullRequestDescription",
        "codecommit:PostCommentForPullRequest",
        "codecommit:PostCommentReply",
        "codecommit:MergeBranchesByFastForward",
        "codecommit:MergeBranchesBySquash",
        "codecommit:MergeBranchesByThreeWay",
        "codecommit:MergePullRequestByFastForward",
        "codecommit:MergePullRequestBySquash",
        "codecommit:MergePullRequestByThreeWay",
        "codecommit:DeleteBranch"
      ],
      "Resource": "arn:aws:codecommit:<region>:<account-id>:*",
      "Condition": { "StringEquals": { "aws:ResourceTag/aidlc": "true" } }
    }
  ]
}
```

**Share a repository by tagging it** `aidlc=true`. Written exactly like that: CodeCommit stores tag keys and values case-sensitively (only the IAM context-key name is case-insensitive). No policy edit per repository, and no restart. A new repository stays closed to the platform until it is tagged, unless it is created with the tag. `ListRepositories` has no resource and is not filtered by the tag, so the platform additionally probes each repository with `GetRepository` under the role and lists only the ones it can read. Removing the tag closes a repository again within seconds.

**Equivalent, more locked-down variant** (the most secured): instead of the tag condition, replace `Resource` and drop the `Condition` with an explicit list of repository ARNs:

```json
"Resource": [
  "arn:aws:codecommit:<region>:<account-id>:<repository-name>",
  "arn:aws:codecommit:<region>:<account-id>:<another-repository-name>"
]
```

This uses the same code path. Do not use `NotResource`: it would open every repository not listed, including new ones. Where the deny below cannot be enforced, prefer the explicit list.

**The tag is the access gate.** Anyone who can set the `aidlc` tag can share a repository with every platform user. Restrict that to the repository admins with a deny — in a Service Control Policy, or in the IAM policies of everyone except those admins:

```json
{
  "Sid": "DenyAidlcTagOutsideRepoAdmins",
  "Effect": "Deny",
  "Action": ["codecommit:TagResource", "codecommit:UntagResource", "codecommit:CreateRepository"],
  "Resource": "*",
  "Condition": {
    "ForAnyValue:StringEqualsIgnoreCase": { "aws:TagKeys": ["aidlc"] },
    "ArnNotLike": { "aws:PrincipalArn": "arn:aws:iam::<account-id>:role/<repo-admin-role>" }
  }
}
```

`aws:TagKeys` covers all three actions, including a tag set at creation. Keep `StringEqualsIgnoreCase`: the allow matches the tag key without case (`aws:ResourceTag/AIDLC` is the same key for IAM), so a case-sensitive deny would let `AIDLC=true` through. (An equivalent form uses a second statement with `"Null": { "aws:RequestTag/aidlc": "false" }` on `CreateRepository` and `TagResource`.)

**The platform admin** then goes to **Admin → Source Control → AWS CodeCommit**, pastes the role ARN and region, and clicks **Test & save**. The platform assumes the role with the deployment external ID, makes one `ListRepositories` call to prove the trust, and stores the connection. A trust failure returns a hint and stores nothing. From then on every space picks CodeCommit repositories from the usual list, with no ARN, region or IAM to supply. The deployment region does not need to match the repositories' region: the git host and API endpoint are derived from each repository's ARN. The connection is one region: a space can bind only repositories in that region, even if the role allows more. Changing the region does not move existing bindings: they keep working in their region. A save that still lists a repository of the old region is refused, and the old binding stays; pick repositories in the new region to move the space.

### Bitbucket (code host)

1. Open **Bitbucket → Workspace settings → OAuth consumers → Add consumer**.
2. Set:
   - **Callback URL**: `https://<your-cloudfront-domain>/bitbucket/callback`
   - **Permissions**: Account (Read, Email), Repositories (Read & Write), Pull requests (Read & Write).
   - Leave **This is a private consumer** enabled.
3. Save, then copy the **Key** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Source Control → Bitbucket**. Paste both values and click **Save**.

Bitbucket OAuth scopes are the singular scope names (`account`, `email`, `repository`, `repository:write`, `pullrequest`, `pullrequest:write`), requested automatically by the platform. The `email` scope is required for commit attribution — enable the **Email** permission on the consumer, otherwise the connection is reported as needing reauthorization. Bitbucket access tokens are short-lived (~2h); the engine refreshes them just-in-time from the stored refresh token, so long-running construction jobs keep a valid token and users don't need to reconnect periodically.

### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `write:jira-work`
   - `offline_access` (required for refresh tokens — don't skip)
3. Under **Authorization**, set the callback URL to `https://<your-app-domain>/trackers/callback/jira-cloud`.
4. Open the **Settings** tab of the app and copy the **Client ID** and **Client Secret**.
5. In the deployed app, sign in and open **Admin → Trackers → Jira Cloud**. Paste both values and click **Save**.

When upgrading from a release before v2.1.0, add `write:jira-work` to the existing OAuth application and reconnect Jira to grant it. This enables delivery comments; Jira task status is not changed automatically.

### Rotate or provision provider credentials

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

### Space-bound source control

Existing spaces must be explicitly bound by an Owner before intents can run against their repositories. During a credential incident, invalidate the affected space bindings (or revoke the token at the provider) — unbound or invalid bindings block repository-backed starts via the launch guard.

## Updating a deployment

### Update a managed installation

Use the installer script you downloaded during setup. If `/tmp/aidlc-install.sh` is no longer on your computer, [download it again](#1-download-the-installer).

To see your installed version and application URL:

```bash
bash /tmp/aidlc-install.sh status
```

To install the newest available release:

```bash
bash /tmp/aidlc-install.sh update
```

The installer reuses your saved deployment settings, backs up Terraform state, and updates both the infrastructure and the web application. Its safeguards reject plans that unexpectedly destroy persistent resources.

If that release is already installed, it prints `Already on AI-DLC v<version>.` and stops. To apply configuration changes without waiting for a new release, follow [Change settings on a managed installation](#change-settings-on-a-managed-installation).

### Choose a release version

List the available releases:

```bash
bash /tmp/aidlc-install.sh versions
```

The list includes stable releases and preview releases. A preview is an early version of an upcoming release.

By default, `install` and `update` choose the highest version number from that list. For example:

- `2.0.0` is chosen over `2.0.0-preview0`: the finished release takes priority over its preview.
- `2.1.0-preview0` is chosen over `2.0.0`: a preview with a higher version number takes priority over an older stable release.

To choose for yourself, add `--version <version>` to your install or update command. For example, if `2.1.0` is listed:

```bash
bash /tmp/aidlc-install.sh update --version 2.1.0
```

To install an older version than the one you are running, also add `--allow-downgrade`. The installer refuses a downgrade without that option.

### Change settings on a managed installation

Your deployment settings are stored in a `.tfvars` text file. For the `dev` installation above, open:

```text
~/.config/collaborative-ai-dlc/terraform/environments/dev.tfvars
```

If you chose another environment name, replace `dev` with that name. If you changed the default file location, see [Installer files](#installer-files).

Find the setting you want in the [configuration reference](#configuration-reference), edit its value in the file, and save it. Then run:

```bash
bash /tmp/aidlc-install.sh update --reapply
```

`--reapply` tells the installer to deploy again even if the selected software version is already installed. This applies your saved settings and rebuilds the web application.

The command still checks for the newest release. To change settings while keeping your current software version, first look up that version with `status`, then include it:

```bash
bash /tmp/aidlc-install.sh update --version <installed-version> --reapply
```

Some settings must be changed through installer options because the installer writes them into the Terraform configuration on every deployment. Editing only their Terraform values will not work:

| Setting                                                 | Installer option                            |
| ------------------------------------------------------- | ------------------------------------------- |
| Environment name (`environment`)                        | `--environment`                             |
| AWS Region (`aws_region`)                               | `--region`                                  |
| Application domain (`app_domain`)                       | `--domain`                                  |
| Additional application hostnames (`app_domain_aliases`) | `--domain-alias` (repeat for each hostname) |
| Application certificate (`acm_certificate_arn`)         | `--certificate-arn`                         |
| Application DNS zone (`route53_zone_id`)                | `--hosted-zone-id`                          |
| Login method (`auth_mode`)                              | `--auth-mode`                               |
| Enterprise identity providers (`sso_providers`)         | `--sso-config`                              |

Add the relevant options to the `update --reapply` command. See [custom domains](#custom-domain) and [enterprise SSO](#enterprise-sso) for complete examples. Changing an existing environment name or Region can replace AWS resources; choose those during initial setup whenever possible.

### Installer files

By default, the installer stores these files in your home directory (`~`):

- **Downloaded releases:** `~/.local/share/collaborative-ai-dlc/releases/`, with a separate folder for each fixed release version.
- **Terraform settings:** `~/.config/collaborative-ai-dlc/terraform/environments/`, reused across updates.

The installer keeps a `current` shortcut to the last successfully installed release. It changes that shortcut only after the AWS infrastructure, administrator setup, and frontend deployment all succeed. If an update fails, the shortcut still points to the previous release; AWS changes already applied are not automatically rolled back.

If you have set the environment variables `XDG_DATA_HOME` or `XDG_CONFIG_HOME`, they replace `~/.local/share` or `~/.config`, respectively, in these paths. Otherwise, use the default paths shown here.

### Update a manual installation

Run the command for the part of the application you changed:

| What changed                    | Command                             |
| ------------------------------- | ----------------------------------- |
| Backend (Lambda, agents, infra) | `./scripts/deploy-terraform.sh dev` |
| Frontend only                   | `./scripts/deploy-frontend.sh dev`  |
| Custom domain                   | both, in that order                 |

A domain change needs both steps: Terraform updates the distribution and the OAuth redirect URIs, then the frontend has to be rebuilt because the endpoint URLs are inlined into the bundle at build time.

### Test an unreleased branch

Testers can install a branch such as `aidlc-v2` before it has a release:

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

The installer downloads a copy of the branch at its current commit and saves which branch you chose. Running `update` then installs newer commits from that branch. Each downloaded copy stays fixed at its original commit. Without `--ref`, installations use fixed release versions instead.

### Adopt an existing v1 deployment

!!! warning "V1 sprints in v2"

    V1 sprints are view-only in v2. Continue active v1 work with the frozen [v1.1.0 release](https://github.com/aws-samples/sample-collaborative-ai-dlc/releases/tag/v1.1.0), then upgrade after the sprint is complete.

The existing checkout must contain its environment's `.tfvars` and `.s3.tfbackend` files:

```bash
bash /tmp/aidlc-install.sh adopt \
  --source /path/to/existing-v1-checkout \
  --environment dev \
  --profile <aws-profile> \
  --admin <existing-administrator-email>

bash /tmp/aidlc-install.sh update --version 2.1.0
```

The update backs up Terraform state and rejects plans that unexpectedly destroy Cognito, Neptune, S3, or persistent DynamoDB resources. Retiring the v1 ECS agent runtime and agent-pool table is expected. The existing administrator receives `platform-admin`. If an update fails, `current` still points to the previous working release.

### One-time tracker-data migration (only relevant for installs with pre-#194 data)

If you're upgrading an install that ran before issue #194 (tracker provider abstraction) landed, existing spaces keep working without intervention — but to bind Jira (or any future tracker) to them, their sprint and space records need a one-time backfill onto the new polymorphic shape.

Operators have two equivalent paths, both idempotent:

- **Admin UI**: open **Admin → Trackers → Tracker Migration** in the deployed app. The card displays a live count of legacy spaces and sprints; click **Migrate all** when ready.
- **CLI**: invoke the `migrate-tracker-fields` Lambda directly. Supports a dry-run for previewing.

  ```bash
  aws lambda invoke \
    --function-name "$(terraform output -raw migrate_tracker_fields_lambda_name)" \
    --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
  ```

Both paths share the same shared core, so the result is identical. Migration is **never** automatic — operators run it on demand. See [Git and Tracker Integration → Migrating from legacy issue integration](../using-the-platform/git-integration.md#migrating-from-legacy-issue-integration) for full context, including why nothing is removed and the migration tooling stays deployed permanently.

## Terraform variable details

These are all inputs declared in the deployment's root `terraform/*.tf` files, including `variables.tf` and `yjs.tf`. Inputs inside `terraform/modules/` are wired by the deployment; they are not additional settings you can put in an environment's `.tfvars`.

For a managed installation, follow [Change settings on a managed installation](#change-settings-on-a-managed-installation). Your settings file is normally `~/.config/collaborative-ai-dlc/terraform/environments/<environment>.tfvars`; see [Installer files](#installer-files) if you use a custom location. For a manual installation, edit `terraform/environments/<environment>.tfvars` and run `./scripts/deploy-terraform.sh <environment>`. Changes to frontend URLs or authentication also require `./scripts/deploy-frontend.sh <environment>`; the managed installer performs both steps.

Examples below are HCL assignments for that file. Replace example hostnames, resource IDs, and ARNs with your own. Omit a setting to use its declared default; `""`, `[]`, `{}`, and `null` have the specific meanings described below. A value in a `.tfvars` file takes precedence over `TF_VAR_*`; see [command-line overrides](#command-line-overrides) for `--var`. Defaults here come from the source declarations, so an existing environment file or an administrator's saved setting can differ.

### Deployment identity and networking

#### `aws_region`

**Type:** string. **Default:** `"us-east-1"`.

Choose an AWS Region that supports the platform's required services, including AgentCore. For example, `aws_region = "eu-central-1"` places the regional infrastructure in Frankfurt. This is a Region name, not an AWS profile or an Availability Zone. There is no fixed Terraform allowlist; check [prerequisites](prerequisites.md) for service availability. CloudFront certificates still use `us-east-1`, and [Bedrock inference](#bedrock_region) can use a different Region.

#### `project_name`

**Type:** string. **Default:** `"collaborative-ai-dlc"`.

The deployment's resource-name prefix and `Project` tag, not the name of an individual space. For example, `project_name = "team-aidlc"` produces names such as `team-aidlc-agentcore-dev`. Use a short lowercase name with letters, digits, and hyphens that fits the named AWS resources; Terraform has no single length validation covering all of them. Choose it before installation: changing it later can replace resources.

#### `environment`

**Type:** string. **Default:** `"dev"`.

`"prod"` selects production behavior: two NAT gateways, longer log retention, larger default Yjs containers, production S3 lifecycle rules, and buckets that cannot be force-destroyed. Automated destroy scripts refuse it, and `skip_final_snapshot = true` is rejected. Every other name, including `"dev"`, `"test"`, and `"production"`, selects non-production behavior. Database deletion protection is controlled separately by [deletion_protection](#deletion_protection), which defaults to `true` in every environment.

Example: `environment = "prod"` for production; `environment = "test"` for a disposable test deployment. Use the same name in your environment files and deployment command. Renaming an existing environment can replace resources.

!!! warning "A production environment must be named exactly `prod`"

    Terraform selects production behaviour by comparing `environment` to the literal string `prod`. That single value controls, among others: two NAT gateways for high availability instead of one, 30-day CloudWatch log retention instead of 7, larger default Yjs collaboration containers, 90-day S3 lifecycle rules, `force_destroy = false` on every bucket, a required final Neptune snapshot, and the refusal of `scripts/destroy.sh` to run. DynamoDB, Neptune and Cognito deletion protection is controlled separately by [deletion_protection](#deletion_protection), which defaults to `true` in every environment.

    A near-miss name such as `production`, `prd`, or `prod-us` is treated as **non-production**: the hardening is silently disabled and the buckets become force-destroyable. Name the production environment `prod` and nothing else.

<span id="provider-ip-allow-lists"></span>

#### `lambda_vpc_scope`

**Type:** string. **Default:** `"required"`.

| Value             | Behavior                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `"required"`      | Only Lambdas needing private resources join the VPC; source-control, trackers, and the VPC AgentCore runtime already use NAT egress.   |
| `"public-egress"` | Also routes OAuth connectors, the credential broker, and seed-blocks through NAT, useful for provider IP allowlists or private GitLab. |
| `"all"`           | Places every Lambda in the private subnets, adding a dependency on the VPC's outbound connectivity for public services.                |

Example: `lambda_vpc_scope = "public-egress"`. Allowlist every NAT address printed by deployment: one for non-production, two for `prod`. See [static egress IPs](../using-the-platform/git-integration.md#static-egress-ips).

#### `vpc_block_public_access_exclusion`

**Type:** bool. **Default:** `false`.

`false` creates no VPC Block Public Access exclusions. `true` creates bidirectional exclusions for the two private subnets used by the Yjs origin and egress-only exclusions for the public NAT subnets. For example, use `vpc_block_public_access_exclusion = true` when account-level Block Public Access prevents CloudFront from reaching the internal Yjs ALB or prevents NAT egress. The account must allow exclusions; this setting does not override an organization policy. Subnet routing and security groups still apply. See [troubleshooting](#troubleshooting) for recovery after a failed VPC Origin create.

### Logging, encryption, and data protection

#### `powertools_log_level`

**Type:** string. **Default:** `"INFO"`.

Allowed values are case-sensitive. `DEBUG` includes diagnostic messages; `INFO` includes normal operation messages; `WARN` keeps warnings and more severe messages; `ERROR` keeps errors and critical messages; `CRITICAL` keeps only critical messages; `SILENT` suppresses Powertools logger output. Each level except `SILENT` includes higher-severity messages. This does not suppress every log written directly by a dependency or CLI.

Example: `powertools_log_level = "DEBUG"` while diagnosing a problem, then restore `"INFO"` to reduce log volume.

#### `powertools_log_event`

**Type:** bool. **Default:** `false`.

`false` leaves incoming-event logging off. `true` enables the shared logger's sanitized incoming API-event logging, useful when diagnosing request handling. Example: `powertools_log_event = true`. Sanitization is not a reason to put credentials or sensitive application content in requests unnecessarily; enable it only where the additional logging is appropriate.

#### `kms_key_arn`

**Type:** string. **Default:** `""`.

`""` keeps the AWS encryption defaults for resources wired to this setting. A full customer-managed KMS **key** ARN selects your existing key for those resources, including DynamoDB and new Neptune clusters; aliases are rejected. The key must be usable in the deployment Region and its policy must permit the relevant services and roles. This is not a global override for every encrypted resource.

Example: `kms_key_arn = "arn:aws:kms:eu-central-1:111122223333:key/12345678-1234-1234-1234-123456789abc"`. Existing Neptune clusters keep their original encryption and key: changing this input does not re-encrypt or replace them.

#### `deletion_protection`

**Type:** bool. **Default:** `true`.

`true` enables deletion protection on durable DynamoDB tables, Neptune, and the Cognito user pool in every environment. `false` allows those protection settings to be removed; it does not itself delete data or disable the other production teardown safeguards.

Example: `deletion_protection = true` for normal operation. Use `false` only as part of a deliberate [teardown](#destroy-infrastructure) after verifying backups; protection must be removed in an apply before destruction.

#### `backup_retention_period`

**Type:** number. **Default:** `7`.

Number of days Neptune retains automated backups. Use a whole number from **7 through 35**; larger values retain a longer recovery window. This does not configure DynamoDB or S3 retention.

Example: `backup_retention_period = 14` keeps two weeks of automated Neptune backups.

#### `neptune_instance_class`

**Type:** string. **Default:** `"db.t3.medium"`.

Choose a Neptune instance class available for the engine version and Region, such as `"db.t4g.medium"` or `"db.r7g.large"`. Terraform checks the `db.<family>.<size>` form; AWS determines which classes are actually supported. Larger classes provide more capacity at higher cost.

Example: `neptune_instance_class = "db.r7g.large"`. Resizing modifies and restarts the **only** instance, interrupting graph access. Schedule it with [neptune_apply_immediately](#neptune_apply_immediately).

#### `neptune_apply_immediately`

**Type:** bool. **Default:** `false`.

`false` defers an instance-class change to Neptune's next maintenance window; plans continue showing the pending change until then. `true` applies it during the current apply, including the restart.

Example: `neptune_apply_immediately = true` for an agreed immediate resize. It does not make resizing interruption-free.

#### `skip_final_snapshot`

**Type:** bool. **Default:** `false`.

`false` creates a final Neptune snapshot when the cluster is deleted. `true` skips that last recovery copy and is allowed only outside `prod`. It does not bypass [deletion_protection](#deletion_protection).

Example: `skip_final_snapshot = false` for recoverable teardown. Use `true` only for a disposable non-production database whose contents are no longer needed.

### Models and agent CLIs

#### `bedrock_model`

**Type:** string. **Default:** `"us.anthropic.claude-sonnet-4-6"`.

The primary Bedrock model/inference profile ID supplied to the runtime. It also seeds OpenCode's default as `amazon-bedrock/<id>` when the CLI-model settings are first created; later applies preserve defaults saved in **Admin → Agents**. Workflow and tier model selections can override the fallback.

Use an ID served in [bedrock_region](#bedrock_region), with the appropriate `us.`, `eu.`, `apac.`, or supported `global.` prefix. Terraform does not enumerate models or verify access. Example: `bedrock_model = "eu.anthropic.claude-sonnet-4-6"` with `bedrock_region = "eu-central-1"`. An empty string omits the initial OpenCode default; it does not disable Bedrock or provision model access.

#### `bedrock_region`

**Type:** string. **Default:** `""`.

`""` uses `aws_region`. A Region name selects a different location for Bedrock inference and model discovery without moving the platform infrastructure. Bedrock API keys are regional, so the Region must match the key and the models you can access.

Example: `bedrock_region = "us-west-2"` when the application runs in Europe but its Bedrock key and model access are in Oregon. Select matching model IDs as well.

#### `bedrock_gateway_url`

**Type:** string. **Default:** `""`.

`""` sends inference to Amazon Bedrock. An HTTPS URL sends Claude Code's Bedrock requests in **Keys** mode to a gateway accepting Bedrock InvokeModel requests with `Authorization: Bearer <key>`. The URL can include a port and path, but cannot contain credentials, whitespace, a query, or a fragment.

Example: `bedrock_gateway_url = "https://bedrock.example.com"` and save the gateway's key through the platform's credential settings. With this configured, every Bedrock key at platform, space, or personal scope is treated as a gateway key; OpenCode and Codex are unavailable with a key because they require AWS endpoints. **IAM** mode continues to call AWS. Set the Region and model selections to values the gateway serves.

The gateway must use a publicly trusted HTTPS certificate and be reachable from the runtime's VPC. Before adding, changing, or removing it on an existing deployment, follow the [Bedrock gateway rollout](../using-the-platform/bedrock-gateway.md#step-2-prepare-a-deployment-that-is-in-use): finish or cancel affected intents, clear saved keys that belong to the old endpoint, and rebuild managed environment revisions. Existing revisions retain their gateway setting, and a mismatch refuses the key. The deploy script blocks gateway changes while intents are started, running, or parked; direct Terraform skips that check.

#### `bedrock_gateway_disable_content_type_guard`

**Type:** bool. **Default:** `false`.

`false` keeps Claude Code's check that streamed Bedrock responses have Content-Type `application/vnd.amazon.eventstream`. `true` disables that check for a gateway that changes the header; it does not convert a different streaming format into Bedrock's format. Ignored without `bedrock_gateway_url`.

Example: `bedrock_gateway_disable_content_type_guard = true` only for that compatibility problem. Prefer a gateway that preserves the original header.

#### `bedrock_model_aliases`

**Type:** map(string). **Default:** `{}`.

Maps any of the three keys `opus`, `sonnet`, and `haiku` to model IDs. `{}` keeps built-in targets; omitted keys keep their built-in target. Values must be non-empty and contain no whitespace. An `anthropic.` ID receives the inference Region's geographic prefix; other IDs, including `global.` IDs, are used as written. The mapping applies both to workflow blocks naming aliases and to Claude Code's subagents and background calls.

Example, when the account or gateway serves a different Haiku target:

```hcl
bedrock_model_aliases = {
  haiku = "eu.anthropic.claude-haiku-5-5"
}
```

Set every alias whose default target is unavailable in your account or gateway.

#### `codex_model`

**Type:** string. **Default:** `"openai.gpt-5.5"`.

Seeds the Codex-on-Bedrock default on the **first** creation of the CLI-model settings. Use an exact `openai.<model-name>` ID, with letters, digits, dots, underscores, or hyphens in the model name; `""` leaves no pinned Codex default. This does not enable or select Codex.

Example: `codex_model = "openai.gpt-5.5"`. Later changes belong in **Admin → Agents**, because Terraform preserves the saved CLI-model settings on subsequent applies.

#### `disabled_clis`

**Type:** list(string). **Default:** `[]`.

`[]` enables all four CLI choices initially. List any of `"kiro"`, `"claude"`, `"opencode"`, and `"codex"` to prevent selecting them for new intents; at least one must remain enabled. Existing intents retain their pinned choices. This value seeds the setting only on its first creation; use **Admin → Agents** afterward.

Example: `disabled_clis = ["kiro", "opencode", "codex"]` initially offers only Claude Code.

### Methodology and Git integrations

#### `aidlc_repo_ref`

**Type:** string. **Default:** `"83ed7a812c4024904f2c5e4d744e28077e0a5acd"`.

The commit SHA, tag, or branch of `awslabs/aidlc-workflows` used by the baseline block seed and AgentCore runtime. A commit SHA gives repeatable content; a moving branch can resolve to different content later. Keep the seed and runtime on the same compatible version and run the normal deployment reseed when changing it.

Example: `aidlc_repo_ref = "83ed7a812c4024904f2c5e4d744e28077e0a5acd"` pins the shipped baseline. Use [aidlc_release_pinning](#aidlc_release_pinning) for catalog-based version selection on new intents.

#### `aidlc_release_pinning`

**Type:** string. **Default:** `"on"`.

`"on"` enables AI-DLC version selection for new intents; standard deployment prepares the supported catalogs. The configured baseline remains in use until Stable is selected. `"off"` opts out of that selection. Existing intents keep their captured version in either case.

Example: `aidlc_release_pinning = "off"` to keep new work on the configured baseline without offering release selection. These are strings, not booleans.

#### `aidlc_custom_source_gitlab_url`

**Type:** string. **Default:** `"https://gitlab.com"`.

The GitLab instance from which custom methodology releases named `gitlab:<namespace>/<project>` are imported. Use an HTTPS origin, optionally with a port or trailing slash, but without a project path, credentials, query, or fragment. It does not register a GitLab source-control connection.

Example: `aidlc_custom_source_gitlab_url = "https://gitlab.example.com"` makes `gitlab:team/aidlc-workflows` imports read that instance.

#### `aidlc_custom_source_gitlab_token_secret_arn`

**Type:** string. **Default:** `""`.

`""` supports imports from public GitLab projects only. A Secrets Manager secret ARN supplies a token with `read_api` access for private custom methodology releases on `aidlc_custom_source_gitlab_url`. Create the token secret beforehand; put its ARN, not the token, in Terraform.

Example: `aidlc_custom_source_gitlab_token_secret_arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:aidlc/release-import-AbCdEf"`. This token is separate from users' GitLab OAuth connections.

#### `gitlab_instance_secrets`

**Type:** map(string). **Default:** `{}`.

Registers self-managed GitLab hosts and their existing OAuth-application secret ARNs. `{}` registers none; GitLab.com remains configured through **Admin → Trackers**. Each secret must contain JSON string fields `client_id` and `client_secret` and be in the deployment account and Region.

Keys are lowercase DNS hostnames, without `https://` or a path. DNS labels must be 1–63 letters/digits/hyphens, with no leading or trailing hyphen, and the hostname at most 253 characters. Do not use `gitlab.com` or `public`. Include `:<port>` only for a non-default port from 1–65535; omit `:443`. Values are exact Secrets Manager ARNs.

```hcl
gitlab_instance_secrets = {
  "gitlab.example.com" = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:aidlc/gitlab-AbCdEf"
}
```

Register the OAuth app and provide network access as described in [self-managed GitLab setup](../using-the-platform/git-integration.md#register-a-self-managed-gitlab-instance). Disconnect users before removing an instance.

#### `pr_title_tracker_key`

**Type:** bool. **Default:** `false`.

`false` leaves intent pull-request titles unchanged. `true` prefixes the Jira issue key when the intent originated from Jira: for example, `Fix invoice rounding` becomes `[ABC-12] Fix invoice rounding`. Intents without a Jira source issue keep their title.

Example: `pr_title_tracker_key = true` when your review process expects the Jira key in PR titles.

<span id="container-builds-and-instances-compute"></span>

### Container builds

#### `docker_build_args`

**Type:** map(string), sensitive. **Default:** `{}`.

Passes build arguments to local Docker image builds. `{}` adds none. For example, supply standard proxy arguments when the build environment needs a proxy:

```hcl
docker_build_args = {
  HTTPS_PROXY = "http://proxy.example.com:8080"
  NO_PROXY    = "localhost,127.0.0.1"
}
```

Only arguments understood by Docker or the Dockerfiles have an effect; these do not configure runtime networking. Deployment scripts detect standard proxy environment variables; see [proxy settings](#proxy-settings) for the installer and environment-variable examples.

To supply your own container build settings, set `TF_VAR_docker_build_args` to a JSON object. This replaces the automatically detected settings. A `.tfvars` value wins over that environment value. Terraform hides these values in terminal output but saves them in plan and state files. Restrict access to those files and keep state storage encrypted.

#### `agentcore_image_tag`

**Type:** string or null. **Default:** `null`.

`null` builds AgentCore locally during apply. An existing ECR tag uses a pre-built ARM64 image from `<project_name>-agentcore-<environment>`. When `enable_instances_compute = true`, also publish an AMD64 image under `<tag>-amd64`. Tags are resolved to digests during planning; a missing tag fails the plan.

Example: `agentcore_image_tag = "1.2.3"` uses `1.2.3` and, when required, `1.2.3-amd64`. Supply a tag, not a repository URL or digest; `""` is not the build-default sentinel. See [pre-built container images](#pre-built-container-images) for repository bootstrap and retention.

#### `yjs_image_tag`

**Type:** string or null. **Default:** `null`.

`null` builds the Yjs collaboration server locally during apply. An existing ECR tag uses the pre-built AMD64 image from `<project_name>-yjs-server-<environment>`, resolved to a digest during planning. A missing tag fails the plan.

Example: `yjs_image_tag = "1.2.3"`. Supply a tag; use `null`, not `""`, to return to local builds. This choice is independent of `agentcore_image_tag`.

#### Public ECR base-image authentication

Container builds use the existing digest-pinned Public ECR Node images.
`deploy-terraform.sh` automatically runs `scripts/with-public-ecr-auth.mjs`
for `--phase all` and `--phase apply`; a separate plan does not request a token.
The wrapper requests a fresh token in `us-east-1` using the current deployment
identity, so that identity needs the
[Public ECR permissions](prerequisites.md#public-ecr-permissions-for-container-builds).

The wrapper creates a temporary Docker config with restrictive permissions and
passes its directory as `DOCKER_CONFIG` for the deployment subprocess. The
locked Terraform Docker provider's Buildx path reads this config for its
BuildKit auth session, covering AgentCore ARM64, optional AgentCore AMD64, and
Yjs AMD64. Terraform's existing private ECR `registry_auth` still handles image
pushes. Existing Docker contexts, proxy settings and other registry helpers are
retained; only Public ECR uses the fresh token. The caller's Docker config is
unchanged. The temporary config is removed on completion, failure, SIGINT or
SIGTERM; a forced kill or host loss can bypass cleanup, so use an ephemeral
runner or clean abandoned `aidlc-public-ecr-*` temporary directories.

Before running the deployment command, the wrapper checks authenticated GET
access to the exact manifests named in both Dockerfiles. This catches missing
permissions, expired/invalid authentication and manifest-access failures before
apply. It does **not** download or verify every layer, validate platform
execution, warm the builder cache, or prove connectivity from a separate builder.
It does not retry Terraform apply.

For direct Terraform use, wrap the saved-plan apply explicitly:

```bash
node scripts/with-public-ecr-auth.mjs "$PWD" -- \
  terraform -chdir=terraform apply /tmp/aidlc-dev.tfplan
```

AWS documents a separate unauthenticated data allowance; a `429 Data limit
exceeded` response is not necessarily a short burst of requests. Authentication
removes reliance on anonymous pulls but cannot guarantee freedom from account
or service limits. If authenticated pulls still encounter limits, record which
identity and build failed, check the applicable
[Public ECR quotas](https://docs.aws.amazon.com/AmazonECR/latest/public/public-service-quotas.html),
and evaluate a separately approved private ECR mirror or pull-through cache.
That requires repository/cache permissions, lifecycle and cost decisions, and
verification of the pinned image digests for each architecture. This deployment
does not provision a mirror or fall back to anonymous Docker Hub pulls.

#### Pre-built container images

By default Terraform builds the AgentCore and Yjs images during apply. To build
them elsewhere (for example in CI, so they can be scanned before they deploy),
push them to the deployment's ECR repositories and set their tags:

```hcl
# terraform/environments/dev.tfvars
agentcore_image_tag = "1.2.3"
yjs_image_tag       = "1.2.3"
```

| Image     | Repository                   | Build context        | Dockerfile                     | Platform                                                       |
| --------- | ---------------------------- | -------------------- | ------------------------------ | -------------------------------------------------------------- |
| AgentCore | `<project>-agentcore-<env>`  | `lambda/`            | `lambda/agentcore/Dockerfile`  | `linux/arm64`, plus `linux/amd64` as `<tag>-amd64` (see below) |
| Yjs       | `<project>-yjs-server-<env>` | `lambda/yjs-server/` | `lambda/yjs-server/Dockerfile` | `linux/amd64`                                                  |

- With `enable_instances_compute = true`, also push the AgentCore amd64 image
  as `<tag>-amd64`.
- Each tag is resolved to its digest, and both images deploy by digest, so
  moving a tag later does not change a running deployment. Treat the tags as
  write-once: published environment revisions pin the AgentCore digest, and the
  AgentCore repository has no lifecycle policy (see issue #427).
- Plan fails if a tag is missing from its repository, so push the images
  before planning. Terraform creates the repositories, so a new environment
  needs one apply with the defaults (or a targeted apply of the two
  `aws_ecr_repository` resources) before switching to pre-built images.
- Leaving either variable unset (`null`) keeps the build during apply.

### Instances compute

#### `enable_instances_compute`

**Type:** bool. **Default:** `false`.

`false` leaves managed environments on the default compute options without provisioning platform-managed Instances capacity providers. `true` enables AgentCore Instances, which run on managed EC2 capacity and support x86_64 and ARM64 environments with larger persistent workspaces. It also requires the additional AMD64 AgentCore image. It does not move existing runtimes to a new compute type.

Example: `enable_instances_compute = true`, then create an Instances environment using the appropriate architecture and instance-type list.

#### `instances_allowed_instance_types`

**Type:** list(string). **Default:** `["m6i.large"]`.

The x86_64 EC2 types the platform-managed Instances capacity provider can use when Instances compute is enabled. Choose non-burstable x86_64 types supported by AgentCore Instances in your Region; the `t` families are not supported. This is a capacity allowlist, not a request for one instance of every listed type.

Example: `instances_allowed_instance_types = ["m6i.large", "m6i.xlarge"]`. Keep the list non-empty when enabling Instances and use the separate ARM64 list for Graviton capacity. AWS, rather than this root variable, validates service and Region availability.

#### `instances_allowed_instance_types_arm64`

**Type:** list(string). **Default:** `["m7g.large"]`.

The corresponding allowlist for ARM64/Graviton Instances capacity. Use supported non-burstable ARM64 families; an x86_64 type cannot run an ARM64 environment. It has no effect while Instances compute is disabled.

Example: `instances_allowed_instance_types_arm64 = ["m7g.large", "m7g.xlarge"]`. Keep it non-empty when enabling Instances; actual availability depends on AgentCore Instances in the Region.

#### `instances_workspace_gib`

**Type:** number. **Default:** `50`.

A positive whole number of GiB for each Instances session's persistent EBS workspace. It replaces the default microVM's fixed 1 GiB session storage only for Instances compute. Larger values give builds more disk space and increase storage cost.

Example: `instances_workspace_gib = 100`. A change creates a new capacity provider; existing runtimes retain their old provider and volume configuration. It does not resize active workspaces.

### Collaboration workers

#### `yjs_scaling`

**Type:** object. **Default:** `{}`.

Controls the Yjs collaboration server's Fargate workers, memory safeguards, and optional document sharding. `{}` runs one standalone worker: 256 CPU units/512 MiB outside production, or 1024 CPU units/2048 MiB in `prod`. All fields are optional.

| Field                      | Default               | Allowed values and behavior                                                                                                                                              |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cluster_enabled`          | `false`               | `false` uses one standalone document owner and REST autosaves; `true` distributes document ownership across workers and recovers binary checkpoints from S3.             |
| `mode_transition`          | `false`               | `true` stops old tasks before starting new ones during a standalone/cluster transition; requires one fixed worker and no autoscaling. Return to `false` after migration. |
| `cpu`                      | Environment-dependent | Fargate CPU units per worker; choose a CPU/memory pair below. `null` keeps the environment default.                                                                      |
| `memory`                   | Environment-dependent | MiB per worker; choose a CPU/memory pair below. `null` keeps the environment default.                                                                                    |
| `desired_count`            | `1`                   | Whole number from 1–64 for fixed capacity; values above 1 require cluster mode. Autoscaling bounds govern capacity when autoscaling is configured.                       |
| `max_connections`          | `2000`                | Maximum admitted connections per worker; positive whole number.                                                                                                          |
| `max_documents`            | `256`                 | Maximum loaded documents per worker; positive whole number.                                                                                                              |
| `max_document_bytes`       | `8388608` (8 MiB)     | Maximum encoded size of one document; positive whole number of bytes.                                                                                                    |
| `max_total_document_bytes` | `67108864` (64 MiB)   | Total encoded-document budget per worker; positive whole number of bytes, at least `max_document_bytes`.                                                                 |
| `max_buffered_bytes`       | `16777216` (16 MiB)   | Socket-buffer limit in bytes; positive whole number, at least `max_document_bytes + 1024` for framing.                                                                   |
| `alarm_actions`            | `[]`                  | Existing CloudWatch alarm-action ARNs, typically SNS topics; `[]` sends no alarm notifications. The same actions run for alarm and recovery transitions.                 |
| `autoscaling`              | `null`                | Omit or use `null` for fixed capacity; `{}` enables scaling with the default bounds below and requires cluster mode.                                                     |
| `autoscaling.min_capacity` | `2`                   | Minimum workers, a whole number at least 2 and no greater than `max_capacity`.                                                                                           |
| `autoscaling.max_capacity` | `8`                   | Maximum workers, a whole number between `min_capacity` and 64.                                                                                                           |

Supported CPU/memory pairs in this deployment:

| CPU units | vCPUs | Memory (MiB)                      |
| --------- | ----- | --------------------------------- |
| `256`     | 0.25  | `512`, `1024`, or `2048`          |
| `512`     | 0.5   | `1024`–`4096` in steps of `1024`  |
| `1024`    | 1     | `2048`–`8192` in steps of `1024`  |
| `2048`    | 2     | `4096`–`16384` in steps of `1024` |
| `4096`    | 4     | `8192`–`30720` in steps of `1024` |

Example: enlarge the standalone worker without changing its storage mode:

```hcl
yjs_scaling = {
  cpu    = 1024
  memory = 2048
}
```

After completing the cluster transition, this example scales between two and eight workers:

```hcl
yjs_scaling = {
  cluster_enabled = true
  cpu             = 1024
  memory          = 2048
  autoscaling = {
    min_capacity = 2
    max_capacity = 8
  }
}
```

For fixed clustered capacity, replace `autoscaling` with `desired_count = 4`. Scaling tracks CPU, memory, and connection/document/buffer pressure. More workers help with more documents; one busy document still has one owner. Encoded size is smaller than runtime memory use, and workers also reject loads/updates above 85% of configured memory.

**For an existing deployment, migrate before scaling:** have editors save and close, apply `cluster_enabled = true`, `mode_transition = true`, and `desired_count = 1` without autoscaling, then verify checkpoint recovery. Set `mode_transition = false` in the next apply before increasing capacity. Returning to standalone needs a maintenance window because it cannot read cluster checkpoints. Follow [Yjs operations](../development/yjs-operations.md#enable-expand-and-roll-back) for rollout, recovery, and load testing.

<span id="web-protection-and-application-domains"></span>

### AWS WAF

#### `enable_waf`

**Type:** bool. **Default:** `false`.

`false` creates no WAF ACLs or REST origin-header restriction. `true` creates a CloudFront ACL and a regional ACL shared by API Gateway and Cognito, with managed protections and a REST API rule requiring CloudFront's generated origin secret. Direct REST calls without that header are blocked even with a valid JWT. The WebSocket API is unaffected by that REST rule.

Example: `enable_waf = true`. Review costs and exercise your normal requests before enabling it; see [WAF rules and request handling](#waf-rules-and-request-handling) for rule behavior, including building-block body exceptions.

#### WAF rules and request handling

[AWS WAF](https://docs.aws.amazon.com/waf/latest/developerguide/waf-chapter.html) (Web Application Firewall) is optional and disabled by default.
To create web ACLs for CloudFront, the REST API Gateway stage, and the Cognito user pool, set:

```hcl
enable_waf = true
```

The ACLs use the AWS-managed Common Rule Set, Known Bad Inputs, and Amazon IP Reputation rule groups.
With `enable_waf = true`, the shared regional ACL also blocks application REST API requests with a missing or incorrect `X-Origin-Verify` header, including direct requests with a valid Cognito JWT. The rule checks URL-decoded paths containing `/api`, which covers every application REST route with or without the stage prefix. Cognito's supported login and token paths do not match this condition, so they do not require the header. CloudFront injects the generated secret for every request to the REST API origin, including OPTIONS preflight and OAuth callbacks. A correct header continues through the managed rules and existing authentication and application authorization checks.

This retains two ACLs: one for CloudFront and one shared by API Gateway and Cognito. The origin check adds one WAF rule (currently $1/month, prorated hourly), with no additional ACL or managed rule groups. New REST routes must remain under `/api` or the rule's path scope must be updated.

With `enable_waf = false` (the default), no WAF ACLs or origin-header restriction are enforced. Direct REST API requests remain available with the existing authentication and authorization controls. The WebSocket API is unaffected by the REST API origin check.

This is a secret-based access restriction: the REST API endpoint remains public, and anyone who obtains the secret can satisfy the origin check. Keep Terraform state and access to the CloudFront/WAF configuration restricted. The secret is not included in the frontend bundle. WAF request sampling is disabled and WAF request logging is not configured; if you enable WAF logging separately, redact the `x-origin-verify` header.

Test them with representative traffic before production and review [AWS WAF pricing](https://aws.amazon.com/waf/pricing/).
A commented IP allow-list rule example is included in `terraform/modules/security/waf/main.tf`.

##### Building-block bodies

Building-block bodies are methodology markdown and sensor scripts. They legitimately contain what two Common Rule Set rules treat as attacks in a request body: relative links such as `../templates/foo.md` (`GenericLFI_BODY`) and HTML comments and tags (`CrossSiteScripting_BODY`). So both ACLs count those two rules and add two rules after the Common Rule Set:

- `LabelBlockWrites` labels a block create (`POST /api/blocks/{type}`) or update (`PUT /api/blocks/{type}/{id}`), with `{type}` matched in any case as the API accepts it. On the regional ACL the API Gateway stage prefix (`/<stage>/api/...`) is allowed too.
- `BlockBodyContentOutsideBlockWrites` blocks any request that matched one of the two rules and isn't labelled.

The two rules still block in every other request body, and the other body rules (`GenericRFI_BODY`, `EC2MetaDataSSRF_BODY`) block everywhere. A block write still goes through every other managed rule, and needs the `platform-admin` group. The two rules add to the ACLs' monthly rule charge.

### Custom domain

Entirely optional. Without it the application is served on the CloudFront-assigned `*.cloudfront.net` domain, which needs no certificate and no DNS.

Every public path — the SPA, `/api/*`, `/ws` and `/yjs/*` — is served by a single CloudFront distribution, so a custom domain needs exactly one certificate and one distribution change. There is no API Gateway custom domain or load balancer certificate to configure. Enterprise SSO uses a separate Cognito managed-login domain for federation; it does not serve the application.

The certificate **must be in `us-east-1`** regardless of the deployment region, because CloudFront accepts viewer certificates from no other region.

#### `app_domain`

**Type:** string. **Default:** `""`.

`""` uses the generated CloudFront hostname. Otherwise use one bare lowercase hostname, such as `app_domain = "aidlc.example.com"`, without a scheme, port, path, or wildcard. It becomes the canonical application URL for frontend endpoints and OAuth redirects.

Set either `acm_certificate_arn` or `route53_zone_id` with it. Apply infrastructure, register updated provider callback URLs, and rebuild/deploy the frontend. See [custom domain](#custom-domain) for the complete sequence.

#### `app_domain_aliases`

**Type:** list(string). **Default:** `[]`.

`[]` adds no aliases. Additional bare lowercase hostnames serve the same CloudFront distribution and enter the CORS allowlist; OAuth callbacks still use `app_domain`. Requires a non-empty `app_domain` and a certificate covering every hostname.

Example: `app_domain_aliases = ["www.aidlc.example.com"]`. Aliases do not create independent deployments or make their hostnames canonical.

#### `acm_certificate_arn`

**Type:** string. **Default:** `""`.

With `app_domain` set, `""` requests and DNS-validates a certificate using `route53_zone_id`. An existing ACM certificate ARN uses that certificate instead; it must be **ISSUED**, in the **deployment account** and **us-east-1**, and cover the canonical hostname and all aliases. It must chain to a publicly trusted CA supported by CloudFront. The zone ID is then optional.

Example: `acm_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/12345678-1234-1234-1234-123456789abc"`. You can import a suitable public certificate into ACM; distributing a private CA to browsers alone is insufficient. Keep this empty when `app_domain` is empty.

#### `route53_zone_id`

**Type:** string. **Default:** `""`.

`""` leaves application DNS under your control and requires an existing certificate when using a custom domain. A hosted-zone ID creates A/AAAA aliases for `app_domain` and its aliases, plus certificate-validation records if Terraform requests the certificate. The zone must contain those names.

Example: `route53_zone_id = "Z1234567890ABC"`. For a zone in another account, also set [dns_role_arn](#dns_role_arn). This does not configure the separate managed-login domain's DNS.

#### `dns_role_arn`

**Type:** string. **Default:** `""`.

`""` manages DNS with the deployment credentials. An IAM role ARN makes the DNS provider assume that role for records in both `route53_zone_id` and `auth_route53_zone_id`. The deployment identity needs permission to assume it, its trust policy must allow that identity, and the role needs access to the relevant zones.

Example: `dns_role_arn = "arn:aws:iam::444455556666:role/aidlc-dns"` for centrally managed Route53. Both configured zones must be accessible through this one role. It does not move the application or certificate into the DNS account.

#### Bring your own certificate

For centrally managed, imported, or wildcard certificates, and for DNS that lives outside Route53 or in another AWS account. The certificate must already be `ISSUED` in the deployment account and `us-east-1`, cover every hostname, and chain to a publicly trusted certificate authority supported by CloudFront. A private-CA certificate trusted only by your organization's browsers does not meet CloudFront's [alternate-domain requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html).

```bash
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment dev \
  --admin <administrator-email> \
  --domain aidlc.example.com \
  --certificate-arn arn:aws:acm:us-east-1:111122223333:certificate/<id>
```

The installer prints the DNS records to create when it finishes. Add `--hosted-zone-id` alongside `--certificate-arn` to keep your own certificate but let Terraform manage the records.

#### Terraform-managed certificate

The installer uses a Route53 hosted zone in the deployment account. Terraform requests the certificate, publishes the validation records, waits for issuance, and creates the A/AAAA alias records. For cross-account Route53 with a manual deployment, also set [dns_role_arn](#dns_role_arn).

```bash
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment dev \
  --admin <administrator-email> \
  --domain aidlc.example.com \
  --hosted-zone-id Z1234567890ABC
```

#### Multiple hostnames

Additional hostnames for the same deployment use `--domain-alias`, repeated as needed:

```bash
  --domain aidlc.example.com \
  --domain-alias www.aidlc.example.com
```

`--domain` is canonical: it is the hostname used for the OAuth redirect URIs and baked into the frontend build, so there can only be one. Aliases are additional names CloudFront answers on. The CloudFront domain also keeps working, which is useful when DNS is misconfigured.

Before touching AWS the installer verifies that the certificate is in `us-east-1`, is `ISSUED`, and covers every hostname (wildcards included); that the hosted zone exists and contains every hostname; and that no other CloudFront distribution already claims the hostnames. Each of these would otherwise fail several minutes into a distribution update.

The same flags work on `update`, and `--no-domain` removes a configured domain.

#### Without the installer

Invoking `deploy-terraform.sh` and `deploy-frontend.sh` directly works the same way — set the variables in your environment's `.tfvars` instead of passing flags:

```hcl
# terraform/environments/dev.tfvars
app_domain         = "aidlc.example.com"
app_domain_aliases = ["www.aidlc.example.com"] # optional

# Supply either of the next two, or both. With only a certificate ARN you
# manage DNS yourself; with only a zone ID Terraform requests the certificate
# as well; with both it uses your certificate and manages the records.
acm_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/<id>"
route53_zone_id     = ""
```

Then apply and rebuild the frontend, **in that order**:

```bash
./scripts/deploy-terraform.sh dev
./scripts/deploy-frontend.sh dev
```

Both steps are required. Terraform updates the distribution, the OAuth redirect URIs and the CORS allowlists; the frontend then has to be rebuilt because its endpoint URLs are inlined into the bundle at build time. `deploy-terraform.sh` prints the DNS records to create when `route53_zone_id` is empty.

For temporary or CI configuration, see [command-line overrides](#command-line-overrides).

!!! warning "The installer's preflight checks do not run on this path"

    Terraform verifies that the variable combination is coherent and that the certificate ARN is in `us-east-1`, but it cannot check the certificate's status, what hostnames it covers, or whether another CloudFront distribution already claims your hostname. Those failures surface several minutes into the apply — or, for a certificate still pending validation, never fail and simply never work.

    Verify by hand first:

    ```bash
    # Must be ISSUED, and the names must cover every hostname
    # (a wildcard covers one label: *.example.com matches a.example.com only).
    aws acm describe-certificate \
      --certificate-arn arn:aws:acm:us-east-1:111122223333:certificate/<id> \
      --region us-east-1 \
      --query 'Certificate.{Status:Status,Names:SubjectAlternativeNames}'

    # Your hostname must not appear here — CloudFront aliases are globally unique.
    aws cloudfront list-distributions \
      --query 'DistributionList.Items[].{Id:Id,Aliases:Aliases.Items}' \
      --output table

    # If using route53_zone_id, the zone must contain every hostname.
    aws route53 get-hosted-zone --id Z1234567890ABC --query 'HostedZone.Name'
    ```

To review the plan before applying — worth doing when adding or removing a domain, since it changes the distribution, the environment variables of every Lambda that handles OAuth or returns CORS headers, and the artifacts bucket CORS rules:

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

Removing a domain is the same edit in reverse: clear all four values back to `""` / `[]`, then run both scripts again. All four have to go together — a leftover certificate ARN or zone ID with an empty `app_domain` is rejected at plan time, on the assumption that it is a half-finished edit rather than an intent to configure a certificate for nothing. Via `--var` that means:

```bash
./scripts/deploy-terraform.sh dev \
  --var app_domain= \
  --var 'app_domain_aliases=[]' \
  --var acm_certificate_arn= \
  --var route53_zone_id=
```

Removing or renaming a domain whose certificate Terraform owns takes about five minutes longer than the distribution update alone. CloudFront releases a certificate asynchronously, so ACM still reports it as in use for a while after the distribution reports `Deployed`, and deleting it too early fails. The apply waits that out before deleting. A supplied `acm_certificate_arn` is never deleted by Terraform and so is not affected.

#### External DNS

Terraform only manages records when `--hosted-zone-id` is given. Otherwise create them yourself, pointing at the value the installer prints:

```bash
terraform -chdir=terraform output -raw dns_target
```

Use an alias/ANAME record where your provider supports it and a CNAME otherwise. Apex domains require alias records — a CNAME is not valid there. Both `A` and `AAAA` are needed because the distribution is IPv6-enabled. CloudFront accepts the hostname as soon as the certificate covers it, so the apply succeeds before the records exist; the deployment is simply unreachable on that hostname until they are published.

#### Adding a domain to a running deployment

Setting the domain at initial install avoids all of the following. On an existing deployment:

1. Obtain a `us-east-1` certificate covering the hostname, `ISSUED`.
2. Run `update` with the domain flags. The CloudFront distribution update takes 5–15 minutes.
3. Create the DNS records if you manage DNS yourself.
4. The frontend is rebuilt and redeployed automatically — the endpoint URLs are inlined at build time, so a Terraform apply alone is not enough.
5. Update the **Authorization callback URL** in every configured OAuth provider to the new hostname. GitHub App mode needs no change.
6. **Every GitLab connection must be reauthorized.** GitLab requires `redirect_uri` on the refresh-token grant and it must match the original authorization request, so changing the canonical hostname invalidates all stored GitLab refresh tokens. GitHub OAuth tokens and Jira connections are unaffected.

`update --no-domain` reverses the change. The CloudFront domain never changes, so it remains a working entry point throughout.

### Login, SSO, and session lifetimes

#### Enterprise SSO

OIDC and SAML federation, including Microsoft Entra ID and Okta, is configured
at deployment time rather than in the Admin UI. See [Enterprise SSO](enterprise-sso.md)
for the installer bootstrap sequence, provider files, and authoritative role
mapping.

#### `auth_mode`

**Type:** string. **Default:** `"local"`.

| Value        | Behavior                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `"local"`    | Cognito email/password login; `sso_providers` must be empty.                                         |
| `"hybrid"`   | Enterprise provider buttons and a separate Cognito-account form; requires at least one SSO provider. |
| `"sso-only"` | Enterprise provider buttons only; requires providers and at least one `platform-admin` role mapping. |

Example: `auth_mode = "hybrid"` with the provider example below. Verify an SSO administrator can sign in before selecting `"sso-only"`. Rebuild/deploy the frontend after changing authentication configuration. The [enterprise SSO guide](enterprise-sso.md) covers installer provider files and the bootstrap sequence.

#### `sso_providers`

**Type:** map(object), sensitive. **Default:** `{}`.

`{}` defines no enterprise providers and is required in local mode. Each map key is a provider name: 1–32 letters, digits, underscores, or hyphens, starting with a letter; `COGNITO` is reserved in any case. The fields below use Terraform names; the installer's JSON provider file uses the different field names documented in [Provider file](enterprise-sso.md#provider-file).

| Field                           | Allowed values and behavior                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display_name`                  | Required string; label shown on the login page, e.g. `"Company SSO"`.                                                                                      |
| `type`                          | Required `"oidc"` or `"saml"` (case-insensitive).                                                                                                          |
| `issuer_url`                    | OIDC issuer URL; required for OIDC, default `""`.                                                                                                          |
| `client_id`                     | OIDC application's client ID; required for OIDC, default `""`.                                                                                             |
| `client_secret_arn`             | Existing Secrets Manager ARN for the OIDC client secret; required for OIDC, default `""`.                                                                  |
| `scopes`                        | OIDC scopes; defaults to `["openid", "email", "profile"]` and must include `"openid"` for OIDC.                                                            |
| `metadata_url` / `metadata_xml` | SAML metadata URL or literal XML. Defaults to `""` for both; SAML requires exactly one to be non-empty.                                                    |
| `email_claim`                   | Required exact claim/attribute containing the email address, e.g. `"email"`.                                                                               |
| `name_claim`                    | Optional display-name claim; `""` means no name mapping.                                                                                                   |
| `role_claim`                    | Optional group/role claim; required when role mappings or access gates are set. Default `""`.                                                              |
| `role_mappings`                 | Map from platform/business role ID to a list of exact, case-sensitive IdP values. `{}` grants no mapped roles; an empty list grants nothing for that role. |
| `required_claim_values`         | List of allowed values in `role_claim`. `[]` adds no access gate; a non-empty list requires at least one match for every user, including admins.           |

Allowed role-mapping keys are `platform-admin`, `product-owner`, `business-analyst`, `architect`, `ux-ui-designer`, `developer`, `qa-tester`, `security-compliance`, `operations-devops`, and `delivery-manager`. Claim values must not be blank. Business roles describe responsibilities; they do not grant space membership or administration rights.

OIDC example (create the client and secret first):

```hcl
auth_mode = "hybrid"
sso_providers = {
  CorporateOIDC = {
    display_name      = "Company SSO"
    type              = "oidc"
    issuer_url        = "https://idp.example.com"
    client_id         = "aidlc-web"
    client_secret_arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:aidlc/oidc-AbCdEf"
    email_claim       = "email"
    name_claim        = "name"
    role_claim        = "groups"
    role_mappings     = { "platform-admin" = ["aidlc-admins"] }
  }
}
```

SAML alternative (use instead of, or as another entry alongside, the OIDC provider):

```hcl
auth_mode = "hybrid"
sso_providers = {
  CorporateSAML = {
    display_name = "Company SAML"
    type         = "saml"
    metadata_url = "https://idp.example.com/saml/metadata"
    email_claim  = "email"
  }
}
```

The SAML example permits hybrid login without granting platform-admin. For SSO-only, add a working administrator mapping. Configure the IdP to always send the role claim, even when empty, so Cognito cannot retain removed group memberships. Secret ARNs keep plaintext out of the input file, but Terraform reads OIDC secrets during provisioning and sensitive values can remain in state. See [role and access mapping](enterprise-sso.md#role-and-access-mapping).

#### `auth_access_token_validity_minutes`

**Type:** number. **Default:** `60`.

Whole minutes from **5 through 1440** for new Cognito access tokens, in both local and federated login. A shorter lifetime causes more frequent refreshes while a valid refresh token exists; it does not force a fresh IdP login each time.

Example: `auth_access_token_validity_minutes = 15`. Already-issued tokens keep their original expiry.

#### `auth_id_token_validity_minutes`

**Type:** number. **Default:** `60`.

Whole minutes from **5 through 1440** for new Cognito ID tokens, which the browser sends to the REST API and realtime services. Shorter tokens reduce the remaining lifetime of the last token issued before refresh access ends.

Example: `auth_id_token_validity_minutes = 15`. Already-issued tokens keep their original expiry; shortening this is not immediate session revocation.

#### `auth_refresh_token_validity_hours`

**Type:** number or null. **Default:** `null`.

`null` selects **168 hours (7 days)** in local mode or **24 hours** in either SSO mode. Otherwise use a whole number from **1 through 87600** hours. After this period Cognito stops permitting refreshes, but the last issued ID token remains valid until its own expiry.

Example: `auth_refresh_token_validity_hours = 8` with a 15-minute ID token allows API access for up to 8 hours 15 minutes after sign-in. Refresh does not recheck the upstream IdP, and already-open realtime connections are not forcibly closed at token expiry. See [token lifetimes](enterprise-sso.md#token-lifetimes) when choosing a limit for access after an IdP removal.

#### `auth_domain`

**Type:** string. **Default:** `""`.

`""` keeps Cognito's generated managed-login hostname. A bare lowercase hostname provisions a custom login domain, separate from the application domain and aliases. Its parent must already have a public DNS A record, and an issued `us-east-1` certificate must cover it.

Example: `auth_domain = "auth.aidlc.example.com"` with `auth_certificate_arn` set. Provisioning does not select the new hostname for login until [auth_domain_active](#auth_domain_active) is `true`.

#### `auth_domain_active`

**Type:** bool. **Default:** `false`.

`false` keeps the generated Cognito domain selected, even if a custom one is provisioned. `true` selects `auth_domain` for login and federation outputs. It requires a non-empty custom domain with working DNS and registered custom IdP callbacks.

Example: first apply `auth_domain_active = false`, test DNS/certificate and register callbacks, then apply `auth_domain_active = true` and rebuild/deploy the frontend. Setting it back to `false` and redeploying the frontend rolls back the login origin without deleting the domain. Follow the [custom managed-login domain sequence](enterprise-sso.md#custom-managed-login-domain).

#### `auth_route53_zone_id`

**Type:** string. **Default:** `""`.

`""` leaves login DNS under your control; point the hostname at the `auth_dns_target` output. A public hosted-zone ID creates A/AAAA aliases when `auth_domain` is also set. This value is independent of `route53_zone_id`, even if both hostnames share a zone.

Example: `auth_route53_zone_id = "Z1234567890ABC"`. For cross-account DNS, set `dns_role_arn` as well.

#### `auth_certificate_arn`

**Type:** string. **Default:** `""`.

`""` reuses the explicitly supplied `acm_certificate_arn`, which must also cover the login hostname. It does **not** reuse a certificate Terraform requested automatically for the application. Otherwise supply an issued ACM certificate ARN in `us-east-1` covering `auth_domain`.

Example: `auth_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/87654321-4321-4321-4321-cba987654321"`. A non-empty value requires `auth_domain`; Terraform does not request a new Cognito-domain certificate for you.

### Organization tags and IAM

#### `extra_tags`

**Type:** map(string). **Default:** `{}`.

Adds AWS provider default tags where supported. `{}` adds none. `Environment` and `Project` always come from their dedicated variables and override the same keys here. Provider default tags do not automatically cover resources managed through other providers.

Example: `extra_tags = { CostCenter = "engineering", Owner = "platform-team" }`.

#### `iam_role_path`

**Type:** string. **Default:** `"/"`.

The path for IAM roles created by the deployment. `"/"` uses the root path; a value such as `"/org/product/"` groups roles under an organization path. It must start and end with `/`; each component may contain letters, digits, `+`, `=`, `,`, `.`, `@`, `_`, or `-`.

Example: `iam_role_path = "/org/aidlc/"`. Choose this at installation when your account requires it. Changing role paths on an existing deployment can replace roles and changes their ARNs.

#### `iam_permissions_boundary_arn`

**Type:** string. **Default:** `""`.

`""` attaches no permissions boundary. An IAM managed-policy ARN attaches that existing boundary to the roles the deployment creates. A boundary limits what role policies can grant; it grants nothing by itself. It must allow the service actions this deployment needs, including any enabled Gateway features.

Example: `iam_permissions_boundary_arn = "arn:aws:iam::111122223333:policy/aidlc-boundary"`. Terraform does not create the policy or validate that its contents permit a working deployment.

### Gateway and runtime access

The following settings change where agent operations run and how their access is checked. On an existing deployment, follow the rollout steps below; enabling every flag in a single apply can break sessions using older runtime versions.

#### `enable_mcp_gateway`

**Type:** bool. **Default:** `false`.

`false` runs the built-in MCP tools inside the agent runtime. `true` serves them through AgentCore Gateway, where every call is checked against a signed execution grant. The standard deployment already uses the required VPC runtime mode; `network_mode` is an internal module input, not another root `.tfvars` variable.

Example: `enable_mcp_gateway = true`. This alone does not remove the runtime role's direct data permissions.

Before enabling it on an existing deployment, stop new starts and retries, let running executions finish or park, then cancel parked and queued executions. Apply, then rewind cancelled work to its current stage (the first stage if none had started) to obtain grants. The deployment script refuses the switch while executions are started, running, or parked; direct Terraform does not perform that safeguard. See [agent runtime architecture](../concepts/architecture.md#agent-runtime).

#### `enable_engine_data`

**Type:** bool. **Default:** `false`.

`false` keeps the runtime's existing direct data clients. `true` routes process state, graph, methodology, blob reads, and broadcasts through the grant-verifying engine-data Lambda; credentials go through the broker and provider review operations through the source-control runtime alias. Requires `enable_mcp_gateway = true`. This prepares grant enforcement but keeps legacy broker request shapes working until enforcement is enabled.

```hcl
enable_mcp_gateway = true
enable_engine_data = true
```

Drain executions as described above before enabling **or disabling** engine-data. When disabling, also stop remaining runtime sessions after apply or let them expire: warm sessions may still call the removed service.

#### `enforce_runtime_grants`

**Type:** bool. **Default:** `false`.

`false` permits legacy-shaped broker requests from old runtimes and logs them as `LEGACY_RUNTIME_REQUEST`; requests carrying the new authority fields are still fully checked. `true` rejects legacy requests and removes the runtime role's direct Neptune, DynamoDB, S3, SSM, WebSocket, and DynamoDB KMS access, along with its unqualified source-control invocation grant. Requires `enable_engine_data = true`.

Example: `enforce_runtime_grants = true` **only after** engine-data is deployed, every core and managed runtime image includes its client, and legacy request counts have drained to zero. Turning it back to `false` restores those direct permissions and legacy compatibility.

#### `runtime_mcp_credentials`

**Type:** string. **Default:** `"allow"`.

`"allow"` permits space/platform custom MCP servers and resolves their secrets into the runtime. `"gateway_only"` refuses direct custom MCP servers and keeps their credentials out of the microVM; customer servers must instead use `mcp_gateway_custom_targets`. It requires `enable_mcp_gateway`, `enable_engine_data`, and `enforce_runtime_grants` all set to `true`.

Example: `runtime_mcp_credentials = "gateway_only"` after those prerequisite rollouts. First remove direct servers and clear their secrets in space/platform settings, register needed Gateway targets, and finish or restart intents that pinned direct servers. Otherwise starts/retries are refused or stages fail. Git tokens and model credentials still reach the runtime. See the [Gateway-only profile](../using-the-platform/customer-mcp-servers.md#gateway-only-profile).

#### `mcp_gateway_custom_targets`

**Type:** map(object). **Default:** `{}` (null is not allowed).

`{}` adds no customer servers. Each entry adds a remote MCP target behind the Gateway and requires `enable_mcp_gateway = true`. Names are 1–32 lowercase letters/digits with single hyphens between them; `aidlc` is reserved. Treat names as immutable because tools are named `<target>___<tool>`.

| Field                          | Allowed values and behavior                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint`                     | Required HTTPS URL for a Streamable HTTP MCP server.                                                                                                                     |
| `description`                  | Optional text describing the target.                                                                                                                                     |
| `auth.type`                    | Required `"oauth"` for client-credentials OAuth or `"api_key"` for API-key injection.                                                                                    |
| `auth.credential_provider_arn` | Required existing AgentCore Identity provider ARN in the deployment account/Region, matching the auth type. Use the returned `bedrock-agentcore` ARN, not an `acps` ARN. |
| `auth.secret_arn`              | Required Secrets Manager ARN returned for that provider's secret. No plaintext credential belongs in this map.                                                           |
| `auth.scopes`                  | OAuth only; defaults to `[]`. At most 100 strings of 1–64 characters; request the scopes your server requires.                                                           |
| `auth.custom_parameters`       | OAuth only; optional token parameters such as `audience` or `resource`. At most 10 entries, non-blank keys of 1–256 characters and values of 1–2048 characters.          |
| `auth.credential_location`     | API key only; `"HEADER"` or `"QUERY_PARAMETER"`. Omit to use the service's default placement.                                                                            |
| `auth.parameter_name`          | API key only; header or query parameter name, e.g. `"X-Api-Key"`.                                                                                                        |
| `auth.prefix`                  | API key only; optional value prefix, e.g. `"Bearer"`.                                                                                                                    |
| `allow.project_ids`            | Required non-empty list of exact space IDs from `/space/<id>`; these spaces may call the target.                                                                         |
| `allow.stage_ids`              | Omit or use `null` for all stages, or a non-empty list of exact workflow stage block IDs.                                                                                |
| `allow.tools`                  | Omit or use `null` for all target tools, or a non-empty list of server tool names without the `<target>___` prefix.                                                      |
| `private_endpoint`             | Omit for a publicly reachable endpoint; otherwise specify exactly one of the private endpoint objects below.                                                             |

For `private_endpoint.managed_vpc_resource`, provide `vpc_identifier`, `subnet_ids`, and `endpoint_ip_address_type` (`"IPV4"` or `"IPV6"`). Optional `security_group_ids` selects the gateway's security groups; omitting it uses the VPC default group. Optional `routing_domain` routes through an intermediate domain, such as an internal load balancer, instead of the target domain. This selects VPC Lattice managed connectivity into your VPC. Alternatively, `private_endpoint.self_managed_lattice_resource` takes the required `resource_configuration_identifier` of an existing Lattice resource configuration. AWS validates the network identifiers and availability.

API-key example; create the Identity provider first and use its returned ARNs:

```hcl
enable_mcp_gateway = true
mcp_gateway_custom_targets = {
  knowledge = {
    endpoint = "https://mcp.example.com/mcp"
    auth = {
      type                    = "api_key"
      credential_provider_arn = "arn:aws:bedrock-agentcore:eu-central-1:111122223333:token-vault/default/apikeycredentialprovider/knowledge"
      secret_arn              = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:knowledge-AbCdEf"
      credential_location     = "HEADER"
      parameter_name          = "X-Api-Key"
    }
    allow = {
      project_ids = ["<space-id>"]
      stage_ids   = ["requirements-analysis"]
      tools       = ["search"]
    }
  }
}
```

For OAuth, use `type = "oauth"` with the provider's `.../oauth2credentialprovider/<name>` ARN, its secret ARN, and the required scopes; omit the API-key placement fields. The [customer MCP guide](../using-the-platform/customer-mcp-servers.md#add-a-target) includes provider creation and both authentication examples.

Only stage sessions can call these targets; discussion and conflict sessions cannot. IDs must match real spaces/stages, lists cannot contain blank values, and the encoded allow rules must stay under 2 KB. The server must be reachable during apply because Gateway synchronizes its tools. Access/endpoint/provider changes apply to running stages on their next call. Sessions already running when the first target is added need a new session to receive the customer-tool entry.

### Notification integrations

#### `notification_events_enabled`

**Type:** bool. **Default:** `false`.

`false` creates no notification bus and publishes no notification feed. `true` creates an EventBridge bus and enables best-effort events for `discussion.message`, `discussion.resolved`, `gate.pending`, and `space.created`. It does not create rules, targets, or a chat integration; configure consumers separately.

Example: `notification_events_enabled = true`. Events may be missed or duplicated, so consumers must deduplicate and reconcile if completeness matters. See [notification events](../using-the-platform/notification-events.md).

#### `notification_event_bus_name`

**Type:** string. **Default:** `""`.

When notifications are enabled, `""` creates `<project_name>-<environment>-events`. Otherwise supply 1–256 letters, digits, dots, underscores, or hyphens for the bus to create. This names a Terraform-managed bus; it does not automatically adopt an existing bus. Ignored while notifications are disabled.

Example: `notification_event_bus_name = "team-aidlc-events"`. Changing it requires consumers to use the new bus.

#### `notification_event_source`

**Type:** string. **Default:** `"collaborative-ai-dlc"`.

The `source` value on notification events, used in EventBridge rule patterns. Allowed: 1–256 letters, digits, dots, underscores, or hyphens, without the reserved `aws.` prefix. It affects published events only when notifications are enabled.

Example: `notification_event_source = "com.example.aidlc"`. Match the same string in your rules; changing it without updating consumers stops those rules matching new events.

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

    These commands permanently delete all application data including DynamoDB tables, Neptune databases, and S3 buckets. This action cannot be undone. Interactive runs require typing the environment name; use `--yes` only for deliberate non-production automation.

Both paths back up Terraform state before destruction. By default, backups are saved in `~/.local/share/collaborative-ai-dlc/backups/`. If `XDG_DATA_HOME` is set, it replaces `~/.local/share` in that path. For standalone runs, `AIDLC_BACKUP_DIR` overrides the entire backup path. The backend state bucket is retained.

Both automated paths refuse an effective `prod` environment, including a differently named tfvars file whose `environment` value is `prod`. Direct `terraform destroy` is intentionally blocked while deletion protection remains enabled.

Production removal is a break-glass operation:

1. Create and verify independent backups of all durable data.
2. Empty every versioned application S3 bucket, including object versions and delete markers.
3. Create a saved Terraform plan with `deletion_protection=false` and `skip_final_snapshot=false`.
4. Have an independent reviewer verify that the plan contains only the intended protection updates, then apply that exact saved plan.
5. Run a separately reviewed Terraform destroy with the same variables.

Emptying the buckets before removing database protection prevents a teardown from deleting DynamoDB and Neptune and then failing on production buckets whose `force_destroy` setting is deliberately disabled.

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

**CloudFront VPC Origin fails with `Block Public Access enabled`**

```
Error: waiting for CloudFront VPC Origin (vo_…) create
unexpected state 'Failed : You can't update an endpoint group that has
endpoints in a subnet with Block Public Access enabled. …'
```

The account enables [VPC Block Public Access](https://docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html), and CloudFront VPC origins cannot reach the internal Yjs ALB in subnets it covers. Check the account mode with `aws ec2 describe-vpc-block-public-access-options`. If `ExclusionsAllowed` is `allowed`:

1. Set the following in your environment's `.tfvars`:

   ```hcl
   vpc_block_public_access_exclusion = true
   ```

2. Delete the failed VPC Origin, as described in the next entry. The failed create left it tainted, and until it is gone every re-run fails with `EntityAlreadyExists`.
3. Re-run the deployment.

This works in both Block Public Access modes (`block-ingress` and `block-bidirectional`) and creates two kinds of exclusion:

- **Bidirectional** for the two private subnets. They route through the NAT gateway, never an internet gateway, and the ALB security group still admits only the CloudFront origin-facing prefix list, so this opens no new path from the internet.
- **Egress-only** for the public subnets that hold the NAT gateways. In `block-bidirectional` mode Block Public Access also blocks NAT gateways, which the private subnets need to pull images and reach AWS APIs. Inbound internet traffic to those subnets stays blocked, and in `block-ingress` mode this exclusion has no effect.

If an organization policy disallows exclusions, ask its administrator for these exclusions.

**Re-running after a failed VPC Origin fails with `EntityAlreadyExists`**

```
Error: creating CloudFront VPC Origin
… EntityAlreadyExists: Another vpc origin with the same name already exists within the aws account.
```

A failed VPC Origin create leaves the resource tainted. Terraform then creates its replacement before deleting the failed one, and VPC Origin names are unique per account, so the replacement collides. Delete the failed origin only when no CloudFront distribution uses it. On a first deployment none does yet.

Run the commands from the repository root with the same AWS credentials (profile and region) as the failed deployment. Set `ENVIRONMENT` to the environment that failed, and keep any `AIDLC_CONFIG_DIR` or `AIDLC_BACKEND_FILE` override it used, so Terraform reads that environment's state:

```bash
ENVIRONMENT=dev
BACKEND_FILE="${AIDLC_BACKEND_FILE:-${AIDLC_CONFIG_DIR:-$PWD/terraform}/environments/${ENVIRONMENT}.s3.tfbackend}"
if ! terraform -chdir=terraform init -reconfigure -backend-config="$BACKEND_FILE"; then
  echo "terraform init failed for ${ENVIRONMENT}; not looking up or deleting anything." >&2
else
  VPC_ORIGIN_ID=$(terraform -chdir=terraform state show -no-color 'module.frontend.aws_cloudfront_vpc_origin.yjs_alb[0]' | awk '$1 == "id" { gsub(/"/, "", $3); print $3 }')
  if [ -z "$VPC_ORIGIN_ID" ]; then
    echo "No VPC origin in the ${ENVIRONMENT} state; nothing to delete." >&2
  elif ! USED_BY=$(aws cloudfront list-distributions --output text \
      --query "(DistributionList.Items || \`[]\`)[?Origins.Items[?VpcOriginConfig.VpcOriginId=='${VPC_ORIGIN_ID}']].Id | join(' ', @)"); then
    echo "Could not list CloudFront distributions; not deleting ${VPC_ORIGIN_ID}." >&2
  elif [ -n "$USED_BY" ]; then
    echo "VPC origin ${VPC_ORIGIN_ID} is still used by distribution ${USED_BY}; not deleting it." >&2
  else
    ETAG=$(aws cloudfront get-vpc-origin --id "$VPC_ORIGIN_ID" --query ETag --output text) &&
      aws cloudfront delete-vpc-origin --id "$VPC_ORIGIN_ID" --if-match "$ETAG"
  fi
fi
```

If the commands report a distribution, the origin is in use and deleting it would break that distribution, so leave it in place. Otherwise, wait until `aws cloudfront get-vpc-origin --id "$VPC_ORIGIN_ID"` returns `EntityNotFound` (several minutes), then re-run the deployment for the same environment, with the same options (`--var`, `--auth-mode`, `--sso-config`) and overrides as the failed run:

```bash
./scripts/deploy-terraform.sh "$ENVIRONMENT"
```

Terraform notices the origin is gone, drops it from state, and creates a fresh one. A permanent fix is tracked in [#648](https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/648).

**Frontend shows authentication errors**

Verify User Pool ID and App Client ID match Terraform outputs, and that the user exists in the correct group.

**Provider integration not working (GitHub, GitLab, or Jira)**

In the deployed app, open **Admin → Trackers**. Each provider should show **Configured**; if it shows **Not configured**, finish the OAuth-app setup and paste the credentials. Also confirm the OAuth app's **Authorization callback URL** matches the value shown in that provider's setup guide — provider apps reject mismatched callbacks at sign-in time.

**Custom domain returns a certificate or DNS error**

The browser showing a certificate warning, or the hostname not resolving, means the deployment applied but DNS is not pointing at the distribution yet. Compare what your DNS returns with:

```bash
terraform -chdir=terraform output -raw dns_target
```

The CloudFront domain keeps working throughout, so use `terraform -chdir=terraform output -raw cloudfront_domain_name` to reach the app while sorting DNS out. Note that requests through the CloudFront domain are still accepted by CORS, but the Admin page will flag that you are not on the canonical hostname.

**Custom domain apply fails with `CNAMEAlreadyExists`**

Another CloudFront distribution, possibly in a different AWS account, already claims the hostname. CloudFront aliases are globally unique. Remove it there first. The installer checks for this before applying; a direct `terraform apply` does not.

**Removing a domain fails with `ResourceInUseException` deleting the ACM certificate**

```
Error: deleting ACM Certificate (arn:aws:acm:us-east-1:…): ResourceInUseException:
Certificate arn:aws:acm:us-east-1:… in account … is in use.
```

CloudFront releases a certificate asynchronously, so ACM can still report it as in use for several minutes after the distribution reports `Deployed`. The apply now waits that out before attempting the delete, so this should not occur on a current version.

If you hit it on an older version, the important part already succeeded: the distribution was updated first, so the aliases are gone and the deployment is back on the CloudFront domain. Only the certificate is left behind. Either wait for the release to propagate and re-run the deployment, which retries just the delete:

```bash
./scripts/deploy-terraform.sh dev
```

Or, if you would rather not wait, drop it from state and delete it out of band later — an unused certificate costs nothing:

```bash
terraform -chdir=terraform state rm 'module.domain.aws_acm_certificate.this[0]'
aws acm delete-certificate --certificate-arn <arn> --region us-east-1   # once released
```

**GitLab connections break after changing the domain**

Expected. GitLab requires `redirect_uri` on the refresh-token grant and it must match the original authorization request, so a changed canonical hostname invalidates every stored GitLab refresh token. Each user has to reconnect GitLab once.
