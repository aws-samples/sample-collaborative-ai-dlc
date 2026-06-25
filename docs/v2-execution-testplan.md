# AI-DLC v2 Execution — Test Plan

Actionable, step-by-step verification for the AgentCore stage-execution runtime
(`lambda/agentcore`) and its terraform (`terraform/modules/compute/agentcore`).
Two phases: **Phase A — local** (no AWS account needed; testcontainers + a real
headless CLI), then **Phase B — after `terraform apply`** (real AgentCore Runtime,
Neptune, DynamoDB, S3, websocket).

Pair with [`v2-runtime.md`](./v2-runtime.md) (design) and [`v2-open.md`](./v2-open.md)
(known gaps — read §4 before Phase B: the AgentCore PUBLIC-vs-VPC network mode and
the unverified `awscc` artifact shape are the two first-apply risks).

Conventions: `✅` = expected pass signal, `⚠️` = known risk to watch.

---

## Phase A — Local (no deploy)

Goal: prove the runtime's logic, the MCP contract, and the full single-stage flow
work, using the gremlin-server + DynamoDB Local testcontainers already wired into
vitest. Docker (or Podman) must be running for testcontainers.

### A0. Prerequisites

```bash
cd /Users/jwthewes/Development/oss/sample-collaborative-ai-dlc
node -v            # ✅ v24.x
docker info        # ✅ daemon reachable (testcontainers needs it)
npm ci             # if deps not yet installed
```

### A1. Unit + integration suite (the core proof)

Runs the pure logic, the MCP server against a real gremlin container, and the
end-to-end `init-ws → run-stage` harness against gremlin + DynamoDB Local.

```bash
npx vitest run --project agentcore
```

✅ All suites pass (~10 files). Key ones to eyeball in the output:

- `graph-writer.test.js` — Neptune writes, provenance stamping, edge allowlist.
- `mcp-server.test.js` — tool routing + reviewer read-only gating.
- `process-bridge.test.js` — blocking `ask_question`, `send_output` persist.
- `run-stage.test.js` — RUNNING→terminal on every path (incl. failures).
- `integration.test.js` — **the headline**: artifact lands in Neptune, state +
  output + metric land in DynamoDB.

### A1a. MCP execution annex binding (the storage-redirect proof)

The runtime injects an **MCP execution annex** ahead of every upstream stage body
(`lambda/agentcore/prompts/mcp-execution-annex.md`, wired in
`stage-materializer.js`). Upstream stage prose is written for a filesystem +
`bun` harness ("Create `aidlc-docs/.../requirements.md`", "run `bun .../aidlc-*.ts`",
`[Answer]:` files, an approval `question` block); the annex redirects all of it
onto our MCP tools. The extended suites prove the binding without a container:

```bash
npx vitest run --project agentcore -t "MCP execution annex"
npx vitest run --project agentcore -t "end-to-end"
```

✅ Headline signals (run against the real upstream body fixture
`test/fixtures/requirements-analysis.md`):

- annex injected **exactly once**, ahead of the stage body and output contract;
- **no raw `{{HARNESS_DIR}}`** survives in the rendered prompt;
- in the e2e run, the workspace gets only `.aidlc/` steering files — **no
  `aidlc-docs/` tree** — and the stage's output lands in Neptune via
  `create_artifact`, not on disk.

### A2. Shared-layer suite (plan resolver + process schema)

```bash
npx vitest run --project shared
```

✅ `v2-execution-plan.test.js` and `v2-process.test.js` green.

### A3. Lint + format (CI parity)

Per repo convention, oxfmt scans the whole tree, so check just the new files:

```bash
npx oxlint lambda/agentcore lambda/shared/v2-*.js
npx oxfmt --check lambda/agentcore lambda/shared/v2-*.js
cd terraform && terraform fmt -check -recursive modules/compute/agentcore && cd ..
```

✅ No errors. (Dangling-underscore warnings on `__`/`_conn` are expected — they
match the existing MCP code.)

### A4. Terraform module validates

```bash
cd terraform/modules/compute/agentcore
terraform init -backend=false
terraform validate
cd ../../../..
```

✅ "Success! The configuration is valid." (⚠️ `data.aws_region.id` deprecation
warnings are expected and shared with the existing modules.)

### A5. Docker image builds for ARM64

Confirms the Dockerfile + build context (`lambda/`) resolve. Build context is the
`lambda/` dir so the image gets both `agentcore/` and `shared/`.

```bash
cd lambda
docker build --platform linux/arm64 -f agentcore/Dockerfile -t aidlc-agentcore:local .
cd ..
```

✅ Image builds. ⚠️ If `@anthropic-ai/claude-code` or the kiro installer changes,
this is where it surfaces.

### A6. Container smoke — `/ping` and a 400 (no AWS calls)

The HTTP contract works without any backing services.

```bash
docker run --rm -p 8080:8080 --name aidlc-smoke aidlc-agentcore:local &
sleep 3
curl -s localhost:8080/ping            # ✅ {"status":"Healthy","time_of_last_update":...}
curl -s -XPOST localhost:8080/invocations -d '{}'   # ✅ {"error":"missing \"command\""}
curl -s localhost:8080/nope            # ✅ {"error":"not found"}
docker stop aidlc-smoke
```

### A7. Real headless CLI honours the annex (required annex check)

Proves a real CLI actually drives our MCP tools AND obeys the annex over genuine
upstream prose (the integration test uses a fake agent). Requires a Claude Code
Bedrock bearer token and a reachable gremlin container. Manual, not automated.

1. Start a local gremlin-server: `docker run -d -p 8182:8182 tinkerpop/gremlin-server:3.7.3`
2. Seed an `Intent` vertex (gremlin console or a one-off node script using
   `lambda/agentcore/commands/init-ws.js` `ensureIntentVertex`).
3. Write an `mcp-config.json` (see `buildMcpConfig` output) pointing `command:node
args:[lambda/agentcore/mcp/index.js]` with `V2_*` env + `GREMLIN_PROTOCOL=ws`.
4. Build the prompt for a **real upstream stage body** (not a synthetic
   instruction): `node -e "import('./lambda/agentcore/stage-materializer.js').then(m=>console.log(m.buildStagePrompt({stage:{stageId:'requirements-analysis',phase:'inception',agentRef:'aidlc-product-agent',outputArtifacts:[{artifact:'requirements-analysis'}],humanValidation:'required'},stageBody:require('fs').readFileSync('lambda/agentcore/test/fixtures/requirements-analysis.md','utf8')})))" > /tmp/stage-prompt.txt`
5. Run: `claude -p "$(cat /tmp/stage-prompt.txt)" --mcp-config ./mcp-config.json --permission-mode bypassPermissions`
   ✅ The agent calls `lookup_artifacts` / `get_intent_graph` then `create_artifact`
   (the `Artifact` vertex appears in gremlin anchored to the Intent), streams a
   `send_output` summary, and uses `ask_question` only for genuine ambiguity.
   ✅ It does **NOT** attempt any filesystem write (no `aidlc-docs/...`), does **NOT**
   run a `bun` tool, and does **NOT** render an approval `question` — the annex
   overrode the upstream prose with a real model in the loop.
   ⚠️ Validates the actual `claude` flag surface — if flags drift, fix `cli/drivers.js`.

### A8. Local exit criteria

- [ ] A1–A2 green (all agentcore + shared v2 tests).
- [ ] A1a annex binding verified — stage prose redirected to MCP, annex injected
      once, no `{{HARNESS_DIR}}` leak, no `aidlc-docs/` files (Neptune-only output).
- [ ] A3–A4 clean (lint/fmt/validate).
- [ ] A5 image builds for arm64.
- [ ] A6 `/ping` + `/invocations` behave.
- [ ] A7 a real CLI drove the MCP tools and honoured the annex (no fs write, no
      `bun` tool, no approval question) over a real upstream stage body.

---

## Phase B — After `terraform apply`

Goal: prove the deployed runtime executes a real stage against real Neptune /
DynamoDB / S3 / websocket. The trigger/resume lambda is **not** built (see
`v2-open.md`), so we drive the runtime directly with the AWS CLI / SDK.

### B0. Deploy + seed

```bash
cd terraform
terraform init   # pulls hashicorp/awscc (new provider for this module)
terraform apply -var-file=environments/dev.tfvars
```

Capture outputs:

```bash
terraform output agentcore_runtime_arn
terraform output agentcore_image_uri
terraform output v2_executions_table_name
cd ..
```

Then seed the baseline blocks + the commit-pinned runtime snapshot the runtime
reads (must match `var.aidlc_repo_ref`):

```bash
aws lambda invoke --function-name "$(cd terraform && terraform output -raw seed_blocks_lambda_name)" \
  --payload '{}' --cli-binary-format raw-in-base64-out /tmp/seed.json
cat /tmp/seed.json   # ✅ seeded blocks + runtimeFiles + a workflow
```

⚠️ Confirm `terraform apply` actually created the `awscc_bedrockagentcore_runtime`
(not just a plan error on the artifact shape — `v2-open.md` §4). If it fails,
reconcile `agent_runtime_artifact` against the installed awscc provider schema.

### B1. Runtime reaches Neptune (the network-mode risk)

This is the **first thing to verify** — the module defaults to `network_mode =
"PUBLIC"` and Neptune is in a private VPC.

1. Invoke `init-ws` (see B2). 2. If it returns `intent_vertex_failed` or times out
   on the Neptune connect, PUBLIC mode can't reach Neptune → switch the module to the
   VPC network mode + subnets/SG and re-apply (`v2-open.md` §4).
   ✅ `init-ws` returns `{ ok: true }` and the Intent vertex exists in Neptune.

### B2. `init-ws` — bootstrap an intent

Invoke the runtime (`InvokeAgentRuntime`); reuse the **same session id** for every
later call on this intent. Pick a UUID for the session.

```bash
SID=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$(cd terraform && terraform output -raw agentcore_runtime_arn)" \
  --runtime-session-id "$SID" \
  --payload '{"command":"init-ws","projectId":"p-test","intentId":"i-test",
    "executionId":"e-test","repos":["<owner>/<repo>"],"branch":"aidlc/i-test",
    "baseBranch":"main","gitToken":"<token>","title":"Test intent",
    "workflowId":"aidlc-v2","workflowVersion":1,"scope":"feature"}' \
  /tmp/initws.json
cat /tmp/initws.json   # ✅ { ok:true, intentId:"i-test", repos:[...] }
```

Verify state seeded:

```bash
aws dynamodb get-item --table-name "$(cd terraform && terraform output -raw v2_executions_table_name)" \
  --key '{"pk":{"S":"EXEC#e-test"},"sk":{"S":"META"}}'
# ✅ status=CREATED, intentId=i-test, workflowVersion=1
```

✅ Neptune has an `Intent` vertex id=`i-test` (query via the app or a Neptune
workbench). ⚠️ Exact `invoke-agent-runtime` CLI shape may differ by CLI version —
fall back to the SDK / console "Test" if needed.

### B3. `run-stage` — execute one real stage (same session)

```bash
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$(cd terraform && terraform output -raw agentcore_runtime_arn)" \
  --runtime-session-id "$SID" \
  --payload '{"command":"run-stage","projectId":"p-test","intentId":"i-test",
    "executionId":"e-test","stageId":"intent-capture",
    "workflowId":"aidlc-v2","workflowVersion":1,"scope":"feature"}' \
  /tmp/runstage.json
cat /tmp/runstage.json   # ✅ { ok:true, state:"SUCCEEDED", cli:"claude" }
```

Pick a real first stage id from the seeded workflow (`intent-capture` is the
ideation entry; an inception stage like `requirements-analysis` needs its inputs
to exist first — run an early stage or one whose inputs are optional).

### B4. Verify business output in Neptune

✅ An `Artifact` vertex of the stage's `artifactType`, anchored to the Intent:
query the intent subgraph (the app's intent page, or Neptune workbench):
`g.V().has('Intent','id','i-test').out('CONTAINS').hasLabel('Artifact').valueMap(true)`

### B4a. No filesystem artifacts on the real runtime (annex holds end-to-end)

Confirm the stage wrote its outputs to Neptune, not to an `aidlc-docs/` tree on
the session checkout. With the same `$SID` still warm, exec into the session (or
inspect via the app's file browser if available) and list the workspace:

```bash
# In the running AgentCore session microVM (or via a debug run-stage that lists):
ls -a "$V2_WORKSPACE_DIR"          # ✅ .aidlc present; ✅ NO aidlc-docs directory
ls "$V2_WORKSPACE_DIR/.aidlc"      # ✅ only mcp-config.json (+ rules.md if rules applied)
```

✅ Every business output is an `Artifact` vertex (B4), never a markdown file. This
is the deployed-runtime counterpart of A1a/A7 — proof the annex binding survives
a real CLI on a real session.

### B5. Verify process state + restore-on-reload in DynamoDB

```bash
TABLE=$(cd terraform && terraform output -raw v2_executions_table_name)
aws dynamodb query --table-name "$TABLE" \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values '{":p":{"S":"EXEC#e-test"}}'
```

✅ `STAGE#…` row state=SUCCEEDED; `EVENT#…` rows (running/succeeded); `OUTPUT#…`
rows (the `send_output` chunks — this is the page-reload restore source);
`METRIC#…` rows if the agent reported usage; `META` currentStage advanced.

### B6. Session reuse keeps the checkout

Run a **second** `run-stage` (a stage that consumes B3's output) with the **same**
`$SID`. ✅ It succeeds and reads the prior artifact via `get_artifact` /
`lookup_artifacts` — confirming the filesystem + graph carried over. Run with a
**new** session id and ✅ it starts from a fresh checkout.

### B7. Realtime + question flow (if a websocket client is connected)

With the app open on the intent (a `intent:i-test` websocket connection live):

- `send_output` → ✅ chunks stream to the UI live, and survive a page reload
  (re-fetched from the `OUTPUT#` rows).
- A stage that calls `ask_question` → ✅ a question appears; answering it (write
  the `HUMAN#` gate to `answered` with the structured answer) unblocks the stage
  (the MCP poll returns). Until the trigger/resume lambda exists, simulate the
  answer with a DynamoDB `update-item` on the `HUMAN#<id>` row (status=answered,
  answer={…}).

### B8. Failure paths

- `run-stage` with an `agent-team` stage → ✅ `{ ok:false, reason:"not_implemented" }`,
  `STAGE#` row FAILED (no stuck stage).
- `run-stage` with a bogus `stageId` → ✅ `{ ok:false, reason:"stage_not_in_scope" }`.
- Kill the CLI mid-run (or a non-zero exit) → ✅ `STAGE#` row FAILED + `v2.stage.failed`
  event.

### B9. Post-apply exit criteria

- [ ] B0 apply created the runtime; seed populated blocks + runtime snapshot.
- [ ] B1 runtime reaches Neptune (network mode correct).
- [ ] B2 init-ws seeds Intent + CREATED state.
- [ ] B3–B5 a real stage runs: artifact in Neptune, state/output/metric in DynamoDB.
- [ ] B4a no `aidlc-docs/` tree on the checkout — outputs are Neptune artifacts only.
- [ ] B6 same-session reuse carries filesystem + graph; new session is fresh.
- [ ] B7 realtime output + question gate work (if UI connected).
- [ ] B8 failure paths record terminal state, never stick.

---

## Cleanup

```bash
# Local
docker rm -f aidlc-smoke 2>/dev/null; docker rmi aidlc-agentcore:local 2>/dev/null
# Deployed test data (dev only)
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"EXEC#e-test"},"sk":{"S":"META"}}'
# (and the Intent subgraph via the app's delete, or a scoped Neptune drop)
```

Do NOT `terraform destroy` a shared dev stack to clean one test intent — delete
just the `e-test` / `i-test` records.
