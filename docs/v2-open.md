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
- on a human answer → write the `HUMAN#` gate to `answered` and issue a **resume**
  `run-stage` (`resumeFrom=<humanTaskId>`, same session id) so the parked CLI
  conversation continues with the answer. See [`v2-resume.md`](./v2-resume.md) for
  the park/resume model, the persistent `/mnt/workspace` session storage, and the
  lifecycle/timeout configuration that replace today's blocking `ask_question`.

It also owns the two park/resume behaviors below (**D1**, **D2**) and per-project
model selection.

### D1 — Release-on-park (configurable per project)

After a question parks, the lambda frees the idle microVM compute instead of
letting it linger until the runtime idle backstop reaps it.

- Schedule a `StopRuntimeSession` `park_release_seconds` after the park.
- `park_release_seconds` is a **per-project setting** on the project vertex, saved by
  `Admin.tsx` (alongside `cli_models`); the lambda reads it from DynamoDB.
- **Default 300s** (5 min). `0` = stop immediately. Bounded by the runtime-level
  `idle_runtime_session_timeout` backstop (900s) — a larger per-project value has no
  effect beyond it (the runtime reaps first).
- Resume re-mounts the persistent session storage, so a stopped session loses no
  state (see [`v2-resume.md`](./v2-resume.md)).

Work items:

- [ ] `Admin.tsx`: add the `park_release_seconds` field; persist on the project vertex.
- [ ] Lambda: read it from DynamoDB; schedule `StopRuntimeSession` after a park.
- [ ] IAM: grant the lambda `bedrock-agentcore:StopRuntimeSession`.

### D2 — Resume with a missing/wiped session store

Managed session storage is wiped on **runtime version update** (every image redeploy)
and after **14 days** idle. A parked session's compute is already terminated, so it
does **not** get the old-version stickiness that protects live sessions — its next
invoke after a redeploy gets a fresh, empty file system. The durable
artifacts/answers live in DynamoDB/Neptune; only the in-progress CLI conversation +
uncommitted working-tree edits are lost. On resume, branch on the gate's `askedAt`:

- **gate < 14 days old** (assume a redeploy wipe) → re-run `init-ws` (re-clone at the
  branch) + re-run the stage fresh, **injecting the answered Q&A into the prompt** so
  the agent does not re-ask. Routine deploys never strand work.
- **gate ≥ 14 days old** (storage idle-expiry) → **hard-fail** the resume
  (`resume_store_expired`) and show a **stale-project warning** in the UI.

Work items:

- [ ] Lambda/`run-stage`: detect a missing store on resume; branch on `askedAt`.
- [ ] Recent path: re-`init-ws` + re-run stage fresh with the answered Q&A injected.
- [ ] Expired path: surface `resume_store_expired`; UI stale-project warning.

### D3 — Multiple pending gates per stage

A single stage run can leave **more than one** pending `HUMAN#` gate: the agent may
call `ask_question` several times before it stops (e.g. an initial batch, then a
follow-up). Each call mints a distinct `humanTaskId` and overwrites
`META.pendingHumanTaskId` — so **`META.pendingHumanTaskId` always points at the
LATEST gate**, which is the one the parked CLI turn is actually waiting on. The
runtime is already correct here: `run-stage`'s park-check keys off the meta pointer,
and resume targets the specific `resumeFrom` gate it is given (`cliSessionId` is
stable across resumes — same conversation). The gap is purely in the **answer +
resume orchestration**, which must not assume one gate:

- **Answering:** answer the gate the resume will target — the one
  `META.pendingHumanTaskId` points at (the latest) — not "the first pending gate
  found". Answering an older sibling gate leaves the resume target `pending`, and the
  resume correctly refuses with `gate_not_answered`. (This is exactly the bug fixed in
  `scripts/phaseb-answer.mjs`, which now reads `META.pendingHumanTaskId` first; the
  lambda must do the same.)
- **Resuming:** issue the resume with `resumeFrom = META.pendingHumanTaskId`. One
  resume continues the conversation; if the agent immediately parks **again** (asks
  another question on the resumed turn), that is a fresh park cycle — answer the new
  meta pointer and resume again. Older already-answered gates stay as the durable Q&A
  record; they are not re-resumed.

Work items:

- [ ] Lambda: answer + resume against `META.pendingHumanTaskId`, never "first pending".
- [ ] Lambda: tolerate a resume that parks again (loop the answer→resume cycle).
- [ ] UI: see the multi-question note in the frontend-consumer section below.

### Per-project model selection

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

**Multiple open questions (see D3 above).** A stage can have more than one pending
`HUMAN#` gate at once — the agent may ask several questions before parking. The UI
must therefore render a **list** of open questions for an intent (query the gates
where `status = pending`), not a single prompt, and let the human answer each. The
gate the agent is actively parked on is `META.pendingHumanTaskId` (highlight it as
the one that unblocks the resume); the others are still legitimate, answerable, and
become the durable Q&A record once answered. `agent.question` events arrive one per
`ask_question` call, so the consumer should **accumulate** them into the list rather
than replacing the prior one.
