# AI-DLC v2 — Open Items & Carry-Forward Notes

Living scratchpad of design gaps, deferred decisions, and salvageable prior art
for the v2 runtime work. Not a spec — a place to pick things up later. Pairs with
[`v2-building-blocks.md`](./v2-building-blocks.md) (authoring) and
[`v2-data-model.md`](./v2-data-model.md) (data model sketch).

## 1. Execution-plan compiler must be rewritten (not ported)

There is a complete, tested v2 runtime on the backup branch
`backup/aidlc-v2-building-blocks-20260619` (peak commit `96dd3f4`), since removed
from the active branch. It includes an execution-plan compiler
(`lambda/shared/v2-execution-plan.js`, "Slice 3") that turns a pinned workflow +
scope into a runnable, validated plan (stage instances, dependencies, resolved
rules/sensors/artifacts, human gates, cycle/dangling detection).

**Why it can't be ported verbatim:** it targets the **old block model** —
stages carried nested `c1_definition` (inputs/outputs/intermediates) and
`c2_verification` (sensors/postConditions/humanValidation). The active branch
reworked stages to **flat V2 frontmatter** (see `lambda/shared/block-mappers.js`
`mapStage`):

| Old (compiler reads)              | New (current model)                          |
| --------------------------------- | -------------------------------------------- |
| `stage.c1_definition.inputs`      | `stage.consumes[]` (`{artifact, required, conditionalOn}`) |
| `stage.c1_definition.outputs`     | `stage.produces[]`                           |
| `stage.c1_definition.intermediates` | (folded into `produces`)                   |
| `stage.c2_verification.sensors`   | `stage.sensors[]` (sensor ids)               |
| `stage.c2_verification.humanValidation` | `stage.humanValidation` (flat: `'none'`/`'required'`) |
| llm-judged **sensor**             | `stage.reviewer` + `stage.reviewerMaxIterations` (flat field, NOT a sensor) |
| `stage.clarification.required`    | (no direct equivalent yet — see §3)          |
| `stage.defaultGrouping` (phase)   | `stage.phase`                                |
| `stage.leadAgent`/`supportAgents` | same (`leadAgent`, `supportAgents[]`)        |

**What to salvage from the old compiler** (`git show 96dd3f4:lambda/shared/v2-execution-plan.js`):
- the overall contract `{ valid, errors, plan }` (never throws; structured errors);
- deterministic stage-instance ids (sha256 of `namespace:stageId`);
- reuse of `compileStageGraph` / `compileRules` from `compile.js` over the
  **in-scope** placement subset (cycle + dangling-consume detection);
- `RUNNABLE_MODES = ['inline','subagent']`; `agent-team` flagged
  `notImplemented` (fail-fast at run time, don't crash the compiler);
- dangling-consume is fatal **unless** the input is `required:false` or has a
  `conditionalOn` (brownfield-style gating).

**Rewrite shape (new model):**
- `produces` = `stage.produces` directly.
- `consumes` = `stage.consumes` directly (already `{artifact, required, conditionalOn}`).
- dependencies = union of data producers (produces→consumes), `requires` (stage
  ids), and `blocksOn`.
- sensors = resolve `stage.sensors[]` ids against SENSOR blocks (all
  deterministic now — `mode:'deterministic'`).
- reviewer = `stage.reviewer` (an AGENT id) + `stage.reviewerMaxIterations`,
  resolved as its own verification axis (see §2), **not** a sensor.

## 2. Three verification axes — runtime gating differs from the spike

The current model has **three orthogonal axes on a stage** (per
`v2-building-blocks.md`): deterministic `sensors[]`, an LLM-judged `reviewer`
agent, and the human `humanValidation` gate. The prior spike collapsed the
reviewer into an "llm-judged sensor" and derived a `review-verdict` human gate
from it — that mapping is now wrong.

Runtime needs to treat them separately:
- **sensors[]** — deterministic checks (command + `bun` runtime); advisory or
  blocking per sensor `severity`. Salvage `v2-script-runner.js` +
  `shared/v2-script-contract.js` from `96dd3f4` (pure, well-tested; runtime model
  unchanged).
- **reviewer** — a clean-room sub-agent (`reviewer` AGENT id, loop up to
  `reviewerMaxIterations`, READY/NOT-READY). Salvage `v2-reviewer-runner.js`
  patterns but read the budget/agent from the flat stage fields, and source the
  reviewer's allowed tools from the **read-only MCP subset** (lookup/get/search),
  never the write surface.
- **humanValidation** — flat field. `mapStage` sets it to `'none'` for
  `phase === 'initialization'` and `'required'` for every other stage. Maps to a
  single `approval` human gate. The `question`/`review-verdict` derivations from
  the spike's `deriveHumanValidation` no longer apply as written.

## 3. `clarification` front-gate has no current equivalent

The old model had `stage.clarification.required` (`always`/`conditional`) which
the spike turned into a front-gate `question` human task. The flat frontmatter
model has no `clarification` field. Decide later whether:
- agents just call the `ask_question` MCP tool ad hoc when they need input
  (current assumption — no declared front gate), or
- we reintroduce a declared clarification gate on the stage block.

For now: **no declared clarification gate**; clarifications happen via the
`ask_question` MCP tool at the agent's discretion.

## 4. Other deferred seams

- **ACP session driver** — we build headless CLI execution first (simple,
  consistent across CLIs; output via the `send_output` MCP tool). A full ACP
  JSON-RPC stdio driver (live token streaming, tool-call interception, ~v1
  `acp-client.js`) is a later, isolated slice behind the same spawn seam.
- **Trigger / resume Lambda** — out of scope here. The container writes the v2
  state table on stage start/end/error and `init-ws`; the future lambda that
  invokes AgentCore for a stage and resumes after a human answer reads/writes the
  same schema. No dispatcher/control-plane is being built now.
- **Team-knowledge write-back** — the `team` knowledge tier and the
  `team-learnings`/`project-learnings` rule layers are seeded empty and accrued
  at runtime. The learning-loop write path is not built yet.
- **Bedrock AgentCore Terraform support** — RESOLVED: the runtime is declared via
  the `hashicorp/awscc` provider (`awscc_bedrockagentcore_runtime`, mirroring the
  CloudFormation `AWS::BedrockAgentCore::Runtime` type) in
  `terraform/modules/compute/agentcore/`. It is the single awscc resource; the
  rest of the stack stays on `hashicorp/aws`. **Open:** the module sets
  `network_configuration.network_mode = "PUBLIC"`. Neptune lives in a private VPC —
  if AgentCore Runtime PUBLIC mode cannot reach it, switch to the VPC network mode
  and wire `private_subnet_ids` + a security group (parallel to the agents module)
  once VPC support is confirmed in-region. Also verify the awscc artifact shape
  (`agent_runtime_artifact.container_configuration.container_uri`) against the
  installed provider version before first apply.
- **Trigger/resume Lambda (next)** — the AgentCore image + state table + runtime
  exist but nothing invokes them yet. The future lambda: on intent create →
  invoke `init-ws` (new session id); per stage → invoke `run-stage` reusing the
  SAME session id (keeps the checkout); on human answer → write the HUMAN# gate
  (the MCP `ask_question` poll unblocks) and re-invoke the next stage. It
  reads/writes the same `v2-process-keys` schema this work already provisions.
