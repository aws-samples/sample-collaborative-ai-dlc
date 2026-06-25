# AI-DLC v2 Runtime — the AgentCore stage executor

The execution layer that runs a single v2 workflow **stage** at a time. It pairs
with the authoring layer ([`v2-building-blocks.md`](./v2-building-blocks.md)): the
blocks/workflows are composed and seeded there; this runtime executes them. Open
items and the not-yet-built trigger/resume lambda are tracked in
[`v2-open.md`](./v2-open.md).

## Shape

A **Bedrock AgentCore Runtime** container (`lambda/agentcore`, ESM). AgentCore
routes the **same session id to the same microVM**, so a session's filesystem
(the git checkout) persists across invocations — that is how stage N+1 reuses
stage N's working tree without any pool/lease machinery of our own.

```
AgentCore Runtime container (ARM64, 0.0.0.0:8080)
  http-server.js     GET /ping (Healthy|HealthyBusy)  POST /invocations
  commands/
    init-ws          checkout repos, create Intent vertex, seed CREATED state
    run-stage        resolve plan → RUNNING → spawn headless CLI → terminal state
  stage-materializer assemble prompt + output contract + rules + --mcp-config
  cli/               headless drivers (claude, kiro) — one consistent interface
  mcp/               the stdio MCP server (the agent↔app contract)
  block-loader       pinned workflow + merged block catalogs + bodies/runtime (S3/DDB)
```

One AgentCore **session = one Intent**. Invoke `init-ws` once (new session), then
`run-stage` per stage (same session id).

### Invocation contract (`POST /invocations`)

```jsonc
{ "command": "init-ws",
  "projectId", "intentId", "executionId", "repos": ["owner/repo"],
  "branch", "baseBranch", "gitToken", "title",
  "workflowId", "workflowVersion", "scope" }

{ "command": "run-stage",
  "projectId", "intentId", "executionId", "stageId",
  "workflowId", "workflowVersion", "scope", "requestedCli?" }
```

`/ping` returns `HealthyBusy` while a stage runs (keeps the session alive through
a long stage); `Healthy` otherwise.

## The MCP server — the integration contract

A stdio MCP server (`mcp/`) the headless CLI connects to via `--mcp-config`. It is
the **only** way a stage touches the app. Scope (project/intent/execution/stage)
comes from the **trusted container ENV**, never tool args — provenance is
spoof-proof.

**Artifact tools (generic over the v2 artifact vocabulary):**
`create_artifact`, `update_artifact`, `link_artifacts`, `lookup_artifacts`,
`get_artifact`, `get_artifact_neighbors`, `get_intent_graph`, `search_graph`.

**Collaboration / process tools:**
`ask_question` (blocks on a DynamoDB human gate until answered),
`send_output` (websocket + DynamoDB persist for restore-on-reload),
`collect_metric` (token usage / context-window %), `emit_stage_note` (audit).

A **reviewer** run gets a read-only subset (lookup/get/search) — a clean-room
judge inspects, never writes.

### Business graph (Neptune)

v2 artifacts are **document-level** stage outputs, so each is one `Artifact`
vertex discriminated by `artifact_type` (the v2 artifact id), anchored to the run's
`Intent` via `CONTAINS`, wired with `PRODUCES`/`CONSUMES`/`DERIVED_FROM`/
`RELATES_TO`/`DEPENDS_ON`. This mirrors the authored stage graph 1:1, so the
runtime graph can't drift.

### Process state (DynamoDB)

The `v2-executions` table (`lambda/shared/v2-process-keys.js`) holds runtime state
only — `EXEC#` meta (status, current phase/stage, pending gate), `STAGE#`,
`EVENT#`, `HUMAN#`, `METRIC#`, `OUTPUT#`. `GSI1` browses a project's executions by
status; `GSI2` queries one execution's records by type/state. The container writes
this; a future trigger/resume lambda shares the schema.

## Stage execution flow (`run-stage`)

1. Load the pinned workflow + merged block catalogs (user forks shadow SYSTEM),
   resolve the runnable plan (`lambda/shared/v2-execution-plan.js`), find the stage.
2. Mark the stage `RUNNING`; advance the execution's current phase/stage.
3. Materialize the workspace: stage body + agent persona + knowledge + resolved
   rules → prompt with a mandatory **output contract** (business writes only via
   `create_artifact`, output via `send_output`, decisions via `ask_question`),
   plus the `--mcp-config` carrying the trusted scope.
4. Select + spawn the headless CLI (claude/kiro) with the MCP server wired in.
5. Record the terminal stage state (`SUCCEEDED`/`FAILED`) + event — **always**,
   including every error path, so the control plane never sees a stuck stage.

## Local testing

`lambda/agentcore/test` runs against real testcontainers — gremlin-server
(`test/gremlin-setup.js`) and DynamoDB Local (`test/dynamodb-setup.js`). The
**integration harness** (`test/integration.test.js`) runs `init-ws` → `run-stage`
end to end with a fake CLI driving the real MCP handlers, asserting the artifact
landed in Neptune and the state/output/metric landed in DynamoDB — "execute a
single stage and verify output". Run: `npx vitest run --project agentcore`.

## Terraform

`terraform/modules/compute/agentcore`: ECR + ARM64 image build, the `v2-executions`
table, the IAM execution role, and the runtime via `awscc_bedrockagentcore_runtime`
(HTTP protocol). Wired into root `main.tf` but **not** invoked by any lambda yet —
this is the foundation the trigger/resume lambda will call. See
[`v2-open.md`](./v2-open.md) for the network-mode (Neptune-in-VPC) caveat.
