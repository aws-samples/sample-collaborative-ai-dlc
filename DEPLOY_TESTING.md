# Level 3 — Full End-to-End Deployment & Bitbucket Test Guide

Complete AWS deployment of AIDLC Collaborative from the `feature/bitbucket-support` branch, then exercise the new Bitbucket Cloud provider end-to-end through the deployed UI.

> ⚠️ **Cost warning:** This provisions real AWS infrastructure, including an Amazon Neptune cluster and ECS/Fargate services, which bill while running. Always run `./scripts/destroy.sh dev` when finished (Step 9).

> ℹ️ All commands below are verified against the actual repo scripts (`scripts/*.sh`) and Terraform layout — not the public docs, which describe a different `terraform/environments/<env>/` structure this repo does not use.

---

## Prerequisites

- [ ] **AWS credentials** with broad permissions (VPC, Neptune, ECS/Fargate, Lambda, API Gateway, Cognito, S3, CloudFront, DynamoDB, IAM, Secrets Manager, ECR, EventBridge).
- [ ] **AWS CLI v2** with a configured profile.
- [ ] **Amazon Bedrock model access** enabled in **us-east-1** for the pinned model (`us.anthropic.claude-sonnet-4-6`) — the agents use it. (Or a Kiro CLI API key; see Step 6.)
- [ ] **Terraform**, **Node.js**, and **Docker/Podman** (the deploy builds & pushes agent/yjs container images to ECR — a working container runtime must be running).
- [ ] Region is **us-east-1** (hardcoded in `bootstrap.sh` and the tfvars default).
- [ ] On the right branch: `bash cd /Users/smoell/development/kiro/sample-collaborative-ai-dlc git checkout feature/bitbucket-support git rev-parse --abbrev-ref HEAD # -> feature/bitbucket-support export AWS_PROFILE=<your-profile>`

---

## Step 1 — Bootstrap the Terraform state backend (once)

Creates a versioned S3 state bucket and writes `terraform/environments/dev.s3.tfbackend`.

```bash
./scripts/bootstrap.sh dev

```

---

## Step 2 — Create the tfvars file

The repo uses a **flat** file `terraform/environments/dev.tfvars` (not a per-env folder). Copy the example and adjust if needed:

```bash
cp terraform/environments/dev.tfvars.example terraform/environments/dev.tfvars

```

The example contains exactly these variables (all that exist — there is **no** `vpc_cidr`, `neptune_instance_class`, or `agent_pool_size`):

```hcl
environment   = "dev"
aws_region    = "us-east-1"
bedrock_model = "us.anthropic.claude-sonnet-4-6"

```

Optional extra variables you _may_ add (they have defaults in `terraform/variables.tf`): `project_name` (default `collaborative-ai-dlc`), `git_author_name`, `git_author_email`.

---

## Step 3 — Deploy the infrastructure (15–30 min)

Runs `npm ci`, `terraform init` (with the bootstrapped backend), `plan`, and `apply`. Neptune creation dominates the time; the script also builds and pushes the agent and yjs-server container images, so your Docker/Podman runtime must be up.

```bash
./scripts/deploy-terraform.sh dev

```

---

## Step 4 — Register the Bitbucket OAuth consumer

You need the CloudFront domain for the callback URL. Get it now:

```bash
cd terraform
terraform output -raw cloudfront_domain_name
cd ..

```

In Bitbucket: **Workspace settings → OAuth consumers → Add consumer**:

- **Callback URL:** `https://<cloudfront-domain>/bitbucket/callback`
- **Permissions:** Account: Read · Repositories: Read, Write · Pull requests: Read, Write (OAuth scopes: `account repository repository:write pullrequest pullrequest:write`)
- Save, then copy the **Key (Client ID)** and **Secret**.

Store the credentials in the secret Terraform created:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(cd terraform && terraform output -raw bitbucket_oauth_secret_name)" \
  --secret-string '{"client_id":"<KEY>","client_secret":"<SECRET>"}'

```

> Or do this later in the app under **Admin → Tracker OAuth Apps → Bitbucket**.

---

## Step 5 — Create a Cognito user

```bash
cd terraform
USER_POOL_ID=$(terraform output -raw user_pool_id)
cd ..

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.com \
  --group-name owner

```

Groups: `member` (view/edit, run agents) · `approver` (+ approve phase transitions) · `owner` (full access).

---

## Step 6 — Configure agent authentication

The sprint/construction flow runs coding agents. Authenticate them with **either**:

- **Bedrock** — ensure Bedrock model access is enabled in us-east-1 (the `bedrock_model` in tfvars), or
- a **Kiro CLI API key** — enter it in the app (Step 8) or via the path in `docs/getting-started/setup.md`.

Confirm agents are ready via the agent-pool DynamoDB table or the ECS task logs. (Not required for the Bitbucket read/PR tests themselves.)

---

## Step 7 — Deploy the frontend

`deploy-frontend.sh` auto-generates `frontend/.env` from Terraform outputs (via `generate-env.sh`) — **no manual .env editing needed** — then builds, uploads to S3, and invalidates CloudFront.

```bash
./scripts/deploy-frontend.sh dev

```

Open the app:

```bash
cd terraform
terraform output -raw cloudfront_domain_name
cd ..

```

---

## Step 8 — Sign in and verify Bitbucket is wired

1. Open `https://<cloudfront-domain>` and sign in with the Cognito user.
2. **Admin → Tracker OAuth Apps** → confirm **Bitbucket** shows **Configured** (if not, paste the client id/secret here and save; also confirm the callback URL matches).

---

## Step 9 — Exercise the Bitbucket provider end-to-end

1. **Create Project** → **Choose git provider → Bitbucket**.
2. **Connect Bitbucket** → authorize on bitbucket.org → back via `/bitbucket/callback`.
3. Confirm your repositories load in the picker — this exercises `listRepos` with a real OAuth token (the two-step workspace-scoped flow the fix introduced for CHANGE-2770).
4. Pick `unicorn-store-spring`, name the project, create it.
5. Confirm the file browser lists files (`getTree` / `getFileContents`) and branches (`listBranches`).
6. Start a sprint; when a change request is produced, confirm a **Pull request** is created in Bitbucket (`createPullRequest`) and that PR comments work.

**Watch specifically for the fixed behaviours:**

- Repo listing succeeds via the two-step workspace-scoped flow (no CHANGE-2770 / 410).
- File tree loads (no `format=meta` single-object bug, no "Unexpected end of JSON input").
- Session keeps working past ~2h without re-auth (Bitbucket token refresh).

---

## Step 10 — Tear everything down (cost control!)

```bash
./scripts/destroy.sh dev     # prompts for confirmation; empties the frontend bucket, then terraform destroy

```

To also remove the Terraform **state** bucket created during bootstrap:

```bash
grep bucket terraform/environments/dev.s3.tfbackend
aws s3 rb s3://<bucket-name> --force

```

---

## Troubleshooting

| Symptom                                             | Fix                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform init` backend error                      | Ensure `bootstrap.sh dev` completed and `terraform/environments/dev.s3.tfbackend` exists.                                                       |
| Deploy fails building images                        | Start your container runtime (`podman machine start`; `docker run --rm hello-world` must work).                                                 |
| Bedrock access denied for agents                    | Enable model access for `us.anthropic.claude-sonnet-4-6` in us-east-1, or configure a Kiro API key.                                             |
| Frontend auth errors                                | `frontend/.env` is generated from TF outputs — re-run `./scripts/deploy-frontend.sh dev` after a successful apply.                              |
| Bitbucket connect fails at sign-in                  | Callback URL must exactly equal `https://<cloudfront>/bitbucket/callback`; secret stored (Admin → Tracker OAuth Apps → Bitbucket = Configured). |
| Bitbucket "Configured" but repo list empty          | The OAuth token must allow workspace enumeration; a repository-scoped token cannot list repos (by design — see CHANGE-2770 handling).           |
| `deploy-frontend` aborts: initialized for wrong env | `cd terraform && terraform init -reconfigure -backend-config=environments/dev.s3.tfbackend`.                                                    |
