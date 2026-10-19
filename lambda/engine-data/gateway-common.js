// The pieces both engine-data gateways (process store and graph) share: the
// denial type, grant verification, argument hygiene and the error envelope.
import { isTransactionConflict } from '../shared/v2-process-store.js';
import { ENGINE_DATA_DENIED_ERROR } from '../shared/engine-data-ops.js';

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Below the 6 MB synchronous Invoke response limit, with room for the envelope.
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export const ENGINE_GRANT_MODES = new Set(['execution', 'stage', 'conflict']);

export class EngineDataAccessDenied extends Error {
  constructor(reason, detail = {}) {
    super('Engine data call denied');
    this.name = ENGINE_DATA_DENIED_ERROR;
    this.reason = reason;
    this.detail = detail;
  }
}

export const deny = (reason, detail) => {
  throw new EngineDataAccessDenied(reason, detail);
};

export const hasPrototypeKey = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPrototypeKey);
  return Object.keys(value).some((key) => PROTOTYPE_KEYS.has(key) || hasPrototypeKey(value[key]));
};

// Paths and issue codes only, never values.
export const issuePaths = (prefix, error) =>
  error.issues.slice(0, 5).map((issue) => `${prefix}.${issue.path.join('.')}:${issue.code}`);

export const verifyGrantOrDeny = async (verifyGrant, token) => {
  if (typeof token !== 'string' || !token) deny('missing_grant');
  try {
    return await verifyGrant(token);
  } catch (error) {
    return deny(error?.code === 'GATEWAY_GRANT_EXPIRED' ? 'grant_expired' : 'grant_invalid');
  }
};

export const grantAudit = (grant) => ({
  projectId: grant.projectId,
  intentId: grant.intentId,
  executionId: grant.executionId,
  grantId: grant.grantId,
  mode: grant.mode,
});

export const serializeError = (error) => ({
  name: typeof error?.name === 'string' ? error.name : 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: typeof error?.message === 'string' ? error.message : 'Engine data call failed',
  conflict: isTransactionConflict(error),
});

export const denialResponse = (error) => ({
  error: {
    name: ENGINE_DATA_DENIED_ERROR,
    code: error.reason,
    message: error.message,
    conflict: false,
  },
});

// Routes a request to the gateway that owns its op namespace. An op outside
// every namespace is denied here; it is never handed to a default gateway.
export const createNamespaceDispatch = (gateways, { audit = () => {} } = {}) => {
  const prefixes = Object.keys(gateways);
  return async (event) => {
    const op = typeof event?.op === 'string' ? event.op : '';
    const prefix = prefixes.find((candidate) => op.startsWith(candidate));
    if (prefix) return gateways[prefix](event);
    const denial = new EngineDataAccessDenied('op_not_allowed');
    audit({ op: op || null, decision: 'deny', reason: denial.reason });
    return denialResponse(denial);
  };
};
