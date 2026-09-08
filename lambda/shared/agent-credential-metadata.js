import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { parseLambdaPayload } from './lambda-payload.js';
import {
  AGENT_CREDENTIAL_METADATA_ACTIONS,
  AGENT_CREDENTIAL_PROVIDERS,
  CREDENTIAL_VALUE_KINDS,
  normalizeCredentialBinding,
} from './agent-credentials.js';

const lambda = new LambdaClient({});
const invalidMetadata = (message) =>
  Object.assign(new Error(message), {
    code: 'AGENT_CREDENTIAL_METADATA_FAILED',
  });

const invokeMetadataBroker = async (
  payload,
  {
    lambdaClient = lambda,
    functionName = process.env.AGENT_CREDENTIAL_METADATA_FUNCTION || '',
  } = {},
) => {
  if (!functionName) {
    throw Object.assign(new Error('Agent credential metadata broker is not configured'), {
      code: 'AGENT_CREDENTIAL_METADATA_NOT_CONFIGURED',
    });
  }
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  if (response.FunctionError) {
    throw Object.assign(new Error('Agent credential metadata broker invocation failed'), {
      code: 'AGENT_CREDENTIAL_METADATA_FAILED',
    });
  }
  const result = parseLambdaPayload(response.Payload);
  if (!result?.ok) {
    throw Object.assign(new Error('Agent credential metadata broker denied the request'), {
      code: result?.code || 'AGENT_CREDENTIAL_METADATA_FAILED',
    });
  }
  return result;
};

export const readCredentialScopeStatusViaBroker = async (request, deps) => {
  // `includeBindingDetail` defaults to FALSE so the fail-safe direction is the
  // default: a caller must opt in to receiving tenant-identifying binding detail.
  // Only a path gated to a principal that may modify the binding may opt in
  // (specs/bedrock-iam-role-credential-mode: req-same-and-cross-account).
  const { includeBindingDetail = false, ...brokerRequest } = request ?? {};
  const result = await invokeMetadataBroker(
    {
      action: AGENT_CREDENTIAL_METADATA_ACTIONS.READ_SCOPE_STATUS,
      ...brokerRequest,
    },
    deps,
  );
  if (!result.status || typeof result.status !== 'object' || Array.isArray(result.status)) {
    throw invalidMetadata('Agent credential metadata broker returned an invalid status');
  }
  // This is a trust boundary, so every field is coerced rather than spread:
  // the broker's response shape is validated here, not assumed. Phase 2 adds the
  // three mode-aware fields (req-configured-semantics); an unrecognised mode
  // becomes null so a newer broker meeting an older reader degrades to "not
  // configured" rather than rendering a mode the UI cannot interpret.
  const mode = result.status.bedrockMode;
  const status = {
    bedrockBearerTokenSet: result.status.bedrockBearerTokenSet === true,
    kiroApiKeySet: result.status.kiroApiKeySet === true,
    bedrockMode: mode === 'bearer' || mode === 'role' ? mode : null,
    bedrockExternalIdSet: result.status.bedrockExternalIdSet === true,
  };
  // The role ARN is not a secret, but it is tenant-identifying and no
  // lower-privilege surface needs it — GET /agents/settings is reachable by any
  // authenticated user, so it must not carry which role a deployment assumes.
  //
  // The binding's external ID rides the SAME gate. It is the value the broker will
  // send to STS, so it is the authoritative answer for a trust policy — the
  // standalone staging parameter is not, because it outlives a rebind to a
  // same-account role that sends none.
  if (includeBindingDetail) {
    status.bedrockRoleArn =
      typeof result.status.bedrockRoleArn === 'string' && result.status.bedrockRoleArn
        ? result.status.bedrockRoleArn
        : null;
    status.bedrockExternalId =
      typeof result.status.bedrockExternalId === 'string' && result.status.bedrockExternalId
        ? result.status.bedrockExternalId
        : null;
  }
  return status;
};

export const resolveEffectiveCredentialMetadataViaBroker = async (request, deps) => {
  const result = await invokeMetadataBroker(
    {
      action: AGENT_CREDENTIAL_METADATA_ACTIONS.RESOLVE_EFFECTIVE_BINDINGS,
      ...request,
    },
    deps,
  );
  if (!result.bindings || typeof result.bindings !== 'object' || Array.isArray(result.bindings)) {
    throw invalidMetadata('Agent credential metadata broker returned invalid bindings');
  }
  // The kind is DESCRIPTIVE, not a security control: it decides whether a badge
  // says "IAM role" or "key". So an absent or unrecognised kind degrades to null
  // rather than throwing — an older broker that returns only `bindings`, or a
  // newer one returning a kind this reader does not know, must leave capabilities
  // working and merely unlabelled. Throwing here would turn a cosmetic field into
  // an outage during a mixed-version deploy window.
  const kinds =
    result.credentialKinds &&
    typeof result.credentialKinds === 'object' &&
    !Array.isArray(result.credentialKinds)
      ? result.credentialKinds
      : {};
  const credentialKinds = Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => {
      const kind = kinds[provider];
      return [
        provider,
        kind === CREDENTIAL_VALUE_KINDS.BEARER || kind === CREDENTIAL_VALUE_KINDS.ROLE
          ? kind
          : null,
      ];
    }),
  );
  try {
    const bindings = Object.fromEntries(
      AGENT_CREDENTIAL_PROVIDERS.map((provider) => [
        provider,
        result.bindings[provider] ? normalizeCredentialBinding(result.bindings[provider]) : null,
      ]),
    );
    return { bindings, credentialKinds };
  } catch {
    throw invalidMetadata('Agent credential metadata broker returned invalid bindings');
  }
};

export const resolveEffectiveCredentialBindingsViaBroker = async (request, deps) =>
  (await resolveEffectiveCredentialMetadataViaBroker(request, deps)).bindings;

export { invokeMetadataBroker };

// req-binding-preflight. Ask the broker to attempt a bare AssumeRole for a binding
// that has NOT been persisted yet, and return its verdict.
//
// Total by construction: a broker or transport failure becomes an `unavailable`
// verdict rather than an exception, because the preflight is an input check and
// not a security control — resolution re-checks the binding on every stage, so a
// preflight that cannot run must never be the reason a legitimate save fails.
export const preflightBedrockRoleBindingViaBroker = async (request, deps) => {
  let result;
  try {
    result = await invokeMetadataBroker(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.PREFLIGHT_BEDROCK_ROLE,
        ...request,
      },
      deps,
    );
  } catch {
    return { ok: false, cause: 'unavailable', candidates: [], available: false };
  }
  const preflight = result?.preflight;
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
    return { ok: false, cause: 'unavailable', candidates: [], available: false };
  }
  return {
    ok: preflight.ok === true,
    cause: typeof preflight.cause === 'string' ? preflight.cause : 'unavailable',
    sessionName: typeof preflight.sessionName === 'string' ? preflight.sessionName : null,
    candidates: Array.isArray(preflight.candidates) ? preflight.candidates : [],
    available: true,
  };
};

export default {
  invokeMetadataBroker,
  preflightBedrockRoleBindingViaBroker,
  readCredentialScopeStatusViaBroker,
  resolveEffectiveCredentialBindingsViaBroker,
  resolveEffectiveCredentialMetadataViaBroker,
};
