// Closed, content-free failure identities shared by the runtime, diagnostic
// mapper/sink and authority store. Never accept a namespace prefix as evidence
// that an arbitrary provider/port error is safe to persist or display.
export const NATIVE_RUNTIME_FAILURE_CODES = Object.freeze([
  'native_execution_failed',
  'native_execution_initialization_failed',
  'native_execution_initialization_unverified',
  'native_execution_cleanup_incomplete',
  'native_execution_status_unconfirmed',
  'native_execution_start_incomplete',
  'native_execution_existing_owner',
  'native_execution_owner_conflict',
  'native_execution_owner_invalid',
  'native_execution_local_record_unavailable',
  'native_execution_reply_conflict',
  'native_execution_reply_admission_unconfirmed',
  'native_execution_interaction_unconfirmed',
  'native_execution_recovery_unconfirmed',
  'native_execution_recovery_failed',
  'native_execution_cancelled',
  'native_execution_command_failed',
  'native_execution_output_invalid',
  'native_execution_output_json',
  'native_execution_output_utf8',
  'native_execution_output_shape',
  'native_execution_output_text',
  'native_execution_output_result',
  'native_execution_output_failed',
  'native_execution_output_incomplete',
  'native_execution_output_terminal',
  'native_execution_output_session',
  'native_execution_output_credential',
  'native_execution_output_limit',
  'native_execution_directory_changed',
  'native_execution_request_invalid',
  'native_execution_busy',
  'native_execution_checkout_commit_mismatch',
  'native_execution_checkout_exists',
  'native_execution_checkout_failed',
  'native_execution_checkout_link',
  'native_execution_claude_settings_invalid',
  'native_execution_configuration_invalid',
  'native_execution_credentials_missing',
  'native_execution_directory_invalid',
  'native_execution_workspace_invalid',
  'native_execution_workflow_not_created',
  'native_execution_workflow_state_unavailable',
  'native_execution_transport_invalid',
  'native_execution_transport_conflict',
  'native_execution_transport_kiro_unqualified',
  'native_execution_disabled',
  'native_execution_file_invalid',
  'native_execution_harness_invalid',
  'native_execution_lfs_unavailable',
  'native_execution_local_record_invalid',
  'native_execution_options_invalid',
  'native_execution_package_invalid',
  'native_execution_preparation_invalid',
  'native_execution_private_state_tracked',
  'native_execution_publication_unconfirmed',
  'native_execution_question_spec_invalid', // Retained failures remain readable.
  'native_execution_question_spec_unsafe',
  'native_execution_scope_mismatch',
  'native_execution_start_failed',
  'native_execution_submodules_unavailable',
  ...[
    'adapter_failed',
    'adapter_invalid',
    'arguments_invalid',
    'cancelled',
    'capture_failed',
    'changed',
    'credential_config',
    'credential_content',
    'external_hardlink',
    'home_path_invalid',
    'limit',
    'manifest_invalid',
    'mode_invalid',
    'mount',
    'path_invalid',
    'project_gitdir_unsupported',
    'restore_failed',
    'restore_not_empty',
    'restore_unverified',
    'root_invalid',
    'session_identity',
    'session_id_mismatch',
    'session_cwd_invalid',
    'session_incomplete',
    'session_invalid',
    'session_layout_unsupported',
    'session_missing',
    'session_unrelated',
    'special_file',
    'symlink',
    'time_failed',
    'time_invalid',
  ].map((suffix) => `native_recovery_${suffix}`),
  ...[
    'arguments_invalid',
    'cancelled',
    'changed',
    'credential_content',
    'hardlink',
    'io_failed',
    'limit',
    'link',
    'mount',
    'path_invalid',
    'root_invalid',
    'special_file',
  ].map((suffix) => `native_snapshot_${suffix}`),
]);
const codes = new Set(NATIVE_RUNTIME_FAILURE_CODES);

const OUTPUT_REASONS = new Set([
  'json_grammar',
  'duplicate_field',
  'field_limit',
  'record_limit',
  'depth_limit',
  'utf8',
  'record_shape',
  'message_shape',
  'text_shape',
  'text_limit',
  'text_encoding',
  'no_visible_text',
  'result_shape',
  'result_empty',
  'result_mismatch',
  'session',
  'terminal',
  'failed',
  'incomplete',
  'credential',
  'query_limit',
  'unexpected',
]);
const OUTPUT_TYPES = new Set([
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.completed',
  'text',
  'step_finish',
  'error',
  'other',
  'none',
]);
const own = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

// Runtime status, lifecycle logger and controller diagnostic sinks share this
// closed projection. Never retain raw frames, error messages or arbitrary types.
export const nativeOutputDiagnostic = (input) => {
  const reason = own(input, 'reason');
  if (!OUTPUT_REASONS.has(reason)) return undefined;
  const result = { reason };
  const recordType = own(input, 'recordType');
  if (OUTPUT_TYPES.has(recordType)) result.recordType = recordType;
  for (const key of ['recordIndex', 'queries', 'messages', 'textBytes', 'resultBytes']) {
    const value = own(input, key);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647) result[key] = value;
  }
  return result;
};

// Public-snapshot diagnostics describe the rejected entry, never its path,
// target, contents or creating process. A named directory is not provenance.
export const nativeSnapshotDiagnostic = (input) => {
  if (own(input, 'reason') !== 'symbolic_link') return undefined;
  const result = { reason: 'symbolic_link' };
  const pathClass = own(input, 'pathClass');
  if (['dependency_bin', 'dependency', 'workflow', 'other'].includes(pathClass))
    result.pathClass = pathClass;
  const phase = own(input, 'phase');
  if (['baseline', 'final'].includes(phase)) result.phase = phase;
  const hash = own(input, 'pathSha256');
  if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) result.pathSha256 = hash;
  for (const key of ['pathDepth', 'entries', 'files', 'bytes']) {
    const value = own(input, key);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647) result[key] = value;
  }
  return result;
};

export const nativeRuntimeFailureCode = (error) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && codes.has(descriptor.value)
      ? descriptor.value
      : 'native_execution_failed';
  } catch {
    return 'native_execution_failed';
  }
};
