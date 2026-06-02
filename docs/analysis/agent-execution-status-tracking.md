# Agent Execution Status Tracking — Analysis & Proposed Fix

## TL;DR

The "Construction Running" badge appears on a sprint whose agent run actually
finished hours ago. Root cause: the system uses an **ECS task ARN** as the
identifier for "is this agent run still going?". With the warm pool, one ECS
task ARN is reused across many jobs, so checking the ECS task's status no
longer answers the original question.

The proposed fix moves all "is this run alive?" decisions onto the
**executionId** (the stable per-job identifier) and on data we already write
to the `agent-outputs` DynamoDB table. The ECS task ARN remains a debugging
hint but is never consulted to decide run status.

---

## How a run is identified today

| Identifier        | Lifetime          | Granularity       | Source of truth                                         |
| ----------------- | ----------------- | ----------------- | ------------------------------------------------------- |
| `executionId`     | One agent run     | Per-job           | Generated when a job is dispatched (`exec-<ts>-<rand>`) |
| `taskArn` (ECS)   | One ECS container | Per **container** | ECS, which can serve **N jobs** while warm in the pool  |
| `workerId` (pool) | One pool worker   | Per **container** | DynamoDB pool table                                     |

Pre-pool architecture used a fresh ECS task per job, so `taskArn` and
`executionId` were 1:1 — and code that asked ECS "is this task running?" was
implicitly asking "is this job running?". With the warm pool this is no
longer true: an idle worker keeps `lastStatus = RUNNING` forever, so any code
that maps "ECS task RUNNING" → "execution RUNNING" gives a false positive
once the actual job has finished.

---

## Where the data flows

### Backend writes

```
Sprint vertex (Neptune)
├── current_execution_id     (string)  ← stable, the one we should trust
├── current_execution_arn    (string)  ← ECS task ARN; volatile per pool reuse
├── current_agent_status     (string)  ← running | waiting | failed | completed | cancelled
├── agent_started_at         (ISO ts)  ← when the run was dispatched
└── agent_completed_at       (ISO ts)  ← terminal write only

Pool table (DynamoDB: agent-pool)
├── workerId      (PK)
├── status        (idle | starting | assigned | busy)   ← GSI: StatusIndex
├── taskArn       (the ECS task ARN of this worker container)
├── job           (object, present only when status ∈ {assigned, busy})
│   ├── projectId
│   ├── sprintId
│   ├── executionId     ← THE link from a worker back to a specific job
│   └── ...
└── lastHeartbeat

Agent-outputs table (DynamoDB)
├── executionId (PK)
├── status      (running | completed | failed)
├── outputText
└── ...

AgentRun vertex (Neptune)
├── execution_id            ← matches agent-outputs.executionId
├── status
└── completed_at
```

### Frontend reads (current behavior — the bug surface)

`ConstructionPage` mounts `useAgentStatus` which:

1. **Initial fetch**: `GET /projects/{projectId}/agents?sprintId=...`
   - Lambda: `agents/index.js` line 947+
   - Returns `{ executionArn, executionId, status }`
   - Frontend stores `executionArn` as `currentArn`, sets `status` from the response
   - **The `executionId` from the response is dropped on the floor** — it's
     never copied into the hook's `executionId` state. The hook's
     `executionId` prop comes from `ConstructionPage.tsx`'s separate
     `setExecutionId` flow, which only fires when `sprint.phase ===
'CONSTRUCTION'`. For an `INCEPTION_COMPLETE` sprint, `executionId`
     stays `null`.

2. **Polling every 15s**: `GET /agents/{currentArn}?executionId={executionId}`
   - Lambda: `agents/index.js` line 1140+
   - With `executionId` missing from the query string, the handler:
     - Tries `agent-outputs.executionId == taskArn` (the URL param) — no match
     - Has no fallback `executionId` to try
     - Calls `getTaskStatus(arn)` (line 1171)
     - `getTaskStatus` describes the ECS task. The pool worker's container
       is **still running** (warm, idle). Returns `RUNNING`.
   - Frontend sets `status = RUNNING` → "Construction Running" badge appears,
     Kick-Off button is disabled.

This is the loop you see: refresh → API returns FAILED on the project-level
endpoint → 15s later, polling endpoint returns RUNNING (because warm pool
worker is alive) → UI flips to "Construction Running".

---

## Why the project-level endpoint also gives a wrong answer (different bug)

`GET /projects/{projectId}/agents` (line 947+) goes through several branches:

```
1. cleanupStaleWorkers()                                      (fire-and-forget)
2. Read Sprint vertex: arn, execId, agentStartedAt
3. Scan pool table for status ∈ {busy, assigned} matching project+sprint
   ↳ if found: return RUNNING
4. STALE_AGENT_MS check (45 min from agent_started_at)
   ↳ if exceeded: writeTerminalStatus('failed') and return FAILED
5. agent-outputs lookup by execId
   ↳ if found: return mapped status
6. getTaskStatus(arn) (ECS describe task)
   ↳ return mapped status
```

For your sprint:

- `agent_started_at = 2026-05-30 23:03Z`, "now" ≈ 14h later → **step 4 fires
  first and forces FAILED**, even though `agent-outputs` has `completed`.

So step 5 (the right answer, `SUCCEEDED`) is never reached. The Sprint
vertex's `current_agent_status` keeps getting overwritten to `failed` on
every poll.

---

## The proposed fix (Option 1)

> **executionId becomes the only identifier of "a run"**, everywhere.

### Principle

A "run" is a job dispatched to an agent. It is identified by `executionId`.
ECS task ARNs and pool workers are _infrastructure_ that may serve many runs;
they are not a run themselves. Therefore:

- "Is run X running?" → answered by `agent-outputs[executionId=X].status`
  combined with the pool table (is any worker currently `busy` for this
  `executionId`?).
- "Is run X dead/abandoned?" → answered by a heartbeat timeout against the
  pool worker that owns it (or absence from the pool with no terminal write
  to `agent-outputs`).

We never consult `getTaskStatus(arn)` to answer questions about a run.

### Data-layer changes (Neptune)

- **Keep**: `current_execution_id`, `current_agent_status`, `agent_started_at`,
  `agent_completed_at` on the Sprint vertex.
- **Demote**: `current_execution_arn` becomes a debugging hint only.
  Nothing reads it to decide status. We could remove it later; for this PR
  we leave it written but stop reading it.

No migration needed — existing data stays valid.

### Lambda changes — `lambda/agents/index.js`

#### `getTaskStatus(taskArn)` — line 344

**Remove all callers.** The function itself can stay for one explicit
debugging endpoint if useful, but no status-decision path calls it.

#### `GET /projects/{projectId}/agents` — line 947+

Rewrite the decision tree to be _executionId-first_:

```
1. Read Sprint vertex: execId, agentStartedAt, currentAgentStatus
2. If execId is null/empty → return {status: null}             (no run yet)
3. Look up agent-outputs[executionId=execId]
   ├── status='completed' → writeTerminal('completed'); return SUCCEEDED
   ├── status='failed'    → writeTerminal('failed');    return FAILED
   └── status='running' (or row exists but not terminal):
       Check pool table: any worker with job.executionId == execId AND status='busy'?
       ├── yes → return RUNNING
       └── no  → it's abandoned. Apply heartbeat-based stale rule:
                 if agentStartedAt > STALE_AGENT_MS ago AND
                    no busy worker AND
                    agent-outputs has no row OR row is non-terminal
                 → writeTerminal('failed'); return FAILED
                 else → return RUNNING (still within grace window;
                                         agent-outputs hasn't been written yet)
4. If agent-outputs row is missing entirely:
   - Apply the same grace-window check as above.
```

Note: the 45-minute STALE_AGENT_MS rule survives, but only fires when the
pool actually shows nothing busy for this executionId. This stops the
"forces FAILED on every poll even though agent-outputs says completed" bug.

#### `GET /agents/{taskId}` — line 1139+

The frontend currently passes `taskId = ECS task ARN`. We change the
contract: `taskId` is treated as `executionId` first; the ECS-ARN path
goes away.

```
1. taskId is the executionId.
2. Look up agent-outputs[executionId=taskId].
3. Apply the same decision tree as the project-level endpoint, minus the
   Sprint-vertex update (this endpoint is read-only with respect to Neptune).
```

If we want to preserve backward compat for callers that still pass an ARN,
we can add a one-line check: "if taskId starts with `arn:`, treat as ARN
and look up the executing pool worker by `taskArn` to find its current
`job.executionId`, then proceed as if executionId was provided." But ideally
the frontend stops sending ARNs (see below).

#### `DELETE /agents/{taskId}` — line 1175+

Same change: accept an `executionId`, find the matching pool worker, clear
its job, and clear the Sprint vertex by `current_execution_id` instead of
`current_execution_arn`.

### Frontend changes

#### `frontend/src/services/agents.ts`

`getStatus(executionArn, executionId?)` → rename param + URL to use
`executionId`:

```ts
async getStatus(executionId: string): Promise<AgentExecution> {
  return api.get(`/agents/${encodeURIComponent(executionId)}`);
}

async cancel(executionId: string): Promise<void> {
  return api.delete(`/agents/${encodeURIComponent(executionId)}`);
}
```

#### `frontend/src/hooks/useAgentStatus.ts`

- Capture `executionId` from `getCurrentExecution` response into local state
  (line 101–112). Today only `executionArn` is captured.
- Drop `executionArn`/`currentArn` from the polling identity. Use
  `executionId` exclusively in the `refresh()` call at line 127.
- Continue exposing both in the public API of the hook so consumers can
  display the ARN if they want to (debugging, links to ECS console), but
  internally never use it.

#### `frontend/src/pages/ConstructionPage.tsx`

The phase-gated `setExecutionId` block at line 124–136 becomes redundant
once the hook captures `executionId` itself. Remove or keep as belt-and-
suspenders.

#### `frontend/src/components/layout/PipelineView.tsx` line 108

```ts
const isAgentFailed = agentStatus === 'failed' && !!sprint?.currentExecutionArn;
```

Switch the truthiness check to `currentExecutionId` (the `currentExecutionArn`
field stays for debugging but isn't authoritative).

### Tests

- Unit-test the new decision tree in `lambda/agents/index.js` against:
  - Sprint with `agent-outputs.status = completed` and idle pool → SUCCEEDED
  - Sprint with `agent-outputs.status = failed` → FAILED
  - Sprint with `agent-outputs` missing, pool busy with matching execId,
    age < grace → RUNNING
  - Sprint with `agent-outputs` missing, no pool match, age > 45min → FAILED
  - Sprint with `agent-outputs` missing, no pool match, age < grace → RUNNING

---

## Why this didn't show up before

Most likely:

- Previously you only landed in this state with sprints whose worker had
  been stopped/replaced by `cleanupStaleWorkers` (so no warm pool worker
  with that ARN existed → `getTaskStatus` returned STOPPED → mapped to
  FAILED, which doesn't disable the button).
- Today the worker is still in the pool (idle) — its container is still
  alive — so `getTaskStatus` returns RUNNING. New shape of stale state.

The bug was always in the code, but the warm pool's longer idle TTL plus
the specific timing of your failed-then-resumed run is the first time it
surfaced clearly.

---

## Migration / rollout safety

- Backward-compatible writes: we keep writing `current_execution_arn`. Old
  clients still see the field.
- Backward-compatible reads on `GET /agents/{taskId}`: optionally accept
  ARNs and resolve them via the pool table, so an old frontend bundle
  still works while we ship the new bundle.
- No Neptune schema migration.
- No DynamoDB schema migration.
- The pool table's `StatusIndex` is already in place; the new code uses it
  the same way the existing busy/assigned scan does at line 996–1006.

---

## Files touched (estimated)

| File                                              | Change                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lambda/agents/index.js`                          | Rewrite GET `/projects/.../agents`, GET `/agents/{id}`, DELETE `/agents/{id}` decision trees. Remove `getTaskStatus` callers. |
| `frontend/src/services/agents.ts`                 | Switch `getStatus` / `cancel` to executionId.                                                                                 |
| `frontend/src/hooks/useAgentStatus.ts`            | Capture and use executionId; drop ARN from polling identity.                                                                  |
| `frontend/src/pages/ConstructionPage.tsx`         | Simplify phase-gated execution-id sync (now handled by hook).                                                                 |
| `frontend/src/components/layout/PipelineView.tsx` | Truthiness check on executionId.                                                                                              |
| `lambda/agents/__tests__/...`                     | Add decision-tree unit tests.                                                                                                 |
