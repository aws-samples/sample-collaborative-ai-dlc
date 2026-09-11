# Demo deployments

The release workflow deploys every published release to the AWS demo account.
It calls the reusable **Deploy Demo** workflow after creating the immutable
release tag and GitHub Release. The reusable workflow can also deploy an
existing release tag manually.

The **Deploy Main Demo** workflow deploys every commit pushed to `main` through
the same reusable workflow. It uses an immutable commit SHA, a separate GitHub
Environment, Terraform state key, AWS region, and project namespace so it can
coexist with the release demo in the same AWS account.

The release GitHub deployment environment is named `demo-release`. Its existing
Terraform logical environment remains `prod`; changing it would rename or
replace resources already recorded in the remote state. The main demo also
uses the `prod` logical environment to retain production capacity, retention,
and deletion behavior, but changes `project_name` to
`collaborative-ai-dlc-main` to isolate account-global resource names.

## Configure the GitHub environment

In the repository, open **Settings → Environments** and create an environment
named `demo-release`. Configure all of these protection settings before granting the
deployment role access to the AWS account:

1. Under **Deployment protection rules**, add the `collaborative-ai-dlc` team
   (or at least two maintainers) as required reviewers.
2. Enable **Prevent self-review** so the person who starts a release cannot
   approve its deployment.
3. Disable administrator bypass for the protection rules.
4. Under **Deployment branches and tags**, choose **Selected branches and
   tags**, add `main`, and save the rule.

Both release-triggered and manually triggered deployments wait for this
approval. The workflow then verifies that the requested annotated release tag
resolves to a commit reachable from `main` before requesting AWS credentials.

Add these **environment variables**:

| Variable          | Value                                            |
| ----------------- | ------------------------------------------------ |
| `AWS_ACCOUNT_ID`  | The 12-digit demo AWS account ID                 |
| `AWS_REGION`      | `eu-west-1`                                      |
| `AWS_ROLE_ARN`    | ARN of the OIDC deployment role created below    |
| `BEDROCK_MODEL`   | `eu.anthropic.claude-sonnet-4-6`                 |
| `TF_STATE_BUCKET` | Name of the existing demo Terraform state bucket |
| `TF_STATE_KEY`    | `terraform.tfstate`                              |
| `TF_STATE_REGION` | `eu-west-1`                                      |

No GitHub secrets are required for the current deployment. OIDC replaces
long-lived AWS access keys, and the current Terraform variables contain no
credentials. Do not create `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`
secrets. Application credentials continue to live in AWS Secrets Manager or
Systems Manager Parameter Store.

The workflow generates `prod.tfvars` and `prod.s3.tfbackend` in the runner's
temporary directory. It never runs `bootstrap.sh` and therefore never creates
or selects a new state bucket.

The job also sets `TF_RECREATE_MISSING_LAMBDA_PACKAGE=false`. GitHub-hosted
runners start without the Lambda archives referenced by remote Terraform state;
the Lambda module otherwise treats every missing local archive as a
timestamp-driven rebuild.

The workflow uses a draft plan to generate the Lambda module's package plans,
builds every content-addressed ZIP, removes the generated `lambda/*/.build`
directories, and then creates the final saved Terraform plan. The final plan
therefore hashes the clean release source while the referenced ZIPs already
exist. Apply reuses those exact packages, so neither missing files nor changed
source hashes can invalidate the saved plan. Source changes still produce and
deploy new content-addressed archives.

## Configure the continuous main demo

The main deployment is intentionally a separate target rather than another
view of the release state. Before enabling `.github/workflows/deploy-main.yml`,
create a GitHub Environment named `demo-main` and restrict its deployment
branches to `main`. Required reviewers are optional: adding them makes every
push wait for approval; omitting them makes deployment continuous after a push
lands on protected `main`.

Provision the dedicated Terraform state bucket and `demo-main` deployment role
through the account's normal administrative process before configuring the
GitHub Environment. The state bucket and application deployment both use
`eu-central-1`; the manual IAM and state requirements are documented below.

Add these environment variables to `demo-main`:

| Variable          | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`  | The same 12-digit demo AWS account ID                           |
| `AWS_REGION`      | `eu-central-1`                                                  |
| `AWS_ROLE_ARN`    | ARN of the main-demo OIDC deployment role described below       |
| `BEDROCK_MODEL`   | A Bedrock inference profile available in the application region |
| `TF_STATE_BUCKET` | The existing demo state bucket, or a dedicated state bucket     |
| `TF_STATE_KEY`    | `main/terraform.tfstate`                                        |
| `TF_STATE_REGION` | The state bucket's region; this may differ from `AWS_REGION`    |

The workflow supplies the isolation values itself:

- Terraform `environment = "prod"`, preserving production behavior.
- Terraform `project_name = "collaborative-ai-dlc-main"`, isolating IAM roles,
  CloudFront functions and origin controls, SSM paths, Lambda functions, and
  other fixed names that are account-global or otherwise shared across regions.
- `ref_type = "commit"`, requiring the full immutable commit SHA and verifying
  that it is reachable from `main` before requesting AWS credentials.

Do not reuse `terraform.tfstate`: changing the provider region in the release
state would plan replacement of the release deployment rather than a second
stack. Sharing the bucket is safe when the key and lock-file permissions are
separate.

### Create or update the main-demo deployment role

Reuse the account's existing GitHub Actions OIDC provider, but prefer a separate
role for the continuous deployment. Its trust policy must use the protected
GitHub Environment subject:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:aws-samples/sample-collaborative-ai-dlc:environment:demo-main"
    }
  }
}
```

Use the same deployment policy as the release demo, described in
[Grant deployment permissions](#grant-deployment-permissions), on the separate
main-demo role. If a customer-managed policy restricts `aws:RequestedRegion` or
contains region-qualified ARNs, add the main demo's application region. IAM and
CloudFront permissions remain account-global.

Grant the role access to the chosen backend bucket and only the new state
objects (plus `s3:GetBucketLocation` and `s3:ListBucket` on the bucket):

```text
arn:aws:s3:::<state-bucket>/main/terraform.tfstate
arn:aws:s3:::<state-bucket>/main/terraform.tfstate.tflock
```

The state object needs `s3:GetObject` and `s3:PutObject`; the lock object also
needs `s3:DeleteObject`. Add KMS permissions when the backend bucket uses a
customer-managed key.

### Check regional and application prerequisites

Before the first deployment:

1. Choose a region present in the AgentCore VPC AZ map in
   `terraform/modules/compute/agentcore/main.tf`, or explicitly configure its
   supported AZ IDs.
2. Confirm the selected Bedrock inference profile is available there. Bedrock
   API keys are regional; enable the OpenAI models in that region when using
   Codex.
3. Check regional quotas for VPCs, elastic IPs/NAT gateways, Neptune,
   Fargate/ECS, Lambda, ECR, and Bedrock AgentCore, plus account quotas for IAM
   roles and CloudFront resources.
4. Use a distinct custom hostname, or leave the main demo on its generated
   CloudFront hostname. A CloudFront alias cannot belong to both deployments.
5. After deployment, configure the new region's users, agent credentials,
   source-control credentials, and tracker credentials. OAuth providers must
   accept the main demo's distinct callback URL; some providers require a
   separate OAuth application.

## Protect release tags

Open **Settings → Rules → Rulesets**, create a tag ruleset for `v*`, and set
its enforcement status to **Active**. Enable rules that restrict updates and
deletions and block force pushes. Leave tag creation unrestricted so the
release workflow's `GITHUB_TOKEN` can create each new version tag.

This makes existing release tags immutable. The separate reachability check in
the deployment workflow ensures that even a newly created release tag can only
deploy code that has passed through `main`.

## Create the AWS OIDC provider

An AWS account has at most one IAM OIDC provider for GitHub Actions. Reuse it
if `token.actions.githubusercontent.com` is already configured.

```bash
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export OIDC_PROVIDER_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"

aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" >/dev/null 2>&1 ||
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

For an existing provider, verify that its client ID list includes
`sts.amazonaws.com`.

## Create the deployment role

Create a trust policy scoped to this repository and the `demo-release` GitHub
Environment. The environment condition is important: pull requests and jobs
that do not pass the environment's protection rules cannot assume the role.

```bash
export ROLE_NAME="CollaborativeDemoGitHubDeploy"

cat > /tmp/collaborative-demo-github-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "$OIDC_PROVIDER_ARN"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:aws-samples/sample-collaborative-ai-dlc:environment:demo-release"
      }
    }
  }]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document file:///tmp/collaborative-demo-github-trust.json
  aws iam update-role \
    --role-name "$ROLE_NAME" \
    --max-session-duration 10800
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --max-session-duration 10800 \
    --assume-role-policy-document file:///tmp/collaborative-demo-github-trust.json
fi

aws iam get-role \
  --role-name "$ROLE_NAME" \
  --query 'Role.Arn' \
  --output text
```

Use the returned ARN as the GitHub `AWS_ROLE_ARN` environment variable.

## Grant access to the existing state

The role must be able to read and update the existing state and its native S3
lock file. Substitute the same bucket and key configured in GitHub:

```bash
export TF_STATE_BUCKET="<existing-state-bucket>"
export TF_STATE_KEY="terraform.tfstate"

cat > /tmp/collaborative-demo-state-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTerraformState",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": "arn:aws:s3:::$TF_STATE_BUCKET"
    },
    {
      "Sid": "ReadWriteTerraformState",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::$TF_STATE_BUCKET/$TF_STATE_KEY"
    },
    {
      "Sid": "LockTerraformState",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$TF_STATE_BUCKET/$TF_STATE_KEY.tflock"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name CollaborativeDemoTerraformState \
  --policy-document file:///tmp/collaborative-demo-state-policy.json
```

If the bucket uses a customer-managed KMS key, also grant the role
`kms:Decrypt`, `kms:Encrypt`, and `kms:GenerateDataKey` for that key.

## Grant deployment permissions

The maintained demo account currently attaches AWS-managed
`AdministratorAccess` (`arn:aws:iam::aws:policy/AdministratorAccess`) to both
deployment roles:

| GitHub Environment | IAM role                            |
| ------------------ | ----------------------------------- |
| `demo-release`     | `CollaborativeDemoGitHubDeploy`     |
| `demo-main`        | `CollaborativeMainDemoGitHubDeploy` |

Each role trusts only its corresponding GitHub Environment. The main demo
mirrors the existing release deployment permissions; it does not require a
broader policy than the release demo.

This documents the current demo account configuration. `AdministratorAccess`
is not required simply because Terraform creates IAM roles or CloudFront
resources. A reviewed customer-managed policy can grant the necessary service
permissions while restricting role management and `iam:PassRole` to application
roles. Permissions boundaries on those roles can limit the permissions the
deployment is allowed to delegate. Developing and validating that policy is
separate hardening work.

For other accounts, prefer a reviewed customer-managed deployment policy.
Attach the policy deliberately selected for the account:

```bash
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "<terraform-deployment-policy-arn>"
```

The policy must cover every service managed by the stack, including IAM role
and policy management, `iam:PassRole`, Lambda, API Gateway, Cognito, EC2,
Elastic Load Balancing, ECS, ECR, S3, DynamoDB, Neptune, CloudFront, CloudWatch,
EventBridge, SQS, Secrets Manager, Systems Manager, and Bedrock AgentCore.

`AdministratorAccess` grants permissions for all AWS actions on all resources,
including resources unrelated to the deployment. Retaining it in the maintained
demo account is an explicit permissions choice. Scoped state policies and
separate project names do not reduce the permissions granted by that policy.

## Verify before enabling automatic deployment

Before publishing the first release, confirm that the `demo-release` environment has
the required reviewers, self-review prevention, administrator bypass disabled,
and the `main` deployment branch rule. Also confirm that the `v*` tag ruleset
is active and the deployment role has the selected deployment policy, with its
scope reviewed for the account.

Every published release then waits for an independent approval, creates a
Terraform plan, applies that exact saved plan, deploys the frontend, and
verifies the application URL. Plans stay on the runner and are not uploaded as
artifacts because Terraform plans can contain sensitive values.
