# AI-DLC v2 — Open Items

Open topics and deferred work for the v2 runtime. Pairs with
[`v2-building-blocks.md`](./v2-building-blocks.md) (authoring),
[`v2-runtime.md`](./v2-runtime.md) (the stage executor), and
[`v2-agent.md`](./v2-agent.md) (the agent-execution layer).

## Trigger / resume Lambda (the main missing piece)

The AgentCore image, state table, and runtime exist and are validated end-to-end,
but nothing invokes them automatically yet. The future lambda:

- on intent create → invoke `init-ws` with a new session id;
- per stage → invoke `run-stage` reusing the **same** session id (keeps the
  checkout warm);
- on a human answer → write the `HUMAN#` gate to `answered` (the MCP
  `ask_question` poll unblocks) and re-invoke the next stage.

It also **owns per-project model selection**: `run-stage` accepts a `cliModels`
payload field (precedence: `cliModels[cli]` > agent `modelOverride` > env). The
lambda reads the project vertex's `cli_models` (saved by `Admin.tsx`) and passes
it in the payload. Until it exists, `scripts/phaseb.sh` supplies `cliModels` for
testing and gates are answered with `scripts/phaseb-answer.mjs`.

It reads/writes the same `v2-process-keys` schema already provisioned.

## Verification axes not yet executed

The execution-plan resolver validates these on a stage, but `run-stage` does not
yet run them:

- **Sensors** (`stage.sensors[]`) — deterministic checks (a command + a `bun`
  script). Runtime needs to fetch the produced artifact from Neptune and feed it
  to the script as JSON in/out (so the script never touches a filesystem),
  honouring each sensor's `severity` (advisory vs blocking). A salvageable
  script-runner + script-contract exist in git history (backup commit `96dd3f4`:
  `v2-script-runner.js`, `shared/v2-script-contract.js`).
- **Reviewer** (`stage.reviewer` + `reviewerMaxIterations`) — a clean-room
  sub-agent that judges the stage output READY / NOT-READY, looping up to the
  budget. It must run with the **read-only MCP subset** (lookup/get/search), never
  the write surface. `handlersForRole(..., 'reviewer')` already gates the tools;
  the runner loop is unbuilt.
- **humanValidation** — the flat `'none'`/`'required'` gate. Today the annex tells
  the agent not to render an in-stage approval prompt and to finish with a
  `send_output` summary; the actual human approval is expected to be owned by the
  control plane out-of-band. The gating mechanism there is not built.

## Clarification front-gate

There is no declared `clarification` gate on a stage. Clarifications happen
ad hoc via the `ask_question` MCP tool at the agent's discretion. Decide later
whether to reintroduce a declared front-gate (a stage field) or keep it agent-driven.

## ACP session driver

Execution is headless-CLI today (spawn the CLI, output via the `send_output` MCP
tool). A full ACP JSON-RPC stdio driver (live token streaming, tool-call
interception) is a later, isolated slice behind the same spawn seam.

## Team-knowledge write-back

The `team` knowledge tier and the `team-learnings` / `project-learnings` rule
layers are seeded empty and meant to accrue at runtime. The learning-loop write
path is not built.

## AgentCore VPC network mode — resolved, watch list

The runtime runs in **VPC mode** with dedicated NAT-routed subnets in
AgentCore-supported AZs (region-agnostic AZ-ID mapping in
`terraform/modules/compute/agentcore`), reaching private Neptune over the VPC.
Carry-forward notes:

- The supported-AZ table is transcribed from AWS docs (16 regions). Update it (or
  set `var.agentcore_supported_az_ids`) as AWS expands coverage; subnets in
  unsupported AZs fail at apply.
- The network service-linked role `AWSServiceRoleForBedrockAgentCoreNetwork`
  auto-creates on first VPC config (needs `iam:CreateServiceLinkedRole`).
- VPC endpoints (ECR dkr+api, S3 gateway, CloudWatch Logs) are recommended (and
  required if the VPC has no internet egress). NAT covers it today; endpoints
  would cut NAT data-processing charges.

## Test-plan coverage gaps

Phase B is validated end-to-end; a few checks remain (see
[`v2-execution-testplan.md`](./v2-execution-testplan.md)):

- Live websocket streaming to a connected UI (the `ask_question` gate round-trip
  is proven; the realtime `send_output`-to-UI half is not).
- `cli_nonzero_exit` / `no_cli` and the `agent-team` `not_implemented` failure
  paths are not remotely triggerable (CLIs fall back; no agent-team stage ships in
  the graph) — covered by unit tests instead.
