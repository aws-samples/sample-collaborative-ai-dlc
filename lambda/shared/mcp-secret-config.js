import { createHash } from 'node:crypto';
import { validateMcpServers, SECRET_VAR_NAME } from './mcp-validator.js';
import { computeSurvivors, inspectMcpSecretRefs } from './mcp-secret-policy.js';

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export const mcpSecretError = (code) => Object.assign(new Error(code), { code });
export const isMcpRecord = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const isMcpProjectId = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9._-]{1,512}$/.test(value) &&
  value !== '.' &&
  value !== '..';
export const isMcpSecretRef = (value) =>
  typeof value === 'string' && SECRET_VAR_NAME.test(value) && !PROTOTYPE_KEYS.has(value);

const canonicalValue = (value, depth = 0) => {
  if (depth > 8) throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
  if (value === null || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1));
  if (!isMcpRecord(value)) throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => {
        if (PROTOTYPE_KEYS.has(key)) throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
        return [key, canonicalValue(value[key], depth + 1)];
      }),
  );
};

export const normalizeMcpSecretConfig = (input) => {
  const config = input ?? {};
  if (
    !isMcpRecord(config) ||
    Object.keys(config).some((key) => !['global', 'project'].includes(key))
  )
    throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
  const normalized = canonicalValue({ global: config.global ?? {}, project: config.project ?? {} });
  if (
    Buffer.byteLength(JSON.stringify(normalized)) > 128 * 1024 ||
    !validateMcpServers(normalized.global).valid ||
    !validateMcpServers(normalized.project).valid
  )
    throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
  const { survivingGlobal, survivingProject } = computeSurvivors(
    normalized.global,
    normalized.project,
  );
  const { globalRefs, projectRefs } = inspectMcpSecretRefs(survivingGlobal, survivingProject);
  if (
    [globalRefs, projectRefs].some(
      (refs) => refs.size > 256 || [...refs].some((ref) => !isMcpSecretRef(ref)),
    )
  )
    throw mcpSecretError('MCP_SECRET_CONFIG_INVALID');
  return normalized;
};

export const mcpSecretConfigAuthority = (input) => {
  const config = normalizeMcpSecretConfig(input);
  const { survivingGlobal, survivingProject } = computeSurvivors(config.global, config.project);
  const policy = inspectMcpSecretRefs(survivingGlobal, survivingProject);
  return {
    config,
    survivingGlobal,
    survivingProject,
    policy,
    configDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    allowedRefs: {
      global: [...policy.globalRefs].toSorted(),
      project: [...policy.projectRefs].toSorted(),
    },
  };
};
