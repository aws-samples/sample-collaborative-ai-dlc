export function nativeExecutionFailureMessage(code: string | undefined): string {
  switch (code) {
    case 'native_execution_question_spec_unsafe':
      return 'The question file failed a filesystem safety check. Previously admitted work is retained.';
    case 'native_execution_question_spec_invalid':
      return 'The workflow returned a question form that native execution could not verify.';
    case 'native_snapshot_changed':
      return 'Files changed while native execution was saving the turn.';
    case 'native_snapshot_limit':
      return 'The turn exceeded the native file capture limits.';
    default:
      return 'Execution reported an error.';
  }
}
