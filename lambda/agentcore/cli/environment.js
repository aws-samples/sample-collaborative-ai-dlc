// Explicit ambient allowlist. Inference auth is supplied by a prepared
// invocation, application AWS identity stays in the runtime-owned MCP process.
export const SAFE_AMBIENT_ENV = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);
export const APPLICATION_CREDENTIAL_ENV = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CREDENTIAL_FILE',
  'BOTO_CONFIG',
]);
export const INFERENCE_CREDENTIAL_ENV = Object.freeze([
  'AWS_BEARER_TOKEN_BEDROCK',
  'KIRO_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'LITELLM_API_KEY',
  'AIDLC_GATEWAY_TOKEN',
]);
export const childEnvironment = (env = {}, ambient = process.env, credentialEnvironment = {}) => {
  const out = Object.fromEntries(
    SAFE_AMBIENT_ENV.filter((key) => ambient[key] !== undefined).map((key) => [key, ambient[key]]),
  );
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      !APPLICATION_CREDENTIAL_ENV.includes(key) &&
      !['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(key)
    )
      out[key] = String(value);
  }
  return {
    ...out,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    BOTO_CONFIG: '/dev/null',
    // Only the invocation's credential adapter may supply inference IAM
    // credentials or a provider-owned credential file. Ambient AWS identity
    // cannot enter through the general environment.
    ...credentialEnvironment,
  };
};
