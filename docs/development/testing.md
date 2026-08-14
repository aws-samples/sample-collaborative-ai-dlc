# Internal testing

This guide covers contributor-facing integration tests that are intentionally
separate from the managed installation documentation.

## Managed build environment deployed-stack test

Use a disposable AWS account or logical environment for this test. Managed
environment image builds use CodeBuild, ECR scanning, S3, DynamoDB, Lambda,
EventBridge, and Bedrock AgentCore resources that incur charges until they are
removed.

Start from a checkout with AWS credentials for the test account. Create the
backend and variable files if this logical environment does not already exist.
The example below uses `managed-env-demo`; substitute your configured name
consistently:

```bash
export AIDLC_TEST_ENV=managed-env-demo
./scripts/bootstrap.sh "$AIDLC_TEST_ENV"
cp terraform/environments/dev.tfvars.example \
  "terraform/environments/$AIDLC_TEST_ENV.tfvars"
```

Set `environment` and `aws_region` in the new tfvars file, then deploy the
infrastructure and frontend:

```bash
./scripts/deploy-terraform.sh "$AIDLC_TEST_ENV"
./scripts/deploy-frontend.sh "$AIDLC_TEST_ENV"
```

The following outputs identify the managed environment resources used during
diagnosis:

```bash
terraform -chdir=terraform output -raw environment_registry_table_name
terraform -chdir=terraform output -raw managed_environment_repository_name
terraform -chdir=terraform output -raw managed_environment_codebuild_project_name
terraform -chdir=terraform output -raw managed_environment_control_lambda_name
terraform -chdir=terraform output -raw managed_environment_status_lambda_name
terraform -chdir=terraform output -raw managed_environment_build_context_bucket_name
terraform -chdir=terraform output -raw managed_tool_repository_name
terraform -chdir=terraform output -raw managed_tool_codebuild_project_name
terraform -chdir=terraform output -raw managed_tool_control_lambda_name
terraform -chdir=terraform output -raw managed_tool_status_lambda_name
```

Sign in as a platform administrator and open **Platform Settings ->
Environments**. The deployment publishes only Standard. Within five minutes,
the catalog bootstrap creates Java, Go, Rust, Maven, and Gradle tool families
and queues their initial versions for import.

For each shipped tool:

1. Follow its CodeBuild log.
2. Confirm the source URL, retained source digest, publisher evidence, OCI
   digest, SBOM, compressed size, and core compatibility evidence are visible.
3. Confirm the version command and representative build run as the non-root
   runtime user.
4. Review ECR findings. Accept Critical or High findings only for this
   disposable deployment. If ECR reports the normalized artifact as
   unsupported, explicitly accept that scan limitation and confirm the
   acceptance remains visible.
5. Publish the version. Mark Java as recommended before publishing Maven or
   Gradle.

Create a `.NET SDK` tool using an official Linux ARM64 SDK archive and the
`.NET` preset. Confirm source inspection, normalization, scanning, `dotnet
--version`, and a real console build succeed, then publish it.

Create catalog-backed environments based on Standard:

1. Select Go and publish the resulting environment.
2. Select Maven and confirm the recommended Java version is added
   automatically.
3. Select `.NET SDK` and publish the resulting environment.
4. Confirm every generated Dockerfile copies tools from exact OCI digests and
   retains the protected base entrypoint, command, user, port, and health
   behavior.
5. Confirm the projected and actual compressed image sizes stay below the
   configured AgentCore image limit.

Create projects with small repositories that exercise each selected toolchain.
In **Project Settings -> Environment**, assign each published environment and
start a new intent. Confirm the intent detail and audit views show the exact
environment revision, image digest, runtime version, endpoint, compatibility
version, tool snapshots, and passed verification result.

To verify immutable intent targeting:

1. Start an intent and record its environment revision and runtime endpoint.
2. Change the project's environment assignment.
3. Resume, rewind, cancel, and stop the original intent.
4. Confirm its detail and audit views retain the original revision and
   endpoint, while a newly created intent uses the new assignment.

To verify updates:

1. Publish a second Go tool version and leave the original recommended.
2. Confirm existing environments remain unchanged.
3. Mark the new Go version recommended and confirm affected environments show a
   structured tool update warning.
4. Edit one affected environment to select the new exact version, then build
   and publish it.
5. Publish a new Standard revision and confirm dependent environments retain
   their published revisions until **Rebuild on latest base** is used.

Inspect failures through the UI or the resource outputs above. Critical and
High findings must stop at security review until a platform administrator
accepts them. The findings and acceptance record must remain visible after
publication. Image build, container validation, and AgentCore endpoint failures
must leave the previous published revision and project assignments unchanged.

When testing is complete, delete the test intents and retire the catalog-backed
test environments in the UI. Environment and tool images are retained while
the stack exists; the non-production repositories are force-deleted with the
stack. Managed AgentCore runtimes and endpoints are created by the control
plane rather than Terraform, so delete remaining test endpoints and runtimes
in the AgentCore console before destroying the logical deployment. Use the
revision details in **Platform Settings -> Environments** to identify the
runtime ID, version, and endpoint. The resources are also tagged with
`ManagedEnvironment` and `ManagedEnvironmentRevision`.

After those resources are removed, destroy the logical deployment:

```bash
./scripts/destroy.sh "$AIDLC_TEST_ENV"
unset AIDLC_TEST_ENV
```

## Enterprise SSO integration test

The repository includes a disposable Cognito User Pool that behaves as an
upstream OIDC provider. Contributors can use it to validate the browser
redirect, claim mapping, access gate, authoritative role behavior, and
`sso-only` UI without an Entra or Okta tenant.

This workflow intentionally uses `deploy-terraform.sh` and
`deploy-frontend.sh` against a contributor test deployment. Product
installations should use `install.sh` as documented in the
[Enterprise SSO guide](../getting-started/enterprise-sso.md).

The main stack and disposable identity provider create billable AWS resources.
Use a non-production environment, keep both Terraform states, and complete the
cleanup step.

### 1. Deploy the test stack in local mode

Start from a repository checkout with a direct deployment already configured:

- AWS credentials select the test account.
- `terraform/environments/<environment>.tfvars` and the matching
  `.s3.tfbackend` file exist.
- The tfvars region matches the account and environment being tested.

The commands below use `dev`; substitute the configured test environment
consistently:

```bash
./scripts/deploy-terraform.sh dev --auth-mode local
./scripts/deploy-frontend.sh dev

export AIDLC_OIDC_CALLBACK="$(
  terraform -chdir=terraform output -raw oidc_idp_callback_url
)"
export AIDLC_TEST_REGION="$(
  terraform -chdir=terraform output -raw aws_region
)"
```

### 2. Deploy the disposable identity provider

Use the same AWS profile and region as the main deployment:

```bash
terraform -chdir=test/fixtures/oidc-idp init
terraform -chdir=test/fixtures/oidc-idp apply \
  -var "aws_region=$AIDLC_TEST_REGION" \
  -var "downstream_callback_url=$AIDLC_OIDC_CALLBACK"

terraform -chdir=test/fixtures/oidc-idp output -json provider_config \
  > /tmp/aidlc-test-idp.json

export TEST_IDP_POOL="$(
  terraform -chdir=test/fixtures/oidc-idp output -raw user_pool_id
)"
```

The fixture state contains a generated OIDC client secret. Treat that state as
sensitive and destroy the fixture after testing.

### 3. Create test identities

Create three users with separate email addresses and strong disposable
passwords. The following commands create the member:

```bash
aws cognito-idp admin-create-user \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username member@example.com \
  --message-action SUPPRESS \
  --user-attributes \
    Name=email,Value=member@example.com \
    Name=email_verified,Value=true \
    Name=name,Value="Test Member"

aws cognito-idp admin-set-user-password \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username member@example.com \
  --password '<disposable-strong-password>' \
  --permanent
```

Repeat both commands for `admin@example.com` and `denied@example.com`, changing
the email, username, display name, and password. Assign the member and
administrator groups:

```bash
aws cognito-idp admin-add-user-to-group \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username member@example.com \
  --group-name aidlc-user

aws cognito-idp admin-add-user-to-group \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username admin@example.com \
  --group-name aidlc-user
aws cognito-idp admin-add-user-to-group \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username admin@example.com \
  --group-name aidlc-admin
```

Leave `denied@example.com` out of `aidlc-user`.

### 4. Verify hybrid login and role mapping

```bash
./scripts/deploy-terraform.sh dev \
  --auth-mode hybrid \
  --sso-config /tmp/aidlc-test-idp.json
./scripts/deploy-frontend.sh dev
```

Create a separate browser profile or isolated browser context for the local
administrator, test member, test administrator, and denied user before signing
in. Different tabs and additional private windows in the same browser can
share the upstream IdP cookie and are not isolated. Separate browser profiles,
different browsers, Firefox containers, or separate Playwright browser
contexts are suitable.

This isolation is intentional. AI-DLC logout clears the application and
federation-broker session, but an application cannot portably terminate both
OIDC and SAML IdP sessions. The disposable IdP therefore reuses the identity
already authenticated in a browser context. It receives no fixture-specific
account-switch behavior; this is the same upstream-session boundary used for
every configured identity provider.

Verify each path in its assigned context:

| User                 | Expected result                                    |
| -------------------- | -------------------------------------------------- |
| Existing local admin | Cognito account form still works                   |
| Test member          | Can sign in; cannot see platform Admin             |
| Test admin           | Can sign in; sees platform Admin                   |
| Denied user          | Sees a sign-in failure; no platform session exists |

Cognito can reduce a pre-token access-gate rejection to a bare `invalid_grant`,
the same error used for expired or replayed authorization codes. The callback
only shows **Access denied** when Cognito or the upstream provider preserves an
explicit `SSO_ACCESS_DENIED` or `access_denied` marker; otherwise it offers a
generic retry.

In **Admin -> Users**, both admitted federated users should say
**Managed by DisposableCognito** and have no role-edit button. The denied
identity also remains in this administrative directory because Cognito creates
its user record before the access gate runs. It must be marked **access denied**,
must not have an effective Admin badge, and must not appear in a space's
**Add member** user list.

As a space owner, open **Project Settings -> Members** and verify:

1. Both admitted federated users appear as **DisposableCognito** identities.
2. The local administrator appears separately as a **Cognito account**.
3. The denied user does not appear.
4. Adding the test member allows that identity to open the space after sign-in.
5. The assigned project role is reflected in the available settings and
   discussion controls.
6. A discussion message posted by the test member is rendered as that user's
   own message, not as another member's message.

In the test administrator's browser context, remove `aidlc-admin`, log out of
AI-DLC, and sign in again. Reusing that context for the same identity is
expected here. The Admin entry must disappear:

```bash
aws cognito-idp admin-remove-user-from-group \
  --region "$AIDLC_TEST_REGION" \
  --user-pool-id "$TEST_IDP_POOL" \
  --username admin@example.com \
  --group-name aidlc-admin
```

Add the group back before testing `sso-only`. To verify that external roles are
authoritative, manually add the downstream federated username to its Cognito
`platform-admin` group. After a fresh SSO login, the token must still contain
only roles mapped from the upstream claim.

### 5. Verify SSO-only and clean up

After the SSO administrator works:

```bash
./scripts/deploy-terraform.sh dev \
  --auth-mode sso-only \
  --sso-config /tmp/aidlc-test-idp.json
./scripts/deploy-frontend.sh dev
```

The Cognito account form must be absent. Restore local mode before deleting the
fixture because the main Terraform configuration still reads its client
secret:

```bash
./scripts/deploy-terraform.sh dev --auth-mode local
./scripts/deploy-frontend.sh dev

terraform -chdir=test/fixtures/oidc-idp destroy \
  -var "aws_region=$AIDLC_TEST_REGION" \
  -var "downstream_callback_url=$AIDLC_OIDC_CALLBACK"

rm -f /tmp/aidlc-test-idp.json
unset AIDLC_OIDC_CALLBACK AIDLC_TEST_REGION TEST_IDP_POOL
```

## AgentCore tests

AgentCore has two separate test layers:

1. The deterministic AgentCore test project, which uses local test containers
   and does not call a model.
2. The credentialed local E2E, which runs the real Claude, Kiro, OpenCode, and
   Codex CLIs against real models.

Neither test requires a deployed AI-DLC stack.

### Deterministic AgentCore tests

Run the AgentCore project from the repository root:

```bash
npx vitest run --project=agentcore
```

These tests are suitable for normal pull request validation. They require a
running Docker daemon because the Vitest global setup starts DynamoDB Local and
Gremlin Server with Testcontainers. They do not require model credentials and
do not incur model usage.

Run the repository checks before opening a pull request:

```bash
npm run lint
npm run format:check
npm run secretlint
npx vitest run --project=agentcore
```

### Local multi-CLI E2E

[`scripts/agent-e2e-testing.sh`](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/main/scripts/agent-e2e-testing.sh)
is the only user-facing runtime E2E command. It builds and runs the production
AgentCore container locally, using DynamoDB Local and Gremlin Server instead of
deployed AWS resources.

The E2E makes real model calls and can incur usage charges. Claude, Kiro,
OpenCode, and Codex run sequentially to limit spend and avoid shared
conversation-store races.

#### Prerequisites

- Docker with Buildx
- Native ARM64 execution or working `linux/arm64` emulation
- Outbound HTTPS access from Docker containers
- A Bedrock API key for Claude, OpenCode, and Codex
- A Kiro API key for Kiro
- For Codex, the OpenAI models (`openai.gpt-5.*`) enabled in Bedrock for the
  chosen `AWS_REGION`

Before making model calls, the script checks Docker, Buildx, ARM64 execution,
key presence, model syntax, and outbound connectivity. It supplies inert AWS
credentials to DynamoDB Local and does not require an AWS profile, Terraform
state, Cognito login, or deployed stack.

When running behind an HTTP proxy, export the standard proxy variables before
starting the E2E:

```bash
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1
./scripts/agent-e2e-testing.sh
```

The harness forwards non-empty standard proxy variables, including lowercase
variants, to the Buildx build, outbound-connectivity check, and AgentCore test
containers. No proxy flags or container variables are added when none are set.
The Docker daemon still needs its own proxy configuration to pull base and test
images.

#### Run all CLIs

To avoid placing credentials directly in shell history, enter them in a Bash
session without echo:

```bash
read -rsp 'Bedrock API key: ' BEDROCK_API_KEY; printf '\n'
read -rsp 'Kiro API key: ' KIRO_API_KEY; printf '\n'
export BEDROCK_API_KEY KIRO_API_KEY

./scripts/agent-e2e-testing.sh

unset BEDROCK_API_KEY KIRO_API_KEY
```

For non-interactive use, the equivalent command is:

```bash
BEDROCK_API_KEY=... KIRO_API_KEY=... ./scripts/agent-e2e-testing.sh
```

`AWS_BEARER_TOKEN_BEDROCK` is accepted when `BEDROCK_API_KEY` is absent.

#### Run selected CLIs

`E2E_CLIS` is a comma-separated list. Only credentials needed by the selected
CLIs are required:

```bash
# Claude, OpenCode, and Codex use the same Bedrock key.
E2E_CLIS=claude,opencode,codex ./scripts/agent-e2e-testing.sh

# Kiro only.
E2E_CLIS=kiro ./scripts/agent-e2e-testing.sh

# Codex only.
E2E_CLIS=codex ./scripts/agent-e2e-testing.sh
```

The examples assume the corresponding key was already exported.

#### Configuration

| Variable                   | Default                                              | Purpose                                            |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `BEDROCK_API_KEY`          | none                                                 | Bedrock authentication for Claude, OpenCode, Codex |
| `AWS_BEARER_TOKEN_BEDROCK` | none                                                 | Alias used when `BEDROCK_API_KEY` is absent        |
| `KIRO_API_KEY`             | none                                                 | Kiro authentication                                |
| `AWS_REGION`               | `us-east-1`                                          | Bedrock region                                     |
| `BEDROCK_MODEL`            | `us.anthropic.claude-sonnet-4-6`                     | Bare Bedrock model or inference-profile ID         |
| `KIRO_MODEL`               | `auto`                                               | Kiro model ID                                      |
| `CODEX_MODEL`              | `openai.gpt-5.5`                                     | Exact Codex-on-Bedrock model ID (`openai.*`)       |
| `E2E_CLIS`                 | `claude,kiro,opencode,codex`                         | CLIs to run, in execution order                    |
| `AGENTCORE_IMAGE`          | none                                                 | Existing local ARM64 image; skips the image build  |
| `KEEP_E2E`                 | `0`                                                  | Set to `1` to retain resources after a failed run  |
| `E2E_OUTPUT_DIR`           | per-run path under `test/e2e/artifacts/agent-output` | Normalized output reports                          |

Do not prefix `BEDROCK_MODEL` with `amazon-bedrock/`. The harness adds that
provider prefix for OpenCode and passes the bare value to Claude.

To reuse an image:

```bash
docker buildx build \
  --platform linux/arm64 \
  --load \
  --tag aidlc-agentcore:e2e \
  --file lambda/agentcore/Dockerfile \
  lambda

AGENTCORE_IMAGE=aidlc-agentcore:e2e ./scripts/agent-e2e-testing.sh
```

#### What the E2E verifies

For each selected CLI, the harness:

1. Seeds an isolated DynamoDB execution, Gremlin Intent, stage, and workspace.
2. Starts a fresh AgentCore container and runs the real CLI through `runStage`.
3. Requires the agent to call `ask_question` and park.
4. Verifies the pending gate and persisted CLI session ID.
5. Removes the container, answers the gate directly in the process store, and
   starts a new container with the same workspace volume.
6. Resumes the same CLI session.
7. Requires `create_artifact`, `send_output`, and `collect_metric`.
8. Verifies the successful stage, graph edge, output, metric, session identity,
   native edit parsing, output timestamps, and Git runtime exclusions.

Starting fresh and resume legs in separate containers exercises Claude's and
Codex's durable JSONL state and Kiro/OpenCode SQLite restore and persistence.

The script continues after an individual CLI failure and prints a flat summary:

```text
Claude:   PASS
Kiro:     PASS
OpenCode: PASS
Codex:    PASS
```

It exits nonzero if any selected CLI fails.

Each run also writes one normalized transcript report per selected CLI and
refreshes the standalone frontend fixture at
`/agent-output-preview.html`. Start it without model calls with:

```bash
npm run dev:agent-output
```

#### Credentials and cleanup

Keys are written to a mode-`0600` temporary file, mounted read-only into local
test containers, and deleted by the exit trap. Key values are not passed through
Docker command arguments or `--env`, stored in container metadata, written to
SSM, or sent to a deployed stack.

Successful runs remove their containers, named volumes, private network, local
fixtures, and logs. To retain a failed run:

```bash
KEEP_E2E=1 ./scripts/agent-e2e-testing.sh
```

The failure output prints the resource label and log directory. Inspect retained
resources with:

```bash
docker ps -a --filter 'label=aidlc.e2e=<run-id>'
docker volume ls --filter 'label=aidlc.e2e=<run-id>'
ls -la '<log-directory>'
```

After inspection, remove retained resources:

```bash
docker ps -aq --filter 'label=aidlc.e2e=<run-id>' |
  while read -r id; do docker rm -f "$id"; done
docker volume ls -q --filter 'label=aidlc.e2e=<run-id>' |
  while read -r id; do docker volume rm -f "$id"; done
docker network rm 'aidlc-e2e-<run-id>'
rm -rf '<log-directory>'
```

The temporary credential file is deleted even when `KEEP_E2E=1`.

### Deployed-stack diagnostics

[`scripts/phaseb.sh`](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/main/scripts/phaseb.sh)
remains a diagnostic tool for an already deployed AgentCore stack. It reads
Terraform outputs and exercises deployed routing and persistence. The local E2E
does not invoke it.

Use `agent-e2e-testing.sh` for local container lifecycle coverage. Use `phaseb.sh` only
when diagnosing deployed infrastructure or routing behavior.

The credentialed E2E is intentionally local and manual; it is not a GitHub
Actions workflow.
