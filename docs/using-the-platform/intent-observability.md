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

## The observability page

The **Observability** button opens the intent's execution dashboard:

- **Usage & activity** — aggregated token usage, a context-window gauge, and cost for the whole intent. Costs are computed per stage from live model pricing; Kiro runs show estimated cost derived from credits.
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
- The **Items & Units** layer adds the derived granular graph: typed items (stories, requirements, components, decisions) and the unit-of-work DAG, with traceability edges such as _covers_, _implements_, _depends on_, and _cites_.

Selecting a node shares the same drill-down as the observability page.

## The audit page

The **Audit** button opens the graph-usage audit: how agents read the graph (compact reads vs. full documents), enrichment spend, derivation health, structure-contract compliance, and coverage findings (for example, must-have requirements not covered by any story). It is the measurement surface for tuning context efficiency.

## Project-level metrics

The project page aggregates the same usage and cost metrics across all intents, next to the intent list. Model attribution is stamped server-side, and anything that couldn't be priced is flagged rather than shown as $0.

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
