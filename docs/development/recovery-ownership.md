# Recovery ownership

A worker may change recovery state only while both ownership tokens match:
`META.orchestratorRunId` identifies its execution run, and
`STAGE.stageCallbackId` identifies its stage attempt. The orchestrator supplies
the run token in the dispatch, and the worker carries both tokens into its MCP
process. A consistent read helps diagnose state; the write transaction enforces
ownership even if a rewind happens after that read.

| Transition                  | Ownership and replay behavior                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim a stage               | Check the active META run and claim the callback without replacing the saved conversation. Repeating the same RUNNING callback is allowed; a different callback cannot claim a RUNNING stage.                                             |
| Open an agent question      | Create HUMAN, park STAGE, and update the linear META wait in one transaction. Unit questions park only their own stage. HUMAN records the creating run and callback.                                                                      |
| Open an engine gate         | Create HUMAN and park META atomically, conditional on the run. The durable gate-open step also retires a specific legacy gate if its later META ownership check fails.                                                                    |
| Answer                      | For owned gates, check the active run and, for agent questions, the creating callback with the pending-to-answered write. Deliver the callback from the committed answer row, including a binding that raced the endpoint's initial read. |
| Unpark                      | Both engine and stage gates use the same conditional transition. Already RUNNING with the same run token and no pending gate means the write previously committed; another owner or another pending gate means retirement.                |
| Finish or fail a worker     | Check the run and callback in the same transaction as the stage write. A retired result stops orchestration without failing a replacement attempt.                                                                                        |
| Retire an unusable question | Check the stage callback and gate identity. Clearing META also requires its expected pending gate. Cleanup errors cannot replace the original recovery error.                                                                             |

Engine-gate durable operation names and order remain compatible with the
implementation before the recovery PR. The replay fixture is frozen from commit
`590ace6`; its checkpoints are resumed with the current implementation in tests.

Legacy synchronous dispatches lack ownership tokens and retain their existing
behavior. The worker does not guess an owner to overwrite an unverified legacy
stage after a failed recovery read. Deploy the orchestrator and runtime changes
together; an already running container on an older image does not acquire these
checks retroactively.

Storage must accept a write to persist FAILED state. During a complete outage the
worker preserves its structured failure, while durable dispatch and callback
reconciliation remain the recovery backstop. These guards protect process state;
they do not undo provider requests or Git operations already in flight.

## Completion boundaries

New histories capture completion policy 1 in the existing `load-meta` result.
The shared unit-completion evaluator validates the pinned, resolved workflow's
expected sections, current-plan units, repository integration evidence and scoped
human omissions. Section fan-in and final success use the same evaluator against
persisted process state. Missing rows, unfinished work and partial integrations
cannot pass; missing provenance, read failures and ambiguous legacy omissions
remain unverified. Serial workflows and sections excluded by approved workflow
scope/composition remain valid. Pre-deploy `MERGED` rows without an
`integrationResults` attribute retain their supported integrated meaning, including
multi-repository retries and rewinds past completed sections. New integrations
always write the attribute; explicit empty, invalid or incomplete evidence never
receives this legacy exemption. PR-per-unit integration still requires its
per-repository PR records. Unpinned historical serial intents without unit work
keep their success presentation without unit-completion diagnostics. Cancelled
executions and recorded aborts from the current run are classified as aborted
before workflow-pin resolution, without implying that their work was integrated.
Missing or truncated execution reads remain unverified.

Required integration writes are not best-effort. A lost response is reconciled
from persisted state; an unrecorded integration stops the lane before dependent
work can proceed. Final status and its completion receipt commit together under
run, status, META revision and unit-plan conditions. Initial publication rechecks
completion before opening a PR. These checks never rerun models or repair rows.
Marker-absent histories (policy 0) retain their saved operation sequence and
terminal step. The intermediate completion implementation was not released and
has no separate replay path. Saved historical successes are never rewritten.

A terminal success with unfinished or unverified work is shown honestly in the
intent detail. Accepted omissions remain partial delivery, not execution defects.
This release does not add automatic preservation-and-continuation recovery for
finished incomplete intents. Existing orphan-lane/PR-review repair and ordinary
rewind remain supported; rewind resets affected lanes, including integrated work,
and clears omission receipts for the work explicitly being retried. Original
answers and events remain historical. Preserve runtime and methodology pins.

Deploy the runtime, orchestrator, intents API and frontend from the same release.
No automatic production audit, status migration or runtime repinning is performed.

## Run a bounded read-only completion audit

`scripts/audit-completion.mjs` is an operator-run, read-only diagnostic. It emits
JSON Lines with intent/execution/run IDs, state, reasons, unit counts and bounded
summary metrics. No scheduled infrastructure, account scan, automatic recovery,
provider calls or model calls are installed.

Try the sanitized fixture first; it needs no AWS credentials and deliberately
exits 2 with one incomplete execution:

```bash
node scripts/audit-completion.mjs \
  --fixture scripts/test/fixtures/completion-audit-example.json \
  --project example \
  --from 2026-10-01T00:00:00.000Z --to 2026-10-02T00:00:00.000Z
```

After explicitly choosing a project, interval and read-only AWS profile:

```bash
node scripts/audit-completion.mjs \
  --profile platform-read --region eu-central-1 \
  --table YOUR_V2_PROCESS_TABLE --blocks-table YOUR_BLOCKS_TABLE \
  --artifacts-bucket YOUR_ARTIFACTS_BUCKET \
  --project YOUR_PROJECT_ID --status SUCCEEDED \
  --from 2026-10-01T00:00:00.000Z --to 2026-10-02T00:00:00.000Z \
  --limit 100 --page-size 25 --max-pages 10 \
  --record-limit 2000 --max-requests 5000 \
  --checkpoint /tmp/completion-audit-checkpoint.json \
  >> /tmp/completion-audit.jsonl
```

The time interval is **execution start time**, inclusive `from`, exclusive `to`,
in normalized ISO UTC format. GSI1 supports project/status/start-time discovery;
each discovered META is verified on the base table. Use separate invocations
for SUCCEEDED, FAILED or CANCELLED. No cross-project discovery is available.
The default status is SUCCEEDED.

Limits apply per invocation: at most 1,000 executions, 100 pages of at most 100
items, 10,000 completion records per execution, and 10,000 application AWS read
requests. Defaults are 100 executions, 10 pages of 25, 2,000 records and 5,000
requests. SDK retries are limited to two attempts per request. Runtime
finalization uses the 2,000-record limit and reports unverified if exceeded.
This bounds reads, not a wall-clock deadline. The process table and blocks table
need targeted GetItem/Query permissions (and index Query); pinned methodology
bundles need GetObject on the artifacts bucket. The command rejects writes and
scans even if its credentials are more privileged.

Exit codes: **0** means the batch finished with only complete/partial/aborted
results, **2** means incomplete work, unverified evidence or a command failure,
and **3** means a clean batch still has more pages. Inspect the summary's
`finished` and `discoveryUnverified` fields even on exit 2. Rerun the exact command
with the checkpoint until `finished: true`; changing scope or limits requires a
fresh checkpoint. Standard output can be appended as above; `--output FILE`
instead replaces that file with the current batch. Checkpoints are written only
after output, so interruption can repeat findings but cannot advance past
unwritten output. Deduplicate monitoring by execution/run IDs when ingesting
repeated batches. A completed checkpoint contains `null`; using it again starts
a fresh audit. Delete a checkpoint to deliberately rescan the chosen interval.

Legacy workflow snapshots that reference mutable stage definitions without
captured methodology pins or a policy-2 section receipt are also unverified:
resolving today's definitions cannot prove their historical section list.

An unavailable plan, read failure, exhausted budget, concurrent recovery or
ambiguous legacy data is **unknown**, never clean or definitely corrupt.
The audit observes current terminal execution records; it does not reconstruct
every retired durable run. The GSI can lag, so repeat the same bounded interval
after it has settled. Review each finding in the intent audit UI. Finished incomplete intents do not
have automatic preservation recovery: an ordinary rewind reruns affected work,
or a new intent can implement the remaining scope. No production audit or recovery
is required as part of installing this detection capability.
