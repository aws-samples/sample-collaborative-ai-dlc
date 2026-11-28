// Failure code → one plain sentence. Codes come from the orchestrator's
// `fail(reason, …)` calls (lambda/v2-orchestrator/index.js, section.js) and
// from stage outcomes (lambda/agentcore/commands/run-stage.js), surfaced as
// `intent.failure.code` or as the prefix of the legacy `failureReason` string
// ("stage_failed: <stageId>: <reason>: <detail>"). The raw text stays available
// as `technical` for a "Technical details" disclosure.

export const GENERIC_FAILURE_SENTENCE = 'The run stopped because of an internal error.';

export const FAILURE_SENTENCES: Record<string, string> = {
  // Stage outcomes (agent runtime)
  not_implemented: 'This stage uses a mode this platform version does not support yet.',
  cli_error: 'The agent could not be started for this stage.',
  cli_nonzero_exit: 'The agent exited with an error before finishing the stage.',
  no_cli: 'The agent tool selected for this run is not installed in the runtime.',
  credential_invalid: 'The agent credential was rejected; it needs to be rotated in settings.',
  credential_unavailable: 'No usable agent credential was available for this run.',
  credential_quota_exhausted: 'The agent credential ran out of quota.',
  mcp_secret_error: 'A tool server secret is missing or misconfigured.',
  methodology_body_unavailable:
    'The stage instructions could not be loaded from the AI-DLC release.',
  conductor_unavailable: 'The stage coordinator instructions could not be loaded.',
  lead_persona_unavailable: 'The lead agent persona for this stage could not be loaded.',
  reviewer_not_found: 'The reviewer configured for this stage does not exist in the release.',
  sensor_blocked: 'A required automated check failed and held the stage.',
  workspace_restore_failed: 'The workspace could not be restored to continue the stage.',
  loopback_archive_failed: 'Earlier work could not be archived before going back a stage.',
  gate_not_found: 'The answer this stage was waiting for could not be found.',
  gate_not_answered: 'The stage resumed before its question was answered.',
  engine_crashed: 'The agent runtime stopped unexpectedly.',
  stage_attempt_conflict: 'Another attempt of this stage took over.',
  // Orchestrator run-level reasons
  stage_failed: 'A stage reported an error and the run stopped.',
  init_ws_failed:
    'The workspace could not be prepared, for example the repository checkout failed.',
  init_ws_callback_failed: 'Workspace setup did not report back in time.',
  init_ws_bad_callback_result: 'Workspace setup reported a result the platform could not read.',
  stage_callback_failed: 'The stage did not report back in time.',
  stage_bad_callback_result: 'The stage reported a result the platform could not read.',
  dispatch_failed: 'The stage could not be sent to the agent runtime.',
  checkpoint_failed: 'The work could not be saved at the end of the stage.',
  plan_invalid: 'The workflow plan for this intent is not valid.',
  rewind_stage_not_found: 'The stage chosen to restart from is not in this workflow.',
  rewind_upstream_incomplete:
    'The run cannot restart there because earlier stages are not complete.',
  parked_without_gate: 'The run paused without a question to answer.',
  durable_deadline_expired: 'The run reached its maximum lifetime while waiting for an answer.',
  gate_callback_conflict: 'The question was already linked to a different stage attempt.',
  units_promotion_failed: 'The units of work could not be prepared from the plan.',
  loopback_reset_failed: 'Going back to an earlier stage could not reset the later stages.',
  invalid_walking_skeleton: 'The plan names a walking skeleton that is not a valid unit.',
  unit_plan_missing: 'A parallel section started without a units-of-work plan.',
  invalid_unit_waves: 'The units-of-work schedule is inconsistent.',
  section_aborted: 'Someone stopped the run after some units could not finish.',
  section_incomplete: 'Some units of work did not finish.',
  completion_unverified: 'The platform could not confirm the run finished; the work is preserved.',
  gateway_grant_retirement_failed: 'Temporary access granted to the run could not be revoked.',
  orchestrator_error: GENERIC_FAILURE_SENTENCE,
};

export interface FailureDescription {
  code?: string;
  stageId?: string;
  sentence: string;
  technical: string;
}

const STAGE_FAILED = /^stage_failed: ([^:]+): ([a-z][a-z0-9_]*)(?::|$)/;
const CODE_PREFIX = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?::|$)/;

export function describeFailure(code?: string | null, message?: string | null): FailureDescription {
  const raw = message?.trim() ?? '';
  const stageMatch = STAGE_FAILED.exec(raw);
  const prefixCode = stageMatch ? stageMatch[2] : CODE_PREFIX.exec(raw)?.[1];
  const explicit = code?.trim() || undefined;
  const resolved = explicit && explicit !== 'stage_failed' ? explicit : (prefixCode ?? explicit);

  const technical =
    resolved && raw && !raw.includes(resolved) ? `${resolved}: ${raw}` : raw || resolved || '';

  return {
    ...(resolved ? { code: resolved } : {}),
    ...(stageMatch ? { stageId: stageMatch[1] } : {}),
    sentence: (resolved && FAILURE_SENTENCES[resolved]) || GENERIC_FAILURE_SENTENCE,
    technical,
  };
}
