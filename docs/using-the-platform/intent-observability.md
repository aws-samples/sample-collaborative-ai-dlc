# Observing Intents

Once an intent is running, the platform gives you several complementary surfaces — all live, all backed by the same durable process state. This page walks through each, then covers how to interact with a run: gates, steering, and rewind.

## The pipeline bar

Every intent page shares a top **pipeline bar**:

- **Phase chips** — the workflow's phases with done/active/pending states and per-phase progress.
- **Navigation** — buttons to switch between the intent's views: the **workbench** (default), **Graph**, **Observability**, and **Audit**.

## The activity panel

The right-hand rail is a three-tab activity panel available on all intent views:

- **Agent** — the live, streamed output of each stage, with **Follow run** auto-following the currently running stage. Output is durable: reloading the page replays it.
- **Timeline** — the append-only event trail: stage transitions, gates, sensor verdicts, workspace events, steering.
- **Discuss** — intent-scoped discussion threads. See [Discussions](discussions.md).

## The workbench

The default intent view is the **workbench** — the working surface for humans:

- **Draft card** — for a DRAFT intent, the "Review & start" card with the prompt, scope, and branch.
- **Work products** — the artifacts produced so far (requirements, stories, designs, decisions), grouped by phase, each with a type badge, markdown body, provenance ("produced by _stage_"), and its own discussion thread. Superseded artifacts stay visible but dimmed.
- **Derived items** — the granular, typed items extracted from the artifacts (stories, personas, requirements, components, decisions, units of work), with graph-context popovers for navigating traceability without leaving the page.
- **Gates** — pending questions and approvals render inline (see [Human gates](#human-gates) below).
- **Course corrections** — the steering history of the run.

### HTML artifacts

The visual artifacts `wireframes`, `user-flow`, and `mockups` can be a complete HTML page instead of markdown. They render as a page wherever an artifact is shown (work products, stage review, artifact history), with a **Rendered / Source** toggle. Other artifact types stay markdown: the agent tools, Quorum rewrites, and manual edits refuse HTML for them.

The page renders in a fixed-height, scrollable sandboxed frame with scripts and links disabled and all network requests blocked, so only inline CSS, inline SVG, and `data:` images display. To get HTML mockups from a stage, request changes at its review gate and ask for the visual outputs as static HTML.

## The observability page

The **Observability** button opens the intent's execution dashboard:

- **Initial prompt** — the final user-authored draft that started the intent, preserved read-only with a copy action.
- **Usage & activity** — aggregated token usage and cost for the whole intent. Costs are computed per stage from live model pricing; Kiro runs show estimated cost derived from credits.

  Token usage comes from CLI output, including lead, repair, reviewer, support, and
  conflict-resolution calls. Claude input totals include uncached input, cache reads,
  and cache writes; **Usage details** shows the cache counts separately. Costs apply
  the corresponding cache rates, including one-hour writes when the CLI reports
  them. Codex reports cumulative thread totals, so resumed calls subtract the
  saved thread usage and record only the new usage. Codex input totals already
  include cache reads and writes. A Codex run with no model selected uses the
  pinned Codex default (`openai.gpt-6.1-sol`) and is recorded under it. Kiro
  credits use the captured overage rate and remain an estimate.

  Usage is recorded when each invocation ends, including reported usage on failure
  or before a human pause. If a CLI stops without reporting usage, the runtime
  does not guess it. Older self-reported samples remain in history; this change
  does not reconstruct missing usage from earlier runs. The agent-facing
  `collect_metric` tool has been removed. Context-window gauges remain visible
  for historical samples that include them.

- **Execution progress** — the stage pipeline in three switchable views (your choice is remembered):
  - **Diagram** — a phase-grouped flow diagram with per-phase progress.
  - **Graph** — the workflow scope graph with live stage status overlaid.
  - **List** — a phase-grouped accordion of stages.

Selecting any stage opens the **stage detail** drill-down:

- State, attempt count, and the CLI/model that ran it
- Durations — total wall clock split into **active** vs. **waiting** (parked on humans)
- Dependencies on other stages, derived from the compiled workflow
- **Sensor runs** with verdict (PASS / FAIL / INCONCLUSIVE), severity, and whether a blocking sensor held the stage
- Per-stage token usage and cost
- Artifacts produced and gates answered
- **Restart from this stage** — the rewind entry point (below)

During parallel construction, the list shows one row per unit lane (with a unit chip), while the graph aggregates to one node per stage with an ×N count. A **lane board** shows the construction waves: each unit's state, dependencies, branch, and the walking-skeleton highlight.

## The graph page

The **Graph** button opens the intent's knowledge graph — the traceability view:

- The **Artifacts** layer shows the canonical documents and their produces/consumes/derived-from relationships.
- The **Items & Units** layer adds the derived granular graph: typed items (stories, requirements, components, decisions) and the unit-of-work DAG, with traceability edges such as _covers_, _implements_, _depends on_, and _cites_. When the intent has code traceability, this layer becomes **Items, Units & Code** and also renders `CodeFile` nodes — the source files each construction stage changed — linked to their unit and, where a stage produced a `traceability.json`, to the requirements and stories they implement. One current revision is shown per unit and file; a re-run or rewind supersedes only that unit's prior revision.

Selecting a node shares the same drill-down as the observability page.

## The audit page

The **Audit** button opens the graph-usage audit: how agents read the graph
(compact reads vs. full documents), enrichment spend, derivation health,
structure-contract compliance, and coverage findings (for example, must-have
requirements not covered by any story). It also records the exact managed
environment revision, image digest, runtime version, endpoint, compatibility
version, and verification result used by the intent. It is the measurement
surface for tuning context efficiency and confirming which immutable runtime
executed a run.

## Where prices come from

Token prices are read from the AWS Price List API. The platform holds no price
table of its own: a model without a usable published price shows **Cost:
unavailable**, and a model picker shows "Cost estimate unavailable for this
model" below such a model when it is selected. It can still be selected and
its usage is still recorded.

- **Refresh.** The price table is rebuilt every hour, and when a model picker is
  opened if the last refresh is more than an hour old. Costs are computed when a
  page is read, so a price that AWS publishes later also prices usage that was
  recorded earlier, and a price change applies to earlier usage as well.
- **After an upgrade or first deployment** costs show as unavailable until the
  first refresh has run (at most one hour, or as soon as someone opens a model
  picker in Admin or in Space Settings → Agent).
- **If a refresh fails** (Price List unreachable or throttled) the last table is
  kept. Nothing is priced from a partial answer.
- **If the stored table cannot be read** for a moment (a throttled or failed
  read), costs keep using the table that was read last, and the read is tried
  again a minute later. A read that succeeds decides: if the table was removed
  or is not in the current format, costs show as unavailable until the next
  refresh.
- **Region.** Prices are those of the platform's inference region
  (`bedrock_region`); Bedrock publishes different rates per region. A space
  whose IAM connection sends inference to another region is priced with the
  same table.
- **Tier.** A `global.` inference profile uses the Global cross-region rate;
  every other ID uses the In-Region rate, which is also the Geo cross-region
  rate. Codex sends bare `openai.*` IDs through the Mantle endpoint and uses the
  In-Region rate; a geo-prefixed OpenAI ID is not priced. Usage samples carry no
  prompt length, so the short-context rate is always used: a request that
  Bedrock bills at a long-context rate is under-reported. Batch, flex, priority
  and latency-optimized rates are not used.
- **Cache tokens** use the published cache rates. When AWS publishes no rate for
  a cache category that a sample contains, that sample's cost is unavailable.
  This applies to cache writes on GPT-5.5 and GPT-5.4, for which the Price List
  has no cache-write rate.
- **Matching.** The Price List identifies a model by its display name, not its
  ID. The platform matches the two by normalizing both (`Claude Sonnet 4.6` and
  `us.anthropic.claude-sonnet-4-6`; `OpenAI GPT-5.5` and `openai.gpt-5.5`). A
  dated ID such as `openai.gpt-5.4-2026-03-05` uses the price of its model. A
  model whose name and ID do not match this way has no price.
- **Kiro** is billed in credits and has no token price; see above.

## Space-level metrics

The space page aggregates the same usage and cost metrics across all intents, next to the intent list. Model attribution is stamped server-side, and anything that couldn't be priced is flagged rather than shown as $0.

## Human gates

When an agent asks a question or a stage requires validation, the run parks and the gate renders on the workbench:

- **Questions** show the agent's question with structured options as buttons where applicable, plus a free-text answer.
- **Stage reviews** show the LLM reviewer's findings; approve, or request changes with feedback.
- **Engine gates** appear after the walking skeleton, on the autonomy choice ("Continue autonomously" vs. "Gate every batch"), after each gated batch, and on halt-and-ask when a lane fails (retry / skip / abort). The fan-out itself (unit plan + per-unit skip matrix) is approved on the unit-plan stage's own review gate. Skeleton and batch gates offer **approve** or **request changes with feedback** — the engine revises the increment and asks again, so a reject never fails the run.

While parked the run consumes no compute — answers hours or days later resume the same agent conversation with full context.

## Steering and rewind

You can redirect a run at any point without restarting it:

- **Course-correct on answer** — every gate answer accepts an optional course-correction note. It is delivered to the agent as a binding "COURSE CORRECTION from the human team" instruction.
- **Revise a past answer** — from the question history, revise an already-answered gate; the correction is injected at the next safe point (gate resume or next stage start).
- **Restart from this stage (rewind)** — from any executed stage's detail view, optionally with guidance. The target stage and everything after it are reset (history preserved, attempt count incremented), their artifacts are superseded in the graph, and the run relaunches from the target. Rewind targets must be in the run's scope.
- **Retry** — one-click rewind without guidance on a failed stage.
- **Cancel run** — from the intent header, for waiting or failed runs. Pushed work stays on the intent branch; live agent sessions are stopped.

All steering is immutable and audited: it appears in the timeline, in the "Course corrections" section of the workbench, and as steering nodes in the graph.
