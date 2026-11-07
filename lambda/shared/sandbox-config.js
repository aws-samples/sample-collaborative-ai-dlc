import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { sandboxSettingsError } from './sandbox-settings.js';

export const SANDBOX_CONFIG_MAX_BYTES = 32_768;

// These options replace enforcement helpers, require credential/certificate
// plumbing, or only work on other operating systems. Do not accept a setting
// that this Linux integration cannot apply.
const unsupported = [
  'credentials',
  'ripgrep',
  'seccomp',
  'bwrapPath',
  'socatPath',
  'javaAgentJarPath',
  'windows',
  'allowAppleEvents',
  'network.httpProxyPort',
  'network.socksProxyPort',
  'network.mitmProxy',
  'network.filterRequest',
  'network.allowPlaintextHeaderSet',
  'network.ambiguousRequestTarget',
  'network.tlsTerminate',
  'network.allowMachLookup',
  'network.allowUnixSockets',
];

// SRT strips some unknown keys. Reject them instead: a misspelled restriction
// must not appear to have been saved successfully.
const unknownKeys = (input, parsed, path = []) => {
  if (!input || typeof input !== 'object') return [];
  return Object.keys(input).flatMap((key) => {
    const nextPath = [...path, key];
    return !Object.hasOwn(parsed ?? {}, key)
      ? [{ path: nextPath.join('.'), message: 'Unknown SRT setting' }]
      : unknownKeys(input[key], parsed[key], nextPath);
  });
};

export const validateSandboxConfig = (input) => {
  let config = input;
  try {
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > SANDBOX_CONFIG_MAX_BYTES) throw new Error('size');
      config = JSON.parse(input);
    } else if (Buffer.byteLength(JSON.stringify(input) ?? '') > SANDBOX_CONFIG_MAX_BYTES) {
      throw new Error('size');
    }
  } catch (error) {
    throw sandboxSettingsError(
      'sandbox_invalid',
      error.message === 'size'
        ? 'Configuration must be at most 32 KiB'
        : 'Invalid JSON configuration',
    );
  }
  const result = SandboxRuntimeConfigSchema.safeParse(config);
  const issues = result.success
    ? unknownKeys(config, result.data)
    : result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
  for (const path of unsupported) {
    const value = path.split('.').reduce((object, key) => object?.[key], config);
    if (value !== undefined) {
      issues.push({ path, message: 'Not supported by this application integration' });
    }
  }
  for (const field of ['http', 'https']) {
    const value = config?.network?.parentProxy?.[field];
    // SRT accepts host:port, but silently ignores invalid proxy URLs at runtime.
    // Reject invalid endpoints and credentials before storing the configuration.
    if (typeof value !== 'string' || value === '') continue;
    const path = `network.parentProxy.${field}`;
    try {
      const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) {
        throw new Error('Invalid proxy URL');
      }
      if (proxy.username || proxy.password) {
        issues.push({ path, message: 'Parent proxy authentication is not supported' });
      }
    } catch {
      issues.push({ path, message: 'Expected an HTTP(S) proxy URL or host:port' });
    }
  }
  for (const path of [
    'enableWeakerNestedSandbox',
    'enableWeakerNetworkIsolation',
    'allowNestedUserNamespaces',
  ]) {
    if (config?.[path] === true) {
      issues.push({ path, message: 'Weaker isolation is not supported' });
    }
  }
  if (
    config?.filesystem?.disabled === true &&
    ['denyRead', 'allowRead', 'allowWrite', 'denyWrite'].some(
      (field) => config.filesystem[field]?.length > 0,
    )
  ) {
    issues.push({
      path: 'filesystem.disabled',
      message: 'Set disabled to false before adding file rules; SRT ignores them while it is true',
    });
  }
  if (issues.length) {
    throw Object.assign(sandboxSettingsError('sandbox_invalid', 'Invalid SRT configuration'), {
      issues,
    });
  }
  return result.data;
};
