# AI-DLC v2 Agent Execution — overview

How a real LLM agent runs **one workflow stage** inside the runtime: how it is
prompted, what it is allowed to do, how it authenticates, which model it uses,
and how its work is verified. This is the agent-facing slice of the runtime;
[`v2-runtime.md`](./v2-runtime.md) covers the container/command architecture and
[`v2-building-blocks.md`](./v2-building-blocks.md) the authoring side.

The agent is a **headless CLI** (Claude Code or Kiro) spawned per stage. Its only
interface to the application is a stdio **MCP server** — no filesystem artifact
store, no `bun` tools. Everything below exists to make that work faithfully.

## The pieces

| Component             | File                                                                 | Role                                                                                                                       |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| MCP execution annex   | `lambda/agentcore/prompts/mcp-execution-annex.md`                    | Binds upstream stage prose (written for a filesystem + `bun` harness) onto our MCP tools. Injected first in the prompt.    |
| Stage prompt assembly | `lambda/agentcore/stage-materializer.js`                             | Builds the prompt: annex → persona → stage body → inputs/outputs → rules → output contract. Neutralizes `{{HARNESS_DIR}}`. |
| MCP server            | `lambda/agentcore/mcp/{index,server,graph-writer,process-bridge}.js` | The agent↔app contract: business reads/writes to Neptune, collaboration/process to DynamoDB + websocket.                   |
| CLI drivers           | `lambda/agentcore/cli/{drivers,discover,spawn}.js`                   | Headless invocation for claude/kiro behind one interface.                                                                  |
| Auth resolver         | `lambda/agentcore/auth-resolver.js`                                  | Loads the Bedrock bearer token / Kiro key from SSM into the CLI env at startup.                                            |
| Model resolver        | `lambda/agentcore/model-resolver.js`                                 | Picks the model (project selection > agent override > env) and resolves tier aliases.                                      |
| Inspect command       | `lambda/agentcore/commands/inspect.js`                               | Read-only (and scoped-drop) access to private Neptune through the runtime, for verification + cleanup.                     |

## The MCP execution annex (the harness binding)

Upstream AI-DLC stage bodies are authored for a filesystem + `bun` harness:
"create `aidlc-docs/.../X.md`", "run `bun {{HARNESS_DIR}}/tools/aidlc-*.ts`",
`[Answer]:` question files, an approval-gate `question` block. Our runtime has
none of that. Rather than fork/transform the upstream content, we treat our
runtime as a **new harness** in upstream's harness-neutral + binding-annex model
(the same pattern upstream uses to bind "present a structured question" →
`AskUserQuestion`).

The annex is injected **first** in every stage prompt and:

1. Declares the environment — no filesystem, MCP tools are the only I/O.
2. Provides a **translation table** keyed on upstream vocabulary:
   - "create `aidlc-docs/.../X.md`" → `create_artifact(artifactType=X)` + `link_artifacts`
   - "read `aidlc-docs/...`" / inputs → `get_artifact` / `lookup_artifacts` / `get_intent_graph` / `search_graph`
   - `bun aidlc-*.ts`, state/audit bookkeeping, the task sidebar, the learnings ritual, the `memory.md` diary → **ignore** (runtime-owned)
   - questions / `[Answer]:` files / `question` blocks → `ask_question` (mid-stage clarification only)
   - the completion message + approval gate → a `send_output` summary; approval is out-of-band
3. Declares **precedence**: stage prose + conductor/protocol own WORK QUALITY
   (good questions, depth, contradiction detection, persona voice); the annex owns
   MECHANICS (paths, tools, state, gates). Where they conflict, the annex wins.
4. Has a tight "execution quality" section distilled from upstream's
   `conductor.md` (ask before assuming, scan for vagueness, resolve contradictions,
   adopt the lead persona, scale depth to complexity).

The closing **output contract** enforces order: write every artifact via
`create_artifact` _first_, then `send_output` a summary that may only describe
what was actually written, then `collect_metric`.

## MCP tool surface (the agent's only I/O)

Author role gets the full set; a clean-room **reviewer** gets the read-only
subset only.

- **Business reads** — `get_artifact`, `lookup_artifacts`, `get_intent_graph`,
  `get_artifact_neighbors`, `search_graph`
- **Business writes** — `create_artifact`, `update_artifact`, `link_artifacts`
- **Collaboration / process** — `ask_question` (blocks until answered),
  `send_output`, `collect_metric`, `emit_stage_note`

Provenance is **spoof-proof**: `project_id`, `intent_id`,
`created_by_execution_id`, `created_by_stage_instance_id`, `created_at` are
stamped from the trusted container ENV, never from agent-supplied args. Business
writes land in Neptune (typed, edge-allowlisted); process/collab land in DynamoDB
(+ websocket broadcast).

## Authentication

The agent CLI authenticates to Bedrock with a **bearer token** (or Kiro with an
API key). At container startup, `auth-resolver.js` reads the token from SSM
(`BEDROCK_BEARER_TOKEN_SSM_PATH` / `KIRO_API_KEY_SSM_PATH`) and sets
`AWS_BEARER_TOKEN_BEDROCK` / `KIRO_API_KEY` in the env the driver forwards.
Without this, the CLI silently falls back to task-role SigV4, which is not
granted Bedrock access.

## Model selection

`model-resolver.js` resolves the model with this precedence (most specific wins):

```
project cliModels[cli]  >  stage/agent modelOverride  >  AGENT_MODEL  >  BEDROCK_MODEL
```

- **Project `cliModels`** — the per-CLI model an admin sets per project
  (`Admin.tsx` → project vertex `cli_models`). This is the authoritative knob.
- **Agent `modelOverride`** — every upstream agent ships one (`opus`/`sonnet`
  tiers); it is the fallback when a project hasn't chosen for the selected CLI.
- Bare tier aliases (`opus`/`sonnet`/`haiku`) resolve to full region-prefixed
  Bedrock ids (geo from `AWS_REGION`: `us`/`eu`/`apac`), overridable via
  `AIDLC_MODEL_ALIASES`. Full ids pass through untouched.

The control plane passes `cliModels` in the `run-stage` payload (the future
trigger/resume lambda reads it from the project vertex; see
[`v2-open.md`](./v2-open.md)).

## Verification

Neptune is private (in-VPC), so artifacts are inspected **through** the runtime:
the `inspect` command (`commands/inspect.js`) reuses the graph-writer read path to
return an intent's artifact snapshot + provenance, and with `drop:true` performs
a **scoped** delete of one intent's subgraph (for test cleanup — never a global
wipe). The local harness `scripts/phaseb.sh` drives `init-ws` / `run-stage` /
`inspect` / `drop-intent` against a deployed runtime, and `phaseb-answer.mjs`
answers a pending `ask_question` gate the way the future resume lambda will.

## Validated end-to-end

A real agent runs a stage on deployed AWS: reads prior artifacts, asks clarifying
questions via `ask_question`, and writes provenance-stamped artifacts to Neptune
— verified by reading them back via `inspect`. Cross-stage flow works (a later
stage consumes an earlier stage's artifacts in the same session). The agent never
writes to the filesystem; all output flows through MCP. See
[`v2-execution-testplan.md`](./v2-execution-testplan.md) for the step-by-step
checks.
