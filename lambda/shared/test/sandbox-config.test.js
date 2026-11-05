import { describe, expect, it } from 'vitest';
import { validateSandboxConfig } from '../sandbox-config.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox-settings.js';

const basic = () => structuredClone(DEFAULT_SANDBOX_CONFIG.settings);

describe('SRT config validation', () => {
  it('accepts the starter and preserves additional restrictions', () => {
    expect(validateSandboxConfig(JSON.stringify(basic()))).toEqual(basic());
    const restricted = basic();
    restricted.network.strictAllowlist = true;
    restricted.network.allowedDomains = ['example.com:443', '*.npmjs.org'];
    restricted.network.deniedDomains = ['blocked.example.com'];
    restricted.filesystem = {
      allowWrite: ['/mnt/workspace'],
      denyRead: ['/etc/example-secret'],
      denyWrite: ['/mnt/workspace/protected'],
    };
    expect(validateSandboxConfig(restricted)).toEqual(restricted);
  });

  it.each(['{', '[]', 'null', '{}', '"hello"', ' '.repeat(32_769)])(
    'rejects malformed, incomplete or oversized configs',
    (text) => {
      expect(() => validateSandboxConfig(text)).toThrow();
    },
  );

  it('reports field paths for schema errors and unknown restrictions', () => {
    for (const [field, value] of [
      ['strictAllowlist', 'true'],
      ['strictAllowList', true],
      ['allowedDomains', 'example.com'],
    ]) {
      const config = basic();
      config.network[field] = value;
      try {
        validateSandboxConfig(config);
        expect.fail('invalid config accepted');
      } catch (error) {
        expect(error.code).toBe('sandbox_invalid');
        expect(error.issues).toContainEqual(expect.objectContaining({ path: `network.${field}` }));
      }
    }
  });

  it.each([
    { bwrapPath: '/untrusted/bwrap' },
    { seccomp: { applyPath: '/untrusted/apply' } },
    { enableWeakerNestedSandbox: true },
    { enableWeakerNetworkIsolation: true },
    { allowNestedUserNamespaces: true },
    { credentials: { envVars: [] } },
  ])('rejects unsupported enforcement and credential options: %j', (patch) => {
    expect(() => validateSandboxConfig({ ...basic(), ...patch })).toThrow();
  });

  it('accepts explicitly disabling nested namespaces and explains why enabling them is rejected', () => {
    const config = { ...basic(), allowNestedUserNamespaces: false };
    expect(validateSandboxConfig(config)).toEqual(config);
    config.allowNestedUserNamespaces = true;
    try {
      validateSandboxConfig(config);
      expect.fail('weaker isolation accepted');
    } catch (error) {
      expect(error.issues).toContainEqual({
        path: 'allowNestedUserNamespaces',
        message: 'Weaker isolation is not supported',
      });
    }
  });

  it.each([
    { httpProxyPort: 1234 },
    { socksProxyPort: 1234 },
    { mitmProxy: { socketPath: '/tmp/proxy', domains: ['example.com'] } },
    { allowUnixSockets: ['/tmp/bridge.sock'] },
    { allowPlaintextHeaderSet: true },
    { ambiguousRequestTarget: 'normalize' },
  ])('rejects replacement proxies and unimplemented proxy plumbing', (patch) => {
    const config = basic();
    Object.assign(config.network, patch);
    expect(() => validateSandboxConfig(config)).toThrow('Invalid SRT configuration');
  });

  it.each([
    { http: 'http://proxy.example.com:8080' },
    { https: 'https://proxy.example.com:8443' },
    { http: 'proxy.example.com:8080', noProxy: 'internal.example.com,10.0.0.0/8' },
  ])('preserves parent proxy settings without authentication: %j', (parentProxy) => {
    const config = basic();
    config.network.parentProxy = parentProxy;
    expect(validateSandboxConfig(JSON.stringify(config))).toEqual(config);
  });

  it.each(['http', 'https'])('rejects credentials and invalid %s proxy URLs', (field) => {
    for (const value of [
      'http://user:password@proxy.example.com',
      'https://user@proxy.example.com',
      'https://:password@proxy.example.com',
      'user:password@proxy.example.com:8080',
      'https://%75ser:p%40ssword@proxy.example.com',
      'socks5://proxy.example.com:1080',
      '',
      'http://',
      'http://proxy.example.com:99999',
      'not a proxy',
    ]) {
      const config = basic();
      config.network.parentProxy = { [field]: value };
      try {
        validateSandboxConfig(config);
        expect.fail('invalid proxy accepted');
      } catch (error) {
        expect(error.code).toBe('sandbox_invalid');
        expect(error.issues).toContainEqual(
          expect.objectContaining({ path: `network.parentProxy.${field}` }),
        );
        if (value) expect(JSON.stringify(error.issues)).not.toContain(value);
      }
    }
  });

  it('preserves violation suppression and the restrictions it must not disable', () => {
    const config = basic();
    config.ignoreViolations = { '*': ['/tmp/noisy-path'] };
    config.network.strictAllowlist = true;
    config.network.deniedDomains = ['blocked.example.com'];
    config.filesystem = { allowWrite: ['/tmp'], denyWrite: ['/tmp/noisy-path'], denyRead: [] };
    expect(validateSandboxConfig(JSON.stringify(config))).toEqual(config);
    config.ignoreViolations['*'] = '/tmp/noisy-path';
    expect(() => validateSandboxConfig(config)).toThrow('Invalid SRT configuration');
  });

  it('rejects file rules that would be silently ignored with filesystem.disabled', () => {
    const config = basic();
    config.filesystem.disabled = true;
    config.filesystem.denyRead = ['/tmp/private'];
    expect(() => validateSandboxConfig(config)).toThrow('Invalid SRT configuration');
  });
});
