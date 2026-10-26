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

## Gateway grant retirement

With the MCP Gateway enabled, every grant consumer (mcp-tools, engine-data, the
credential broker and the source-control `runtime` alias) refuses a retired
grant. A grant is retired one by one when its use ends (`GRANT#<jti>`: a stage
callback, a failed dispatch, a synchronous command that returned), or with every
grant of its execution by a deliberate stop (`EXEC#<executionId>`: cancel,
delete, rewind, recompose, lane repair, the durable watchdog). A run that ends on
its own writes no execution record. The writers live in
`lambda/shared/gateway-grant-retirement.js`; the HTTP handlers use
`lambda/intents/grant-retirement.js` and the durable orchestrator uses
`lambda/v2-orchestrator/grant-retirement.js`.

A jti whose retirement could not be written is recorded on META in
`pendingGrantRetirements`. For an execution grant, every consumer reads META
first and treats a recorded jti as retired, so there is no window in which it is valid again. `/start`,
rewind, recompose and lane repair retire the recorded jtis and clear the set
before they relaunch; their relaunch write is conditioned on the set being
absent, so a jti recorded meanwhile (by a concurrent derive) is retired and the
write retried once.

| Failure                                                                                  | Persisted state                                                                                                                                                                                                        | Response                                                                                                                                                        | Retry                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Execution retirement write fails before cancel, rewind, recompose, lane repair or delete | Nothing changed: the write comes before any state change                                                                                                                                                               | 503 `grant_retirement_unavailable`, log `GATEWAY_GRANT_RETIREMENT_FAILED`                                                                                       | Retry the same request                                                    |
| The run changed while the request was in flight                                          | Nothing changed when the first retirement detects it: the execution write is conditioned on the run id the request read. A lane repair that detects it after stopping the durable run keeps the state it already wrote | 409 `run_superseded`                                                                                                                                            | Refresh and retry                                                         |
| Lane repair: the second retirement, after the durable run was stopped, fails             | The execution is FAILED with `repairRelaunch` recorded; `failureReason: lane_repair_grant_retirement_failed` is stamped on a best-effort basis                                                                         | 503 `grant_retirement_unavailable`                                                                                                                              | Retry the repair: it resumes from the recorded phase                      |
| A recorded jti cannot be retired or cleared before a relaunch                            | Nothing relaunched; `pendingGrantRetirements` kept                                                                                                                                                                     | 503 `grant_retirement_unavailable`, log `GATEWAY_GRANT_RETIREMENT_FAILED` (`GATEWAY_GRANT_RETIREMENT_PENDING` when jtis kept arriving during the retried write) | Retry the same request                                                    |
| A synchronous derive ran, its grant retirement failed                                    | The jti is added to `pendingGrantRetirements`                                                                                                                                                                          | The command's own result                                                                                                                                        | None needed: consumers treat it as retired; the next relaunch retires it  |
| Same, and recording the jti failed too                                                   | The command's effect is kept; nothing records the live grant                                                                                                                                                           | 503 `grant_retirement_unavailable`, log `GATEWAY_GRANT_RETIREMENT_FAILED` with reason `<command>_pending_record`                                                | Retry once the store recovers; the grant expires at its TTL               |
| A compose job is accepted                                                                | The job runs in the background; its grant is not retired when it ends                                                                                                                                                  | 202                                                                                                                                                             | None: the grant expires after 15 minutes, or with an execution retirement |
| A compose dispatch fails or is refused                                                   | The compose is marked FAILED and its grant retired at once, both best effort (a failed retirement is recorded as for derive; during a store outage the compose can stay PENDING)                                       | 503 (compose dispatch failed)                                                                                                                                   | Start a new compose                                                       |
| The orchestrator cannot retire a stage or command grant after its durable retries        | The jti is added to `pendingGrantRetirements`, then the stage or run fails with `gateway_grant_retirement_failed`                                                                                                      | —                                                                                                                                                               | Rewind, recompose, lane repair or `/start` retire it before relaunching   |
| Same, and recording the jti failed too                                                   | The run fails with `gateway_grant_retirement_failed` (`recorded: false`)                                                                                                                                               | —                                                                                                                                                               | Same; the grant expires at its TTL                                        |
| The watchdog cannot retire the grants of an expired durable run                          | Nothing changed: the intent stays active                                                                                                                                                                               | —                                                                                                                                                               | The next watchdog tick retries                                            |
| A consumer cannot read the retirement records                                            | —                                                                                                                                                                                                                      | The call is denied: the verifier raises `GATEWAY_GRANT_RETIREMENT_UNAVAILABLE`, engine-data answers `grant_retirement_unavailable`                              | The caller's own retry                                                    |

Lane repair records its progress on META in `repairRelaunch` before the first
destructive step, with the run id it retired. In phase `cleanup`, a retried
repair redoes the idempotent cleanup for the recorded section and lanes instead
of re-checking eligibility (which the partial cleanup may have changed). Once
every cleanup step has landed, the phase becomes `relaunch`; a retry then only
performs the guarded relaunch. The record is cleared once the orchestrator is
invoked, so a failed invoke, rolled back to FAILED, can be retried too.
