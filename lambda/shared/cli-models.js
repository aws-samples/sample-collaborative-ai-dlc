'use strict';

const ALLOWED_CLI_MODEL_KEYS = new Set(['kiro', 'claude', 'opencode']);
const MAX_CLI_MODEL_LENGTH = 200;
const OPENCODE_MODEL_PREFIX = 'amazon-bedrock/';

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizeCliModels(value) {
  const issues = [];
  const normalized = {};

  if (value === undefined || value === null) {
    return { valid: true, issues, value: normalized };
  }

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      return {
        valid: false,
        issues: [{ path: '', message: `Invalid JSON: ${err.message}.` }],
        value: normalized,
      };
    }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ path: '', message: `Expected an object; got ${describe(value)}.` }],
      value: normalized,
    };
  }

  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_CLI_MODEL_KEYS.has(key)) {
      issues.push({
        path: key,
        message: `Unknown model key "${key}". Allowed: ${[...ALLOWED_CLI_MODEL_KEYS].join(', ')}.`,
      });
      continue;
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      issues.push({ path: key, message: `Expected string; got ${describe(raw)}.` });
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_CLI_MODEL_LENGTH) {
      issues.push({
        path: key,
        message: `Must be ${MAX_CLI_MODEL_LENGTH} characters or fewer.`,
      });
      continue;
    }
    if (key === 'opencode' && trimmed && !trimmed.startsWith(OPENCODE_MODEL_PREFIX)) {
      issues.push({
        path: key,
        message: `OpenCode model must start with "${OPENCODE_MODEL_PREFIX}".`,
      });
      continue;
    }
    // Claude on Bedrock uses a bare cross-region inference profile ID — the
    // inverse of OpenCode: the "amazon-bedrock/" provider prefix is invalid.
    if (key === 'claude' && trimmed && trimmed.startsWith(OPENCODE_MODEL_PREFIX)) {
      issues.push({
        path: key,
        message: `Claude model must be a bare Bedrock inference profile ID (no "${OPENCODE_MODEL_PREFIX}" prefix).`,
      });
      continue;
    }
    if (trimmed) normalized[key] = trimmed;
  }

  return { valid: issues.length === 0, issues, value: normalized };
}

function parseCliModels(raw) {
  const validation = normalizeCliModels(raw || {});
  return validation.value;
}

module.exports = {
  normalizeCliModels,
  parseCliModels,
};
