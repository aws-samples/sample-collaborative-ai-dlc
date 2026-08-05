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

For a managed install or update behind an HTTP proxy, export the proxy settings
before downloading or running the installer:

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

The installer passes non-empty standard proxy variables, including lowercase
variants, to both Docker Buildx builds. It adds no proxy build arguments in a
non-proxy environment. Set `TF_VAR_docker_build_args` to a JSON object to
override auto-detection. These values are hidden in Terraform CLI output but
remain in saved plans and Terraform state, so protect both and keep the backend
encrypted and access-restricted.

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

### Custom domain

Entirely optional. Without it the application is served on the CloudFront-assigned `*.cloudfront.net` domain, which needs no certificate and no DNS.

Every public path — the SPA, `/api/*`, `/ws` and `/yjs/*` — is served by a single CloudFront distribution, so a custom domain needs exactly one certificate and one distribution change. There is no API Gateway custom domain or load balancer certificate to configure. Enterprise SSO uses a separate Cognito managed-login domain for federation; it does not serve the application.

The certificate **must be in `us-east-1`** regardless of the deployment region, because CloudFront accepts viewer certificates from no other region.

#### Bring your own certificate

For centrally managed, imported, wildcard or private-CA certificates, and for DNS that lives outside Route53 or in another AWS account. The certificate must already be `ISSUED`.

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

Requires the Route53 hosted zone to be in the same account. Terraform requests the certificate, publishes the validation records, waits for issuance, and creates the A/AAAA alias records.

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

### Enterprise SSO

OIDC and SAML federation, including Microsoft Entra ID and Okta, is configured
at deployment time rather than in the Admin UI. See [Enterprise SSO](enterprise-sso.md)
for the installer bootstrap sequence, provider files, and authoritative role
mapping.

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
# For a custom domain, also set app_domain plus either acm_certificate_arn or
# route53_zone_id — see "Custom domain → Without the installer" above.
./scripts/deploy-terraform.sh dev
./scripts/deploy-frontend.sh dev
```

Unlike the managed installer, nothing here rewrites `dev.tfvars` for you — it is yours to edit, and the scripts only read it.

To review a saved plan before applying:

Export proxy variables before running `--phase plan`. Terraform resolves
`TF_VAR_docker_build_args` while planning and stores the value in the saved
plan, so exporting or changing proxy variables before `--phase apply` has no
effect.

```bash
./scripts/deploy-terraform.sh dev --phase plan --plan-file /tmp/aidlc-dev.tfplan
./scripts/deploy-terraform.sh dev --phase apply --plan-file /tmp/aidlc-dev.tfplan
```

The plan is rejected if it would destroy a Cognito user pool, Neptune cluster, S3 bucket, or DynamoDB table. The check runs in both phases, so a saved plan is re-inspected before it is applied.

Manual deployments honor the same proxy variables documented for the managed
installer. You can also define `docker_build_args` in the `.tfvars` file.

The deployment takes 15-30 minutes. Neptune DB cluster creation takes the longest.

These environment variables are useful when iterating:

| Variable              | Effect                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AIDLC_SKIP_NPM_CI=1` | Skips the root `npm ci` before planning. Saves a lot of time on repeat runs when dependencies are current. |
| `AIDLC_KEEP_PLAN=1`   | Keeps the plan file after a successful apply instead of deleting it.                                       |
| `AIDLC_TFVARS_FILE`   | Path to an alternative `.tfvars`, overriding the `<environment>.tfvars` convention.                        |
| `AIDLC_BACKEND_FILE`  | Path to an alternative `.s3.tfbackend`.                                                                    |
| `AIDLC_CONFIG_DIR`    | Directory holding `environments/`, if you keep Terraform configuration outside the checkout.               |

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

### Configure provider OAuth apps

The platform integrates with external providers as code hosts (GitHub, GitLab, Bitbucket) and issue trackers (GitHub Issues, GitLab Issues, Jira Cloud) so an intent can be started from a tracker issue. For each provider you want to enable, register an OAuth app and paste the credentials into **Admin → Trackers** in the deployed app.

For GitHub and GitLab a single OAuth app serves both the code host and that provider's issue tracker. Jira Cloud is a tracker only. All providers are optional — skip a section if you don't need that provider; the corresponding **Connect** buttons in the UI stay disabled with a hint pointing to this admin panel.

`<your-app-domain>` below is the deployment's canonical hostname: the custom domain when one is configured, otherwise the CloudFront domain. The Admin page shows it at the top and each provider's setup guide shows the exact callback URL to paste, so copying from there is safer than assembling it by hand. Retrieve it directly with:

```bash
terraform -chdir=terraform output -raw application_domain
```

#### GitHub (code host + GitHub Issues)

Configure OAuth and GitHub App independently. They remain enabled simultaneously, and each project chooses its authentication type.

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

1. Create a [GitHub App](https://github.com/settings/apps) with repository permissions **Contents: Read & write**, **Pull requests: Read & write**, **Issues: Read & write**, and metadata read access. No callback URL or webhook is needed. **Workflows: Read & write** is recommended but optional — without it a binding still verifies, but the agent cannot create or modify files under `.github/workflows/` and the project settings page shows a warning.
2. Generate a **private key** (PEM) and note the **App ID**.
3. Install the App on each personal account or organization whose repositories projects may bind.
4. In the deployed app, open **Admin → Source Control → GitHub**, paste the App ID and private key, then click **Save**. Installation IDs are discovered per repository when a project is bound.

### Project-bound source control

Existing projects must be explicitly bound by an owner/admin before intents can run against their repositories. During a credential incident, invalidate the affected project bindings (or revoke the token at the provider) — unbound or invalid bindings block repository-backed starts via the launch guard.

#### GitLab (code host + GitLab Issues)

1. Open [GitLab → User Settings → Applications](https://gitlab.com/-/user_settings/applications) → **Add new application**.
2. Set:
   - **Redirect URI**: `https://<your-app-domain>/gitlab/callback`
   - **Scopes**: `api` and `read_user`
   - Leave **Confidential** enabled.
3. Save, then copy the **Application ID** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Trackers → GitLab Issues**. Paste both values and click **Save**.

GitLab's `api` scope includes repository writes, including changes to `.gitlab-ci.yml`; there is no separate workflow-file scope. Connections missing `api` are reported as requiring reauthorization.

#### Bitbucket (code host)

1. Open **Bitbucket → Workspace settings → OAuth consumers → Add consumer**.
2. Set:
   - **Callback URL**: `https://<your-cloudfront-domain>/bitbucket/callback`
   - **Permissions**: Account (Read, Email), Repositories (Read & Write), Pull requests (Read & Write).
   - Leave **This is a private consumer** enabled.
3. Save, then copy the **Key** (Client ID) and **Secret**.
4. In the deployed app, sign in and open **Admin → Source Control → Bitbucket**. Paste both values and click **Save**.

Bitbucket OAuth scopes are the singular scope names (`account`, `email`, `repository`, `repository:write`, `pullrequest`, `pullrequest:write`), requested automatically by the platform. The `email` scope is required for commit attribution — enable the **Email** permission on the consumer, otherwise the connection is reported as needing reauthorization. Bitbucket access tokens are short-lived (~2h); the engine refreshes them just-in-time from the stored refresh token, so long-running construction jobs keep a valid token and users don't need to reconnect periodically.

#### Jira Cloud

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps) and create an **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** with scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `offline_access` (required for refresh tokens — don't skip)
3. Under **Authorization**, set the callback URL to `https://<your-app-domain>/trackers/callback/jira-cloud`.
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

All commands in this section run from the repository root.

### Install dependencies

Only needed for local development — `deploy-frontend.sh` runs `npm ci` itself.

```bash
npm --prefix frontend install
```

### Configure environment variables

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

### Deploy to S3 and CloudFront

```bash
./scripts/deploy-frontend.sh dev
```

This regenerates `.env`, builds the frontend, uploads it to S3, and invalidates the CloudFront cache.

### Access the application

```bash
terraform -chdir=terraform output -raw application_url
```

Open the domain in your browser to reach the sign-in page.

## Local frontend development

For iterating on the frontend locally while connected to the deployed AWS backend:

```bash
./scripts/generate-env.sh dev
npm --prefix frontend run dev
```

This starts the Vite development server on `http://localhost:5173`, calling the deployed API, WebSocket and Yjs endpoints. `http://localhost:5173` is already in the CORS allowlist, alongside the deployment's own hostnames.

Two things to expect on a deployment with a custom domain:

- The **Admin** page reports that you are not on the canonical hostname. That is correct and intentional: the OAuth callback URLs it shows are the deployed ones, because those are what the backend actually sends to providers. Paste those, not a `localhost` variant.
- Provider OAuth flows cannot complete against a local dev server, since the provider redirects the browser to the deployed callback URL. Connect your accounts in the deployed app instead; the tokens are stored per user server-side, so your local session picks them up.

## Updating a deployment

For managed installations, run `bash /tmp/aidlc-install.sh update`. It creates a Terraform state backup and applies the release safeguards automatically.

For advanced manual installations:

| What changed                    | Command                             |
| ------------------------------- | ----------------------------------- |
| Backend (Lambda, agents, infra) | `./scripts/deploy-terraform.sh dev` |
| Frontend only                   | `./scripts/deploy-frontend.sh dev`  |
| Custom domain                   | both, in that order                 |

A domain change needs both steps: Terraform updates the distribution and the OAuth redirect URIs, then the frontend has to be rebuilt because the endpoint URLs are inlined into the bundle at build time.

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
