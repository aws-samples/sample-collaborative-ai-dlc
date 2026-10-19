// engine-data: the server side of the engine's Neptune access.
//
// Each graph call arrives as `{ op: 'graph.<name>', args: [selector, input],
// grant }` and is authorized on its own, the same way store calls are:
//   1. the grant is verified and its mode must be allowed for the operation
//      (engine grants for engine work, discussion grants for the three assist
//      operations only);
//   2. the operation must be on the shared allowlist, the selector and input
//      must match their strict schemas, and every ownership id the selector
//      names must equal the grant's;
//   3. the execution META (consistent read) and the Neptune Intent anchor must
//      belong to the grant's project and intent, and every stage, unit lane and
//      Quorum edit the call names must resolve inside the granted execution;
//   4. the operation runs with a writer scope rebuilt from the grant and the
//      resolved stage row, never from the request.
// The graph connection is shared across requests of one Lambda environment;
// nothing scoped is cached on it. Graph code that finds a reference outside
// the grant mid-operation reports it as a denial, like the checks above.
import {
  ENGINE_DATA_GRAPH_DISCUSSION_OPS,
  ENGINE_DATA_GRAPH_OPS,
  ENGINE_DATA_GRAPH_PREFIX,
} from '../shared/engine-data-ops.js';
import {
  createEngineGraphOps,
  EngineGraphScopeError,
  readIntentAnchor,
} from '../shared/engine-graph-ops.js';
import { GRAPH_OPS, GRAPH_SELECTOR } from './graph-schemas.js';
import {
  ENGINE_GRANT_MODES,
  EngineDataAccessDenied,
  MAX_RESPONSE_BYTES,
  denialResponse,
  deny,
  grantAudit,
  hasPrototypeKey,
  issuePaths,
  serializeError,
  verifyGrantOrDeny,
} from './gateway-common.js';

const ALLOWED_OPS = new Set(ENGINE_DATA_GRAPH_OPS);
const DISCUSSION_OPS = new Set(ENGINE_DATA_GRAPH_DISCUSSION_OPS);

const supplied = (value) => value !== undefined && value !== null;

const parseOrDeny = (schema, value, prefix) => {
  const result = schema.safeParse(value);
  if (!result.success) deny('invalid_arguments', { issues: issuePaths(prefix, result.error) });
  return result.data;
};

const resolveStage = async (store, executionId, stageInstanceId) => {
  const stage = await store.getStage(executionId, stageInstanceId, { consistentRead: true });
  if (!stage || stage.executionId !== executionId) deny('scope_mismatch');
  return stage;
};

const checkScope = async (store, { grant, spec, selector, input, executionId }) => {
  const meta = await store.getExecution(executionId, { consistentRead: true });
  if (!meta && spec.meta === 'required') deny('execution_not_found');
  if (meta && (meta.projectId !== grant.projectId || meta.intentId !== grant.intentId)) {
    deny('scope_mismatch');
  }

  let stage = null;
  if (selector.stageInstanceId) {
    stage = await resolveStage(store, executionId, selector.stageInstanceId);
    if (
      (selector.sectionIndex !== undefined &&
        selector.sectionIndex !== (stage.sectionIndex ?? null)) ||
      (selector.unitSlug !== undefined && selector.unitSlug !== (stage.unitSlug ?? null))
    ) {
      deny('scope_mismatch');
    }
  }
  for (const stageInstanceId of new Set(spec.stageIds(input))) {
    await resolveStage(store, executionId, stageInstanceId);
  }
  for (const { sectionIndex, unitSlug } of spec.unitRefs(input)) {
    const unit = await store.getUnit(executionId, sectionIndex, unitSlug);
    if (!unit || (unit.executionId && unit.executionId !== executionId)) deny('scope_mismatch');
  }
  for (const editId of new Set(spec.quorumEditIds(input))) {
    const edit = await store.getQuorumEdit(executionId, editId);
    if (!edit || (edit.executionId && edit.executionId !== executionId)) deny('scope_mismatch');
  }

  return {
    projectId: grant.projectId,
    intentId: grant.intentId,
    executionId,
    ...(stage
      ? {
          stageInstanceId: stage.stageInstanceId,
          stageId: stage.stageId ?? null,
          sectionIndex: stage.sectionIndex ?? null,
          unitSlug: stage.unitSlug ?? null,
        }
      : {}),
  };
};

const checkAnchor = async (g, { grant, spec }) => {
  const anchor = await readIntentAnchor(g, grant.intentId);
  if (!anchor.exists) {
    if (spec.anchor === 'required') deny('intent_not_found');
    return;
  }
  if (anchor.projectIds.length !== 1 || anchor.projectIds[0] !== grant.projectId) {
    deny('scope_mismatch');
  }
};

export const createGraphGateway = ({
  verifyGrant,
  createStore,
  withGraph,
  createOps = createEngineGraphOps,
  clock,
  audit = () => {},
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) => {
  const authorize = async (event, record) => {
    const grant = await verifyGrantOrDeny(verifyGrant, event?.grant);
    Object.assign(record, grantAudit(grant));
    const discussion = grant.mode === 'discussion';
    if (!ENGINE_GRANT_MODES.has(grant.mode) && !discussion) deny('grant_mode_not_allowed');

    const op = typeof event.op === 'string' ? event.op : '';
    const name = op.startsWith(ENGINE_DATA_GRAPH_PREFIX)
      ? op.slice(ENGINE_DATA_GRAPH_PREFIX.length)
      : null;
    if (!name || !ALLOWED_OPS.has(name) || !Object.hasOwn(GRAPH_OPS, name)) deny('op_not_allowed');
    const spec = GRAPH_OPS[name];
    if (discussion ? !DISCUSSION_OPS.has(name) : spec.modes === 'discussion') {
      deny('op_not_allowed');
    }
    if (spec.grantModes && !spec.grantModes.includes(grant.mode)) deny('grant_mode_not_allowed');

    const { args } = event;
    if (!Array.isArray(args) || args.length > 2 || hasPrototypeKey(args)) {
      deny('invalid_arguments');
    }
    const selector = parseOrDeny(GRAPH_SELECTOR, args[0] ?? {}, 0);
    const input = parseOrDeny(spec.input, args[1] ?? {}, 1);

    const executionId = grant.executionId ?? (discussion ? grant.intentId : null);
    if (
      (supplied(selector.projectId) && selector.projectId !== grant.projectId) ||
      (supplied(selector.intentId) && selector.intentId !== grant.intentId) ||
      (supplied(selector.executionId) && selector.executionId !== executionId)
    ) {
      deny('scope_mismatch');
    }
    // A lane only exists through a stage row: a lane without a stage, or any
    // stage under a discussion grant, names a scope nothing can verify.
    const lane = supplied(selector.sectionIndex) || supplied(selector.unitSlug);
    if ((lane && !selector.stageInstanceId) || (discussion && selector.stageInstanceId)) {
      deny('scope_mismatch');
    }
    if (spec.requireStage && !selector.stageInstanceId) deny('stage_required');
    return { grant, name, spec, selector, input, executionId };
  };

  const denied = (record, startedAt, reason, detail = {}) => {
    audit({ ...record, ...detail, decision: 'deny', reason, ms: Date.now() - startedAt });
    return denialResponse(new EngineDataAccessDenied(reason));
  };

  return async (event) => {
    const startedAt = Date.now();
    const record = { op: typeof event?.op === 'string' ? event.op : null };
    let authorized;
    let scope;
    try {
      authorized = await authorize(event, record);
      scope = await checkScope(createStore(), authorized);
    } catch (error) {
      if (error instanceof EngineDataAccessDenied) {
        return denied(record, startedAt, error.reason, error.detail);
      }
      audit({
        ...record,
        decision: 'error',
        error: error?.name ?? 'Error',
        ms: Date.now() - startedAt,
      });
      return { error: serializeError(error) };
    }

    try {
      const result = await withGraph(
        async (g) => {
          await checkAnchor(g, authorized);
          return createOps({ g, scope, ...(clock ? { clock } : {}) })[authorized.name](
            authorized.input,
          );
        },
        { retryAuth: authorized.spec.replaySafe },
      );
      const bytes = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
      if (bytes > maxResponseBytes) {
        audit({
          ...record,
          decision: 'allow',
          outcome: 'response_too_large',
          bytes,
          ms: Date.now() - startedAt,
        });
        return {
          error: {
            name: 'EngineGraphError',
            code: 'response_too_large',
            message: 'Graph result is too large to return',
            conflict: false,
          },
        };
      }
      audit({ ...record, decision: 'allow', outcome: 'ok', ms: Date.now() - startedAt });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof EngineDataAccessDenied) {
        return denied(record, startedAt, error.reason, error.detail);
      }
      if (error instanceof EngineGraphScopeError) return denied(record, startedAt, error.code);
      audit({
        ...record,
        decision: 'allow',
        outcome: 'graph_error',
        error: error?.name ?? 'Error',
        ms: Date.now() - startedAt,
      });
      return { error: serializeError(error) };
    }
  };
};
