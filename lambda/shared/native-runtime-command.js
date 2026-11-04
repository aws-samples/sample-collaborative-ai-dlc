// Current engine-to-runtime envelopes. Public member requests never carry
// these ownership, configuration or credential fields.
const IDENTITY = [
  'projectId',
  'executionId',
  'bindingId',
  'attemptId',
  'epoch',
  'runtimeSessionId',
];
const COMMON = ['command', ...IDENTITY, 'writerGeneration'];
const TURN = ['schemaVersion', 'sequence', 'configuration', 'credentials'];
export const NATIVE_RUNTIME_COMMANDS = Object.freeze({
  'native-start': { method: 'start', fields: [...COMMON, ...TURN, 'imageDigest', 'package'] },
  'native-continue': {
    method: 'continue',
    fields: [...COMMON, ...TURN, 'requestId', 'priorInteractionId', 'priorPublicationId', 'text'],
  },
  'native-resume': {
    method: 'resume',
    fields: [...COMMON, ...TURN, 'imageDigest', 'package', 'recoveryId'],
  },
  'native-status': { method: 'status', fields: COMMON },
  'native-activity': { method: 'activity', fields: [...COMMON, 'after'] },
  'native-cancel': { method: 'cancel', fields: COMMON },
});
const record = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const fields = (value, names) =>
  record(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const integer = (value, min) => Number.isSafeInteger(value) && value >= min;
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const invalid = () => {
  throw Object.assign(new Error('Invalid native runtime command'), {
    code: 'native_execution_request_invalid',
  });
};
const turnConfiguration = (value) =>
  fields(value, ['harness', 'recoveryMode', 'model', 'prompt', 'packageVersion', 'repository']) &&
  value.recoveryMode === 'efs-workspace-v1' &&
  fields(value.repository, ['provider', 'repository', 'branch', 'commit']);

export const nativeRuntimeCommand = (value, command = value?.command) => {
  if (!Object.hasOwn(NATIVE_RUNTIME_COMMANDS, command ?? '')) invalid();
  const definition = NATIVE_RUNTIME_COMMANDS[command];
  if (
    !fields(value, definition.fields) ||
    value.command !== command ||
    value.epoch !== 1 ||
    IDENTITY.filter((key) => key !== 'epoch').some(
      (key) => !matches(value[key], /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    ) ||
    !integer(value.writerGeneration, 1)
  )
    invalid();
  if (definition.fields.includes('schemaVersion')) {
    if (
      value.schemaVersion !== 2 ||
      !integer(value.sequence, 1) ||
      !turnConfiguration(value.configuration) ||
      !record(value.credentials)
    )
      invalid();
  }
  if (command === 'native-start' && (value.sequence !== 1 || value.writerGeneration !== 1))
    invalid();
  if (command === 'native-start' || command === 'native-resume') {
    if (
      !matches(value.imageDigest, /^sha256:[a-f0-9]{64}$/) ||
      !fields(value.package, ['candidate', 'archiveReceipt'])
    )
      invalid();
  }
  if (
    command === 'native-resume' &&
    (value.writerGeneration < 2 || !matches(value.recoveryId, UUID))
  )
    invalid();
  if (command === 'native-continue') {
    if (
      value.sequence < 2 ||
      !matches(value.requestId, UUID) ||
      !matches(value.priorInteractionId, SHA) ||
      !matches(value.priorPublicationId, SHA) ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      Buffer.byteLength(value.text) > 16 * 1024 ||
      !value.text.isWellFormed() ||
      // oxlint-disable-next-line no-control-regex -- Preserve tabs and line endings.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)
    )
      invalid();
  }
  if (command === 'native-activity' && !integer(value.after, 0)) invalid();
  // Nested package provenance, credentials and configuration values are still
  // checked by their owners at admission. This validator never strips fields.
  return value;
};
