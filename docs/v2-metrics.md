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
  "resolvedModel": "us.anthropic.claude-sonnet-4-6",
  "metrics": { "tokensInput": 18500, "tokensOutput": 2200, "contextWindowPct": 28 },
  "timestamp": "2026-06-29T07:24:06.134Z"
}
```

**Live broadcast** (`agent.metric`): `{ action, executionId, intentId,
stageInstanceId, metricId, metrics }`.

**Observed keys so far** (not a closed set — the agent chooses them):

| Key                | Meaning                                                                                                                                                                                                                                                                                 | Example |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `tokensInput`      | prompt tokens consumed by the stage                                                                                                                                                                                                                                                     | 18500   |
| `tokensOutput`     | completion tokens produced                                                                                                                                                                                                                                                              | 2200    |
| `contextWindowPct` | % of the model's context window used                                                                                                                                                                                                                                                    | 28      |
| `agentLaunchMs`    | agent launching time (cold start): orchestrator dispatch → container job accept, one sample per dispatch leg (fresh AND resume — a resume after a park release hits a fresh microVM). Engine-emitted by `run-stage` from `run-stage-start`'s accept-time measurement, not agent-chosen. | 3400    |

### Aggregation — additive vs gauge (the "context full 629%" fix)

A metric bag is an **open set**, but keys fold differently across samples, and
getting this wrong is what produced the "context full 629%" bug (summing a
percentage across a 9-stage run). The single source of truth is the classifier
in `lambda/shared/metric-classification.js` (mirrored in
`frontend/src/lib/metricAggregation.ts`; a cross-tree test asserts parity):

| Kind           | Fold across samples        | Keys                                                         |
| -------------- | -------------------------- | ------------------------------------------------------------ |
| `additive`     | **sum**                    | `tokensInput`, `tokensOutput`, and any unknown key (default) |
| `gauge:max`    | **max** (peak)             | `contextWindowPct`, `agentLaunchMs`                          |
| `gauge:latest` | value of the newest sample | (none yet)                                                   |

Unknown keys default to `additive` (counters are the common case). A **new
gauge must be registered** in both files or it will be summed. The three scopes
compose from one `aggregateMetrics(samples)` primitive: per-stage (filter by
`stageInstanceId`), per-intent (all the execution's samples), per-project
(`rollupAggregates` over the per-intent bags — additive summed, gauge peaked).

A stage may emit 0..N samples; key off `metricId` for dedupe, `timestamp` for
order. Keys are best-effort — `contextWindowPct` was absent on one of the two
samples in the validation run.

### Model attribution + cost

Each metric is attributed to a **model** so tokens can be priced. The model is
resolved server-side (the agent bag is untrusted and carries no model):

- **Stage row** — `run-stage.js` persists `resolvedModel` on the `STAGE#` row at
  RUNNING (the concrete region-prefixed Bedrock id, Kiro namespace id, or null).
- **Metric row** — the process bridge stamps the same `resolvedModel` onto each
  `METRIC#` row from its trusted scope (covers stageless metrics too).

At read time the intents DTO prefers the metric-row model, falling back to the
stage-row join, and computes `cost` per sample via
`lambda/shared/model-pricing.js`:

```json
"cost": { "model": "...", "currency": "USD",
          "inputCost": 0.0555, "outputCost": 0.033, "totalCost": 0.0885,
          "priced": true }
```

Pricing table (family → USD per 1M input/output tokens) lives in SSM
(`${prefix}/model-pricing`). The **agents lambda** refreshes it from the AWS
Price List API (`pricing:GetProducts`, `serviceCode=AmazonBedrock`) on model
discovery (`GET /agents/capabilities?models=1`); the **intents lambda** only
reads it. A static fallback baked into `model-pricing.js` means cost is always
computable even before the first refresh. `priceFor` normalizes an inference-
profile id (`us.anthropic.claude-sonnet-4-6` → `claude-sonnet-4-6`) to a family
key; **Kiro** is credit-based and its ids don't normalize to a Bedrock family,
so its token samples are `priced: false` — Kiro cost comes from **credits**
instead (below).

`priced: false` (a newer model with no price entry, or Kiro credits without a
captured rate) means the UI shows "cost unavailable" rather than a misleading
`$0`.

### Kiro credits (estimated cost)

Kiro is credit-based — tokens have no dollar price. Instead, the runner scrapes
two things straight out of `kiro-cli`:

- **Credits per run** — kiro-cli prints a per-turn footer on stderr
  (`▸ Credits: 0.03 • Time: 2s`); `run-stage.js` already tees Kiro's stderr
  tail (for the benign-crash check), parses the footer post-run
  (`parseKiroCredits`, drivers.js) and records a `credits` metric sample
  (additive). Runs on ANY exit — a parked/crashed turn still spent its credits.
- **$/credit rate** — the runner runs `kiro-cli chat --no-interactive "/usage"`
  (once per container, cached) and parses "billed at `$0.04` per credit"
  (`parseKiroCreditRate`). The rate is **stamped on the metric row**
  (`creditRate`) so a later plan change never reprices history.

At read time `costForMetrics` prices a credits sample as `credits × creditRate`
with `priced: true, estimated: true` — **estimated** because in-plan credits
are covered by the subscription; the overage rate is an honest upper-bound
estimate, not billing truth. The UI renders it as `~$0.50` labelled
"Cost (est.)". No rate captured → the sample stays `priced: false`.

Verdict rule (server `summarizeExecutionMetrics` + frontend `summarizeCost`,
kept in sync): an unpriced Kiro **token** sample counts as covered when the
same stage also has a credit-priced sample — the credits ARE that stage's
spend; its token counts are usage detail.

### Project rollup

`GET /projects/{projectId}/intents/metrics` rolls usage + cost up across every
intent: it reads each execution's `METRIC#`/`STAGE#` rows, aggregates per
intent, then sums additive keys + cost and peaks gauges. Returns
`{ perIntent: [...], project: { metrics, cost: { totalCost, currency,
anyUnpriced, anyEstimated } } }`. `anyUnpriced` flags that a spending intent
ran on an unpriceable model (and wasn't covered by credits); `anyEstimated`
flags that Kiro credit-estimated dollars are in the total, so the UI can caveat
it.

### Frontend surfaces

The shared `UsageMetrics` component (`frontend/src/components/intent/`) renders
an aggregated bag identically at all three scopes — token counts, a threshold-
colored context-window gauge (green <50, amber 50–80, red >80), and cost:

- **Stage** — per-stage totals + gauge + stage cost (`StageDetail`).
- **Intent** — the `MetricsPanel` "Usage & cost" card, peak context across
  stages + total intent cost (`IntentView`).
- **Project** — a "Usage & cost" card fed by the rollup endpoint (`Project`).

### Stage durations (wall-clock vs. agent-active)

Durations are derived from STAGE-row timestamps, not metric samples. The row
carries `startedAt` (first entry into RUNNING — it survives park/resume
cycles: a resume PATCHES the row via `resumeStageRow`, never rebuilds it),
`completedAt`, plus the human-wait accounting pair `parkedAt` (stamped at the
moment the question is asked; cleared on resume) and `waitMs` (accumulated
parked milliseconds across all park/resume cycles). The UI shows:

- **Total** (stage list): `(completedAt ?? now) − startedAt` — wall clock
  including waits.
- **Active/waiting** (`StageDetail`): active = total − `waitMs` − the open
  park window (`now − parkedAt` while WAITING_FOR_HUMAN); see
  `stageDurations` in `stageStyle.tsx`.

A rewind/retry reset (`resetStageRow`) clears all four fields — attempt N+1
starts fresh accounting.

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
