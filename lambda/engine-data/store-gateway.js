// engine-data: the server side of the AgentCore runtime's process store.
//
// The engine stays in the microVM; each store call it makes arrives here as
// `{ op: 'store.<method>', args, grant }` and is authorized independently:
//   1. the control-plane grant is verified (signature, audience, expiry, kid)
//      and must be an engine grant (execution, stage or conflict); a discussion
//      grant may only read its own intent's META (the assist reuses the intent
//      id as execution id to find the run's CLI snapshot);
//   2. the op must be on the shared allowlist, and its positional arguments
//      must match that method's schema;
//   3. the execution the arguments name must be the grant's, and its META row
//      (consistent read) must belong to the grant's project and intent;
//   4. every stage id that addresses a STAGE# row must resolve to a row of that
//      execution.
// There is deliberately no execution/stage status gate: a grant may keep
// acting on its own execution, never outside it. The real store method then
// runs unchanged (its CAS and transaction-conflict retries stay server-side),
// and its errors travel back by name so CAS callers keep working.
import { isTransactionConflict } from '../shared/v2-process-store.js';
import {
  ENGINE_DATA_DENIED_ERROR,
  ENGINE_DATA_OP_PREFIX,
  ENGINE_DATA_STORE_METHODS,
} from '../shared/engine-data-ops.js';
import { RESERVED_ATTRIBUTES, STORE_OPS } from './store-schemas.js';

const ENGINE_GRANT_MODES = new Set(['execution', 'stage', 'conflict']);
const DISCUSSION_METHODS = new Set(['getExecution']);
const ALLOWED_METHODS = new Set(ENGINE_DATA_STORE_METHODS);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_KEYS = new Set(RESERVED_ATTRIBUTES);

export class EngineDataAccessDenied extends Error {
  constructor(reason, detail = {}) {
    super('Engine data call denied');
    this.name = ENGINE_DATA_DENIED_ERROR;
    this.reason = reason;
    this.detail = detail;
  }
}

const deny = (reason, detail) => {
  throw new EngineDataAccessDenied(reason, detail);
};

// Top-level keys a schema dropped. Names only: they go to the audit log so a
// field the runtime sends but the schema does not know shows up on the first
// deployed run instead of silently disappearing from process state.
const droppedKeys = (raw, parsed) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) && parsed && typeof parsed === 'object'
    ? Object.keys(raw).filter((key) => raw[key] !== undefined && !Object.hasOwn(parsed, key))
    : [];

const hasPrototypeKey = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPrototypeKey);
  return Object.keys(value).some((key) => PROTOTYPE_KEYS.has(key) || hasPrototypeKey(value[key]));
};

const namesReservedAttribute = (arg) =>
  Boolean(arg) &&
  typeof arg === 'object' &&
  !Array.isArray(arg) &&
  Object.keys(arg).some((key) => RESERVED_KEYS.has(key));

const parseArgs = (spec, args) => {
  if (!Array.isArray(args) || args.length > spec.args.length) deny('invalid_arguments');
  if (hasPrototypeKey(args) || args.some(namesReservedAttribute)) deny('invalid_arguments');
  const parsed = [];
  const stripped = [];
  for (const [index, schema] of spec.args.entries()) {
    const result = schema.safeParse(args[index]);
    if (!result.success) {
      // Paths and issue codes only, never values.
      deny('invalid_arguments', {
        issues: result.error.issues
          .slice(0, 5)
          .map((issue) => `${index}.${issue.path.join('.')}:${issue.code}`),
      });
    }
    stripped.push(...droppedKeys(args[index], result.data).map((key) => `${index}.${key}`));
    parsed.push(result.data);
  }
  while (parsed.length && parsed.at(-1) === undefined) parsed.pop();
  return { parsed, stripped };
};

const serializeError = (error) => ({
  name: typeof error?.name === 'string' ? error.name : 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: typeof error?.message === 'string' ? error.message : 'Engine data call failed',
  conflict: isTransactionConflict(error),
});

export const createStoreGateway = ({ verifyGrant, createStore, audit = () => {} }) => {
  const authorize = async (event, record) => {
    if (typeof event?.grant !== 'string' || !event.grant) deny('missing_grant');
    let grant;
    try {
      grant = await verifyGrant(event.grant);
    } catch (error) {
      deny(error?.code === 'GATEWAY_GRANT_EXPIRED' ? 'grant_expired' : 'grant_invalid');
    }
    Object.assign(record, {
      projectId: grant.projectId,
      intentId: grant.intentId,
      executionId: grant.executionId,
      grantId: grant.grantId,
      mode: grant.mode,
    });
    const discussion = grant.mode === 'discussion';
    if (!ENGINE_GRANT_MODES.has(grant.mode) && !discussion) deny('grant_mode_not_allowed');

    const op = typeof event.op === 'string' ? event.op : '';
    const method = op.startsWith(ENGINE_DATA_OP_PREFIX)
      ? op.slice(ENGINE_DATA_OP_PREFIX.length)
      : null;
    if (!method || !ALLOWED_METHODS.has(method) || !Object.hasOwn(STORE_OPS, method)) {
      deny('op_not_allowed');
    }
    if (discussion && !DISCUSSION_METHODS.has(method)) deny('op_not_allowed');
    const spec = STORE_OPS[method];
    const { parsed: args, stripped } = parseArgs(spec, event.args);
    if (stripped.length) record.strippedKeys = stripped;

    const executionId = spec.executionId(args);
    if (executionId !== (grant.executionId ?? (discussion ? grant.intentId : null))) {
      deny('scope_mismatch');
    }
    return { grant, method, spec, args, executionId };
  };

  const checkScope = async (store, { grant, method, spec, args, executionId }) => {
    if (method === 'createExecution') {
      if (args[0].projectId !== grant.projectId || args[0].intentId !== grant.intentId) {
        deny('scope_mismatch');
      }
      return;
    }
    const meta = await store.getExecution(executionId, { consistentRead: true });
    // A missing META is a valid answer to getExecution itself (a deleted intent
    // retires its worker); every other op needs the execution to exist.
    if (!meta) {
      if (method === 'getExecution') return;
      deny('execution_not_found');
    }
    if (meta.projectId !== grant.projectId || meta.intentId !== grant.intentId) {
      deny('scope_mismatch');
    }
    for (const stageInstanceId of new Set(spec.stageIds(args))) {
      const stage = await store.getStage(executionId, stageInstanceId, { consistentRead: true });
      if (!stage || stage.executionId !== executionId) deny('scope_mismatch');
    }
  };

  return async (event) => {
    const startedAt = Date.now();
    const record = { op: typeof event?.op === 'string' ? event.op : null };
    let authorized;
    let store;
    try {
      authorized = await authorize(event, record);
      store = createStore();
      await checkScope(store, authorized);
    } catch (error) {
      if (!(error instanceof EngineDataAccessDenied)) {
        audit({
          ...record,
          decision: 'error',
          error: error?.name ?? 'Error',
          ms: Date.now() - startedAt,
        });
        return { error: serializeError(error) };
      }
      audit({
        ...record,
        ...error.detail,
        decision: 'deny',
        reason: error.reason,
        ms: Date.now() - startedAt,
      });
      return {
        error: {
          name: ENGINE_DATA_DENIED_ERROR,
          code: error.reason,
          message: error.message,
          conflict: false,
        },
      };
    }

    try {
      const result = await store[authorized.method](...authorized.args);
      audit({ ...record, decision: 'allow', outcome: 'ok', ms: Date.now() - startedAt });
      // `ok` marks success explicitly: a method that returns nothing has no
      // `result` key once the response is serialized.
      return { ok: true, result };
    } catch (error) {
      audit({
        ...record,
        decision: 'allow',
        outcome: 'store_error',
        error: error?.name ?? 'Error',
        ms: Date.now() - startedAt,
      });
      return { error: serializeError(error) };
    }
  };
};
