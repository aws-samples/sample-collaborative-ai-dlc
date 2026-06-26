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

## Team-knowledge write-back

**Knowledge tier — built.** The `team` knowledge tier now accrues at runtime. It
lives in Neptune as `TeamKnowledge` vertices hung off the `Project`
(`Project --HAS_KNOWLEDGE--> TeamKnowledge`), so a learning recorded in one
intent is readable by every intent in the project (business data that steers
future outcomes, kept where the rest of the business graph is — not in the blocks
table). The loop:

- **Write** — the author agent calls the `record_team_knowledge` MCP tool when it
  learns something durable (a convention, decision, constraint, gotcha). The
  annex's learnings ritual now routes here instead of being ignored. Provenance
  (`project_id`, `created_by_intent_id`, execution/stage) is stamped from the
  trusted container ENV, never agent args — spoof-proof like artifacts.
- **Read** — `run-stage` fetches the project's team knowledge for the stage's
  agent (+ the `shared` corpus) and injects it into the prompt's
  `## Reference knowledge` section, so the agent always receives it; the
  read-only `get_team_knowledge` tool (also granted to reviewers) re-reads or
  pulls another agent's corpus on demand. This also fixed the methodology tier,
  whose read path was silently dead (`loadLibrary` never loaded `KNOWLEDGE`).

**Still open — rule-layer learnings.** The `team-learnings` / `project-learnings`
rule layers (the feedback half that turns a learning into a layered _guardrail_,
priorities 1.5 / 2.5 in the resolver) are still seeded empty. Knowledge steers by
reference; a learnings _rule_ would steer by precedence. That write path is not
built.
