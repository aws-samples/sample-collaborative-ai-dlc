# AI-DLC v2 Parallel Construction — Plan

Design and feasibility record for parallelizing per-unit construction work
("bolts") in the v2 execution engine. The parallelization grain is the
**unit of work** from the methodology's own `unit-of-work-dependency` DAG; the
engine schedules deterministic **lanes** over that DAG — no LLM dispatcher
(v1's loss mode #2), and no agent-owned git (v1's loss mode #1). The
methodology is imported from the pinned upstream repo and is **never
modified**; everything below is an interpretation of block metadata the seed
already imports.

Related docs: authoring model in [`v2-building-blocks.md`](./v2-building-blocks.md),
execution slice in [`v2-agent.md`](./v2-agent.md), park/resume design in
[`v2-resume.md`](./v2-resume.md), storage split in [`v2-data-model.md`](./v2-data-model.md).

Status: **planned** (feasibility verified, not yet implemented).

---

## Part A — Methodology mapping

### A1. Where fan-out is defined upstream

Pinned ref: `awslabs/aidlc-workflows@ba0cfe999856033ecb909a9135b46fe10811bf55`
(`terraform/variables.tf` → `aidlc_repo_ref`). These files are seeded into our
system as the **internal runtime snapshot** at S3 `aidlc-runtime/<ref>/<repo-path>`
(classification in `lambda/shared/block-mappers.js` `isRuntimeFile`, writes in
`lambda/seed-blocks/index.js`) — present but unused by the execution layer today.

Key upstream files and definitions:

- `core/aidlc-common/protocols/stage-definition.md` (§ `for_each`): the
  normative fan-out marker: _"artifact slug; stage runs once per instance of
  that artifact. Omit for once-per-workflow stages. Doctor validates the
  artifact is produced by an upstream stage."_
- `core/aidlc-common/stages/construction/*.md`: `functional-design`,
  `nfr-requirements`, `nfr-design`, `infrastructure-design`, and
  `code-generation` all carry `for_each: unit-of-work`. `build-and-test` is the
  fan-in: _"Always executes once after all per-unit stages are finished"_, with
  inputs _"ALL code generation outputs across all units"_.
- `core/aidlc-common/stages/inception/units-generation.md`: produces
  `unit-of-work`, `unit-of-work-dependency`, `unit-of-work-story-map`. Its
  condition text: _"Produces the dependency DAG that … Delivery Planning
  consumes for Bolt sequencing"_.
- `core/aidlc-common/stages/inception/delivery-planning.md`: consumes the unit
  DAG and produces `bolt-plan` (prose iteration grouping, team allocation, risk
  rationale).
- `core/aidlc-common/protocols/stage-protocol.md` (§ Construction Bolt gates):
  walking-skeleton gate, autonomy ladder, batch-level gates ("single gate per
  batch, not one per Bolt"), halt-and-ask failure semantics ("wait for all
  parallel Tasks, preserve successful Bolts' artifacts, retry / skip / abort",
  retry inside the existing worktree).
- `core/tools/aidlc-bolt.ts`: _"A bolt is one execution of stages 3.1–3.5 for a
  Unit (or small group of dependency-linked Units)"_ + per-Bolt worktree
  lifecycle (`start --worktree`, `complete --merge`, `abort --discard`).
- `core/tools/aidlc-swarm.ts`, `core/tools/aidlc-worktree.ts`: the parallel
  split: _"the conductor owns the fan-out (N parallel Task calls) … fork an
  isolated git worktree per unit … the serialised merge-back"_; determinism
  (merge, verdict, audit) in tools, judgement with the human.

Our engine already ports one piece: `parseBoltDag` / `computeBatches` in
`lambda/shared/v2-sensor-contract.js` ("faithful JS port of the upstream lib")
validates the fenced YAML `units:` block of the `unit-of-work-dependency`
artifact at the sensor gate — but nothing schedules from it yet. Stage
`for_each` is mapped to `forEach` (`lambda/shared/block-mappers.js`) and
likewise ignored by the plan resolver and orchestrator.

The upstream model maps 1:1 onto our runtime primitives:

| Upstream (local CLI harness)                                                    | Our v2 engine                                                   |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| git worktree per unit (`aidlc-worktree.ts`)                                     | AgentCore session + unit branch per lane                        |
| conductor issues N parallel Task calls                                          | durable orchestrator `ctx.map` lanes                            |
| serialized deterministic merge-back (`aidlc-swarm.ts`)                          | engine-owned serialized `--no-ff` merges                        |
| check-cmd exit 0 authoritative; "a worker's own success claim is never trusted" | blocking sensors as the verdict                                 |
| batch partial failure: preserve successes, retry / skip / abort                 | lane FAILED → dependents BLOCKED, others finish, human decision |

### A2. Structural rules

Derived **purely from block metadata** — no hard-coded stage names — so the
imported default workflow and any user-composed (forked) workflow get identical
semantics:

1. **Parallel section** := a maximal contiguous run (w.r.t. the topologically
   ordered in-scope plan) of stages with `forEach: unit-of-work`. N sections
   per workflow are supported generically; each section is one
   fan-out → lanes → merge cycle. The default workflow has exactly one.
2. **Fan-out point** := immediately before the section's first stage.
   Plan-time validation: an in-scope upstream stage must produce
   `unit-of-work-dependency`; otherwise the plan fails with
   `no_unit_dag_producer` (same style as `dangling_consume` in
   `lambda/shared/v2-execution-plan.js`; mirrors upstream's Doctor rule).
   At runtime, fan-out requires the human gate on that artifact to be approved.
3. **Lane** := one unit's sequential execution of the section's stages, in plan
   order, in its own AgentCore session (`aidlc-intent-<id>-s<k>-<slug>`),
   own workspace, own git branch. Stage instance ids gain the unit dimension:
   `si-sha256(namespace:stageId:unit-<slug>)` — deterministic, replay-stable.
4. **Lane blocking** := unit U's lane starts only when every `depends_on` lane
   of U has **MERGED** (lane-level blocking). Scheduling truth is the
   `unit-of-work-dependency` snapshot **only**; `bolt-plan` is never parsed for
   scheduling — it stays the human iteration document upstream defines.
5. **Fan-in point** := immediately before the first non-`forEach` stage after
   the section; requires all lanes of the section MERGED. In the default
   workflow this lands exactly on `build-and-test`, matching its own contract.
6. **Multiple sections**: each section fans out from the current intent-branch
   HEAD (which contains the previous section's merged work) and must fully
   merge back before any downstream non-`forEach` stage. Unit branches are
   per-section: `ai-dlc/<intent>--s<k>-unit-<slug>` — a unit gets a fresh
   branch per section, avoiding long-lived divergence.
7. **Per-unit stage skipping**: per-unit stages with `execution: CONDITIONAL`
   are skippable per unit. Mechanism: the fan-out gate presents a
   **unit × conditional-stage matrix** (defaults: all EXECUTE; hints pre-filled
   from the `unit-of-work` artifact's unit metadata, e.g. `unit_type`). The
   approved matrix is frozen into the UNITPLAN snapshot; skipped instances get
   stage state `SKIPPED`. `execution: ALWAYS` stages (e.g. `code-generation`)
   are not skippable. Decisions are deterministic and auditable — no runtime
   LLM judgement.
8. **Walking skeleton first** (stage-protocol.md): the first lane runs **solo**
   with a mandatory Bolt-level approval gate covering its design artifacts and
   generated code together, regardless of autonomy mode. Skeleton selection:
   the `bolt-plan` walking-skeleton marker / team-practices stance, confirmed
   by the human at the fan-out gate (deterministic once approved; a
   `PRACTICES_OVERRIDE`-style event is recorded when practices win over the
   bolt-plan marker).
9. **Autonomy ladder** (stage-protocol.md): immediately after the skeleton gate
   approves, exactly one prompt — **"Continue autonomously"** (remaining lanes
   run without approval gates; failures still halt-and-ask) vs **"Gate every
   Bolt"** (one approval gate per parallel **batch**, not per lane). Recorded
   on execution META as `constructionAutonomyMode: autonomous | gated`,
   audited (`AUTONOMY_MODE_SET`-equivalent event). This **replaces** per-stage
   human gating inside lanes; deterministic sensors and the LLM reviewer still
   run per stage. Failure semantics per upstream: preserve successful lanes'
   pushed work, present retry (same lane/branch) / skip / abort.

### A3. Git mapping onto the phases

All git is **engine-owned and deterministic**; the agent never commits, pushes,
merges, or holds credentials (v1 lost code precisely where agents owned commits
and an LLM orchestrator owned merges).

```
init-ws                     → create intent branch ai-dlc/<intent>
ideation/inception stages   → run on intent branch; ENGINE commits after every
                              stage exit (success, park, fail) + pushes
units-generation gate ✔     → engine re-parses unit-of-work-dependency,
                              snapshots UNITPLAN (DDB = scheduling truth; the
                              orchestrator has no Neptune access), mirrors
                              UnitOfWork vertices + DEPENDS_ON edges to Neptune
                              (traceability/UI only), captures skip matrix +
                              walking-skeleton pick
walking-skeleton lane       → runs SOLO on its unit branch → Bolt-level gate
                              → autonomy ladder prompt
── fan-out (per section) ───
lane start (unit U)         → engine: branch ai-dlc/<intent>--s<k>-unit-<slug>
                              from intent HEAD; own AgentCore session
per-unit stages             → agent works in its workspace; ENGINE commits
                              (aidlc(<stage>): <unit> — <executionId>) and
                              pushes after every stage exit; remote URL is
                              token-scrubbed after clone, re-injected only
                              inside engine push/fetch
lane end                    → engine merges unit branch → intent branch
                              (--no-ff), serialized via merge lock, completion
                              order (topo-safe: deps merged before dependents);
                              conflict → scoped conflict-resolution stage
                              (sensors must pass) → human gate on repeat failure
── fan-in ──────────────────
build-and-test etc.         → run once on the merged intent branch
                              (session aidlc-intent-<id>)
execution SUCCEEDED         → PR(s) per project prStrategy:
                              intent-pr (default) | pr-per-unit | stacked
```

Merging into the _intent branch_ (not base) preserves the methodology's shape:
one intent = one integrated increment, reviewed as a whole; dependent units
genuinely build on their dependencies' merged code because their lanes branch
off _after_ the merge.

---

## Part B — Feasibility findings (verified)

1. **Durable functions support lanes natively.** Verified against the deployed
   SDK (`@aws/durable-execution-sdk-js@2.0.0`, dist-types):
   `ctx.parallel` / `ctx.map` with `maxConcurrency` (omit for unbounded),
   named branches (stable checkpoint identity per unit slug), each branch a
   **full `DurableContext`** (steps, waits, `createCallback` inside lanes),
   independent per-branch checkpointing, `BatchResult` failure isolation
   (`toleratedFailureCount`), multiple concurrently-pending callbacks
   (parallel human gates; `CALLBACK_PENDING`). Wavefront options: batch
   barriers (`for (batch of computeBatches(dag)) await ctx.map(batch, lane)`)
   or true wavefront (lanes await their dependency lanes' DurablePromises);
   PoC proves the latter, the former is the fallback.
2. **CRITICAL prerequisite — async stage invocation.** Today `run-stage` is a
   _synchronous_ durable step (`lambda/v2-orchestrator/index.js` `runStage`),
   but the orchestrator Lambda timeout is 900s
   (`terraform/modules/api/lambda/main.tf`: "one step (a stage) must fit the
   function timeout") **and** AgentCore's synchronous request timeout is a
   hard 15 minutes. Interrupted steps re-execute on re-drive
   (`RETRY_INTERRUPTED_STEP`). Any stage > ~15 min is already at risk
   _sequentially_; N parallel lanes in a hot handler make timeout certain.
   Fix: short `run-stage-start` invoke → container runs the CLI as a
   **background job** (AgentCore async jobs: 8 h max; the `HealthyBusy` ping
   tracker already exists in `lambda/agentcore/http-server.js`) → container
   completes a **durable callback** via `SendDurableExecutionCallbackSuccess`
   (pattern exists in `lambda/intents/index.js` for human gates; container
   task role needs the IAM action). The orchestrator suspends at zero compute.
   This also fixes the latent sequential risk, independent of parallelization.
3. **AgentCore quotas — no blocker** for realistic fan-out: 2,500–5,000 active
   session workloads/account (adjustable), 400 new sessions/min per endpoint,
   `InvokeAgentRuntime` 200 TPS, 2 vCPU/8 GB per microVM, dedicated
   microVM + filesystem per session (the intended isolation model). Watch:
   **1 GB session storage per lane** (clone-size check at fan-out) and cost
   (per-lane release-on-park, extending the existing D1 logic).
4. **UI — feasible on existing primitives.** Multi-gate rendering already works
   (Map-keyed gates, one `GateCard` per pending gate); the hand-rolled DAG
   renderer (`IntentGraph` + exported, tested `layerStages`) is reusable for
   the lane board. Must build: `unitId` dimension across DTOs/WS events
   (none exists), a `UnitState` union + styling
   (`PENDING/READY/RUNNING/MERGING/MERGED/FAILED/BLOCKED`), per-unit
   stage-row merging (today's merge is 1:1 by `stageId` and would collide on
   fan-out instances), refetch debouncing (every `agent.stage` event triggers
   a full DTO refetch — N lanes multiply this), settings fields (pattern:
   `parkReleaseSeconds` in `ProjectSettings.tsx`). No graph library in the
   codebase; staying hand-rolled matches two prior deliberate decisions.
5. **Local PoC without AWS**: `@aws/durable-execution-sdk-js-testing@1.1.1`
   (in-process local runner with real replay/suspend semantics — the existing
   orchestrator tests use a fake ctx that does _not_ exercise replay).
6. **Residual unknown**: durable execution operation-count / payload quotas
   under N lanes × stages checkpoints — verify via the quotas console / cloud
   runner early in WP0/WP1.

---

## Part C — Work packages

Each step leaves the system shippable; sequential flow benefits from WP1+WP2
before any concurrency lands. **Hard ordering gates** (review-identified
failure points — these are preconditions, not preferences):

- **WP5 must not start until WP1 is deployed** and a stage **longer than
  15 minutes** has completed through the async callback path in the
  _sequential_ flow (proves the timeout fix before any concurrency).
- **WP5 must not start until the unit dimension is threaded through the data
  model** (WP3/WP4 deliverable below) — otherwise gates/events from parallel
  lanes are unattributable.
- **WP6b (extra PR strategies) must not start until WP8's merge fixtures pass**
  on `intent-pr`.
- **WP7's lane board must not start until the frontend is re-keyed on
  `stageInstanceId`** (WP7 step 1).

Work packages:

- **WP0 — PoCs (local)**: this document; then four PoCs on the local test
  runner: (a) wavefront with cross-branch dependency awaits vs batch barriers,
  (b) multi-callback park + out-of-order resume, (c) interrupted-step
  demonstration (documents why sync run-stage must go), (d) async-stage
  lifecycle (start step → background → callback → merge step) across replays.
- **WP1 — Async stage invocation**: callback-based `run-stage` (finding B2);
  container-side background job + callback completion + IAM; per-stage
  `callbackId` persisted on the STAGE row. Exit criterion: a >15-min stage
  completes through the callback path in the sequential flow (gate for WP5).
- **WP2 — Deterministic git layer**: `lambda/agentcore/git-engine.js` —
  engine-owned branch/commit/push on every stage exit, credential scrubbing,
  port of v1 `pushBranchWithRetry` semantics (retry + backoff + remote-HEAD
  verification); prompts/annex lose all git responsibility. **All branch
  creation and merging is local `git` (argv-based, `shell:false`) in the
  runtime workspace, pushed and verified — never provider merge APIs** (v1's
  server-side `merge-task-branches.js` path is explicitly not the model here;
  provider APIs are used only to open PRs in WP6). Closes the documented v2
  working-tree loss mode for the sequential flow immediately.
- **WP3 — Unit DAG promotion**: on fan-out gate approval, engine re-parses the
  artifact (`parseBoltDag`), writes UNITPLAN + `UNIT#<slug>` rows to the DDB
  process table (scheduling truth), mirrors to Neptune (`UnitOfWork`,
  `DEPENDS_ON` — already allowlisted); captures skip matrix (rule 7), skeleton
  pick (rule 8), autonomy mode (rule 9). Lane states:
  `PENDING → READY → RUNNING → MERGING → MERGED | FAILED | BLOCKED`.
- **WP4 — Plan fan-out + unit dimension through the data model**: section
  detection over `forEach` in `v2-execution-plan.js`, per-unit stage instances
  with unit-dimension ids, `no_unit_dag_producer` validation, N sections
  generically; `run-stage` accepts `unitSlug` + lane workspace;
  stage-materializer injects the unit's scope (its stories/sections from the
  DAG artifact). **Named deliverable — `unitSlug` threaded end-to-end, as a
  precondition of WP5**: `STAGE#` rows, `EVENT#` rows, `HUMAN#` gate rows,
  `SENSOR#`/`METRIC#`/`OUTPUT#` rows where stage-scoped, WS broadcast payloads
  (`agent.stage`, `agent.question`, new `agent.unit` / `v2.unit.*`), and the
  REST `IntentDetail` DTO (stages, gates, events). Fan-out lands here running
  **sequentially** (lanes executed one at a time) — a safe intermediate state
  that already exercises the whole unit data model before concurrency.
- **WP5 — Parallel lane orchestration** _(gated on WP1 exit criterion + WP4
  unit-dimension deliverable)_: skeleton-solo → skeleton gate → autonomy
  ladder → wavefront over the UNITPLAN (deterministic replacement for v1's LLM
  construction orchestrator); `maxParallelUnits` project setting
  (0 = unbounded → omit `maxConcurrency`); batch-level approval gates in
  `gated` mode; halt-and-ask retry/skip/abort on lane failure (dependents →
  BLOCKED, independents finish, pushed work preserved); per-lane park/resume +
  release-on-park; lane transitions as durable steps + `EVENT#` rows +
  broadcasts.
- **WP6 — Fan-in (intent-pr only)**: serialized `--no-ff` merges in completion
  order (local git in the runtime workspace, engine merge lock; provider APIs
  only to open the PR); conflict-resolution stage (fresh lane, conflicted
  merge state, sensors must pass, engine commits) with human-gate escalation;
  `prStrategy` project setting ships with **`intent-pr` (default) as the only
  enabled value**, reusing `lambda/shared/git-providers*` + the v1
  unmerged-branch guard.
- **WP6b — Extra PR strategies** _(gated on WP8 merge fixtures passing)_:
  enable `pr-per-unit` and `stacked` in `prStrategy`. Until then the two
  options are visible but disabled in settings (design unchanged, timing
  staged).
- **WP7 — UI**: **step 1 (precondition for the rest): re-key all frontend
  stage aggregation from `stageId` to `stageInstanceId`** (which carries the
  unit dimension after WP4) — today's 1:1 `stageId` merge in
  `IntentContext.stageRows` collides on fan-out instances — and land the
  DTO/WS type changes. Then: lane board (rows = units via `layerStages`,
  embedded stage strips, DAG edges; skeleton lane visually distinct), gate
  lane-attribution, batch gates, refetch debouncing, settings
  (`maxParallelUnits`, `prStrategy`, autonomy default) in the v2
  ProjectSettings card.
- **WP8 — Hardening**: integration fixtures — 3-unit DAG (A,B ∥ → C: A∥B run,
  C waits and sees merged A+B code), forced merge conflict (exercises the
  conflict stage), kill-a-lane mid-stage (pushed park-commits survive a mount
  wipe); `disjoint-files` advisory sensor on the unit DAG (warn on overlapping
  file ownership). Passing merge fixtures unlock WP6b.

---

## Decisions log

- **What parallelizes**: units of work from the `unit-of-work-dependency` bolt
  DAG (per-unit construction lanes).
- **Blocking granularity**: lane-level. A unit starts only when all
  `depends_on` lanes are fully MERGED.
- **Scheduling source**: the unit DAG only. `bolt-plan` stays prose and is never
  parsed for execution.
- **Custom workflows**: N parallel sections handled generically (structural
  `forEach` rule).
- **Per-unit conditionals**: skippable per unit via human-approved matrix at the
  fan-out gate.
- **Human gating in construction**: methodology model: walking-skeleton gate +
  autonomy ladder + per-batch gates — replaces per-stage lane gates.
- **Merge conflicts**: deterministic merge; conflict → scoped agent stage +
  sensor verification; human on repeat failure.
- **Branch/PR model**: per-project `prStrategy`: intent-pr (default) /
  pr-per-unit / stacked — **staged**: intent-pr ships in WP6; the other two
  unlock in WP6b after WP8 merge fixtures pass.
- **Git ownership**: engine-only (branch, commit, push, merge); agents hold no
  credentials.
- **Merge mechanics**: local git in the runtime workspace (never provider merge
  APIs); provider APIs open PRs only.
- **Sequencing**: git layer + parallelization as one combined effort (async
  invocation first); hard gates: WP1 >15-min proof and WP4 unit-dimension
  deliverable before WP5.
- **Concurrency cap**: per-project `maxParallelUnits`; 0 = unbounded
  (DAG-limited).
