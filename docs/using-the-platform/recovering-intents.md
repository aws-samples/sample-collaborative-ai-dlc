# Recovering an Intent

An expired or exhausted provider credential can interrupt an intent without
removing its saved work. Credential recovery and execution recovery are separate
steps: replacing a key does not recreate a missing agent conversation or repair
an inconsistent unit plan.

## Preserve the saved work

Use the export dropdown beside **Discuss** in the intent header to select your
local harness, then choose **Download workspace**. Existing started intents can
use [native workspace export](exporting-workspaces.md); a working model credential
or CLI conversation is not required.

Failed or waiting intents export their stored state. Running intents normally
export the latest completed checkpoint. Compatibility checks can prevent export
of edited or mixed methodology revisions. Keep the exact error if export fails.

The archive contains methodology artifacts, workflow state, human questions and
answers, and continuation information. It is not a complete backup of raw runtime
logs, every project memory, or the original CLI transcript. Source repositories
and credentials are retrieved separately.

If you have already continued locally, extract into a separate recovery directory
and reconcile the saved artifacts and Git branches with your current work. Follow
the setup commands generated for your own intent. Local work does not synchronize
back to the platform.

## Rotate the intent's credential

Open the intent's configuration details and check its credential source. Started
intents retain their selected personal, space, or platform binding. Legacy intents
without a binding use the platform credential.

Update the key at that same scope. Personal credentials are in **Account
Settings**; space credentials are in **Space Settings**; a platform administrator
manages platform credentials. New invocations resolve the latest value, including
invocations in an existing runtime session. Updating another scope can make a new
intent work while leaving the original intent's binding unchanged.

`credential_quota_exhausted` means the provider reported an exhausted credit or
usage allowance. Replenish it or rotate the bound key, then retry the failed
stage. A transient rate limit alone is not treated as exhausted credits. The
platform does not automatically switch credential scopes or providers.

MCP definitions, repositories and model selections are separate intent snapshots.
Rotating a secret does not refresh those configurations.

## Recover the execution

| Symptom                                                                            | Recovery                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed stage with **Retry \<stage\>** available                                    | Export first, then retry. Completed upstream stages remain; affected artifacts are archived and the target and downstream work may run again. An incomplete parallel section can restart from its first stage.                           |
| `resume_no_session`                                                                | The saved session handle is unavailable. A correctly owned parked Kiro stage can recover a fresh conversation with its recorded answer. If ownership cannot be established, use stage retry instead of repeatedly resuming the old gate. |
| `kiro_session_missing`, `kiro_store_persist_failed` or `stage_park_persist_failed` | The engine retries and verifies the saved conversation. A usable saved question remains resumable; a confirmed unusable one is retired. If storage cannot be read, restore it and retry; saved work is retained.                         |
| `resume_store_expired`                                                             | Automatic conversation recovery is outside its supported window. Export or use a reviewed stage retry.                                                                                                                                   |
| `resume_state_unavailable` or `unit_plan_unavailable`                              | A storage read failed. Restore storage availability before retrying; do not treat this as an absent session or missing unit.                                                                                                             |
| `unit_not_found`                                                                   | Have an operator reconcile the approved dependency DAG with the stored promoted unit plan and lane records before retrying the affected lane. Do not invent a replacement unit or blindly rename existing units.                         |
| **Parallel execution needs recovery**                                              | An owner or admin can use **Repair execution** for the detected orphaned waits or recoverable PR reviews. This preserves completed stages and merged units where provider reconciliation confirms their state.                           |
| `gate_callback_conflict`                                                           | A genuine conflicting callback must not be overwritten. Preserve the error and have an operator inspect the gate and current run owner. The engine handles an answer that wins the bind race without stealing a callback.                |

Repair has deliberately narrower eligibility than a generic restart. It requires
recoverable work in a single parallel section and can return `repair_not_needed`
for other failure states. The presence of `resume_no_session` or an engine gate
conflict alone does not make an intent eligible.

Retry uses the existing intent and its stored configuration. A full new intent is
not required for an ordinary failed-stage retry. Avoid editing callback IDs or
session IDs directly: those fields protect against a retired run or sibling lane
consuming the wrong answer.

For operator investigation, retain the intent ID, deployed revision, structured
failure, current stage and gate IDs, credential source (never its secret value),
and the relevant timeline entries. Compare the execution's current run owner,
stage/session metadata, gate status and approved unit-plan source before changing
state.
