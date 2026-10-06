import {
  AUTH_MECHANISMS,
  authError,
  assertIdentifier,
  normalizeEndpoint,
} from './agent-auth-protocol.js';

const text = (value, key) => {
  if (typeof value !== 'string' || !value.trim())
    throw authError('AGENT_AUTH_INVALID', `${key} is invalid`);
  return value;
};
const FIELD_KINDS = Object.freeze({
  string: (value, key) => text(value, key).trim(),
  endpoint: (value, key) => normalizeEndpoint(text(value, key), key),
  scopes: (value) => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
      throw authError('AGENT_AUTH_INVALID', 'OAuth scopes are invalid');
    }
    return [...new Set(value)].toSorted();
  },
});

// Binding identity pins this output byte-for-byte: keys keep their input order.
export const normalizeConfigurationFields = (configuration = {}, fields) => {
  for (const kind of Object.values(fields)) {
    if (!Object.hasOwn(FIELD_KINDS, kind))
      throw new TypeError(`Unsupported connection configuration field kind: ${kind}`);
  }
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    Object.keys(configuration).some((key) => !Object.hasOwn(fields, key))
  ) {
    throw authError('AGENT_AUTH_INVALID', 'Connection configuration contains unsupported fields');
  }
  const out = {};
  for (const [key, value] of Object.entries(configuration)) {
    out[key] = FIELD_KINDS[fields[key]](value, key);
  }
  return out;
};

// Unknown keys are refused so a misspelled `planned` cannot make a stub selectable.
const DESCRIPTOR_KEYS = Object.freeze([
  'id',
  'label',
  'backend',
  'mechanisms',
  'planned',
  'modelDiscovery',
  'defaultConnectionId',
  'normalizeConfiguration',
]);
const MODEL_DISCOVERY = Object.freeze(['runtime']);

export const defineAuthMode = (descriptor) => {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new TypeError('Authentication mode descriptor is required');
  const {
    id,
    label,
    backend,
    mechanisms,
    planned = false,
    modelDiscovery,
    defaultConnectionId,
    normalizeConfiguration,
  } = descriptor;
  assertIdentifier(id, 'Authentication mode id');
  const invalid = (problem) => new TypeError(`Authentication mode ${id} ${problem}`);
  const unsupported = Object.keys(descriptor).filter((key) => !DESCRIPTOR_KEYS.includes(key));
  if (unsupported.length) throw invalid(`declares unsupported fields: ${unsupported.join(', ')}`);
  if (typeof label !== 'string' || !label.trim()) throw invalid('requires a label');
  assertIdentifier(backend, `Authentication mode ${id} backend`);
  if (
    !Array.isArray(mechanisms) ||
    !mechanisms.length ||
    new Set(mechanisms).size !== mechanisms.length ||
    mechanisms.some((mechanism) => !Object.hasOwn(AUTH_MECHANISMS, mechanism))
  ) {
    throw invalid('requires unique, known authentication mechanisms');
  }
  if (typeof planned !== 'boolean') throw invalid('declares a non-boolean planned flag');
  if (modelDiscovery !== undefined && !MODEL_DISCOVERY.includes(modelDiscovery))
    throw invalid(`declares unsupported model discovery: ${modelDiscovery}`);
  if (defaultConnectionId !== undefined)
    assertIdentifier(defaultConnectionId, `Authentication mode ${id} defaultConnectionId`);
  if (typeof normalizeConfiguration !== 'function')
    throw invalid('requires a normalizeConfiguration function');
  return Object.freeze({
    id,
    label,
    backend,
    mechanisms: Object.freeze([...mechanisms]),
    planned,
    ...(modelDiscovery ? { modelDiscovery } : {}),
    ...(defaultConnectionId ? { defaultConnectionId } : {}),
    normalizeConfiguration,
  });
};

// Entries are re-validated, so a root or test may list spread copies of descriptors.
export const createAuthModeRegistry = (descriptors) => {
  if (!Array.isArray(descriptors)) throw new TypeError('Authentication modes must be a list');
  const modes = new Map();
  for (const descriptor of descriptors.map((entry) => defineAuthMode(entry))) {
    if (modes.has(descriptor.id))
      throw new TypeError(`Authentication mode ${descriptor.id} is registered twice`);
    modes.set(descriptor.id, descriptor);
  }
  const catalog = Object.freeze(
    [...modes.values()].map(({ id, label, backend, mechanisms, planned, modelDiscovery }) =>
      Object.freeze({
        id,
        label,
        backend,
        mechanisms,
        available: !planned,
        ...(modelDiscovery ? { modelDiscovery } : {}),
      }),
    ),
  );
  return Object.freeze({ get: (id) => modes.get(id) ?? null, catalog });
};
