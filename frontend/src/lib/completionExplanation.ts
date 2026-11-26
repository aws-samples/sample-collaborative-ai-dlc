const explanations: Record<string, string> = {
  unit_plan_missing: 'The list of planned units is missing.',
  legacy_workflow_unpinned:
    'This run didn’t record which steps were required, so some work can’t be verified.',
  pinned_plan_read_failed: 'The saved workflow could not be loaded.',
  pinned_plan_unverified: 'The saved workflow could not be verified.',
  completion_read_limit: 'Only part of the run history was available.',
  completion_read_failed: 'The run history could not be loaded.',
  expected_sections_unknown: 'The run history doesn’t identify the planned sections.',
  legacy_section_mapping_unknown:
    'The run history doesn’t identify which section each unit belonged to.',
  repository_evidence_missing:
    'The run history doesn’t show whether the changes reached every repository.',
  repository_evidence_invalid: 'The saved repository results could not be verified.',
  repository_integration_incomplete: 'Some repository changes still need to be integrated.',
  unit_row_missing: 'The planned unit has no saved result.',
  unit_state_missing: 'The unit has no saved status.',
  legacy_skip_scope_unknown: 'The run history doesn’t identify which units were skipped.',
};

export function completionExplanation(reason?: string | null) {
  return (
    (reason && explanations[reason]) ||
    'The run history doesn’t show whether all planned work was finished.'
  );
}
