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

New histories capture completion policy 2 in the existing `load-meta` result.
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
keep their success presentation without unit-completion diagnostics.

Required integration writes are not best-effort. A lost response is reconciled
from persisted state; an unrecorded integration stops the lane before dependent
work can proceed. Final status and its completion receipt commit together under
run, status, META revision and unit-plan conditions. Initial publication rechecks
completion before opening a PR. These checks never rerun models or repair rows.
Old marker-absent and completion-policy-1 histories retain their saved operation
sequence and terminal step. Saved historical successes are never rewritten.

A terminal success with unfinished or unverified work is shown honestly in the
intent detail. Accepted omissions remain partial delivery, not execution defects.
This release does not add automatic preservation-and-continuation recovery for
finished incomplete intents. Existing orphan-lane/PR-review repair and ordinary
rewind remain supported; rewind resets affected lanes, including integrated work,
and clears omission receipts for the work explicitly being retried. Original
answers and events remain historical. Preserve runtime and methodology pins.

Deploy the runtime, orchestrator, intents API and frontend from the same release.
No automatic production audit, status migration or runtime repinning is performed.
