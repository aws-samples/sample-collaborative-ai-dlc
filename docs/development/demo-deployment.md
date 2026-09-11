# Demo release deployment

The release workflow deploys every published release to the AWS demo account.
It calls the reusable **Deploy Demo** workflow after creating the immutable
release tag and GitHub Release. The reusable workflow can also deploy an
existing release tag manually.

The GitHub deployment environment is named `demo`. The existing Terraform
logical environment remains `prod`; changing it would rename or replace
resources already recorded in the remote state.

## Configure the GitHub environment

In the repository, open **Settings → Environments** and create an environment
named `demo`. Configure all of these protection settings before granting the
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

Create a trust policy scoped to this repository and the `demo` GitHub
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
        "token.actions.githubusercontent.com:sub": "repo:aws-samples/sample-collaborative-ai-dlc:environment:demo"
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

Attach the customer-managed policy currently used for manual Terraform
deployments:

```bash
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "<terraform-deployment-policy-arn>"
```

The policy must cover every service managed by the stack, including IAM role
and policy management, `iam:PassRole`, Lambda, API Gateway, Cognito, EC2,
Elastic Load Balancing, ECS, ECR, S3, DynamoDB, Neptune, CloudFront, CloudWatch,
EventBridge, SQS, Secrets Manager, Systems Manager, and Bedrock AgentCore.

Do not attach `AdministratorAccess` as a bootstrap policy. Keep deployment
disabled until a reviewed customer-managed policy is available; an approval
mistake must not grant the workflow unrestricted control of the account.

## Verify before enabling automatic deployment

Before publishing the first release, confirm that the `demo` environment has
the required reviewers, self-review prevention, administrator bypass disabled,
and the `main` deployment branch rule. Also confirm that the `v*` tag ruleset
is active and the deployment role has the reviewed customer-managed policy.

Every published release then waits for an independent approval, creates a
Terraform plan, applies that exact saved plan, deploys the frontend, and
verifies the application URL. Plans stay on the runner and are not uploaded as
artifacts because Terraform plans can contain sensitive values.
