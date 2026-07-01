# AI-DLC v2 — Steering (course-correcting a running intent)

How a human corrects an agent that went in the wrong direction during a v2
intent execution — without breaking the consistency of stages, questions, the
knowledge graph, or the durable orchestration. Pairs with
[`v2-agent.md`](./v2-agent.md) (the agent-execution layer),
[`v2-resume.md`](./v2-resume.md) (park/resume), and
[`v2-data-model.md`](./v2-data-model.md) (data ownership).

## Design invariants

1. **Immutability.** Questions, answers, and steering messages are never
   mutated. A correction is a NEW `STEER#` row layered on top; correcting a
   correction supersedes the older row (`status: superseded`). A revised gate
   keeps its original answer and points at the correction
   (`revisedAt`/`revisionSteerId`).
2. **Deterministic delivery.** Steering text enters the agent conversation ONLY
   at a deterministic injection point: a **gate resume** (appended to the
   answer message) or a **fresh stage start** (prepended to the prompt). There
   is deliberately NO mid-turn injection and no way to interrupt a RUNNING CLI
   turn — mid-run steering is nondeterministic by nature, so the API rejects
   it (409) and the human waits for the stage to park or finish.
3. **Full audit trail.** Every steering action produces an `EVENT#` row, an
   `agent.steering` broadcast, and a Neptune `Steering` vertex mirror with
   provenance edges (`REVISES` → the corrected Question, `INFLUENCES` → the
   artifacts the redirected stage produced).
4. **Single-writer orchestration.** Each orchestrator run claims META with an
   `orchestratorRunId` ownership token; its terminal writes CAS on it. A run
   retired by cancel/rewind exits quietly instead of clobbering the relaunch.
5. **Supersede, never delete.** A rewind marks the reset stages' artifacts
   with `superseded_at`/`superseded_by` (kept for lineage, dimmed in the UI).
   The re-run's `create_artifact`/`update_artifact` clears the marker
   ("rehabilitation"); a replacement links `DERIVED_FROM` instead.

## Data model

DynamoDB (`lambda/shared/v2-process-keys.js`):

```
SK = STEER#<createdAt>#<steerId>       (sorts in creation order)
  kind:    gate-steer | revision | rewind
  status:  pending → consumed | superseded
  message, targetGateId, targetStageId, createdBy/Name,
  consumedAt, consumedByStageInstanceId, supersededAt/By
GSI2SK = TYPE#STEER#STATE#<status>#<steerId>   (pending steering = one query)
```

- `HUMAN_TASK_STATUSES` gains `superseded` — a still-pending gate retired by
  cancel/rewind (never answered; kept as the audit record).
- META gains `orchestratorRunId` (ownership token) and `rewindFromStageId`.
- New event types: `v2.steering.recorded`, `v2.steering.consumed`,
  `v2.gate.revised`, `v2.stage.reset`, `v2.execution.rewound`,
  `v2.execution.cancelled`.

Neptune: a `Steering` vertex per STEER row (`Intent —CONTAINS→ Steering`),
`Steering —REVISES→ Question` for revisions, `Steering —INFLUENCES→ Artifact`
linked by run-stage when the consuming stage succeeds (mirrors the
answered-question linking). Artifact supersede markers are the dedicated
`superseded_at`/`superseded_by` props — NOT the free-form `status` prop agents
may set — and are reserved (spoof-proof) in the graph-writer.

## The four steering actions

### 1. Answer + course-correct (execution WAITING)

`POST …/gates/{humanTaskId}/answer` accepts an optional `steering` string next
to the structured `answer`. The STEER row (kind `gate-steer`) is written
BEFORE the durable callback resumes, so the resume run-stage — which reads
pending steering at entry — is guaranteed to inject it into the parked
conversation right after the answer.

### 2. Revise a past answer

`POST …/gates/{humanTaskId}/revise` `{ message }` on an `answered` gate
(pending → answer it instead, 409; SUCCEEDED/CANCELLED intent → 409). Creates
a STEER row (kind `revision`), stamps the gate `revisedAt`/`revisionSteerId`,
mirrors `Steering —REVISES→ Question`. Delivery is deferred to the next
injection point; the response says which (`delivery: next-resume |
next-stage-start`).

### 3. Cancel

`POST …/intents/{id}/cancel` for `WAITING | CREATED | FAILED` (RUNNING → 409).
Supersedes every pending gate (CAS — a concurrently answered gate is left
alone), wakes any suspended callback with a cancel sentinel
(`{ cancelled: true }`), then flips META → `CANCELLED`. The woken orchestrator
re-reads its gate, sees `superseded`, and returns `{ reason: 'retired' }`
without touching META.

### 4. Rewind — restart from an earlier stage

`POST …/intents/{id}/rewind` `{ fromStageId, guidance }` for
`SUCCEEDED | FAILED | WAITING | CANCELLED` (RUNNING → 409; guidance is
required — the correction is the point). The flow:

1. retire a parked run (supersede gates + cancel sentinel, as in Cancel);
2. record the guidance as a STEER row (kind `rewind`) BEFORE anything resets,
   so the restarted stage can never miss it;
3. reset the target stage + every stage after it in run order
   (`resetStageRow`: state → PENDING, `attempt`+1, CLI session cleared —
   prior attempts' events/outputs stay as history);
4. mark the reset stages' artifacts superseded in Neptune (lineage kept);
5. CAS META → `CREATED` with `rewindFromStageId` and invoke the orchestrator
   with `startAtStageId` (rollback to the prior status if the invoke fails —
   same discipline as `/start`).

The orchestrator slices its stage loop at `startAtStageId` after verifying
every upstream stage holds a SUCCEEDED row (`rewind_upstream_incomplete`
otherwise). `init-ws` still runs (idempotent workspace heal).

**Git strategy is agent-led:** the intent branch keeps the wrong-direction
commits; the rewound stage's prompt leads with the correction block, which
instructs the agent to revert/redo conflicting commits as part of the stage.
No deterministic branch reset is performed.

## Injection (run-stage)

Every run-stage entry — fresh, resume, or demoted resume — calls
`consumePendingSteering`: reads `listPendingSteering`, CAS-flips each row
pending → consumed (stamping `consumedByStageInstanceId`), appends
`v2.steering.consumed`, broadcasts `agent.steering`. The consumed rows render
via `renderSteering` into an imperative block:

> `## COURSE CORRECTION from the human team` — overrides the current plan and
> any conflicting earlier instruction/answer; re-evaluate, and revert/redo
> conflicting artifacts/commits.

Placement: appended to the resume answer message (`--resume … -p "<answer>
\n\n<correction>"`), or prepended to a fresh prompt ahead of the materialized
stage body.

## API summary

| Endpoint | Purpose |
|---|---|
| `POST …/gates/{id}/answer` (+`steering`) | answer + ride a correction into the resume |
| `POST …/gates/{id}/revise` | correct an already-given answer |
| `POST …/intents/{id}/cancel` | retire a parked/stranded/failed run |
| `POST …/intents/{id}/rewind` | restart from a stage with guidance |

The detail DTO gains `steering[]`; gates carry `revisedAt`/`revisionSteerId`/
`supersededAt`; artifacts carry `supersededAt`/`supersededBy`; the intent
carries `rewindFromStageId`. The knowledge graph endpoint renders `Steering`
nodes + `REVISES`/`INFLUENCES` edges and flags superseded artifacts.

## UI

- **GateCard**: optional "Course correction" field under the question editor.
- **Question history**: "Revise answer" on answered gates; revision +
  superseded badges; the correction (queued/delivered) shown with the answer.
- **StageDetail**: "Restart from this stage" (hidden while RUNNING) with a
  required guidance textarea; `Attempt n` badge on re-run stages.
- **IntentView header**: "Cancel run" for WAITING/CREATED/FAILED.
- **Work products**: a "Course corrections" section (kind, delivery state,
  author, message). **Knowledge graph**: Steering nodes; superseded artifacts
  dimmed. **ArtifactViewer**: superseded badge + dimming.
