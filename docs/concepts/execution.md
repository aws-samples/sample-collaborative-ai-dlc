# Execution Model

This page explains what happens when an intent runs: the orchestration, the agent runtime, git handling, human interaction, and the artifact graph. For the component-level system view see [Architecture](architecture.md); for the day-to-day UI see [Observing intents](../using-the-platform/intent-observability.md).

## The intent lifecycle

```
DRAFT → CREATED → RUNNING → WAITING → SUCCEEDED | FAILED | CANCELLED
```

An intent is created as a draft, reviewed, and started. On start, the platform compiles the project's pinned workflow into an execution plan for the intent's scope, snapshots the project's runtime settings (CLI, models, park release, parallelism, PR strategy), and hands off to a **durable orchestrator** — a Lambda-based durable execution that drives the intent end to end.

`WAITING` means the run is parked on a human gate; answering resumes it exactly where it stopped. Terminal states can be rewound (see [Steering and rewind](#steering-and-rewind)).

## The agent runtime: Bedrock AgentCore

Agents run on **Amazon Bedrock AgentCore** — a serverless runtime that gives each session a dedicated microVM and filesystem. There is no agent server fleet to operate: sessions are created on demand, park at zero compute while waiting for humans, and expire when idle.

- Each intent gets one runtime session; parallel construction lanes get their own sessions.
- Each stage spawns a **headless agent CLI** (Kiro, Claude Code, OpenCode, or Codex — selected per project) inside the session.
- The CLI's only interface to the platform is a stdio **MCP server**. Business reads and writes go to the graph as typed, provenance-stamped artifacts; questions, outputs, and metrics go to the process store and stream live to the browser.
- Stages run as background jobs with durable callbacks, so a stage can run for hours while the orchestrator is suspended at zero compute.
- Session storage persists across park/resume, so a stage that asked a question continues its conversation with full context when you answer — even days later.

The CLI authenticates to its model with a bearer token (Bedrock API key) or a Kiro API key configured in [Platform Admin → Agents](../using-the-platform/platform-settings.md#agents). The runtime's IAM role deliberately has no model-invocation permissions — token auth is the only path.

!!! note "No ECS agent fleet"

    Earlier releases ran agents on an ECS Fargate worker pool with a DynamoDB mailbox and EventBridge fan-out. That runtime has been fully retired. The only remaining ECS service is the Yjs real-time collaboration server; everything agent-related is AgentCore plus Lambda.

## Engine-owned git

Git is deterministic and owned by the engine — **the agent never runs git and never holds credentials**:

- On start, the engine clones the project's repositories, creates the intent branch `aidlc/<title-slug>` (a readable slug derived from the intent title) off each repository's base branch, and mounts the checkout as the agent's working directory.
- The engine commits and pushes after **every** stage exit — success, park, or failure — so no work is ever lost to a session expiry.
- Credentials are injected only inside the engine's push/fetch windows and scrubbed from the checkout otherwise. In GitHub App mode, pushes use installation tokens instead of user tokens.
- Parallel lanes work on section-specific per-unit branches (`aidlc/<intent-slug>--s<k>-unit-<slug>`).
- With **Intent PR**, the engine merges completed lanes into the intent branch with serialized `--no-ff` merges in dependency-safe order.
- With **PR per unit**, every changed repository gets a draft pull/merge request from the unit branch to the intent branch. Reviews can proceed in parallel, but only the next dependency-ready unit becomes mergeable. Before readiness, the engine reconciles it with the latest intent head. Unchanged repositories are neutral.
- After all units integrate and shared stages pass, both strategies open the final intent-to-base pull/merge request.

For PR-per-unit delivery, DynamoDB is scheduling truth. A unit is complete only after every changed repository confirms the exact ready head is on the intent branch. A partial multi-repository merge preserves merged work, blocks dependents, and enters halt-and-ask.

Provider comments never launch agents by themselves. A project member selects comments in the intent's review drawer; the API refetches those comments with fresh credentials, rejects bot/system comments, and queues a bounded, audited feedback batch. The lane revisits its last successful stage, runs its normal sensors, commits and pushes the revision, and posts a summary without resolving provider threads.

## Human gates, park and resume

When an agent needs a decision, it calls the `ask_question` MCP tool; when the engine needs one (walking-skeleton review, batch review, halt-and-ask on a failed lane), it opens an engine gate. Fan-out is approved on the unit-plan stage's own validation gate — one gate covers the artifact and the fan-out decisions. Either way:

1. The stage parks, the run flips to `WAITING`, and after a configurable grace period (`parkReleaseSeconds`, default 300s) the session is stopped — zero compute while waiting.
2. The question renders in the UI in real time, with structured options where applicable.
3. Your answer completes a durable callback; the orchestrator resumes the same session and the agent continues its conversation where it left off.

Multiple questions per stage are supported, and a recovered session that lost its conversation (for example after a redeploy) is re-run fresh with the already-answered Q&A injected — you are never asked twice.

## Steering and rewind

You are never locked out of a running intent:

- **Answer + course-correct** — attach steering guidance to any gate answer.
- **Revise a past answer** — correct an earlier decision; the revision is delivered at the next safe injection point.
- **Rewind** — restart from any executed stage, optionally with guidance ("restart functional design, but use DynamoDB instead"). Downstream stages are reset, their artifacts are superseded (kept for lineage, dimmed in the UI), and the run relaunches from the target stage.
- **Retry** — a rewind without guidance; one click on a failed stage.
- **Cancel** — stop a waiting run; pushed work is preserved on the intent branch.

Steering is immutable and fully audited: corrections are appended, never edited, and every one appears in the timeline and the graph.

## The artifact graph

Methodology documents (requirements, stories, designs, decisions) are written to the graph as **artifacts** — canonical markdown documents. On top of them the platform derives a **granular graph**:

- Headings become sections; structured blocks become **typed items** — stories, personas, requirements, components, decisions, contracts, units of work.
- Deterministic parsers derive **traceability edges**: which story covers which requirement, which unit implements which story, what depends on what, what cites what. Agents never author graph topology by hand.
- Agents read the graph through a compact-first ladder (graph overview → table of contents → individual sections/items) instead of re-reading whole documents, keeping context bounded.
- An optional **graph enrichment** mode (a platform admin setting) adds LLM-generated summaries to derived artifacts.

The graph is a re-derivable index — documents stay the source of truth. You explore it on the intent's [Graph page](../using-the-platform/intent-observability.md#the-graph-page), and audit how agents used it on the Audit page.

## Observability

Every process write is persisted to DynamoDB (the source of truth) and broadcast live over WebSocket to the intent's channel. The UI shows:

- A live stage pipeline grouped by phase, with per-stage status, durations (active vs. waiting), attempts, and sensor verdicts.
- Streaming agent output per stage, a timeline of events, and artifact discussions.
- Token usage, context-window pressure, and estimated cost per stage, per intent, and per project — with model attribution stamped server-side.

See [Observing intents](../using-the-platform/intent-observability.md) for the full tour.
