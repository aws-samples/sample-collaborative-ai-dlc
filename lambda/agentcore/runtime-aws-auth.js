// Forward the original provider environment to the built-in MCP by name,
// without writing credentials into MCP config files.
const RUNTIME_AWS_ENV_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
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
  'AWS_EC2_METADATA_DISABLED',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
];

export const runtimeAwsSnapshot = (env) =>
  JSON.stringify(
    Object.fromEntries(
      RUNTIME_AWS_ENV_NAMES.filter((name) => env[name] !== undefined).map((name) => [
        name,
        env[name],
      ]),
    ),
  );

export const restoreRuntimeAwsAuth = (env) => {
  if (env.AIDLC_RESTORE_RUNTIME_AWS !== '1') return;
  if (!env.AIDLC_RUNTIME_AWS_ENV) throw new Error('Runtime AWS environment is required');
  const original = JSON.parse(env.AIDLC_RUNTIME_AWS_ENV);
  for (const name of RUNTIME_AWS_ENV_NAMES) {
    delete env[name];
    if (typeof original[name] === 'string') env[name] = original[name];
  }
  delete env.AIDLC_RUNTIME_AWS_ENV;
  delete env.AIDLC_RESTORE_RUNTIME_AWS;
};
