import { APPLICATION_CREDENTIAL_ENV } from '../../shared/runtime-credential-env.js';
export {
  APPLICATION_CREDENTIAL_ENV,
  INFERENCE_CREDENTIAL_ENV,
} from '../../shared/runtime-credential-env.js';

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
