// SECURITY: Keep the API Gateway event useful for diagnostics while replacing
// known credentials before it reaches Powertools/CloudWatch.

const REDACTED = '[REDACTED]';

const SENSITIVE_QUERY_NAMES = new Set([
  'access_token',
  'api_key',
  'client_secret',
  'refresh_token',
  'ticket',
  'token',
]);

const SENSITIVE_VALUE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'bearertoken',
  'bedrockbearertoken',
  'clientsecret',
  'gittoken',
  'idtoken',
  'kiroapikey',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
  'webhooksecret',
]);

const MCP_CONFIG_KEYS = new Set(['custommcpservers', 'mcpservers']);
const SECRET_MAP_KEYS = new Set(['environmentvariables', 'mcpsecrets', 'unsavedsecrets']);

const normalizedKey = (key) =>
  String(key)
    .replaceAll(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

const redactNamedValues = (value, sensitiveNames) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (!sensitiveNames.has(key.toLowerCase()) && !SENSITIVE_VALUE_KEYS.has(normalizedKey(key))) {
        return [key, child];
      }
      return [key, Array.isArray(child) ? child.map(() => REDACTED) : REDACTED];
    }),
  );
};

const redactMapValues = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  return Object.fromEntries(Object.keys(value).map((key) => [key, REDACTED]));
};

const redactKnownValues = (value, { route = '' } = {}) => {
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownValues(item, { route }));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const normalized = normalizedKey(key);
      if (SECRET_MAP_KEYS.has(normalized)) return [key, redactMapValues(child)];
      if (SENSITIVE_VALUE_KEYS.has(normalized)) return [key, REDACTED];
      if (normalized === 'ticket' && route.includes('/trackers/connections/')) {
        return [key, REDACTED];
      }
      if (MCP_CONFIG_KEYS.has(normalized)) return [key, REDACTED];
      return [key, redactKnownValues(child, { route })];
    }),
  );
};

const redactBody = (body, { isBase64Encoded = false, route = '' } = {}) => {
  if (body === undefined || body === null) return body;
  if (isBase64Encoded) return REDACTED;
  if (typeof body !== 'string') return redactKnownValues(body, { route });
  if (body === '') return body;
  try {
    return JSON.stringify(redactKnownValues(JSON.parse(body), { route }));
  } catch {
    return REDACTED;
  }
};

export const redactEventForLogging = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return REDACTED;

  const route = event.resource ?? event.path ?? event.rawPath ?? '';
  const redacted = redactKnownValues(event, { route });
  const sensitiveQueryNames = route.includes('/callback')
    ? new Set([...SENSITIVE_QUERY_NAMES, 'code', 'state'])
    : SENSITIVE_QUERY_NAMES;

  delete redacted.headers;
  delete redacted.multiValueHeaders;
  if (event.queryStringParameters !== undefined) {
    redacted.queryStringParameters = redactNamedValues(
      event.queryStringParameters,
      sensitiveQueryNames,
    );
  }
  if (event.multiValueQueryStringParameters !== undefined) {
    redacted.multiValueQueryStringParameters = redactNamedValues(
      event.multiValueQueryStringParameters,
      sensitiveQueryNames,
    );
  }
  if (event.rawQueryString !== undefined) redacted.rawQueryString = REDACTED;
  if (event.cookies !== undefined) {
    redacted.cookies = Array.isArray(event.cookies) ? event.cookies.map(() => REDACTED) : REDACTED;
  }
  if (event.stageVariables !== undefined) {
    redacted.stageVariables = redactMapValues(event.stageVariables);
  }
  if (event.requestContext?.authorizer !== undefined) {
    redacted.requestContext = {
      ...redacted.requestContext,
      authorizer: REDACTED,
    };
  }
  if (event.body !== undefined) {
    redacted.body = redactBody(event.body, {
      isBase64Encoded: event.isBase64Encoded === true,
      route,
    });
  }

  return redacted;
};

export const logSafeEventIfEnabled = (logger, event) => {
  logger.logEventIfEnabled(redactEventForLogging(event));
};

const REDACTED_DIAGNOSTIC = '[REDACTED]';
const CREDENTIAL_LABEL =
  '[A-Za-z0-9_-]*(?:secret|password|passwd|token|credential|private[-_]?key|api[-_]?key|authorization|cookie|signature)[A-Za-z0-9_-]*';
const JSON_DOUBLE_CREDENTIAL_PATTERN = new RegExp(
  `(["']${CREDENTIAL_LABEL}["']\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  'gi',
);
const JSON_SINGLE_CREDENTIAL_PATTERN = new RegExp(
  `(["']${CREDENTIAL_LABEL}["']\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`,
  'gi',
);
const ASSIGNED_CREDENTIAL_PATTERN = new RegExp(
  `(\\b(${CREDENTIAL_LABEL})\\b\\s*[:=]\\s*)(?!\\[REDACTED\\])([^\\s,;}\\][{]+)`,
  'gi',
);
const ARGUMENT_CREDENTIAL_PATTERN = new RegExp(`(--?${CREDENTIAL_LABEL}\\b\\s+)([^\\s]+)`, 'gi');
const QUERY_CREDENTIAL_PATTERN = new RegExp(`([?&]${CREDENTIAL_LABEL}=)([^&#\\s]+)`, 'gi');
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:secret|password|passwd|token|credentials?|private_key|api_key|authorization|cookie|signature|askpass|netrc|access_key_id)(?:_|$)/i;
const SENSITIVE_FIELD_NAME =
  /(?:secret|password|passwd|token|credential|privatekey|apikey|authorization|cookie|signature|askpass|netrc)/i;
const SENSITIVE_PATH_PATTERN =
  /(?:~|\/(?:[^/\s"'():]+\/)*)(?:\.aws\/credentials|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.config\/gcloud\/application_default_credentials\.json|run\/secrets\/[^\s"'():]+)/gi;

export const sensitiveEnvironmentValues = (source = {}) =>
  [
    ...new Set(
      Object.entries(source)
        .filter(([name]) => SENSITIVE_ENV_NAME.test(String(name)))
        .map(([, value]) => (typeof value === 'string' ? value : ''))
        // Replacing very short values globally would destroy ordinary diagnostics;
        // labelled forms are still covered by the structural patterns below.
        .filter((value) => value.length >= 4 && value !== REDACTED_DIAGNOSTIC),
    ),
  ].toSorted((a, b) => b.length - a.length);

const credentialField = (key) => {
  const normalized = String(key).replaceAll(/[-_]/g, '').toLowerCase();
  return SENSITIVE_FIELD_NAME.test(normalized) || ['setcookie', 'accesskeyid'].includes(normalized);
};

// Sensor and harness tools can emit credentials in diagnostics. Redact before
// logging or persisting them; callers bound the redacted text afterwards.
export const redactCredentialText = (value, sensitiveValues = []) => {
  let text = String(value);
  for (const sensitiveValue of sensitiveValues) {
    text = text.replaceAll(sensitiveValue, REDACTED_DIAGNOSTIC);
  }
  text = text.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    REDACTED_DIAGNOSTIC,
  );
  text = text.replace(
    /\b((?:authorization|proxy-authorization)\s*[:=])([^\r\n,;]+)/gi,
    (_match, prefix) => `${prefix} ${REDACTED_DIAGNOSTIC}`,
  );
  text = text.replace(
    /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
    `$1 ${REDACTED_DIAGNOSTIC}`,
  );
  text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, `$1${REDACTED_DIAGNOSTIC}@`);
  text = text.replace(JSON_DOUBLE_CREDENTIAL_PATTERN, `$1"${REDACTED_DIAGNOSTIC}"`);
  text = text.replace(JSON_SINGLE_CREDENTIAL_PATTERN, `$1'${REDACTED_DIAGNOSTIC}'`);
  text = text.replace(ASSIGNED_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(ARGUMENT_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(QUERY_CREDENTIAL_PATTERN, `$1${REDACTED_DIAGNOSTIC}`);
  text = text.replace(SENSITIVE_PATH_PATTERN, REDACTED_DIAGNOSTIC);
  text = text.replace(
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}(?:-[A-Za-z0-9-]{10,})*)\b|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    REDACTED_DIAGNOSTIC,
  );
  return text;
};

export const redactDiagnostic = (value, sensitiveValues = [], seen = new WeakMap()) => {
  if (typeof value === 'string') return redactCredentialText(value, sensitiveValues);
  if (Array.isArray(value))
    return value.map((entry) => redactDiagnostic(entry, sensitiveValues, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const redacted = {};
  seen.set(value, redacted);
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = credentialField(key)
      ? entry == null
        ? entry
        : REDACTED_DIAGNOSTIC
      : redactDiagnostic(entry, sensitiveValues, seen);
  }
  return redacted;
};
