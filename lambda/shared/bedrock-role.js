// Bedrock IAM-role assumption, shared by the two brokers.
//
// specs/bedrock-iam-role-credential-mode: req-broker-side-assume,
// req-session-name-attribution, req-binding-preflight.
//
// The value broker assumes the role to resolve credentials for a stage; the
// metadata broker assumes it with no invocation as a bind-time preflight. Both run
// under the SAME credential-broker execution role, which is the only principal
// holding sts:AssumeRole for customer Bedrock roles — so the preflight adds no
// permission to any role (req-binding-preflight). Keeping the call, the session
// name and the error classification in one module is what stops the preflight
// drifting from the path it is supposed to predict.
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
// The write path decides whether a binding is cross-account with this same
// function, so the preflight must not re-derive it: two answers to one question is
// how the guidance ends up contradicting the value that was actually stored.
import { bedrockRoleIsCrossAccount } from './agent-credentials.js';

// con-role-chaining-3600: the broker itself runs under an assumed role, so this
// AssumeRole is role chaining and STS caps it at exactly 3600s. This is a
// ceiling, not a tuning knob, and is deliberately not configurable.
export const ROLE_SESSION_DURATION_SECONDS = 3600;
// req-session-name-trust-condition: customers authorize on this format with an
// sts:RoleSessionName trust-policy condition, so changing it is a BREAKING change
// requiring a migration note. Composed in exactly one place, on the server.
export const ROLE_SESSION_NAME_PREFIX = 'aidlc-';
const ROLE_SESSION_NAME_PATTERN = /^[\w+=,.@-]{2,64}$/;

// A platform-scope binding is shared by every space, so a preflight for it has no
// single space to name. It uses this name instead, which a StringLike "aidlc-*"
// condition admits and a StringEquals condition for one space does not — and that
// asymmetry is the correct guidance: a shared role cannot carry a single-space
// condition.
export const PREFLIGHT_SESSION_NAME = 'aidlc-preflight';

export const BEDROCK_ROLE_ERROR_CODES = Object.freeze({
  BINDING_INVALID: 'BEDROCK_ROLE_BINDING_INVALID',
  ASSUME_DENIED: 'BEDROCK_ROLE_ASSUME_DENIED',
  ASSUME_THROTTLED: 'BEDROCK_ROLE_ASSUME_THROTTLED',
  RESOLUTION_FAILED: 'BEDROCK_ROLE_RESOLUTION_FAILED',
});

// Never carries provider text: an STS message can name the caller session and
// the target role, and the allowlisted code is the only thing that may be logged
// or returned.
export const roleError = (code, message) => Object.assign(new Error(message), { code });

const DENIED_STS_ERRORS = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'ExpiredToken',
  'ExpiredTokenException',
]);
const THROTTLED_STS_ERRORS = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'SlowDown',
]);

// Map an STS failure onto one allowlisted code, discarding the original message.
export const classifyAssumeFailure = (error) => {
  const name = error?.name || error?.Code || '';
  if (DENIED_STS_ERRORS.has(name)) {
    return roleError(BEDROCK_ROLE_ERROR_CODES.ASSUME_DENIED, 'Role assumption was denied');
  }
  if (THROTTLED_STS_ERRORS.has(name)) {
    return roleError(BEDROCK_ROLE_ERROR_CODES.ASSUME_THROTTLED, 'Role assumption was throttled');
  }
  return roleError(BEDROCK_ROLE_ERROR_CODES.RESOLUTION_FAILED, 'Role assumption failed');
};

export const composeRoleSessionName = (projectId) => {
  const sessionName = `${ROLE_SESSION_NAME_PREFIX}${String(projectId || '')}`;
  if (!projectId || !ROLE_SESSION_NAME_PATTERN.test(sessionName)) {
    // Without a usable projectId there is no attribution, and attribution is the
    // premise the whole showback model rests on — so fail rather than invent one.
    throw roleError(
      BEDROCK_ROLE_ERROR_CODES.RESOLUTION_FAILED,
      'Role session name could not be composed for this request',
    );
  }
  return sessionName;
};

// ── The permission ceiling attached to every minted credential ──
//
// req-least-privilege-assume. The customer-facing grant rendered by
// terraform/bedrock-role-grant.tf is ADVICE: the role lives in an account this
// deployment does not manage, so nothing verifies the operator attached it, or that
// they attached nothing wider. A role named `aidlc-bedrock-*` that trusts the broker
// is bindable by any space owner, and whatever it grants is delivered verbatim into a
// container that executes model-authored code.
//
// A session policy closes that: effective permissions become the INTERSECTION of the
// role's own policy and this ceiling, so an over-permissive role cannot exceed Bedrock
// invoke. Measured 2026-09-07 against a throwaway role holding the reference grant
// plus s3:ListAllMyBuckets — without the ceiling the S3 call succeeded, with it the S3
// call was denied while `eu.anthropic.claude-sonnet-5` still invoked, and a bare
// foundation-model id stayed denied (con-fm-fence-works holds through the ceiling).
//
// The value is rendered from the same Terraform definition as the grant and passed in
// BEDROCK_SESSION_POLICY, never composed here. Hard-coding it would reintroduce the
// drift this exists to prevent: when Codex moved to the Bedrock Runtime provider the
// grant gained a fourth statement (`project/default`), and a copy would have 401'd
// every Codex call.
//
// An ABSENT value applies no ceiling rather than refusing to mint. That matches
// roleArnMatchesAllowlist's treatment of an empty allowlist — a missing configuration
// means "unknown", not "deny everything" — and the alternative would fail every stage
// during a partial deploy for the sake of a defence-in-depth control whose primary is
// the role's own policy.
export const readSessionPolicy = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    // Parsed rather than passed through, so a malformed value is inert instead of
    // failing every AssumeRole with a ValidationError.
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.Statement) || parsed.Statement.length === 0) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
};

export const assumeBedrockRole = async (
  { roleArn, externalId, projectId, sessionName = null, sessionPolicy = null },
  stsClient,
) => {
  const RoleSessionName = sessionName || composeRoleSessionName(projectId);
  const Policy = readSessionPolicy(sessionPolicy);
  let result;
  try {
    result = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName,
        DurationSeconds: ROLE_SESSION_DURATION_SECONDS,
        // con-tagsession-required: session tags need sts:TagSession in the
        // customer's trust policy, so passing any would fail closed on every
        // role that omits it. Attribution is RoleSessionName only.
        ...(externalId ? { ExternalId: externalId } : {}),
        ...(Policy ? { Policy } : {}),
      }),
    );
  } catch (error) {
    throw classifyAssumeFailure(error);
  }
  const credentials = result?.Credentials;
  if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey || !credentials?.SessionToken) {
    throw roleError(
      BEDROCK_ROLE_ERROR_CODES.RESOLUTION_FAILED,
      'Role assumption returned no credentials',
    );
  }
  return {
    AccessKeyId: credentials.AccessKeyId,
    SecretAccessKey: credentials.SecretAccessKey,
    SessionToken: credentials.SessionToken,
    Expiration:
      credentials.Expiration instanceof Date
        ? credentials.Expiration.toISOString()
        : (credentials.Expiration ?? null),
  };
};

// ── Bind-time preflight ──
//
// req-binding-preflight. A bare AssumeRole with no model invocation, run when a
// binding is saved, converting a class of mid-stage failure into an input error.
//
// It is an INPUT CHECK, NOT A SECURITY CONTROL: a trust policy can change the
// moment after it passes, and resolution re-checks on every stage anyway.

export const BEDROCK_PREFLIGHT_CAUSES = Object.freeze({
  OK: 'ok',
  // Decidable locally, before any STS call: the broker's own IAM policy names the
  // role ARNs it may assume, so a role outside that set can never work.
  ROLE_NOT_ALLOWLISTED: 'role-not-allowlisted',
  // MEASURED, not assumed: STS returns a byte-identical AccessDenied for a wrong
  // external ID, an omitted external ID, a session-name condition mismatch, an
  // untrusted principal and a role that does not exist — differing only in the
  // resource ARN it echoes back. Probed against a throwaway role on 2026-09-06.
  // So these four causes CANNOT be separated from the response, and pretending
  // otherwise would mean guessing at message text. They are reported as one
  // category carrying the exact facts an operator needs to check each candidate.
  TRUST_POLICY_REJECTED: 'trust-policy-rejected',
  THROTTLED: 'throttled',
  UNAVAILABLE: 'unavailable',
});

// Match an ARN against the broker's assumable-role patterns, using IAM's own
// resource-wildcard semantics: `*` is any run of characters and `?` is exactly one
// (reference_policies_elements_resource). Both are honoured so this check can only
// ever agree with the grant it mirrors — a pattern IAM would admit must not be
// refused here, or a legitimate binding is rejected at save time. Anchored, and
// every OTHER regex metacharacter is escaped, so a pattern can never widen itself.
export const roleArnMatchesAllowlist = (roleArn, patterns = []) => {
  const arn = String(roleArn || '');
  const list = (Array.isArray(patterns) ? patterns : [])
    .map((p) => String(p || ''))
    .filter(Boolean);
  // An empty allowlist means "unknown", not "deny everything": the check exists to
  // give a better message, and failing the save on a missing configuration would
  // be worse than letting STS answer.
  if (list.length === 0) return true;
  return list.some((pattern) => {
    // `*` and `?` are deliberately left out of the escape class, then translated.
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.');
    return new RegExp(`^${escaped}$`).test(arn);
  });
};

export const parseAssumableRoleArns = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v || '')).filter(Boolean);
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => String(v || '')).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

// The candidate causes an operator should check, ordered most likely first, each
// paired with the non-secret fact needed to check it. No STS text, ever.
const trustPolicyCandidates = ({ brokerRoleArn, sessionName, externalIdSent, crossAccount }) =>
  [
    {
      candidate: 'principal-not-trusted',
      detail: brokerRoleArn
        ? `The trust policy must name ${brokerRoleArn} as a principal.`
        : 'The trust policy must name this deployment\u2019s credential-broker role as a principal.',
    },
    {
      candidate: 'session-name-condition-mismatch',
      detail: `Any sts:RoleSessionName condition must admit ${sessionName}.`,
    },
    externalIdSent
      ? {
          candidate: 'external-id-mismatch',
          detail:
            'Any sts:ExternalId condition must equal the external ID this platform generated for the binding, which the save response returns.',
        }
      : {
          candidate: 'external-id-required-but-absent',
          detail: crossAccount
            ? 'A cross-account trust policy that requires sts:ExternalId will reject this binding until the platform-generated value is stored with it.'
            : 'The trust policy must not require sts:ExternalId, because a same-account binding sends none.',
        },
  ].filter(Boolean);

export const preflightBedrockRoleBinding = async (
  {
    roleArn,
    externalId = null,
    projectId = null,
    assumableRoleArns = [],
    brokerRoleArn = null,
    platformAccountId = null,
    sessionPolicy = null,
  },
  stsClient,
) => {
  // A platform binding has no single space, so it probes with PREFLIGHT_SESSION_NAME.
  const sessionName = projectId ? composeRoleSessionName(projectId) : PREFLIGHT_SESSION_NAME;
  const crossAccount = bedrockRoleIsCrossAccount({ roleArn, platformAccountId });
  if (!roleArnMatchesAllowlist(roleArn, assumableRoleArns)) {
    return {
      ok: false,
      cause: BEDROCK_PREFLIGHT_CAUSES.ROLE_NOT_ALLOWLISTED,
      sessionName,
      candidates: [
        {
          candidate: 'role-not-allowlisted',
          detail: `This deployment may assume only role ARNs matching ${assumableRoleArns.join(', ')}. Rename the role or widen bedrock_assumable_role_arns.`,
        },
      ],
    };
  }
  try {
    await assumeBedrockRole({ roleArn, externalId, sessionName, sessionPolicy }, stsClient);
    return { ok: true, cause: BEDROCK_PREFLIGHT_CAUSES.OK, sessionName };
  } catch (error) {
    if (error?.code === BEDROCK_ROLE_ERROR_CODES.ASSUME_THROTTLED) {
      return {
        ok: false,
        cause: BEDROCK_PREFLIGHT_CAUSES.THROTTLED,
        sessionName,
        candidates: [],
      };
    }
    if (error?.code === BEDROCK_ROLE_ERROR_CODES.ASSUME_DENIED) {
      return {
        ok: false,
        cause: BEDROCK_PREFLIGHT_CAUSES.TRUST_POLICY_REJECTED,
        sessionName,
        candidates: trustPolicyCandidates({
          brokerRoleArn,
          sessionName,
          externalIdSent: Boolean(externalId),
          crossAccount,
        }),
      };
    }
    return { ok: false, cause: BEDROCK_PREFLIGHT_CAUSES.UNAVAILABLE, sessionName, candidates: [] };
  }
};

export default {
  BEDROCK_PREFLIGHT_CAUSES,
  BEDROCK_ROLE_ERROR_CODES,
  PREFLIGHT_SESSION_NAME,
  ROLE_SESSION_DURATION_SECONDS,
  assumeBedrockRole,
  classifyAssumeFailure,
  composeRoleSessionName,
  parseAssumableRoleArns,
  preflightBedrockRoleBinding,
  readSessionPolicy,
  roleArnMatchesAllowlist,
};
