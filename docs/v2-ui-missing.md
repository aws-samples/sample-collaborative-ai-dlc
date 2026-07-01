# Plan: Elevate the v2 Intent UI (right sidebar, pipeline view, graph, artifact viewer)

> Revision note: this replaces the earlier parity-only draft. Line refs and data shapes were
> re-verified against the code; three claims in the draft were wrong and are corrected below.

## Context

The v1 sprint UI has a rich three-tab **right sidebar** (Agent / Timeline / Discuss), a graph
view, and full artifact cards. The v2 `IntentView` (`frontend/src/pages/IntentView.tsx`) crams
everything into one stacked column — activity card, flat stage list, metrics grid, raw `<pre>`
output, collapsible `<details>` artifacts — with the discussion thread as a fixed overlay, and
bypasses the shared `AppShell` `ActivityPanel`.

The backend already exposes what we need via `GET /projects/{id}/intents/{intentId}`
(`events`, `outputs`, `metrics`, `gates`, `sensorRuns`, `artifacts` — see
`lambda/intents/index.js` GET handler) plus `GET /workflows/{id}/compiled`. **No backend
changes.**

### Corrections to the earlier draft (verified)

1. **`dependencyStageIds` is NOT in the compiled DTO.** Compiled graph nodes are
   `{stageId, phasePath, order}` and edges are `{from, to, artifact?, kind}`
   (`lambda/shared/compile.js:84-131`). `dependencyStageIds` exists only in the
   orchestrator-internal execution plan (`lambda/shared/v2-execution-plan.js:314`), never
   exposed to the frontend. Stage dependencies must be derived from `compiled.graph.edges`.
2. **Scope filtering is required.** The compiled graph covers ALL placements, but the run
   executes only stages with `scopeMembership[scope] === 'EXECUTE'`
   (`v2-execution-plan.js:229`). The current stage list shows out-of-scope stages as eternal
   PENDING — a bug. Everything (list + graph) must filter through
   `compiled.scopeGrid[intent.scope]` (keyed scope → stageId, `compile.js:21-30`).
3. **`review-verdict` gates are unreachable today.** The runtime only creates
   `kind: 'question'` gates (`lambda/agentcore/mcp/process-bridge.js:52`). The UI branch is
   built defensively and verified by unit test only — no live verification is possible.
4. **The v1 `SprintGraph` is NOT reused.** Its "hierarchical" layout is type-ordered
   (`SprintGraph.tsx:183`), not topological, and force layout is nondeterministic physics —
   both poor fits for a stage DAG. A topological layout would have to be written either way,
   and the `GraphCanvas` extraction was the riskiest refactor in the draft. Decision: a small
   purpose-built pipeline DAG; `SprintGraph.tsx` stays untouched (zero v1 regression risk).
5. **AppHeader's activity toggle is gated on `sprintId`** (`AppHeader.tsx:181`) — it must
   also show on intent routes or a closed panel can never be reopened.
6. **DRAFT prompt edits are silently discarded on Start** (no update endpoint exists).
   Decision: render the prompt read-only in the DRAFT card (like the branch field).

## Approach

### 1. `IntentProvider` context — single source of truth

`frontend/src/contexts/IntentContext.tsx`, modeled on `SprintContext.tsx`. Owns the fetch
(`intentsService.get` + best-effort `workflowsService.compiled`), the 8s polling backstop
while CREATED/RUNNING/WAITING, the `useIntentEvents` realtime wiring, the per-stage-instance
output buffer (+ version counter), the live gate map (upsert by `humanTaskId`), and
`answerGate`. Derived state:

- `stageRows`: scope-filtered plan stages (via `scopeGrid`) merged with live STAGE rows,
  keeping `startedAt/completedAt/attempt/cli` (previously dropped); live rows not in the plan
  are appended.
- `sensorsByStage`, `artifactsByStage`, `stageNameOf(stageInstanceId)` (instance ids are
  opaque `si-<hash>`), `pendingGates`.
- Shared UI state: `selectedStageId` (list/graph drill-down) and `agentFocus` (a request to
  focus the sidebar Agent tab on one stage's output; bumping it also opens the panel via an
  `onAgentFocus` callback prop, mirroring `DiscussionProvider`'s `onDiscussionOpen`).

**Mounting:** the provider renders inside `AppShell` (always mounted, inert when the route has
no `intentId`) — NOT as a route wrapper, because the sidebar renders outside the routed
element and must consume the same context.

### 2. `AppShell` + `AppHeader`

- `AppShell` renders `IntentProvider` around the layout grid; on intent routes the aside slots
  (inline column on lg+, non-modal overlay below) render the new `IntentActivityPanel`
  instead of the sprint `ActivityPanel`, reusing the resize handle + width persistence.
  `showActivity` includes `inIntent`; the default-open effect covers intent routes.
- `AppHeader` shows the panel toggle when `sprintId` **or** `intentId` is present.
- `IntentView`'s fixed discussion overlay is removed — threads render in the panel like v1.

### 3. `IntentActivityPanel` (3 tabs, fed from `useIntent()`)

`frontend/src/components/layout/IntentActivityPanel.tsx`, mirroring the sprint panel's shell
(`ActivityPanel.tsx:244-306`) but not reusing it (sprint-coupled):

- **Agent** — per-stage streamed output; stage selector defaults to **auto-follow** (the
  RUNNING stage, else the last stage with output); human stage names; auto-scroll with
  stick-to-bottom; `intent`-keyed output labeled "Workspace setup".
- **Timeline** — `detail.events` with the v1 dot+line visual (new small item component —
  v1's `TimelineEventItem` is typed to sprint events); dot color by `v2.*` event type.
- **Discuss** — `DiscussionsTab` / `DiscussionPanel` exactly like the sprint panel; the
  `DiscussionProvider` already resolves intent scope.

### 4. Stage pipeline (main pane, default view)

`components/intent/IntentStageList.tsx`:

- Stages **grouped by phase** (`phasePath`) with per-phase progress (n/m succeeded).
- Rows: state badge, duration (live-ticking while RUNNING), attempt count when >1, CLI badge,
  **sensor chips** (PASS green / FAIL red, `held` marked blocking / INCONCLUSIVE amber),
  current-stage highlight.
- Click → inline **`StageDetail`** expansion: timing, dependencies (derived from compiled
  edges), runtime error, all sensor runs w/ severity, per-stage metrics, artifacts produced
  (links to the artifact cards), stage gates, and "View output" (focuses the sidebar Agent tab).

### 5. `IntentGraph` — purpose-built topological DAG

`components/intent/IntentGraph.tsx` behind a **List ↔ Graph** toggle in the Stages card:

- Kahn layering over scope-filtered `compiled.graph.edges` (column = dependency depth, row
  order by `order`; cycle leftovers appended — compiled already reports `cycles`).
- HTML nodes (same `STAGE_STYLE` state colors, current-stage ring) over an SVG edge layer;
  `data` edges solid with artifact labels, `requires`/`blocks` dashed. Fit-to-content with
  horizontal scroll — no zoom/minimap needed at 5–20 nodes.
- Node click selects the same `selectedStageId` drill-down as the list.

### 6. Artifact viewer

`components/intent/ArtifactViewer.tsx` replacing the `<details>` blocks: type-colored left
border + badge, markdown body (collapsible for long content), per-artifact `DiscussButton`,
provenance ("produced by _stage_ · date") linking back to the stage row.

### 7. Gates + DRAFT

- `GateCard` gains a defensive `review-verdict`/`approval` branch: `gate.prompt` +
  `gate.options` (string[] → one button per option; else Approve/Reject) answered through the
  same endpoint with `{status, answer}`. Unreachable today — unit-tested only.
- DRAFT card renders the prompt read-only with a "set at creation" hint.

### 8. Slim `IntentView`

Header (status, live dot, current phase/stage, DiscussButton, provenance link) →
failure/stalled banner → DRAFT card → pending gates → init-ws indicator → Stages/Graph card →
Metrics → Artifacts. All state from `useIntent()`.

## Critical files

- New: `contexts/IntentContext.tsx`, `components/layout/IntentActivityPanel.tsx`,
  `components/intent/{stageStyle,IntentStageList,StageDetail,SensorChips,IntentGraph,ArtifactViewer}.tsx`
- Modified: `pages/IntentView.tsx`, `components/layout/AppShell.tsx`,
  `components/layout/AppHeader.tsx`
- Untouched: `pages/SprintGraph.tsx`, `components/layout/ActivityPanel.tsx`, all backend.

## Reuse (do not rebuild)

- `useIntentEvents`, `intentsService`/`workflowsService`, `DiscussionProvider`/`DiscussionsTab`/
  `DiscussionPanel`/`DiscussButton`, `QuestionEditor`, `STAGE_STYLE`+`StageBadge` (moved to
  `components/intent/stageStyle.tsx`), AppShell resize/width persistence, shadcn primitives
  (`tabs`, `scroll-area`, `select`, `toggle-group`).

## Verification

1. `npm --prefix frontend run typecheck`
2. `npm --prefix frontend run test` — extended `IntentView.test.tsx` (provider-wrapped), new
   context tests (gate upsert, output buffering, scope-filtered stageRows), graph layering
   unit tests, review-verdict gate branch.
3. `npx oxlint` + `npx oxfmt --check` on changed files.
4. Manual against a live intent: sidebar opens/toggles on intent routes (header button +
   small-screen overlay), Agent tab follows the running stage, List↔Graph toggle recolors
   live, stage drill-down, artifact provenance links, sensor chips, out-of-scope stages absent.
5. Regression: sprint routes still mount the original `ActivityPanel`; `SprintGraph` is
   untouched — only the AppShell/AppHeader conditionals need a sprint-route smoke check.
