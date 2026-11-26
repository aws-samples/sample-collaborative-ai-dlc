// Native execution: an intent that runs the AI-DLC methodology itself
// (`engine: "native"`) instead of the platform's stage engine. The design and
// its delivery order live in docs/development/native-execution-plan.md.
//
// The feature is hidden behind a runtime platform setting in SSM at
// `${AGENT_SETTINGS_SSM_PREFIX}/native-execution`. Only the exact value
// `enabled` switches it on. The parameter is not created by Terraform, so a
// deployment that never set it has native execution off.
//
// The flag gates NEW native work only. An intent keeps the engine it was
// created with, and an existing native intent stays readable while the flag is
// off.
import { GetParameterCommand } from '@aws-sdk/client-ssm';

export const NATIVE_ENGINE = 'native';

export const nativeExecutionParameterName = (prefix) => `${prefix}/native-execution`;

// Fail-safe read: no prefix, a missing parameter, a read failure and any value
// other than `enabled` all yield `disabled`. A missing parameter is the normal
// state of a deployment that never set the flag. Any other failure (a missing
// IAM grant, a throttle) is handed to `onError`, so the caller can log why the
// feature reads as off.
export const readNativeExecution = async (ssm, prefix, { onError } = {}) => {
  if (!prefix) return 'disabled';
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: nativeExecutionParameterName(prefix) }),
    );
    return res.Parameter?.Value === 'enabled' ? 'enabled' : 'disabled';
  } catch (error) {
    if (error?.name !== 'ParameterNotFound') onError?.(error);
    return 'disabled';
  }
};

// The engine a create request asks for. Absent or null is a platform intent,
// which stores no `engine` at all, so its row and its responses stay exactly
// as they were before native execution existed.
export const normalizeEngine = (value) => {
  if (value === undefined || value === null) return { value: null };
  if (value === NATIVE_ENGINE) return { value: NATIVE_ENGINE };
  return {
    error: {
      error: `engine must be "${NATIVE_ENGINE}" or omitted`,
      code: 'engine_invalid',
    },
  };
};

export const isNativeExecution = (meta) => meta?.engine === NATIVE_ENGINE;

// Inputs that select or shape the platform's stage plan. A native intent has
// no workflow, scope, release or stage plan of its own, so the intents API
// refuses them by name instead of storing a value nothing reads.
// `sparseCheckout` is refused until native delivery defines what a commit of a
// partial checkout contains (open topic T11 in the plan).
export const NATIVE_UNSUPPORTED_INPUTS = Object.freeze([
  'scope',
  'composedGrid',
  'policyScope',
  'skipStageIds',
  'aidlcSettings',
  'methodologyReleaseId',
  'methodologyReleaseTest',
  'constructionGateAutonomy',
  'sparseCheckout',
]);

// The refused inputs a request body carries, or null. `undefined` means the
// caller did not send the field. An explicit null is still an input: for these
// fields it means "clear", which is as meaningless for a native intent as a
// value.
export const nativeUnsupportedInputError = (data) => {
  const fields = NATIVE_UNSUPPORTED_INPUTS.filter((field) => data?.[field] !== undefined);
  if (fields.length === 0) return null;
  return {
    error: `Not supported for a native intent: ${fields.join(', ')}`,
    code: 'native_input_not_supported',
    fields,
  };
};
