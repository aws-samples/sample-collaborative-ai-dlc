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

It also **owns the learning-loop curation gate** (see the runtime learning loop
below). Accrued `TeamKnowledge` / `LearningRule` are append-only and unvetted
today. When this lambda lands, give the learning loop the same human-validation
gate as a stage: on a stage that recorded learnings, park a `HUMAN#` approval
before they steer later intents, and on approval mark the learning `active`
(`run-stage`'s reads should then filter to `active`). This is also the natural
home for **promotion** — an approved project learning can be promoted into a
`default`/SYSTEM library block (team-knowledge tier / a rule layer) so it crosses
projects, reusing the building-blocks CRUD path.

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

## Realtime intent channel — frontend consumer

The runtime now **publishes** every relevant process event on the intent's
realtime channel (`intent:<intentId>`): `agent.workspace`, `agent.execution`,
`agent.stage`, `agent.output`, `agent.question`, `agent.metric`, `agent.note`
(see [`v2-agent.md`](./v2-agent.md) for the envelope + table). The backend
publish side is built and tested.

What remains is the **frontend consumer**: the realtime-token layer
(`frontend/src/lib/realtimeToken.ts`) and the `$connect` authorizer scope only
`sprint:` / `project:` channels today, so the UI can't yet subscribe to
`intent:`. To light up the v2 UI: add an `intent:` channel format (token target +
scope check), a realtime-token endpoint for an intent, and a hook that subscribes
and reacts (notify on `agent.question`, advance state on `agent.stage` /
`agent.execution`, stream `agent.output`, show usage from `agent.metric`). The v1
`useObservabilityEvents` hook is the pattern to mirror.

## Runtime learning loop — built

Both halves of the runtime learning loop now accrue per-project in Neptune (hung
off the `Project` vertex, so a learning recorded in one intent steers every later
intent in the project — business data kept where the rest of the business graph
is, not in the blocks table). Provenance (`project_id`, `created_by_intent_id`,
execution/stage) is stamped from the trusted container ENV on every write, never
agent args — spoof-proof like artifacts. Two steering KINDS:

**Team knowledge (reference prose).** `TeamKnowledge` vertices
(`Project --HAS_KNOWLEDGE--> TeamKnowledge`).

- **Write** — the author agent calls `record_team_knowledge` when it learns
  something durable (a convention, decision, constraint, gotcha).
- **Read** — `run-stage` fetches the project's knowledge for the stage's agent
  (+ the `shared` corpus) and injects it into the prompt's `## Reference
knowledge` section; the read-only `get_team_knowledge` tool (also granted to
  reviewers) re-reads on demand. This also fixed the methodology tier, whose read
  path was silently dead (`loadLibrary` never loaded `KNOWLEDGE`).

**Learning rules (binding guardrails).** `LearningRule` vertices
(`Project --HAS_LEARNING--> LearningRule`) at the `team-learnings` /
`project-learnings` layers. Where knowledge steers by reference, a rule steers by
**precedence**.

- **Write** — the author agent calls `record_learning_rule({ id, title, content,
layer })` for an ALWAYS/NEVER constraint that must bind later work.
- **Read / apply** — `run-stage` reads the project's learning rules and merges
  them into `workflow.ruleRefs` + `library.rulesById` _before_ the execution-plan
  resolver runs, so the **existing** resolver interleaves them into each stage's
  rule stack at priority 1.5 / 2.5 (no new precedence logic — the chain in
  `compile.js` already names these layers). They render into `rules.md` in
  resolved order; `get_learning_rules` lists them on demand. An authored library
  rule of the same id is never overridden by an accrued one.

What remains is **curation / promotion**, not plumbing: accrued knowledge and
rules are append-only and unvetted per project. That work is folded into the
trigger / resume lambda above (the curation gate + cross-project promotion) — to
be tackled when that lambda is implemented.
