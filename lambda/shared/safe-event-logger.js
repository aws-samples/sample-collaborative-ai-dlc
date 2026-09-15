// SECURITY: Keep the API Gateway event useful for diagnostics while replacing
// known credentials before it reaches Powertools/CloudWatch.

const REDACTED = '[REDACTED]';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-amz-security-token',
]);

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

const redactKnownValues = (value, { inMcpConfig = false, route = '' } = {}) => {
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownValues(item, { inMcpConfig, route }));
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
      if (inMcpConfig && (normalized === 'headers' || normalized === 'env')) {
        return [key, redactMapValues(child)];
      }
      if (MCP_CONFIG_KEYS.has(normalized)) {
        if (typeof child === 'string') {
          try {
            return [
              key,
              JSON.stringify(redactKnownValues(JSON.parse(child), { inMcpConfig: true, route })),
            ];
          } catch {
            return [key, REDACTED];
          }
        }
        return [key, redactKnownValues(child, { inMcpConfig: true, route })];
      }
      return [key, redactKnownValues(child, { inMcpConfig, route })];
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

  if (event.headers !== undefined) {
    redacted.headers = redactNamedValues(event.headers, SENSITIVE_HEADER_NAMES);
  }
  if (event.multiValueHeaders !== undefined) {
    redacted.multiValueHeaders = redactNamedValues(event.multiValueHeaders, SENSITIVE_HEADER_NAMES);
  }
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
