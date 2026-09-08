import { randomBytes as defaultRandomBytes } from 'node:crypto';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';

export const AGENT_CREDENTIAL_PROVIDERS = ['bedrock', 'kiro'];
export const AGENT_CREDENTIAL_SOURCES = ['user', 'space', 'platform'];
export const AGENT_CREDENTIAL_METADATA_ACTIONS = Object.freeze({
  READ_SCOPE_STATUS: 'read-agent-credential-scope-status',
  RESOLVE_EFFECTIVE_BINDINGS: 'resolve-effective-agent-credential-bindings',
  // Bind-time input check for a Bedrock role binding (req-binding-preflight).
  // Returns a verdict, never credentials.
  PREFLIGHT_BEDROCK_ROLE: 'preflight-bedrock-role-binding',
});

export const AGENT_CLI_PROVIDER = {
  kiro: 'kiro',
  claude: 'bedrock',
  opencode: 'bedrock',
  codex: 'bedrock',
};

const PROVIDER_CONFIG = {
  bedrock: {
    parameterName: 'bedrock-bearer-token',
    inputField: 'bedrockBearerToken',
    setField: 'bedrockBearerTokenSet',
    envName: 'AWS_BEARER_TOKEN_BEDROCK',
  },
  kiro: {
    parameterName: 'kiro-api-key',
    inputField: 'kiroApiKey',
    setField: 'kiroApiKeySet',
    envName: 'KIRO_API_KEY',
  },
};

// The temporary-credential variables a Bedrock IAM-role binding resolves to.
// They are NOT a provider's own env name: the binding lives in the same bedrock
// parameter, and which shape it holds is a property of the stored value
// (specs/bedrock-iam-role-credential-mode: req-single-parameter-encoding).
export const AWS_TEMPORARY_CREDENTIAL_ENV_NAMES = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

// Every name an invocation may have written for a credential. cleanBaseEnv
// scrubs all of them from the base environment on every invocation, so one
// caller's credentials can never leak into the next one's — which is why the
// three AWS names belong here and not only on the write side.
export const AGENT_CREDENTIAL_ENV_NAMES = Object.freeze([
  ...AGENT_CREDENTIAL_PROVIDERS.map((provider) => PROVIDER_CONFIG[provider].envName),
  ...AWS_TEMPORARY_CREDENTIAL_ENV_NAMES,
]);

const normalizeBase = (base) => String(base || '').replace(/\/+$/, '');

const assertIdentifier = (value, label) => {
  const normalized = String(value || '');
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
};

const assertProvider = (provider) => {
  if (!AGENT_CREDENTIAL_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported agent credential provider: ${provider}`);
  }
  return provider;
};

const assertSource = (source) => {
  if (!AGENT_CREDENTIAL_SOURCES.includes(source)) {
    throw new Error(`Unsupported agent credential source: ${source}`);
  }
  return source;
};

export const credentialProviderForCli = (cli) => AGENT_CLI_PROVIDER[cli] ?? null;

export const credentialEnvName = (provider) => PROVIDER_CONFIG[assertProvider(provider)].envName;

export const isConfiguredCredentialValue = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized !== '' && normalized !== 'placeholder';
};

// ── Credential-store failures, and the one place this module reads SSM ──
//
// specs/bedrock-iam-role-credential-mode: req-resolution-resilience. The broker
// reads SSM on EVERY resolution, concurrently across stages, so SSM's own request
// rate is on the critical path. A throttled read must be legible as exactly that
// rather than collapsing into a generic broker failure, because the operator
// response differs: throttling is transient and the stage retry will clear it,
// while an unavailable store is a configuration or permission fault.
//
// The classification is applied by the two READ HELPERS below rather than at each
// call site, and every read in this module goes through them. That placement is
// the point: a raw SSM error can echo the parameter name, which identifies the
// tenant, so a read that forgot to classify would leak one. Making the helper the
// only reader removes the chance to forget instead of fixing it once per site.
export const AGENT_CREDENTIAL_STORE_ERROR_CODES = Object.freeze({
  THROTTLED: 'AGENT_CREDENTIAL_STORE_THROTTLED',
  UNAVAILABLE: 'AGENT_CREDENTIAL_STORE_UNAVAILABLE',
});

const THROTTLED_SSM_ERRORS = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'TooManyUpdates',
  'SlowDown',
]);

// Map an SSM failure onto one allowlisted code, discarding the original message.
export const classifyCredentialStoreFailure = (error) => {
  const name = error?.name || error?.Code || '';
  const code = THROTTLED_SSM_ERRORS.has(name)
    ? AGENT_CREDENTIAL_STORE_ERROR_CODES.THROTTLED
    : AGENT_CREDENTIAL_STORE_ERROR_CODES.UNAVAILABLE;
  return Object.assign(
    new Error(
      code === AGENT_CREDENTIAL_STORE_ERROR_CODES.THROTTLED
        ? 'Credential store read was throttled'
        : 'Credential store read failed',
    ),
    { code },
  );
};

// Read ONE parameter. Returns null when it does not exist — absence is a distinct,
// expected answer (a cleared scope, a binding that never needed an external ID)
// and must not be confused with a store outage. Every other failure throws an
// allowlisted store code.
const readStoreParameter = async (ssm, name) => {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return result.Parameter?.Value ?? '';
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return null;
    throw classifyCredentialStoreFailure(error);
  }
};

// Read MANY parameters. GetParameters omits absent names instead of failing, so
// absence needs no special case here; the caller sees a missing key.
const readStoreParameters = async (ssm, names) => {
  if (names.length === 0) return {};
  try {
    const result = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    return Object.fromEntries(
      (result.Parameters || []).map((parameter) => [parameter.Name, parameter.Value || '']),
    );
  } catch (error) {
    throw classifyCredentialStoreFailure(error);
  }
};

// ── Bedrock binding value: bearer token or IAM role ──
//
// The bedrock parameter holds EITHER today's plain bearer string OR a JSON
// object naming an IAM role to assume. Every pre-existing value is a plain
// string and therefore still a bearer token, so this is backwards compatible by
// construction (specs/bedrock-iam-role-credential-mode: dec-value-encoding).
//
// Discrimination is positional, never a guess: a trimmed value starting with `{`
// MUST parse as an object carrying a valid roleArn, else it is rejected. Any
// other non-empty value is a bearer token and is never parsed. Rejection happens
// on the settings write path so a malformed value can never reach a stage.
export const CREDENTIAL_VALUE_KINDS = Object.freeze({ BEARER: 'bearer', ROLE: 'role' });

// The spec's `^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+`, narrowed to reject
// trailing whitespace and embedded junk. An IAM role path and name contain no
// whitespace, so `\S+$` excludes nothing a real ARN can carry.
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/\S+$/;
const ROLE_ARN_MAX_LENGTH = 2048;
// The STS ExternalId charset and length bounds.
const EXTERNAL_ID_PATTERN = /^[\w+=,.@:/-]+$/;
const EXTERNAL_ID_MIN_LENGTH = 2;
const EXTERNAL_ID_MAX_LENGTH = 1224;

export const BEDROCK_ROLE_BINDING_INVALID = 'BEDROCK_ROLE_BINDING_INVALID';
export const BEDROCK_EXTERNAL_ID_NOT_ACCEPTED = 'BEDROCK_EXTERNAL_ID_NOT_ACCEPTED';

const invalidRoleBinding = (message) =>
  Object.assign(new Error(message), { code: BEDROCK_ROLE_BINDING_INVALID });

// True when the value is SHAPED like a role object. Says nothing about validity —
// a true here means the value must parse, or the write is rejected.
export const looksLikeRoleBindingValue = (value) =>
  typeof value === 'string' && value.trim().startsWith('{');

// Parse a role binding value. Throws BEDROCK_ROLE_BINDING_INVALID with a reason
// that names the offending field and never echoes the value.
export const parseRoleBindingValue = (value) => {
  if (!looksLikeRoleBindingValue(value)) {
    throw invalidRoleBinding('Credential value is not a role binding object');
  }
  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw invalidRoleBinding('Role binding must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRoleBinding('Role binding must be a JSON object');
  }
  const roleArn = typeof parsed.roleArn === 'string' ? parsed.roleArn.trim() : '';
  if (!roleArn) throw invalidRoleBinding('Role binding requires roleArn');
  if (roleArn.length > ROLE_ARN_MAX_LENGTH) {
    throw invalidRoleBinding(`roleArn must be at most ${ROLE_ARN_MAX_LENGTH} characters`);
  }
  if (!ROLE_ARN_PATTERN.test(roleArn)) {
    throw invalidRoleBinding('roleArn must be a valid IAM role ARN');
  }
  let externalId = null;
  if (parsed.externalId !== undefined && parsed.externalId !== null && parsed.externalId !== '') {
    if (typeof parsed.externalId !== 'string') {
      throw invalidRoleBinding('externalId must be a string');
    }
    externalId = parsed.externalId.trim();
    if (
      externalId.length < EXTERNAL_ID_MIN_LENGTH ||
      externalId.length > EXTERNAL_ID_MAX_LENGTH ||
      !EXTERNAL_ID_PATTERN.test(externalId)
    ) {
      throw invalidRoleBinding(
        `externalId must be ${EXTERNAL_ID_MIN_LENGTH} to ${EXTERNAL_ID_MAX_LENGTH} characters in the STS external-id charset`,
      );
    }
  }
  return { roleArn, externalId };
};

// The kind of a configured binding value: 'role' for a valid role object,
// 'bearer' for any other configured value, null when nothing is configured.
// Throws for a role-shaped value that does not parse — a malformed binding is an
// error, never silently a bearer token.
export const credentialValueKind = (value) => {
  if (!isConfiguredCredentialValue(value)) return null;
  if (!looksLikeRoleBindingValue(value)) return CREDENTIAL_VALUE_KINDS.BEARER;
  parseRoleBindingValue(value);
  return CREDENTIAL_VALUE_KINDS.ROLE;
};

// Non-throwing variant for read paths that must not fail on a value someone
// wrote before validation existed: a malformed role-shaped value is reported as
// a role so it is never mistaken for a usable bearer token.
export const credentialValueKindSafe = (value) => {
  if (!isConfiguredCredentialValue(value)) return null;
  return looksLikeRoleBindingValue(value)
    ? CREDENTIAL_VALUE_KINDS.ROLE
    : CREDENTIAL_VALUE_KINDS.BEARER;
};

// Describe a stored bedrock value for the SETTINGS READ path.
//
// specs/bedrock-iam-role-credential-mode: req-configured-semantics. Read-only
// and total — every branch returns a shape, because a settings page must render
// for a malformed stored value rather than 500.
//
// NEITHER the role ARN nor the external ID is a secret: AWS says so of the
// external ID in terms, and dec-external-id-not-secret records why. Both are
// however tenant-identifying, so the CALLER decides what to expose — a caller on a
// lower-privilege path must drop `roleArn` and `externalId` and keep only
// `externalIdSet`. The gated caller passes the values through
// (req-same-and-cross-account, req-external-id-lifecycle).
//
// `externalId` is the value the binding ITSELF carries, which is the value the
// broker will send to STS. It is therefore the authoritative answer to "which
// external ID does this binding use", and the standalone staging parameter is NOT:
// the parameter survives a rebind to a same-account role that sends none, so
// reading the display off the parameter can tell an operator to add an
// sts:ExternalId condition that this binding will never satisfy.
//
// A malformed role-shaped value reports mode `role` with a null ARN, never
// `bearer`. Reporting bearer would tell the operator a usable secret is present
// when the binding is broken, which is the failure this field exists to expose.
export const describeBedrockBinding = (value) => {
  const kind = credentialValueKindSafe(value);
  if (kind === null) return { mode: null, roleArn: null, externalId: null, externalIdSet: false };
  if (kind === CREDENTIAL_VALUE_KINDS.BEARER) {
    return {
      mode: CREDENTIAL_VALUE_KINDS.BEARER,
      roleArn: null,
      externalId: null,
      externalIdSet: false,
    };
  }
  try {
    const { roleArn, externalId } = parseRoleBindingValue(value);
    return {
      mode: CREDENTIAL_VALUE_KINDS.ROLE,
      roleArn,
      externalId: externalId ?? null,
      externalIdSet: Boolean(externalId),
    };
  } catch {
    return {
      mode: CREDENTIAL_VALUE_KINDS.ROLE,
      roleArn: null,
      externalId: null,
      externalIdSet: false,
    };
  }
};

// Generate an external ID for a cross-account role binding.
//
// specs/bedrock-iam-role-credential-mode: req-external-id-lifecycle requires a
// CSPRNG with at least 128 bits of entropy, and requires that the value is
// generated here rather than accepted from a client — AWS is explicit that the
// assuming party must control it, "generated by Example Corp and NOT their
// customers", so that no two bindings can share one.
//
// 32 bytes is 256 bits — chosen over the 16-byte floor because the value is
// written once into a customer trust policy and is not rotated automatically, so
// there is no cost to the margin.
//
// base64url is used because its alphabet is a strict subset of the stored
// EXTERNAL_ID_PATTERN charset and of the documented `sts:ExternalId` charset, so
// a generated value can never fail the validator that guards the write path.
// The underscore base64url emits is absent from the AWS user guide's PROSE
// charset but present in the AssumeRole API pattern; an AssumeRole probe against
// a real role returned AccessDenied rather than ValidationError for it, so the
// API pattern is authoritative and this alphabet is safe.
//
// Uniqueness per binding comes from the CSPRNG, not from deriving the value off
// the scope: a derived value would be reproducible by anyone who knew the
// inputs, which defeats the confused-deputy control it exists to provide.
export const EXTERNAL_ID_ENTROPY_BYTES = 32;
export const generateExternalId = (randomBytes = defaultRandomBytes) =>
  randomBytes(EXTERNAL_ID_ENTROPY_BYTES).toString('base64url');

// ── Where the external ID lives, and why it is not only inside the binding ──
//
// dec-external-id-storage. The bootstrap order in req-same-and-cross-account is
// generate → surface → operator writes the trust policy → save → preflight, and
// req-binding-preflight forbids persisting a binding whose AssumeRole fails. A
// cross-account binding therefore CANNOT be saved on the first attempt: the trust
// policy cannot name an external ID nobody has seen yet.
//
// If the value existed only inside the binding, every rejected save would discard
// it and the retry would generate a different one, so the operator's freshly
// written trust policy would already be stale — the bootstrap would never
// converge. The value is therefore kept in its own per-scope parameter, generated
// idempotently, and COPIED into the binding when a save succeeds.
//
// The path is deliberately OUTSIDE `agent-credentials/`: the external ID is not a
// credential (dec-external-id-not-secret), the broker's write-only discipline for
// credential paths stays untouched, and the settings API can read its own value
// back without gaining any read permission on credential material.
export const bedrockExternalIdPath = ({ base, source, projectId = null }) => {
  const prefix = normalizeBase(base);
  if (!prefix) throw new Error('Agent credential store is not configured');
  switch (assertSource(source)) {
    case 'platform':
      return `${prefix}/bedrock-external-id`;
    case 'space':
      return `${prefix}/projects/${assertIdentifier(projectId, 'projectId')}/bedrock-external-id`;
    default:
      // User scope has no role binding at all (dec-user-scope-role-deferred), so
      // it can never need an external ID.
      throw new Error(`Bedrock external IDs are not supported at ${source} scope`);
  }
};

// The account that owns a role ARN. Returns null for anything unparseable rather
// than throwing: callers use it to decide whether an external ID is needed, and a
// malformed ARN is already rejected by parseRoleBindingValue.
export const accountIdFromRoleArn = (roleArn) => {
  const match = /^arn:aws[a-z-]*:iam::([0-9]{12}):role\//.exec(String(roleArn || ''));
  return match ? match[1] : null;
};

// dec-external-id-scope: the confused-deputy problem is a THIRD-PARTY problem, so
// an external ID is required cross-account and generated for nothing else. When
// the platform account is unknown the answer is `true` — that direction fails
// safe, since a superfluous external ID is inert unless the trust policy asks for
// one, whereas a missing one is a hard AssumeRole denial.
export const bedrockRoleIsCrossAccount = ({ roleArn, platformAccountId }) => {
  const roleAccount = accountIdFromRoleArn(roleArn);
  if (!roleAccount) return false;
  if (!platformAccountId) return true;
  return roleAccount !== String(platformAccountId);
};

export const readBedrockExternalId = async (ssm, { base, source, projectId = null }) => {
  const path = bedrockExternalIdPath({ base, source, projectId });
  const value = await readStoreParameter(ssm, path);
  return value === null ? null : String(value).trim() || null;
};

// Idempotent, and atomically so: the FIRST caller stores, every later caller
// returns the SAME value.
//
// req-external-id-lifecycle requires the value be re-readable rather than shown
// once, because a stable value is what lets a save rejected by the preflight be
// retried against a trust policy the operator has already written. A read-then-
// write with Overwrite:true does not deliver that under concurrency: two saves for
// one scope can both read absent, both generate, and the later write wins — leaving
// the earlier caller holding a value that is no longer stored. The operator would
// then paste an external ID that can never authenticate, and STS reports it as the
// undifferentiated trust-policy rejection that by construction cannot name a cause
// (BEDROCK_PREFLIGHT_CAUSES.TRUST_POLICY_REJECTED).
//
// Overwrite:false makes SSM itself the arbiter: exactly one writer wins, and the
// loser re-reads the winner's value instead of returning its own. This is also why
// the parameter is never overwritten once set — rotation is a deliberate operator
// act, not a side effect of saving a binding.
export const ensureBedrockExternalId = async (
  ssm,
  { base, source, projectId = null, randomBytes = defaultRandomBytes },
) => {
  const path = bedrockExternalIdPath({ base, source, projectId });
  const existing = await readBedrockExternalId(ssm, { base, source, projectId });
  if (existing) return existing;
  const externalId = generateExternalId(randomBytes);
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: path,
        Value: externalId,
        Type: 'SecureString',
        Overwrite: false,
      }),
    );
    return externalId;
  } catch (error) {
    if (error?.name !== 'ParameterAlreadyExists') throw classifyCredentialStoreFailure(error);
    // A concurrent save won the race. Its value is the stored one, so discard ours
    // and return theirs — both callers then agree with what the broker will send.
    const winner = await readBedrockExternalId(ssm, { base, source, projectId });
    if (winner) return winner;
    // ParameterAlreadyExists with nothing readable back is not a state this can
    // recover from by guessing; fail rather than return a value that is not stored.
    throw classifyCredentialStoreFailure(error);
  }
};

// Compose the value that is actually STORED for a Bedrock binding write.
//
// The client sends a role ARN and never an external ID (req-external-id-lifecycle
// forbids accepting one, and validateCredentialScopeUpdate rejects it). The server
// decides whether the binding needs one and attaches its own value, so the stored
// binding is always the canonical form the broker reads.
//
// Returns the update unchanged for a bearer token or a cleared value, so a
// bearer-configured deployment is untouched.
export const prepareBedrockBindingWrite = async (
  ssm,
  { base, source, projectId = null, update = {}, platformAccountId = null, randomBytes },
) => {
  const value = update?.bedrockBearerToken;
  if (typeof value !== 'string' || !looksLikeRoleBindingValue(value)) {
    return { update, roleArn: null, externalId: null, crossAccount: false };
  }
  const { roleArn } = parseRoleBindingValue(value);
  const crossAccount = bedrockRoleIsCrossAccount({ roleArn, platformAccountId });
  const externalId = crossAccount
    ? await ensureBedrockExternalId(ssm, {
        base,
        source,
        projectId,
        ...(randomBytes ? { randomBytes } : {}),
      })
    : null;
  // dec-external-id-scope makes the external ID MANDATORY cross-account, so a
  // cross-account binding must never be composed without one. The platform
  // generates it, so reaching here means generation returned nothing — persisting
  // the binding anyway would produce a confused-deputy exposure rather than a
  // legible failure.
  if (crossAccount && !externalId) {
    throw invalidRoleBinding('A cross-account role binding requires an external ID');
  }
  return {
    update: {
      ...update,
      bedrockBearerToken: JSON.stringify({ roleArn, ...(externalId ? { externalId } : {}) }),
    },
    roleArn,
    externalId,
    crossAccount,
  };
};

// Validate a credential-scope write BEFORE it reaches SSM.
//
// specs/bedrock-iam-role-credential-mode: req-single-parameter-encoding puts
// validation on the settings write path so a malformed value can never reach a
// stage, and req-role-credential-mode keeps role bindings out of user scope
// (dec-user-scope-role-deferred).
//
// Returns null when the update is acceptable, else { error, issues } for a 400.
// Throws nothing: every caller is an HTTP handler.
export const validateCredentialScopeUpdate = ({ source, update = {} }) => {
  const value = update?.bedrockBearerToken;
  // Only a role-SHAPED value is inspected. Any other non-empty value is a bearer
  // token and is deliberately never parsed, which is what keeps every
  // pre-existing deployment working untouched.
  if (typeof value !== 'string' || !looksLikeRoleBindingValue(value)) return null;
  if (source === 'user') {
    // PUT /users/me/agent-credentials is gated only on authentication, so any
    // member could otherwise name a role ARN. Permitting this scope later is
    // backwards compatible; forbidding it later would be breaking.
    return {
      error: 'A Bedrock IAM role cannot be configured at user scope',
      code: 'BEDROCK_ROLE_SCOPE_UNSUPPORTED',
      issues: [
        'Role bindings are supported at space and platform scope only. Personal credentials must be a Bedrock API key.',
      ],
    };
  }
  try {
    parseRoleBindingValue(value);
  } catch (error) {
    // The message names the offending field and never echoes the value.
    return {
      error: 'Invalid Bedrock role binding',
      code: error.code || BEDROCK_ROLE_BINDING_INVALID,
      issues: [error.message],
    };
  }
  // req-external-id-lifecycle: AWS requires the value be "generated by Example
  // Corp and not their customers", i.e. controlled by the party doing the
  // assuming. Accepting one here would also break per-binding uniqueness, so an
  // operator-supplied value is refused outright rather than quietly replaced —
  // silently overwriting it would leave them with a trust policy they believe is
  // correct.
  if (looksLikeClientSuppliedExternalId(value)) {
    return {
      error: 'A Bedrock external ID cannot be supplied by a client',
      code: BEDROCK_EXTERNAL_ID_NOT_ACCEPTED,
      issues: [
        'The platform generates the external ID for a cross-account role binding and returns it for you to paste into the trust policy. Send only roleArn.',
      ],
    };
  }
  return null;
};

const looksLikeClientSuppliedExternalId = (value) => {
  try {
    return Boolean(parseRoleBindingValue(value).externalId);
  } catch {
    return false;
  }
};

export const agentCredentialPath = ({
  base,
  source,
  provider,
  projectId = null,
  userId = null,
}) => {
  const prefix = normalizeBase(base);
  if (!prefix) throw new Error('Agent credential store is not configured');
  const config = PROVIDER_CONFIG[assertProvider(provider)];
  switch (assertSource(source)) {
    case 'platform':
      return `${prefix}/${config.parameterName}`;
    case 'space':
      return `${prefix}/projects/${assertIdentifier(projectId, 'projectId')}/agent-credentials/${
        config.parameterName
      }`;
    case 'user':
      return `${prefix}/users/${assertIdentifier(userId, 'userId')}/agent-credentials/${
        config.parameterName
      }`;
    default:
      throw new Error(`Unsupported agent credential source: ${source}`);
  }
};

export const normalizeCredentialBinding = (binding) => {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const provider = assertProvider(binding.provider);
  const source = assertSource(binding.source);
  return {
    provider,
    source,
    ...(source === 'user' ? { userId: assertIdentifier(binding.userId, 'userId') } : {}),
  };
};

const scopePaths = ({ base, source, projectId, userId }) =>
  Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => [
      provider,
      agentCredentialPath({ base, source, provider, projectId, userId }),
    ]),
  );

const deleteParameterIfPresent = async (ssm, path) => {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: path }));
    return true;
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return false;
    throw error;
  }
};

// Broker-only read path. API Lambdas call the metadata broker and deliberately
// have no ssm:GetParameter(s) permission on agent credential paths.
const fetchValues = async (ssm, paths) =>
  readStoreParameters(ssm, [...new Set(Object.values(paths))]);

// Per-provider set-state for one scope.
//
// specs/bedrock-iam-role-credential-mode: req-configured-semantics.
// `bedrockBearerTokenSet` keeps its EXACT original meaning — a bearer token is
// configured — which now requires excluding a role object. Without this the
// legacy boolean would read true for a role binding (isConfiguredCredentialValue
// only checks non-empty and not the placeholder), telling both credential cards
// that a bearer secret is set when none is.
//
// It deliberately does NOT become "this scope is configured". That question is
// answered by the mode fields added in Phase 2; widening this boolean's meaning
// would silently change what two existing UI cards assert.
export const readCredentialScopeStatus = async (
  ssm,
  { base, source, projectId = null, userId = null },
) => {
  const paths = scopePaths({ base, source, projectId, userId });
  const values = await fetchValues(ssm, paths);
  const status = Object.fromEntries(
    AGENT_CREDENTIAL_PROVIDERS.map((provider) => {
      const value = values[paths[provider]];
      const set =
        provider === 'bedrock'
          ? credentialValueKindSafe(value) === CREDENTIAL_VALUE_KINDS.BEARER
          : isConfiguredCredentialValue(value);
      return [PROVIDER_CONFIG[provider].setField, set];
    }),
  );
  // Phase 2 (req-configured-semantics): the existing boolean answers only "is a
  // bearer secret set", which reads false for a perfectly good role binding.
  // These three fields are what let a card report a role-only scope as
  // configured without changing the boolean's meaning for existing callers.
  const bedrock = describeBedrockBinding(values[paths.bedrock]);
  status.bedrockMode = bedrock.mode;
  status.bedrockRoleArn = bedrock.roleArn;
  status.bedrockExternalIdSet = bedrock.externalIdSet;
  // The value the binding itself carries, i.e. what the broker will actually send.
  // Gated to callers that may modify the binding by
  // readCredentialScopeStatusViaBroker, exactly as bedrockRoleArn is.
  status.bedrockExternalId = bedrock.externalId;
  return status;
};

export const writeCredentialScope = async (
  ssm,
  { base, source, projectId = null, userId = null, update = {} },
) => {
  assertSource(source);
  const written = [];
  const cleared = [];
  for (const provider of AGENT_CREDENTIAL_PROVIDERS) {
    const field = PROVIDER_CONFIG[provider].inputField;
    if (typeof update[field] !== 'string') continue;
    const path = agentCredentialPath({ base, source, provider, projectId, userId });
    const value = update[field].trim();
    if (value) {
      await ssm.send(
        new PutParameterCommand({
          Name: path,
          Value: value,
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
      written.push(provider);
      continue;
    }
    if (source === 'platform') {
      await ssm.send(
        new PutParameterCommand({
          Name: path,
          Value: 'placeholder',
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
    } else {
      await deleteParameterIfPresent(ssm, path);
    }
    cleared.push(provider);
  }
  return { saved: true, written, cleared };
};

export const deleteCredentialScope = async (
  ssm,
  { base, source, projectId = null, userId = null },
) => {
  const normalizedSource = assertSource(source);
  if (normalizedSource === 'platform') {
    throw new Error('Platform agent credentials cannot be deleted as a scope');
  }
  const deleted = [];
  const missing = [];
  for (const provider of AGENT_CREDENTIAL_PROVIDERS) {
    const path = agentCredentialPath({
      base,
      source: normalizedSource,
      provider,
      projectId,
      userId,
    });
    if (await deleteParameterIfPresent(ssm, path)) deleted.push(provider);
    else missing.push(provider);
  }
  // The external ID is stored OUTSIDE agent-credentials/ (dec-external-id-storage),
  // so the provider loop above cannot reach it. Deleting it with the scope is what
  // gives it a lifecycle: without this it outlives the binding it belongs to, and a
  // recreated space reusing the same projectId would inherit a stale value that no
  // trust policy references. User scope never has one (dec-user-scope-role-deferred).
  let externalIdDeleted = false;
  if (normalizedSource === 'space') {
    externalIdDeleted = await deleteParameterIfPresent(
      ssm,
      bedrockExternalIdPath({ base, source: normalizedSource, projectId }),
    );
  }
  return { deleted, missing, externalIdDeleted };
};

// Resolve the effective binding per provider AND the kind of value each one
// holds, in a single pass over the scope precedence.
//
// The kind rides in a SIBLING map rather than on the binding object, and that
// placement is load-bearing. A binding is a POINTER (provider + source), and
// three separate paths consume it verbatim: it is the payload of a signed
// credential grant, it is forwarded raw to the AgentCore runtime by
// fetchRuntimeCapabilities, and it is persisted as an execution's durable
// credentialBinding snapshot. The kind belongs to none of those — it is a
// property of the stored VALUE, re-read on every invocation, so recording it
// alongside a pointer would let a snapshot outlive the fact it asserts.
//
// Free of extra reads: the raw value is already in hand here, which is the only
// place where classification costs nothing.
export const resolveEffectiveCredentialState = async (ssm, { base, projectId, userId }) => {
  const sources = {
    user: scopePaths({ base, source: 'user', userId }),
    space: scopePaths({ base, source: 'space', projectId }),
    platform: scopePaths({ base, source: 'platform' }),
  };
  const bindings = {};
  const credentialKinds = {};
  const unresolved = new Set(AGENT_CREDENTIAL_PROVIDERS);
  for (const source of AGENT_CREDENTIAL_SOURCES) {
    const paths = Object.fromEntries(
      [...unresolved].map((provider) => [provider, sources[source][provider]]),
    );
    const values = await fetchValues(ssm, paths);
    for (const provider of unresolved) {
      const path = sources[source][provider];
      if (!isConfiguredCredentialValue(values[path])) continue;
      bindings[provider] = {
        provider,
        source,
        ...(source === 'user' ? { userId: assertIdentifier(userId, 'userId') } : {}),
      };
      // Non-throwing on purpose: a malformed role-shaped value must not fail a
      // resolve that already decided the binding EXISTS. It reports 'role', which
      // is the fail-safe direction — never mistaken for a usable bearer token.
      credentialKinds[provider] = credentialValueKindSafe(values[path]);
      unresolved.delete(provider);
    }
    if (unresolved.size === 0) break;
  }
  for (const provider of unresolved) {
    bindings[provider] = null;
    credentialKinds[provider] = null;
  }
  return { bindings, credentialKinds };
};

export const resolveEffectiveCredentialBindings = async (ssm, options) =>
  (await resolveEffectiveCredentialState(ssm, options)).bindings;

export const readCredentialBindingValue = async (ssm, { base, binding, projectId = null }) => {
  const normalized = normalizeCredentialBinding(binding);
  if (!normalized) return '';
  const path = agentCredentialPath({
    base,
    source: normalized.source,
    provider: normalized.provider,
    projectId,
    userId: normalized.userId,
  });
  // An absent parameter is a MISSING binding, not a failure: a cleared scope must
  // fail closed as "no credential", never as a store outage. readStoreParameter
  // returns null for exactly that case and classifies everything else.
  const value = await readStoreParameter(ssm, path);
  if (value === null) return '';
  return isConfiguredCredentialValue(value) ? value : '';
};

export const credentialSourcesFromBindings = (bindings = {}) => ({
  bedrock: bindings.bedrock?.source ?? null,
  kiro: bindings.kiro?.source ?? null,
});

export const availableClisForBindings = ({ installed = [], bindings = {} } = {}) =>
  installed.filter((cli) => {
    const provider = credentialProviderForCli(cli);
    return provider && bindings[provider];
  });

export default {
  accountIdFromRoleArn,
  agentCredentialPath,
  availableClisForBindings,
  bedrockExternalIdPath,
  bedrockRoleIsCrossAccount,
  credentialEnvName,
  credentialProviderForCli,
  credentialSourcesFromBindings,
  credentialValueKind,
  credentialValueKindSafe,
  deleteCredentialScope,
  describeBedrockBinding,
  ensureBedrockExternalId,
  generateExternalId,
  isConfiguredCredentialValue,
  looksLikeRoleBindingValue,
  normalizeCredentialBinding,
  parseRoleBindingValue,
  prepareBedrockBindingWrite,
  readBedrockExternalId,
  readCredentialBindingValue,
  readCredentialScopeStatus,
  resolveEffectiveCredentialBindings,
  resolveEffectiveCredentialState,
  validateCredentialScopeUpdate,
  writeCredentialScope,
};
