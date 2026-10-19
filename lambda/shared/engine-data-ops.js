// The wire contract between the AgentCore runtime and the engine-data Lambda.
//
// The runtime keeps the engine and moves only its process-store calls behind
// engine-data, one call per store method. Both sides read the allowlist from
// here so the client can never expose a method the Lambda would refuse, and a
// method added to the store stays unreachable until it is added below with its
// argument schema.
export const ENGINE_DATA_OP_PREFIX = 'store.';

export const ENGINE_DATA_STORE_METHODS = Object.freeze([
  'appendEvent',
  'getStage',
  'getExecution',
  'updateStageState',
  'getHumanTask',
  'updateExecution',
  'recordMetric',
  'recordSensorRun',
  'putStage',
  'putReceipt',
  'listReceipts',
  'getUnitPlan',
  'updateCompose',
  'syncUnitRows',
  'supersedeHumanTask',
  'resumeStageRow',
  'putWorkflowCheckpoint',
  'putUnitPlan',
  'markSteeringConsumed',
  'markLoopBackArchived',
  'listSensorRuns',
  'listPendingSteering',
  'listEvents',
  'getExecutionRecords',
  'createHumanTask',
  'createExecution',
  'claimStageAttempt',
  'appendOutput',
  'raiseStageCounter',
  'getQuorumEdit',
  'updateQuorumEdit',
  'recordGraphRead',
  'setLoopBackRecommendation',
  'getReceipt',
]);

export const ENGINE_DATA_DENIED_ERROR = 'EngineDataAccessDenied';

export const engineDataOp = (method) => `${ENGINE_DATA_OP_PREFIX}${method}`;

// The engine's Neptune access, one semantic operation per call. Each request is
// `{ op: 'graph.<name>', args: [selector, input], grant }`: the selector names
// the scope the runtime believes it acts in (checked against the grant, never
// trusted), the input is that operation's own strict shape. No Gremlin,
// bytecode, callbacks or vertex ids cross the wire.
export const ENGINE_DATA_GRAPH_PREFIX = 'graph.';

// Writer-shaped operations: the graph-writer methods the engine calls, with
// the narrower inputs engine-data accepts (see engine-data/graph-schemas.js).
export const ENGINE_DATA_GRAPH_WRITER_OPS = Object.freeze([
  'getIntentGraph',
  'lookupArtifacts',
  'getArtifactToc',
  'getItems',
  'getCoverage',
  'getTeamKnowledge',
  'getLearningRules',
  'updateArtifact',
  'recordPullRequest',
  'recordUnitPullRequest',
  'recordLearningRule',
  'linkSteeringInfluences',
  'mirrorUnitDag',
  'ingestCodeFiles',
  'mirrorArtifactDerivations',
  'resolveDerivedItemEdges',
  'applyArtifactEnrichment',
  'supersedeDerivationsForArtifacts',
  'recordContributionGap',
]);

// Named operations for the raw graph helpers the engine runs outside the writer.
export const ENGINE_DATA_GRAPH_NAMED_OPS = Object.freeze([
  'ensureIntent',
  'inspect',
  'readProjectCliConfig',
  'readDiscussionContext',
  'completeDiscussionAssist',
  'getArtifactForEdit',
  'fetchDownstreamClosure',
  'applyArtifactEdit',
  'verifyArtifact',
  'markArtifactsStale',
  'archiveArtifactsForStages',
  'snapshotCurrentArtifactHeads',
  'readCurrentArtifactHeadHashes',
]);

export const ENGINE_DATA_GRAPH_OPS = Object.freeze([
  ...ENGINE_DATA_GRAPH_WRITER_OPS,
  ...ENGINE_DATA_GRAPH_NAMED_OPS,
]);

// The only graph operations a discussion grant may call.
export const ENGINE_DATA_GRAPH_DISCUSSION_OPS = Object.freeze([
  'readProjectCliConfig',
  'readDiscussionContext',
  'completeDiscussionAssist',
]);

export const engineDataGraphOp = (name) => `${ENGINE_DATA_GRAPH_PREFIX}${name}`;

// The methodology catalog the engine reads: global, read-only SYSTEM/default
// blocks and official release closures. Each request is
// `{ op: 'catalog.<name>', args: [input], grant }`; no S3 key, bucket, table or
// tenant outside the catalog grammar crosses the wire.
export const ENGINE_DATA_CATALOG_PREFIX = 'catalog.';

export const ENGINE_DATA_CATALOG_OPS = Object.freeze([
  'loadLibrary',
  'listMergedBlocks',
  'listReleaseBlocks',
  'loadBlockBody',
  'loadBlockScript',
  'loadConductor',
  'loadScriptClosure',
]);

export const engineDataCatalogOp = (name) => `${ENGINE_DATA_CATALOG_PREFIX}${name}`;

// Execution-owned objects: the project's custom rules and the intent's
// committed attachments. Each request is `{ op: 'blob.<name>', args: [input],
// grant }`; the object descriptors come from the execution META engine-data
// reads itself, so no key, bucket or object version crosses the wire.
export const ENGINE_DATA_BLOB_PREFIX = 'blob.';

export const ENGINE_DATA_BLOB_OPS = Object.freeze([
  'readCustomRules',
  'pinCustomRuleVersions',
  'readAttachmentChunk',
]);

export const engineDataBlobOp = (name) => `${ENGINE_DATA_BLOB_PREFIX}${name}`;

// Attachment bytes cross the wire in chunks of this size: a 5 MiB attachment
// does not fit one synchronous Invoke response once base64-encoded.
export const ENGINE_DATA_ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

// Live events on the granted intent's realtime channel. Each request is
// `{ op: 'realtime.broadcastIntent', args: [{ payload }], grant }`; the channel,
// connection table and websocket endpoint are engine-data's own.
export const ENGINE_DATA_REALTIME_PREFIX = 'realtime.';

export const ENGINE_DATA_REALTIME_OPS = Object.freeze(['broadcastIntent']);

export const engineDataRealtimeOp = (name) => `${ENGINE_DATA_REALTIME_PREFIX}${name}`;
