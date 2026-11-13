// The captured engine pin and its reviewed profile. This module is imported
// by the runtime command validator, which the preparation-only runtime server
// loads: keep it free of SDK, storage and execution imports.
export const NATIVE_ENGINE_PROFILE = Object.freeze({
  id: 'aidlc-2.11.1-native-1',
  version: '2.11.1',
  sourceCommit: '895a35d86d20336d9b7bc4aedc9440e4a12c83ab',
  packageId: 'sha256:577eced0d4425aba7cd4fdaec100315363e104d28fa47f1aec141aac606dfb56',
  runtimeSha256: '9f213c8254e646123b3f4bcefe347a61c95c72fee9fda4bf9afab42ccb20f44a',
  harnesses: Object.freeze(['claude', 'codex', 'opencode']),
});
export const nativeWorkflowProfile = (packageId, harness) =>
  packageId === NATIVE_ENGINE_PROFILE.packageId && NATIVE_ENGINE_PROFILE.harnesses.includes(harness)
    ? NATIVE_ENGINE_PROFILE.id
    : null;
export const engineFailure = (code = 'NATIVE_ENGINE_INVALID') =>
  Object.assign(new Error(code), { code });

const SHA = /^[a-f0-9]{64}$/;
const shape = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).toSorted().join(',') === keys.toSorted().join(',');

export const nativeEnginePin = (value, { accountId, packageId, harness } = {}) => {
  if (
    !shape(value, ['profileId', 'producerSha256', 'functionArn', 'version']) ||
    value.profileId !== NATIVE_ENGINE_PROFILE.id ||
    !SHA.test(value.producerSha256 ?? '') ||
    !/^arn:(aws|aws-us-gov|aws-cn):lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}$/.test(
      value.functionArn ?? '',
    ) ||
    !/^[1-9][0-9]{0,19}$/.test(value.version ?? '') ||
    (accountId && value.functionArn.split(':')[4] !== accountId) ||
    (packageId && nativeWorkflowProfile(packageId, harness) !== value.profileId)
  )
    throw engineFailure('NATIVE_ENGINE_PIN_INVALID');
  return structuredClone(value);
};
