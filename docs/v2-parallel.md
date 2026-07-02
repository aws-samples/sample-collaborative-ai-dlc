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

Status: **in progress** — WP0 complete (PoCs verified on the local durable
test runner, see `lambda/v2-orchestrator/test/poc/`); WP1 code-complete
(async run-stage via durable callback); WP2 complete (engine-owned git layer,
`lambda/agentcore/git-engine.js`); WP3 complete (unit DAG promotion —
UNITPLAN/UNIT scheduling rows + Neptune mirror); WP4 complete (plan fan-out +
unit dimension end-to-end); WP5 **code-complete** (parallel lane
orchestration — skeleton/ladder/wavefront/halt-and-ask, per-lane
sessions/branches, engine merge-back; proven on the local durable runner).
⚠️ **Deployment checklist before enabling parallel construction in
production**: WP1's exit criterion — a stage **longer than 15 minutes**
completed through the async callback path on a DEPLOYED stack — is still
unproven (requires a cloud deployment; every local proof passes). WP6+ not
yet started.

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
   **WP0 executed finding (PoC a)**: branches/child contexts that COMPLETED
   before a suspend are **not re-executed on replay** — their DurablePromise
   resolves from checkpointed history. A wavefront built on plain in-handler
   deferreds therefore deadlocks after the first suspend/resume cycle; the
   replay-safe shape is one `ctx.runInChildContext` per lane whose dependents
   await the lane DurablePromises directly (proved with human-gate callbacks
   inside lanes, exactly-once stage steps across replays, and FAILED →
   dependents BLOCKED isolation). Note for WP5: the wavefront shape has no
   built-in `maxConcurrency` (that belongs to `ctx.map`/`ctx.parallel`);
   `maxParallelUnits` needs an app-level semaphore or the batch-barrier
   fallback — replayed lanes never re-execute their bodies, so completed
   lanes never re-contend for permits.
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
   **WP0 executed**: installed as a devDependency of `lambda/v2-orchestrator`
   with a root npm `overrides` entry pinning its peer
   `@aws/durable-execution-sdk-js` to `^2.0.0` (upstream peer range is stale
   at `^1.0.1`); compatibility with 2.0.0 is proven by the PoC suites
   themselves, which run in CI (`lambda/v2-orchestrator/test/poc/`). Two
   local-runner behaviors found while proving PoC (c)/(d): the runner cannot
   interrupt an in-flight step (in-process limitation — interruption is
   demonstrated via the retry path instead), and callback heartbeats are
   rejected unless the callback was created with a `heartbeatTimeout`
   (production run-stage callbacks should set
   `timeout ≈ 8h` + `heartbeatTimeout` for dead-container detection).
6. **Residual unknown**: durable execution operation-count / payload quotas
   under N lanes × stages checkpoints — not verifiable on the local runner;
   still open after WP0, verify via the quotas console / cloud runner early
   in WP1.

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
  lanes are unattributable. ✅ met by WP4.
- **WP6b (extra PR strategies) must not start until WP8's merge fixtures pass**
  on `intent-pr`.
- **WP7's lane board must not start until the frontend is re-keyed on
  `stageInstanceId`** (WP7 step 1).

Work packages:

- **WP0 — PoCs (local)** ✅ **done**: this document; four PoC suites on the
  local test runner, kept permanently under
  `lambda/v2-orchestrator/test/poc/` as executable documentation:
  (a) `poc-a-wavefront.test.js` — batch barriers vs true wavefront over the
  real `parseBoltDag` output, including the replay-semantics finding (B1) and
  FAILED → BLOCKED lane isolation; (b) `poc-b-multi-callback.test.js` —
  N concurrent human-gate callbacks, out-of-order resume, per-lane answer
  attribution, gate cancellation isolation; (c)
  `poc-c-interrupted-step.test.js` — why sync run-stage must go (at-least-once
  step bodies re-run the whole stage; AtMostOncePerRetry fails it instead;
  the callback shape suspends at zero compute); (d)
  `poc-d-async-stage.test.js` — full async-stage lifecycle
  (createCallback → dispatch step → suspend → container callback → finalize
  step) across replays, exactly-once dispatch per attempt, out-of-order job
  completion, container-reported failure → fresh-callback retry, heartbeats.
- **WP1 — Async stage invocation** 🔨 **code-complete** (cloud exit criterion
  pending): callback-based run-stage (finding B2), implemented as:
  - orchestrator (`lambda/v2-orchestrator/index.js` `runStage`): per stage
    attempt `ctx.createCallback('stage-cb-<stageId>[-resume-<gate>]', {
timeout: 8h, heartbeatTimeout: 15m })` → short `run-stage-start` dispatch
    step → suspend on the callback for the verdict. **Verified pitfall**:
    `createCallback`'s default serdes is PASS-THROUGH (steps use JSON) — the
    orchestrator JSON-decodes the callback body defensively
    (`stage_bad_callback_result` on garbage). Callback rejection (timeout /
    heartbeat expiry = dead container) → `stage_callback_failed`; dispatch
    refusal → accept-time stage failure. One uniform decode path over
    `result.state` (the container always sends a state).
  - container (`lambda/agentcore/commands/run-stage-start.js`): validates,
    guards duplicates (same attempt + same callbackId → idempotent accept for
    dispatch-step retries; different callbackId → `job_already_running`), runs
    the untouched `runStage` as a background job holding the /ping busy
    tracker (HealthyBusy keeps the session alive), heartbeats every 60s,
    and ALWAYS completes the callback — success, ok:false failures, and
    crashes (`stage_job_crashed`) — via
    `lambda/agentcore/clients.js` `sendStageCallbackSuccess` (5-attempt
    backoff; orchestrator heartbeatTimeout is the final backstop).
  - `stageCallbackId` persisted on the STAGE row (`buildStageRow` /
    run-stage putStage) for traceability + manual operator recovery.
  - IAM: agentcore task role gets `lambda:SendDurableExecutionCallback{Success,
Failure,Heartbeat}` on the orchestrator function (ARN by naming convention
    — module dependency direction forbids passing it in).
  - tests: `lambda/agentcore/test/run-stage-start.test.js` (background-job
    lifecycle), reworked `orchestrator.test.js` (fake ctx models the callback
    seam), and `orchestrator-replay.test.js` — the REAL handler on the local
    durable runner: park → out-of-band gate answer → resume → succeed,
    FAILED verdict, cancel sentinel; exactly-once side effects across replays.
  - **Exit criterion (open)**: a stage **longer than 15 minutes** completed
    through the callback path on a deployed stack — required before WP5.
- **WP2 — Deterministic git layer** ✅ **done**: `lambda/agentcore/git-engine.js`
  (argv-based `git`, `shell:false`, never throws — failures are values):
  - **stage-exit hook**: `commitAndPushAll` runs in run-stage after EVERY CLI
    exit (success, park, fail) — commit message `aidlc(<stageId>): <executionId>`
    (unit dimension joins in WP4), engine identity via per-command `-c` flags
    (repo config never mutated). Sensors run after the hook on the same tree;
    a sensor hold happens with the work already pushed (retry-safe).
  - **v1 `pushBranchWithRetry` semantics ported**: retry + linear backoff
    (2s/4s), push `HEAD:refs/heads/<branch>` refspec, remote-HEAD verification
    via ls-remote (mismatch = race → still pushed; unreadable → trust exit
    code), `'empty'` neutral sentinel for commit-less repos.
  - **credential scrubbing**: workspace.js resets origin to the token-free URL
    immediately after every clone (and adds it after the `git init` fallback);
    the tokenized URL exists only inside the engine's push window and is
    restored in a `finally`. The agent's checkout never holds a token.
  - **no-network fast path**: push is skipped when there is no new commit AND
    the remote-tracking ref matches HEAD (`isAheadOfRemote`), so artifact-only
    stages on token-less projects behave exactly as before; a clean tree that
    is ahead still pushes (retries a previously failed push).
  - **failure policy**: `push_failed` fails the stage ONLY when THIS run
    committed work that did not reach the remote (new work at risk — the loss
    mode); a parked stage parks regardless (human loop never blocked, resume
    retries); failures are always visible as `v2.git.push_failed` events,
    successes as `v2.git.pushed`.
  - **prompts lose git**: the annex now forbids the agent from running any git
    command (engine-owned; the steering block asks for file fixes, not
    `revert/redo the commits`).
  - tests: `test/git-engine.test.js` — REAL git against local bare remotes
    (commit/push/retry/verify/scrub, multi-repo, up-to-date skip, ahead-retry);
    run-stage hook wiring + failure-policy suite; workspace scrub suite.
  - Closes the documented v2 working-tree loss mode for the sequential flow:
    pushed commits survive the mount wipe that self-heal re-clones from.
- **WP3 — Unit DAG promotion** ✅ **done**:
  - **data model** (`lambda/shared/v2-process-keys.js` / `v2-process-store.js`):
    `UNITPLAN` singleton snapshot (units, batches, skipMatrix, walkingSkeleton,
    autonomyMode, source artifact + producing stage provenance) and
    `UNIT#<slug>` lane rows (dependsOn, state, batchIndex, branch/session +
    terminal fields) with GSI2 `TYPE#UNIT#STATE#<laneState>` so "all READY
    lanes" is one query. Lane states `PENDING → READY → RUNNING → MERGING →
MERGED | FAILED | BLOCKED`; `updateUnitState` is CAS'd on `fromStates`
    (WP5 concurrency-safe), `syncUnitRows` protects active lanes on
    re-promotion (creates missing, refreshes PENDING/READY, preserves
    started, reports orphans — never deletes audit history).
  - **promotion command** (`lambda/agentcore/commands/promote-units.js`,
    dispatched by the orchestrator right after the stage producing
    `unit-of-work-dependency` succeeds — sensors passed, gates answered):
    re-reads the current (non-superseded, newest) artifact from the graph,
    re-parses with the SAME `parseBoltDag` the sensor used, writes the DDB
    scheduling truth, then mirrors `UnitOfWork` vertices (+ `DEPENDS_ON`,
    `DERIVED_FROM` source-artifact edge, Intent `CONTAINS` anchor) — the
    mirror never blocks promotion (`v2.units.mirror_failed` recorded).
    Note: the `UnitOfWork` vertex label was NOT previously allowlisted (the
    plan text assumed it was) — added to the graph writer as `mirrorUnitDag`
    following the TeamKnowledge pattern; re-promotion supersedes dropped
    units and revives re-added ones.
  - **decision fields** (rules 7–9): frozen with deterministic defaults —
    skipMatrix `{}` (all EXECUTE), walkingSkeleton = first slug of the first
    topological wave, autonomyMode `null`; preserved across re-promotion;
    `updateUnitPlanDecisions` is the WP5 fan-out-gate patch point.
  - **orchestrator hook**: `promote-units-<stageId>` durable step, fires only
    when the plan stage's `outputArtifacts` include `unit-of-work-dependency`
    (structural, no hard-coded stage names); a refused/failed promotion fails
    the run (`units_promotion_failed`) — deterministic, instead of a missing
    UNITPLAN surfacing at fan-out; `v2.units.plan_ready` event on success.
  - tests: keys/builders + store methods (CAS, sync protection, GSI2),
    promote-units command suite (14), real-gremlin `mirrorUnitDag` suite
    (idempotency, supersede/revive), orchestrator hook ordering suite (also
    proves promotion waits for the park loop to drain).
- **WP4 — Plan fan-out + unit dimension through the data model** ✅ **done**:
  - **plan layer** (`lambda/shared/v2-execution-plan.js`): plan entries carry
    `forEach` / `execution` / `parallelSection` (1-based, matching `s<k>`
    naming); sections detected structurally as maximal contiguous
    `forEach: unit-of-work` runs w.r.t. the topological run order (N sections
    generic); plan exposes `namespace` + `sections`; validations
    `no_unit_dag_producer` (an in-scope NON-forEach producer must precede each
    section — a producer inside a section cannot gate its own fan-out) and
    `unsupported_for_each` (any other forEach value fails loudly rather than
    running once and breaking the stage's own contract).
    `stageInstanceId(ns, stageId, unitSlug?)` gains the unit dimension
    (`si-sha256(ns:stageId:unit-<slug>)`, null-slug = legacy id); exported
    `planSegments` splits the ordered stages into the orchestrator's walk.
  - **unit dimension end-to-end (the WP5 precondition — MET)**: `unitSlug`
    (null default) on STAGE/EVENT/HUMAN/SENSOR/METRIC/OUTPUT rows + all store
    writers; run-stage accepts `unitSlug` (invariants: `unit_required` on a
    forEach stage without a unit, `unit_not_applicable` on the inverse,
    `unit_not_found` when the slug is not in the promoted UNITPLAN), computes
    the per-unit instance id from `plan.namespace`, stamps the slug on every
    row/event/broadcast, commit message gains the unit
    (`aidlc(<stage>): <unit> — <executionId>`); `V2_UNIT_SLUG` flows through
    the MCP config → process-bridge (gates opened by parallel lanes are
    attributable); the prompt gains a deterministic **unit-scope block**
    (slug + dependsOn from the UNITPLAN, lane boundary rules) injected before
    the stage prose; `run-stage-start`'s job key gains the lane dimension
    (one job per stage attempt PER LANE); WS payloads carry `unitSlug` +
    new `agent.unit` action for `v2.unit.*` lifecycle events; REST
    `IntentDetail` carries `unitSlug` on stages/gates/events/outputs/
    sensorRuns plus new `unitPlan` + `units` arrays (frontend types additive;
    re-keying the stage merge is WP7 step 1).
  - **orchestrator sequential fan-out** (`lambda/v2-orchestrator/index.js`):
    the stage loop is now a `planSegments` walk; a section loads the UNITPLAN
    (`unit_plan_missing` fails deterministically), iterates lanes ONE AT A
    TIME in batch order — per lane: CAS PENDING/READY→RUNNING (lost CAS
    tolerated: STAGE rows are the execution truth, the UNIT row is the lane
    view), section stages via per-unit durable identities
    (`stage-cb-<stage>-u-<slug>[-resume-<gate>]`), frozen skip matrix honored
    for `execution: CONDITIONAL` stages only (SKIPPED stage row + event),
    lane end → MERGED (WP4's identity merge: lanes run in the intent session
    ON the intent branch; real branches/merges are WP5/WP6), failure → lane
    FAILED + direct dependents BLOCKED + attributable `stage_failed`
    (`<stage> [unit <slug>]`); `v2.unit.started/merged/failed` events +
    `agent.unit` broadcasts; rewind-upstream-check expands forEach stages per
    unit (SUCCEEDED or SKIPPED counts); the WP3 promote hook rides only
    once-per-workflow segments.
  - **rewind** (`lambda/intents/index.js`): reset expands per-unit instances
    for forEach stages (STAGE rows + artifact supersede by per-unit instance
    ids) and re-opens touched lanes (UNIT rows → PENDING, verdict fields
    cleared); reset events carry `unitSlug`.
  - tests: plan-layer suite (sections/validations/segments), row-builder +
    store unit-dimension suites, run-stage unit-lane suite (instance ids,
    invariants, prompt scope, commit message), materializer/bridge/job-key
    suites, orchestrator fake-ctx section suite (order, skip matrix, failure
    blocking, unit_plan_missing, lane park/resume, rewind) **and a real
    durable-runner replay test** (mid-lane park → resume with exactly-once
    lane bookkeeping), intents DTO + rewind-expansion suites.
- **WP5 — Parallel lane orchestration** 🔨 **code-complete** _(the WP1 >15-min
  cloud proof remains a deployment-time checklist item — see Status)_: the
  deterministic replacement for v1's LLM construction orchestrator, as
  `lambda/v2-orchestrator/section.js` + the lane git/commands layer:
  - **engine gates**: approval HUMAN# rows the ORCHESTRATOR opens (same row +
    callback + cancel/supersede discipline as agent question gates, so the
    existing answer endpoint and UI apply unchanged). Deterministic ids
    `eg-<name>-<runId>`; META parks WAITING while pending (engine gates are
    barriers — cancel works); a superseded gate retires the run with no
    writes; answers are parsed defensively (`parseChoice`) with SAFE
    deterministic fallbacks (ladder → `gated`, halt → `abort`), and every
    interpretation is audited.
  - **fan-out gate** (rules 2/7/8): opens before any lane with the frozen
    defaults (units, waves, skip matrix, skeleton pick); the structured answer
    may override `walkingSkeleton` / `skipMatrix` — validated against the plan
    (only CONDITIONAL section stages skippable; the skeleton must be
    DEPENDENCY-FREE since it runs solo first); invalid entries are rejected
    into a `v2.units.decisions_invalid` audit event; the effective decisions
    are frozen as a durable step result + `updateUnitPlanDecisions`.
  - **walking skeleton** (rule 8): the picked lane runs SOLO → merges → a
    mandatory Bolt-level approval gate (design + code as one increment),
    regardless of autonomy mode; rejection stops the run (work preserved).
  - **autonomy ladder** (rule 9): one prompt after the skeleton gate —
    `autonomous` vs `gated`; recorded on META (`constructionAutonomyMode`,
    validated in the store) + UNITPLAN (`autonomyMode`); a pre-set
    UNITPLAN.autonomyMode (resume/re-promotion) skips the prompt.
  - **lanes**: own AgentCore session (`aidlc-intent-<id>-s<k>-<slug>`), own
    workspace, own branch (`<intentBranch>--s<k>-unit-<slug>`); `init-lane`
    (container command, lane session) clones the intent branch, creates/checks
    out the unit branch from intent HEAD and PUSHES it (self-heal can re-clone
    it); the lane's stages run through the WP4 executeStage with lane-scoped
    sessions/cloneInputs (`branch=unitBranch, baseBranch=intentBranch`),
    per-lane park/resume + release-on-park (the LANE session is stopped, never
    a sibling's); lane end = `merge-lane` (container command, INTENT session):
    fetch → reset local intent branch onto the remote → `--no-ff` merge with
    the engine identity → push, idempotent (`up_to_date` on re-dispatch),
    conflicts abort cleanly and report the conflicted paths (the WP6
    conflict-resolution stage consumes them; until then the lane FAILS into
    halt-and-ask). Merges are serialized by an in-process merge lock;
    topo-safety holds because dependents only start after their deps MERGED.
  - **scheduling**: `autonomous` = TRUE WAVEFRONT (one `runInChildContext` per
    lane, dependents await their dependency lanes' DurablePromises — poc-a's
    replay-safe shape; failures convert to lane states, never throws) with an
    app-level semaphore honoring `maxParallelUnits` (new project setting,
    0 = unbounded; snapshotted onto META at intent create; acquired AFTER the
    dependency wait so blocked lanes hold no capacity). `gated` = batch
    barriers over the topological waves with ONE approval gate per batch.
  - **halt-and-ask** (stage-protocol.md): a failed lane BLOCKS its direct
    dependents; independents finish (allSettled join); then one gate —
    `retry` (same branch/worktree, fresh durable round `-r<n>` identities,
    revives FAILED/BLOCKED lanes via CAS) / `skip` (audited
    `v2.units.lanes_skipped`; blocked lanes stay blocked; fan-in proceeds
    without them and says so) / `abort` (`section_aborted`; pushed work +
    merged lanes preserved). Unbounded retry rounds by design — each is one
    explicit human decision.
  - **git layer** (`git-engine.js`): `fetchOrigin` (the authenticated READ
    window — token injected only between set-url and the finally-scrub, like
    pushBranch), `ensureLaneBranch` (remote-truth idempotent branch
    creation/checkout + push), `mergeBranchNoFf` (remote-based merge base,
    ancestor short-circuit, conflict collection + clean abort, engine
    identity, push with retry/verify).
  - tests: real-git suites for the three new engine helpers + the two lane
    commands (conflicts, idempotency, wiped-mount self-heal, token scrubbing);
    fake-ctx orchestrator suites (full lifecycle order, lane sessions,
    RUNNING→MERGING→MERGED, retry/skip/abort, autonomous blocking, fan-out
    overrides + rejections, ladder default, pre-set autonomy); section-helper
    unit suites (semaphore, merge lock, choice parsing, override validation,
    naming); and REAL durable-runner replay proofs — full section through
    three engine gates with a mid-lane park, exactly-once lane bookkeeping,
    CONCURRENT independent lanes completing out of order, and
    halt-and-ask abort preserving the merged skeleton.
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
  **Pulled forward (passing)**: the two merge fixtures landed with WP5 as
  `lambda/v2-orchestrator/test/section-integration.test.js` — the REAL
  orchestrator on the REAL durable runner dispatching the REAL
  init-lane/merge-lane commands against REAL git bare remotes (the only fakes:
  in-memory store + the agent CLI, replaced by real file writes + the real
  engine commit/push hook). Fixture 1 proves C's lane workspace genuinely
  contains merged A+B code, per-lane sessions, three `--no-ff` merge commits,
  and preserved unit branches; fixture 2 proves a real add/add conflict fails
  the lane with repo-qualified conflicted paths, halt-and-ask SKIP completes
  the run honestly (fan-in reports 2/3), and the intent branch/tree stay
  pristine with the conflicted lane's work preserved on its unit branch.
  Remaining for WP8: kill-a-lane mid-stage (cloud-flavored) + the
  `disjoint-files` sensor.

---

## Decisions log

- **What parallelizes**: units of work from the `unit-of-work-dependency` bolt
  DAG (per-unit construction lanes).
- **Blocking granularity**: lane-level. A unit starts only when all
  `depends_on` lanes are fully MERGED.
- **Wavefront mechanism** (WP0 verified): one `ctx.runInChildContext` per
  lane; dependents await their dependency lanes' DurablePromises. Plain
  in-handler deferreds are forbidden — completed lanes do not re-execute on
  replay, so deferreds never re-resolve (proven in PoC a). Batch barriers
  via `ctx.map` remain the fallback and the natural `maxParallelUnits` shape.
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
- **Skeleton eligibility** (WP5): the walking skeleton must be a
  DEPENDENCY-FREE unit — it runs solo first, so a dependent pick would block
  on its unmerged deps immediately. The fan-out gate rejects such overrides
  (audited), keeping the promotion default.
- **Engine-gate fallbacks** (WP5): unparseable gate answers resolve to the
  SAFE deterministic choice — autonomy ladder → `gated` (more human
  checkpoints, never silent autonomy), halt-and-ask → `abort` (never silent
  continuation). Every interpretation is recorded as an event.
- **Halt-and-ask `skip`** (WP5): the failed lane stays FAILED and its blocked
  dependents stay BLOCKED; fan-in proceeds WITHOUT them and the fan-in event
  says so — honest partial delivery (upstream: "preserve successful Bolts'
  artifacts"), never a fabricated MERGED state.
- **Merge-back timing** (WP5/WP6 split): the engine `--no-ff` merge-back
  (fetch → remote-based merge → push, serialized, idempotent) landed WITH WP5
  — parallel lanes are meaningless without it (dependents must see merged
  code). WP6 keeps the conflict-resolution STAGE (a conflict currently fails
  the lane into halt-and-ask, with the conflicted paths recorded) + the PR
  strategies.
