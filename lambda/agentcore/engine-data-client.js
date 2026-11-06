// The runtime side of engine-data: a process store whose methods run in the
// engine-data Lambda instead of against DynamoDB.
//
// It has the same shape as the local store for every method engine-data
// allows, and nothing else, so feature detection (`typeof store.x`,
// `store.x?.()`, `{ ...store }`) sees exactly what the Lambda will accept. The
// grant is read on every call from the invocation that is running, so a
// method called outside a granted invocation fails instead of acting with no
// scope. Store errors come back with their name, so `ConditionalCheckFailed`
// and transaction-conflict handling in the engine behave as with the local
// store.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  ENGINE_DATA_BLOB_OPS,
  ENGINE_DATA_CATALOG_OPS,
  ENGINE_DATA_GRAPH_OPS,
  ENGINE_DATA_REALTIME_OPS,
  ENGINE_DATA_STORE_METHODS,
  ENGINE_DATA_STORE_READ_METHODS,
  engineDataBlobOp,
  engineDataCatalogOp,
  engineDataGraphOp,
  engineDataOp,
  engineDataRealtimeOp,
} from '../shared/engine-data-ops.js';
import { currentGatewayGrant } from './mcp/gateway-context.js';

export class EngineDataError extends Error {
  constructor(message, { name = 'EngineDataError', code = null } = {}) {
    super(message);
    this.name = name;
    if (code) this.code = code;
  }
}

const rehydrate = ({ name, code, message, conflict }) => {
  const error = new EngineDataError(message ?? 'Engine data call failed', { name, code });
  // isTransactionConflict reads these reasons on a cancelled transaction.
  if (conflict && name === 'TransactionCanceledException') {
    error.CancellationReasons = [{ Code: 'TransactionConflict' }];
  }
  return error;
};

const lambdaClients = new Map();
const lambdaClient = (maxAttempts) => {
  const key = maxAttempts ?? 'default';
  if (!lambdaClients.has(key)) {
    lambdaClients.set(key, new LambdaClient(maxAttempts ? { maxAttempts } : {}));
  }
  return lambdaClients.get(key);
};

const invokeWith = async (client, event, env) => {
  const response = await client.send(
    new InvokeCommand({
      FunctionName: env.ENGINE_DATA_FUNCTION,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
  let body;
  try {
    body = JSON.parse(Buffer.from(response.Payload ?? []).toString('utf8') || 'null');
  } catch {
    throw new EngineDataError('Engine data returned an unreadable response', {
      code: 'ENGINE_DATA_BAD_RESPONSE',
    });
  }
  if (response.FunctionError) {
    throw new EngineDataError(body?.errorMessage ?? 'Engine data function failed', {
      code: 'ENGINE_DATA_FUNCTION_ERROR',
    });
  }
  return body;
};

const defaultInvoke = (event, env = process.env) => invokeWith(lambdaClient(), event, env);
// A mutation is not safe to replay after an ambiguous failure (the Lambda may
// have run it), so mutating store methods and graph calls never retry at the
// transport.
const singleAttemptInvoke = (event, env = process.env) => invokeWith(lambdaClient(1), event, env);
const defaultGraphInvoke = singleAttemptInvoke;
const STORE_READS = new Set(ENGINE_DATA_STORE_READ_METHODS);

const remoteCall = async ({ invoke, grant, op, args }) => {
  const token = grant();
  if (!token) {
    throw new EngineDataError('No engine data grant for this invocation', {
      code: 'ENGINE_DATA_GRANT_MISSING',
    });
  }
  const body = await invoke({ op, args, grant: token });
  if (!body || typeof body !== 'object' || !(body.ok === true || body.error)) {
    throw new EngineDataError('Engine data returned an unreadable response', {
      code: 'ENGINE_DATA_BAD_RESPONSE',
    });
  }
  if (body.error) throw rehydrate(body.error);
  return body.result;
};

// `invoke` replaces both transports (tests, in-process gateways); by default
// reads may retry and every other method is sent exactly once.
export const createRemoteProcessStore = ({ invoke, grant }) => {
  if (typeof grant !== 'function')
    throw new Error('createRemoteProcessStore requires a grant source');
  const invokeFor = (method) =>
    invoke ?? (STORE_READS.has(method) ? defaultInvoke : singleAttemptInvoke);
  const call = (method) => {
    const send = invokeFor(method);
    return (...args) => remoteCall({ invoke: send, grant, op: engineDataOp(method), args });
  };
  return Object.fromEntries(ENGINE_DATA_STORE_METHODS.map((method) => [method, call(method)]));
};

const present = (value) => value !== undefined && value !== null && value !== '';

// The scope the runtime believes it acts in. engine-data checks every id
// against the grant and resolves the stage itself; a lane is only named
// together with the stage that carries it.
export const graphSelector = (scope = {}) => {
  const selector = {};
  for (const key of ['projectId', 'intentId', 'executionId', 'stageInstanceId']) {
    if (present(scope[key])) selector[key] = scope[key];
  }
  if (selector.stageInstanceId) {
    if (Number.isInteger(scope.sectionIndex)) selector.sectionIndex = scope.sectionIndex;
    if (present(scope.unitSlug)) selector.unitSlug = scope.unitSlug;
  }
  return selector;
};

const pick = (source, keys) => {
  const out = {};
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
};

// engine-data refuses unknown input keys, and some engine call sites hand the
// writer richer records than the operation accepts (forwarded PR payloads,
// parsed unit rows, traceability batches). These name the accepted fields.
const GRAPH_INPUTS = Object.freeze({
  recordPullRequest: (pr) => pick(pr, ['repoId', 'prUrl', 'prNumber', 'branch', 'baseBranch']),
  recordUnitPullRequest: (pr) =>
    pick(pr, [
      'sectionIndex',
      'unitSlug',
      'repoId',
      'provider',
      'prUrl',
      'prNumber',
      'sourceBranch',
      'targetBranch',
      'headSha',
      'state',
    ]),
  recordLearningRule: (rule) => pick(rule, ['id', 'title', 'content', 'layer', 'pairing', 'props']),
  mirrorUnitDag: ({ units = [], sourceArtifactId } = {}) => ({
    units: units.map((unit) => ({
      slug: unit.slug ?? unit.name,
      dependsOn: unit.dependsOn ?? unit.depends_on ?? [],
    })),
    ...(sourceArtifactId !== undefined ? { sourceArtifactId } : {}),
  }),
  ingestCodeFiles: (batch) => ({
    ...pick(batch, ['repository', 'commitRef', 'stageInstanceId', 'unitSlug']),
    files: (batch?.files ?? []).map((file) =>
      pick(file, ['filePath', 'fileKind', 'traceabilitySource', 'summary', 'evidenceIds']),
    ),
  }),
});

// The engine's graph access through engine-data: `openEngineGraph(scope)`
// returns one method per allowed graph operation plus a no-op `close`, the
// same shape the local adapter returns.
export const createRemoteGraphAccess = ({ invoke = defaultGraphInvoke, grant }) => {
  if (typeof grant !== 'function')
    throw new Error('createRemoteGraphAccess requires a grant source');
  return async (scope = {}) => {
    const selector = graphSelector(scope);
    const call = (name) => (input) =>
      remoteCall({
        invoke,
        grant,
        op: engineDataGraphOp(name),
        args: [selector, GRAPH_INPUTS[name] ? GRAPH_INPUTS[name](input) : (input ?? {})],
      });
    return {
      ...Object.fromEntries(ENGINE_DATA_GRAPH_OPS.map((name) => [name, call(name)])),
      close: async () => {},
    };
  };
};

export const misconfiguredGraphAccess = (reason) => async () => {
  throw new EngineDataError(reason, { code: 'ENGINE_DATA_MISCONFIGURED' });
};

const blockRef = (ref) =>
  ref?.s3Key
    ? { s3Key: ref.s3Key, ...(typeof ref.sha256 === 'string' ? { sha256: ref.sha256 } : {}) }
    : null;

// Only the fields the catalog op reads leave the runtime: the tenant and the
// one ref, never the whole block row.
const blockObjectInput = (block, refField, methodologyRelease) => ({
  ...(typeof block?.tenantId === 'string' ? { tenantId: block.tenantId } : {}),
  ref: blockRef(block?.[refField]),
  methodologyRelease: methodologyRelease ?? null,
});

// The block-loader API served by engine-data: same functions, same arguments,
// same results as the local loader.
export const createRemoteCatalog = ({ invoke = defaultInvoke, grant }) => {
  if (typeof grant !== 'function') throw new Error('createRemoteCatalog requires a grant source');
  const call = (name, input) =>
    remoteCall({ invoke, grant, op: engineDataCatalogOp(name), args: [input] });
  return {
    loadLibrary: ({
      workflowId,
      workflowVersion,
      methodologyPins = null,
      aidlcRepoRef = null,
      methodologyRelease = null,
    }) =>
      call('loadLibrary', {
        workflowId,
        // The local loader reads the version through Number() too.
        workflowVersion: Number(workflowVersion),
        methodologyPins,
        aidlcRepoRef,
        methodologyRelease,
      }),
    listMergedBlocks: (type) => call('listMergedBlocks', { type }),
    listReleaseBlocks: (type, methodologyRelease, methodologyPins = null) =>
      call('listReleaseBlocks', { type, methodologyRelease, methodologyPins }),
    loadBlockBody: (block, { methodologyRelease = null } = {}) =>
      call('loadBlockBody', blockObjectInput(block, 'bodyRef', methodologyRelease)),
    loadBlockScript: (block, { methodologyRelease = null } = {}) =>
      call('loadBlockScript', blockObjectInput(block, 'scriptRef', methodologyRelease)),
    loadConductor: (ref, { methodologyRelease = null } = {}) =>
      call('loadConductor', { ref: ref || null, methodologyRelease }),
    loadScriptClosure: ({ sensorId, entryContent, methodologyRelease }) =>
      call('loadScriptClosure', { sensorId, entryContent, methodologyRelease }),
  };
};

export const misconfiguredCatalog = (reason) => {
  const fail = async () => {
    throw new EngineDataError(reason, { code: 'ENGINE_DATA_MISCONFIGURED' });
  };
  return Object.fromEntries(ENGINE_DATA_CATALOG_OPS.map((name) => [name, fail]));
};

const misconfiguredOps = (names, reason) => {
  const fail = async () => {
    throw new EngineDataError(reason, { code: 'ENGINE_DATA_MISCONFIGURED' });
  };
  return Object.fromEntries(names.map((name) => [name, fail]));
};

// The project's custom rules and the intent's attachments, read by engine-data
// from what the execution META lists. Callers name a rule by filename and an
// attachment by id; keys, bucket and versions stay server-side.
export const createRemoteBlobs = ({ invoke = defaultInvoke, grant }) => {
  if (typeof grant !== 'function') throw new Error('createRemoteBlobs requires a grant source');
  const call = (name, input) =>
    remoteCall({ invoke, grant, op: engineDataBlobOp(name), args: [input] });
  return {
    readCustomRules: ({ filenames } = {}) =>
      call('readCustomRules', filenames ? { filenames } : {}),
    pinCustomRuleVersions: () => call('pinCustomRuleVersions', {}),
    readAttachmentChunk: ({ attachmentId, offset }) =>
      call('readAttachmentChunk', { attachmentId, offset }),
  };
};

// A broadcast is not replayed after an ambiguous failure (recipients may have
// received it already), so it uses the no-retry transport like graph writes.
export const createRemoteRealtime = ({ invoke = defaultGraphInvoke, grant }) => {
  if (typeof grant !== 'function') throw new Error('createRemoteRealtime requires a grant source');
  return {
    broadcastIntent: (payload) =>
      remoteCall({
        invoke,
        grant,
        op: engineDataRealtimeOp('broadcastIntent'),
        args: [{ payload }],
      }),
  };
};

// Engine-data mode only: the remote facade under the invocation's grant, or,
// without the MCP Gateway, one that fails closed. Never a direct client.
const remoteAccessFor = (env, createRemote, names) =>
  env.AIDLC_MCP_GATEWAY_URL
    ? createRemote({ grant: currentGatewayGrant })
    : misconfiguredOps(names, 'Engine data requires the MCP Gateway');

export const blobAccessFor = ({ env = process.env, createRemote = createRemoteBlobs } = {}) =>
  remoteAccessFor(env, createRemote, ENGINE_DATA_BLOB_OPS);

export const realtimeAccessFor = ({
  env = process.env,
  createRemote = createRemoteRealtime,
} = {}) => remoteAccessFor(env, createRemote, ENGINE_DATA_REALTIME_OPS);

// Stands in for the runtime's S3/DynamoDB clients wherever the catalog would
// otherwise read them directly while engine data is enabled.
export const directClientTripwire = (service) => ({
  send: async () => {
    throw new EngineDataError(`Direct ${service} access is disabled when engine data is enabled`, {
      code: 'ENGINE_DATA_DIRECT_ACCESS',
    });
  },
});

// Handed to engine code in place of the direct Neptune opener when engine data
// is enabled, so a path that still opens its own connection fails loudly
// instead of quietly using the runtime role.
export const directGraphTripwire = () => async () => {
  throw new EngineDataError('Direct graph access is disabled when engine data is enabled', {
    code: 'ENGINE_DATA_GRAPH_DIRECT',
  });
};

// A deployment that routes the store to engine-data but still runs the
// built-in MCP locally would keep the MCP's own direct table access, so it is
// refused rather than half-applied.
export const misconfiguredProcessStore = (reason) => {
  const fail = async () => {
    throw new EngineDataError(reason, { code: 'ENGINE_DATA_MISCONFIGURED' });
  };
  return Object.fromEntries(ENGINE_DATA_STORE_METHODS.map((method) => [method, fail]));
};
