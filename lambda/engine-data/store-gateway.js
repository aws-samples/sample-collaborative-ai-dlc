// engine-data: the server side of the AgentCore runtime's process store.
//
// The engine stays in the microVM; each store call it makes arrives here as
// `{ op: 'store.<method>', args, grant }` and is authorized independently:
//   1. the control-plane grant is verified (signature, audience, expiry, kid)
//      and must be an engine grant (execution, stage or conflict); a discussion
//      grant may only act on its own intent's execution (the assist reuses the
//      intent id as execution id) through the assist's four calls: read META
//      (the run's CLI snapshot) and the process records (recent events), record
//      its spend metric and append its completion event;
//   2. the op must be on the shared allowlist, and its positional arguments
//      must match that method's schema;
//   3. the execution the arguments name must be the grant's, and its META row
//      (consistent read) must belong to the grant's project and intent;
//   4. ops whose arguments must agree with META are checked against it
//      (a workflow checkpoint may only pin the custom rules META lists);
//   5. every stage id that addresses a STAGE# row must resolve to a row of that
//      execution;
//   6. a stage grant reads the whole execution (prior stages' rows, receipts,
//      events) but writes only as its own stage: the writes run-stage makes are
//      the only ones it may call, every stage, unit, section and leg id they name
//      must be the grant's signed one, and the attempt-fenced writes must carry
//      exactly the grant's ownership (none when the grant names no leg).
// There is deliberately no execution/stage status gate: a grant may keep
// acting on its own execution, never outside it. The real store method then
// runs unchanged (its CAS and transaction-conflict retries stay server-side),
// and its errors travel back by name so CAS callers keep working.
import { ENGINE_DATA_OP_PREFIX, ENGINE_DATA_STORE_METHODS } from '../shared/engine-data-ops.js';
import { STAGE_ATTEMPT_METHODS } from '../shared/stage-attempt.js';
import { RESERVED_ATTRIBUTES, STORE_OPS } from './store-schemas.js';
import {
  ENGINE_GRANT_MODES,
  EngineDataAccessDenied,
  denialResponse,
  deny,
  grantAudit,
  grantStageInstanceId,
  hasPrototypeKey,
  issuePaths,
  sameAsGrant,
  serializeError,
  verifyGrantOrDeny,
} from './gateway-common.js';

export { EngineDataAccessDenied };

const DISCUSSION_METHODS = new Set([
  'getExecution',
  'getExecutionRecords',
  'recordMetric',
  'appendEvent',
]);
// Execution-wide reads a stage needs (META, prior stages, receipts, events).
export const STORE_READ_METHODS = Object.freeze([
  'getStage',
  'getExecution',
  'getHumanTask',
  'listReceipts',
  'getUnitPlan',
  'listSensorRuns',
  'listPendingSteering',
  'listEvents',
  'getExecutionRecords',
  'getQuorumEdit',
  'getReceipt',
]);
// The writes run-stage (and the ensemble runner it drives) makes. Everything
// else (unit plans, compose, checkpoints, Quorum edits, execution seeding) is
// execution-grant work.
export const STAGE_WRITE_METHODS = Object.freeze([
  'appendEvent',
  'appendOutput',
  'recordMetric',
  'recordSensorRun',
  'putReceipt',
  'putStage',
  'resumeStageRow',
  'updateStageState',
  'updateExecution',
  'createHumanTask',
  'supersedeHumanTask',
  'claimStageAttempt',
  'markLoopBackArchived',
  'markSteeringConsumed',
  'raiseStageCounter',
]);
const STAGE_READS = new Set(STORE_READ_METHODS);
const STAGE_WRITES = new Set(STAGE_WRITE_METHODS);
const OWNED_WRITES = new Set([...STAGE_ATTEMPT_METHODS, 'claimStageAttempt']);
const ALLOWED_METHODS = new Set(ENGINE_DATA_STORE_METHODS);
const RESERVED_KEYS = new Set(RESERVED_ATTRIBUTES);

// Top-level keys a schema dropped. Names only: they go to the audit log so a
// field the runtime sends but the schema does not know shows up on the first
// deployed run instead of silently disappearing from process state.
const droppedKeys = (raw, parsed) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) && parsed && typeof parsed === 'object'
    ? Object.keys(raw).filter((key) => raw[key] !== undefined && !Object.hasOwn(parsed, key))
    : [];

const namesReservedAttribute = (arg) =>
  Boolean(arg) &&
  typeof arg === 'object' &&
  !Array.isArray(arg) &&
  Object.keys(arg).some((key) => RESERVED_KEYS.has(key));

const namesStageOrLane = (arg) =>
  Boolean(arg) &&
  typeof arg === 'object' &&
  ['stageInstanceId', 'unitSlug', 'sectionIndex'].some(
    (key) => arg[key] !== undefined && arg[key] !== null,
  );

const parseArgs = (spec, args) => {
  if (!Array.isArray(args) || args.length > spec.args.length) deny('invalid_arguments');
  if (hasPrototypeKey(args) || args.some(namesReservedAttribute)) deny('invalid_arguments');
  const parsed = [];
  const stripped = [];
  for (const [index, schema] of spec.args.entries()) {
    const result = schema.safeParse(args[index]);
    if (!result.success) {
      deny('invalid_arguments', { issues: issuePaths(index, result.error) });
    }
    stripped.push(...droppedKeys(args[index], result.data).map((key) => `${index}.${key}`));
    parsed.push(result.data);
  }
  while (parsed.length && parsed.at(-1) === undefined) parsed.pop();
  return { parsed, stripped };
};

export const createStoreGateway = ({ verifyGrant, createStore, audit = () => {} }) => {
  const authorize = async (event, record) => {
    const grant = await verifyGrantOrDeny(verifyGrant, event?.grant);
    Object.assign(record, grantAudit(grant));
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
    if (grant.mode === 'stage' && !STAGE_READS.has(method) && !STAGE_WRITES.has(method)) {
      deny('op_not_allowed');
    }
    const spec = STORE_OPS[method];
    const { parsed: args, stripped } = parseArgs(spec, event.args);
    if (stripped.length) record.strippedKeys = stripped;

    const executionId = spec.executionId(args);
    if (executionId !== (discussion ? grant.intentId : grant.executionId)) {
      deny('scope_mismatch');
    }
    // A discussion has no stage or lane: none of its calls may name one.
    if (discussion && (spec.stageIds(args).length > 0 || namesStageOrLane(args[0]))) {
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
    const metaDenial = spec.checkMeta(args, meta, grant);
    if (metaDenial) deny(metaDenial);
    for (const stageInstanceId of new Set(spec.stageIds(args))) {
      const stage = await store.getStage(executionId, stageInstanceId, { consistentRead: true });
      if (!stage || stage.executionId !== executionId) deny('scope_mismatch');
    }
    if (grant.mode === 'stage') await bindStageWrite(store, { grant, method, args, meta });
  };

  const bindStageWrite = async (store, { grant, method, args, meta }) => {
    if (STAGE_READS.has(method)) return;
    const own = grantStageInstanceId(grant, meta);
    const [input] = args;
    if (
      !sameAsGrant(input.stageInstanceId ?? undefined, own) ||
      !sameAsGrant(input.stageId, grant.stageId) ||
      !sameAsGrant(input.unitSlug, grant.unitSlug) ||
      !sameAsGrant(input.sectionIndex, grant.sectionIndex) ||
      !sameAsGrant(input.stageCallbackId, grant.stageCallbackId) ||
      !sameAsGrant(input.orchestratorRunId, grant.orchestratorRunId)
    ) {
      deny('scope_mismatch');
    }
    if (OWNED_WRITES.has(method)) {
      const ownership = input.ownership ?? null;
      const leg = grant.orchestratorRunId && grant.stageCallbackId;
      if (
        leg
          ? ownership?.orchestratorRunId !== grant.orchestratorRunId ||
            ownership?.stageCallbackId !== grant.stageCallbackId ||
            ownership?.stageInstanceId !== own
          : ownership !== null
      ) {
        deny('ownership_mismatch');
      }
    }
    // Superseding names its gate by id only: the gate must be this stage's.
    if (method === 'supersedeHumanTask') {
      const task = await store.getHumanTask(input.executionId, input.humanTaskId, {
        consistentRead: true,
      });
      if (!task || task.stageInstanceId !== own) deny('scope_mismatch');
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
      return denialResponse(error);
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
