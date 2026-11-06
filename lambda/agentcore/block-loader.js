// Block loader — the runtime's methodology catalog: the pinned workflow, the
// library blocks it references, their bodies/scripts and the conductor persona
// (implementation: shared/engine-catalog.js).
//
// Flag off, the catalog runs here over the runtime's own DynamoDB/S3 clients.
// With engine data enabled every catalog read is an engine-data catalog.* call
// under the invocation's grant, and the runtime clients the local catalog would
// use are tripwires, so a read that bypasses the catalog operations fails instead
// of using the runtime role. Commands import these functions directly, so the
// selection happens here at call time rather than only in http-server's wiring.

import { ddb, s3 } from './clients.js';
import {
  assembleWorkflow,
  assertSystemSourceRef,
  createEngineCatalog,
  keyById,
  streamToString,
} from '../shared/engine-catalog.js';
import {
  createRemoteCatalog,
  directClientTripwire,
  misconfiguredCatalog,
} from './engine-data-client.js';
import { currentGatewayGrant } from './mcp/gateway-context.js';

const directCatalog = (env) =>
  createEngineCatalog({
    s3: env.ENGINE_DATA_FUNCTION ? directClientTripwire('S3') : s3,
    ddb: env.ENGINE_DATA_FUNCTION ? directClientTripwire('DynamoDB') : ddb,
    bucket: env.ARTIFACTS_BUCKET,
    blocksTable: env.BLOCKS_TABLE,
  });

// Same choice as http-server's processStoreFor: engine data without the MCP
// Gateway fails closed rather than reading with the runtime role.
export const catalogAccessFor = ({
  env = process.env,
  createLocal = directCatalog,
  createRemote = createRemoteCatalog,
  misconfigured = misconfiguredCatalog,
} = {}) => {
  if (!env.ENGINE_DATA_FUNCTION) return createLocal(env);
  if (!env.AIDLC_MCP_GATEWAY_URL) return misconfigured('Engine data requires the MCP Gateway');
  return createRemote({ grant: currentGatewayGrant });
};

const catalog = () => catalogAccessFor({ env: process.env });

export const loadLibrary = (input) => catalog().loadLibrary(input);
export const listMergedBlocks = (type) => catalog().listMergedBlocks(type);
export const listReleaseBlocks = (type, methodologyRelease, methodologyPins = null) =>
  catalog().listReleaseBlocks(type, methodologyRelease, methodologyPins);
export const loadBlockBody = (block, options) => catalog().loadBlockBody(block, options);
export const loadBlockScript = (block, options) => catalog().loadBlockScript(block, options);
export const loadConductor = (ref, options) => catalog().loadConductor(ref, options);
export const loadScriptClosure = (input) => catalog().loadScriptClosure(input);

// No runtime caller and no engine-data operation: with engine data enabled it
// reaches the tripwire clients.
export const loadRuntimeManifest = (ref) => directCatalog(process.env).loadRuntimeManifest(ref);

export const __test = {
  assembleWorkflow,
  keyById,
  streamToString,
  loadPlacedStages: (...args) => directCatalog(process.env).__test.loadPlacedStages(...args),
  loadPinnedBlocks: (...args) => directCatalog(process.env).__test.loadPinnedBlocks(...args),
  assertSystemSourceRef,
};
