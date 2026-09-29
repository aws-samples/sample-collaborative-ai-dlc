import { assertIdentifier } from '../shared/agent-auth-contracts.js';
import { authModeDescriptor } from '../shared/agent-auth-providers.js';
import { RUNTIME_AUTH_PROVIDERS } from './runtime-auth-providers.js';

// Foundation-owned capability fields; a provider contribution never replaces them.
const RESERVED_CAPABILITY_KEYS = Object.freeze([
  'ok',
  'clis',
  'kiroModels',
  'agentAuthProtocol',
  'agentAuthModes',
  'agentAuthVerification',
  'invocationAccounting',
  'command',
  'at',
]);
// Unknown keys are refused so a misspelled controlledEnv cannot leave ambient values in place.
const PROVIDER_KEYS = Object.freeze(['id', 'modes', 'materials', 'controlledEnv', 'capabilities']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const composeRuntimeAuthProviders = (providers) => {
  if (!Array.isArray(providers))
    throw new TypeError('Runtime authentication providers must be a list');
  const ids = new Set();
  const materialAdapters = {};
  const materialEnv = {};
  const modes = [];
  const controlledEnv = new Set();
  const contributors = [];
  for (const provider of providers) {
    if (!isRecord(provider)) throw new TypeError('Runtime authentication provider is required');
    const {
      id,
      modes: advertised,
      materials,
      controlledEnv: envNames = [],
      capabilities,
    } = provider;
    assertIdentifier(id, 'Runtime authentication provider id');
    const invalid = (problem) => new TypeError(`Runtime authentication provider ${id} ${problem}`);
    const unsupported = Object.keys(provider).filter((key) => !PROVIDER_KEYS.includes(key));
    if (unsupported.length) throw invalid(`declares unsupported fields: ${unsupported.join(', ')}`);
    if (ids.has(id)) throw invalid('is registered twice');
    ids.add(id);
    if (!Array.isArray(advertised) || !advertised.length) throw invalid('requires a mode');
    for (const mode of advertised) {
      // Every Lambda must be able to select what the image advertises.
      const descriptor = typeof mode === 'string' ? authModeDescriptor(mode) : null;
      if (!descriptor || descriptor.planned) throw invalid(`advertises unavailable mode ${mode}`);
      if (modes.includes(mode)) throw invalid(`advertises mode ${mode}, which is already served`);
      modes.push(mode);
    }
    if (!isRecord(materials) || !Object.keys(materials).length)
      throw invalid('requires credential materials');
    for (const [type, adapter] of Object.entries(materials)) {
      assertIdentifier(type, `Runtime authentication provider ${id} material type`);
      if (
        typeof adapter !== 'function' ||
        (adapter.createSession !== undefined && typeof adapter.createSession !== 'function')
      )
        throw invalid(`declares an invalid adapter for material ${type}`);
      if (Object.hasOwn(materialAdapters, type))
        throw invalid(`adapts material ${type}, which is already adapted`);
      materialAdapters[type] = adapter;
    }
    if (
      !Array.isArray(envNames) ||
      envNames.some((name) => typeof name !== 'string' || !ENV_NAME.test(name))
    )
      throw invalid('declares invalid controlled env names');
    for (const name of envNames) controlledEnv.add(name);
    for (const type of Object.keys(materials)) materialEnv[type] = Object.freeze([...envNames]);
    if (capabilities !== undefined) {
      if (typeof capabilities !== 'function')
        throw invalid('declares an invalid capabilities hook');
      contributors.push({ types: Object.keys(materials), capabilities });
    }
  }
  // Only providers whose material this invocation adapted contribute. A failing hook
  // contributes nothing, so the rest of the probe (Kiro included) still answers.
  const capabilityContributions = async ({ env = {}, materialTypes = [] } = {}) => {
    const results = await Promise.all(
      contributors
        .filter(({ types }) => types.some((type) => materialTypes.includes(type)))
        .map(async ({ capabilities }) => {
          try {
            return await capabilities({ env });
          } catch {
            return {};
          }
        }),
    );
    const contributions = {};
    for (const result of results.filter(isRecord))
      for (const [key, value] of Object.entries(result))
        if (!RESERVED_CAPABILITY_KEYS.includes(key)) contributions[key] = value;
    return contributions;
  };
  return Object.freeze({
    materialAdapters: Object.freeze(materialAdapters),
    controlledEnv: Object.freeze([...controlledEnv]),
    materialEnv: Object.freeze(materialEnv),
    modes: Object.freeze(modes),
    capabilityContributions,
  });
};

// Built at load from the root, so a misregistered provider fails the image at boot.
const RUNTIME_AUTH = composeRuntimeAuthProviders(RUNTIME_AUTH_PROVIDERS);
export const CREDENTIAL_MATERIAL_ADAPTERS = RUNTIME_AUTH.materialAdapters;
// Env names provider adapters control: stripped from ambient env and the MCP bridge, blanked in
// custom MCP servers and reserved from MCP refs.
export const CREDENTIAL_ADAPTER_ENV_NAMES = RUNTIME_AUTH.controlledEnv;
// Per material type, the controlled env names of the provider that adapts it.
export const CREDENTIAL_MATERIAL_ENV_NAMES = RUNTIME_AUTH.materialEnv;
export const RUNTIME_AGENT_AUTH_MODES = RUNTIME_AUTH.modes;
export const runtimeCapabilityContributions = RUNTIME_AUTH.capabilityContributions;
