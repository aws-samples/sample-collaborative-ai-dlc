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

## Verification axes

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
