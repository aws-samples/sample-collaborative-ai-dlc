# Internal testing

This guide covers contributor-facing tests for the AgentCore runtime. There are
two separate test layers:

1. The deterministic AgentCore test project, which uses local test containers
   and does not call a model.
2. The credentialed local E2E, which runs the real Claude, Kiro, and OpenCode
   CLIs against real models.

Neither test requires a deployed AI-DLC stack.

## Deterministic AgentCore tests

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

## Local multi-CLI E2E

[`scripts/agent-e2e-testing.sh`](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/main/scripts/agent-e2e-testing.sh)
is the only user-facing runtime E2E command. It builds and runs the production
AgentCore container locally, using DynamoDB Local and Gremlin Server instead of
deployed AWS resources.

The E2E makes real model calls and can incur usage charges. Claude, Kiro, and
OpenCode run sequentially to limit spend and avoid shared conversation-store
races.

### Prerequisites

- Docker with Buildx
- Native ARM64 execution or working `linux/arm64` emulation
- Outbound HTTPS access from Docker containers
- A Bedrock API key for Claude and OpenCode
- A Kiro API key for Kiro

Before making model calls, the script checks Docker, Buildx, ARM64 execution,
key presence, model syntax, and outbound connectivity. It supplies inert AWS
credentials to DynamoDB Local and does not require an AWS profile, Terraform
state, Cognito login, or deployed stack.

### Run all CLIs

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

### Run selected CLIs

`E2E_CLIS` is a comma-separated list. Only credentials needed by the selected
CLIs are required:

```bash
# Claude and OpenCode use the same Bedrock key.
E2E_CLIS=claude,opencode ./scripts/agent-e2e-testing.sh

# Kiro only.
E2E_CLIS=kiro ./scripts/agent-e2e-testing.sh

# OpenCode only.
E2E_CLIS=opencode ./scripts/agent-e2e-testing.sh
```

The examples assume the corresponding key was already exported.

### Configuration

| Variable                   | Default                                              | Purpose                                           |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `BEDROCK_API_KEY`          | none                                                 | Bedrock authentication for Claude and OpenCode    |
| `AWS_BEARER_TOKEN_BEDROCK` | none                                                 | Alias used when `BEDROCK_API_KEY` is absent       |
| `KIRO_API_KEY`             | none                                                 | Kiro authentication                               |
| `AWS_REGION`               | `us-east-1`                                          | Bedrock region                                    |
| `BEDROCK_MODEL`            | `us.anthropic.claude-sonnet-4-6`                     | Bare Bedrock model or inference-profile ID        |
| `KIRO_MODEL`               | `auto`                                               | Kiro model ID                                     |
| `E2E_CLIS`                 | `claude,kiro,opencode`                               | CLIs to run, in execution order                   |
| `AGENTCORE_IMAGE`          | none                                                 | Existing local ARM64 image; skips the image build |
| `KEEP_E2E`                 | `0`                                                  | Set to `1` to retain resources after a failed run |
| `E2E_OUTPUT_DIR`           | per-run path under `test/e2e/artifacts/agent-output` | Normalized output reports                         |

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

### What the E2E verifies

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

Starting fresh and resume legs in separate containers exercises Claude's
durable JSONL state and Kiro/OpenCode SQLite restore and persistence.

The script continues after an individual CLI failure and prints a flat summary:

```text
Claude:   PASS
Kiro:     PASS
OpenCode: PASS
```

It exits nonzero if any selected CLI fails.

Each run also writes one normalized transcript report per selected CLI and
refreshes the standalone frontend fixture at
`/agent-output-preview.html`. Start it without model calls with:

```bash
npm run dev:agent-output
```

### Credentials and cleanup

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

## Deployed-stack diagnostics

[`scripts/phaseb.sh`](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/main/scripts/phaseb.sh)
remains a diagnostic tool for an already deployed AgentCore stack. It reads
Terraform outputs and exercises deployed routing and persistence. The local E2E
does not invoke it.

Use `agent-e2e-testing.sh` for local container lifecycle coverage. Use `phaseb.sh` only
when diagnosing deployed infrastructure or routing behavior.

The credentialed E2E is intentionally local and manual; it is not a GitHub
Actions workflow.
