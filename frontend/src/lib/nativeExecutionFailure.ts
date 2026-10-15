export function nativeExecutionFailureMessage(code: string | undefined): string {
  switch (code) {
    case 'native_execution_question_spec_unsafe':
      return 'The question file failed a filesystem safety check. Previously admitted work is retained.';
    case 'native_execution_question_spec_invalid':
      return 'The workflow returned a question form that native execution could not verify.';
    case 'native_recovery_session_cwd_invalid':
      return 'The session referenced a working directory outside its captured project directories.';
    case 'native_recovery_session_id_mismatch':
      return 'The checkpoint contained a different session identity.';
    case 'native_recovery_home_path_invalid':
    case 'native_recovery_session_layout_unsupported':
      return 'Native execution could not save this session’s recovery file layout.';
    case 'native_recovery_changed':
    case 'native_snapshot_changed':
      return 'Files changed while native execution was saving the turn.';
    case 'native_recovery_limit':
    case 'native_snapshot_limit':
      return 'The turn exceeded the native file capture limits.';
    case 'native_recovery_session_missing':
    case 'native_recovery_session_incomplete':
    case 'native_recovery_session_invalid':
    case 'native_recovery_session_identity':
      return 'Native execution could not verify the session checkpoint.';
    default:
      return 'Execution reported an error.';
  }
}
