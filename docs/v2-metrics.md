# AI-DLC v2 Metrics & Observability Records

What the runtime emits per execution that a frontend can render — captured here
so the UI work can pick it up without re-deriving the shapes. Everything below is
**built and verified on deployed AWS** (the `intent-capture` validation run on
2026-06-29, execution `e-sensor1`); the samples are real rows from that run.

Two delivery paths, same data:

- **Durable** — DynamoDB rows in the v2 process table (`v2-process-keys.js`),
  queryable by `pk = EXEC#<executionId>`. The source of truth; survives reload.
- **Live** — a best-effort websocket broadcast on the intent channel
  (`intent:<intentId>`) as each row is written. The UI reacts in real time; if a
  broadcast is missed, the durable row is the fallback (replay on reload).

The realtime **consumer** is not built yet (see [`v2-open.md`](./v2-open.md) —
the `$connect` authorizer only scopes `sprint:`/`project:` today). This doc is the
contract that consumer implements against.

## Record types (one execution = one DynamoDB partition)

`PK = EXEC#<executionId>`. Sort-key prefix selects the record type:

| SK prefix | type      | What it carries                                           | Live action       |
| --------- | --------- | --------------------------------------------------------- | ----------------- |
| `META`    | Execution | status, current phase/stage, workflow, scope, `outputSeq` | `agent.execution` |
| `STAGE#`  | Stage     | per-stage runtime state (RUNNING → terminal), error       | `agent.stage`     |
| `EVENT#`  | Event     | append-only audit/progress trail                          | `agent.note`      |
| `HUMAN#`  | HumanTask | a pending/answered gate (question / approval / review)    | `agent.question`  |
| `METRIC#` | Metric    | token usage / context-window samples                      | `agent.metric`    |
| `SENSOR#` | SensorRun | a deterministic sensor verdict for a stage                | `agent.note`      |
| `OUTPUT#` | Output    | agent output chunks (restore-on-reload)                   | `agent.output`    |

The full broadcast envelope + per-action emit table lives in
[`v2-agent.md`](./v2-agent.md) ("Realtime broadcasts"). This doc focuses on the
**metric-shaped** rows the UI charts: `Metric` and `SensorRun`.

## Metric samples (`METRIC#`)

Emitted by the agent's `collect_metric` MCP tool at stage end (and potentially
mid-stage). A free-form numeric bag — the UI should treat keys as optional and
render what's present.

**Row shape** (`buildMetricRow`):

```json
{
  "type": "Metric",
  "executionId": "e-sensor1",
  "stageInstanceId": "si-649d151f25dad31b",
  "metricId": "<uuid>",
  "metrics": { "tokensInput": 18500, "tokensOutput": 2200, "contextWindowPct": 28 },
  "timestamp": "2026-06-29T07:24:06.134Z"
}
```

**Live broadcast** (`agent.metric`): `{ action, executionId, intentId,
stageInstanceId, metricId, metrics }`.

**Observed keys so far** (not a closed set — the agent chooses them):

| Key                | Meaning                              | Example |
| ------------------ | ------------------------------------ | ------- |
| `tokensInput`      | prompt tokens consumed by the stage  | 18500   |
| `tokensOutput`     | completion tokens produced           | 2200    |
| `contextWindowPct` | % of the model's context window used | 28      |

Frontend notes: aggregate `tokensInput + tokensOutput` per stage for a
cost/usage bar; `contextWindowPct` is a gauge (warn as it approaches 100). A
stage may emit 0..N samples; key off `metricId` for dedupe, `timestamp` for
order. Keys are best-effort — `contextWindowPct` was absent on one of the two
samples in the validation run.

## Sensor verdicts (`SENSOR#`)

Emitted by the runtime (not the agent) after a stage's agent finishes — the
deterministic verification axis (see [`v2-agent.md`](./v2-agent.md) "Deterministic
sensors"). One row per sensor run.

**Row shape** (`buildSensorRow`):

```json
{
  "type": "SensorRun",
  "executionId": "e-sensor1",
  "stageInstanceId": "si-649d151f25dad31b",
  "sensorRunId": "<uuid>",
  "sensorId": "required-sections",
  "kind": "graph",
  "severity": "advisory",
  "result": "PASS",
  "held": false,
  "detail": {
    "artifacts": [
      {
        "artifact": "intent-statement",
        "h2_count": 7,
        "headings": ["## Problem Statement", "..."],
        "findings_count": 0
      }
    ]
  },
  "timestamp": "2026-06-29T07:24:10.395Z"
}
```

**Live broadcast** (`agent.note`): `{ action: 'agent.note', stageInstanceId,
note: "sensor required-sections: PASS", kind: 'sensor' }`.

Fields the UI keys on:

- `result` — `PASS` | `FAIL` | `INCONCLUSIVE` | `BLOCKED` (status pill colour).
- `severity` — `advisory` | `blocking` (a blocking non-PASS is what held the stage).
- `held` — `true` when this verdict failed the stage (`run-stage` returns
  `sensor_blocked`). Drives the "why did this stage fail" affordance.
- `kind` — `graph` (methodology-doc check, evaluated in-process) | `script`
  (code check, spawned against the workspace).
- `detail` — sensor-specific structured output. `required-sections` →
  `{ h2_count, headings[], findings_count, edge_block? }`; `upstream-coverage` →
  `{ consumes[], unreferenced[], findings_count, reason? }`; code sensors →
  `{ files: [{ file, result, detail }] }`.

Frontend notes: group a stage's `SensorRun` rows under the stage; a `held: true`
row explains a `FAILED` stage. `INCONCLUSIVE` (e.g. a code sensor that matched no
files) should read as a neutral "not run", not a failure.

## Validation provenance

These shapes are not speculative. They are the rows the deployed runtime wrote
during the `intent-capture` end-to-end run (execution `e-sensor1`, intent
`i-sensor1`, 2026-06-29):

- 2 `METRIC#` rows (token usage + context-window).
- 4 `SENSOR#` rows (`required-sections` + `upstream-coverage`, both `PASS`,
  `advisory`, `held: false` — two passes because a synchronous-invoke client
  timeout retried the stage; see [`v2-open.md`](./v2-open.md)).
- `OUTPUT#` rows carrying the agent's human-facing `send_output` summary.
- `STAGE#` reached `SUCCEEDED`; `HUMAN#` gates cycled `pending → answered`.

The **`script`-kind sensor** metric shape (`detail.files[]`) is unit-covered but
not yet observed on AWS — it needs a code-producing stage to run first (see
[`v2-open.md`](./v2-open.md)).
