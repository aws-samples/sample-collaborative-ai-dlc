// engine-data: the server side of the runtime's methodology catalog.
//
// Each catalog call arrives as `{ op: 'catalog.<name>', args: [input], grant }`
// and is authorized on its own:
//   1. the grant is verified and must be an engine grant (execution, stage or
//      conflict). The catalog is global read-only content, so there is no META
//      or pin-equality check: a draft compose reads it before any execution
//      exists, and release integrity stays with the loader's own checks;
//   2. the op must be on the shared allowlist and its input must match the
//      strict schema (tenants SYSTEM|default, catalog key grammar);
//   3. the shared loader then runs over confined clients: every S3 read must be
//      a plain GetObject of a catalog key in the configured bucket, every
//      DynamoDB read a Get/Query of a SYSTEM or default block/workflow row in
//      the blocks table, or a Get of the release record a fork pin's promotion
//      check reads. That covers keys recovered from manifests, catalogs
//      and stored block rows, not only the request.
// A confinement violation anywhere inside the loader is a denial, even when the
// loader wrapped it in a release error.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ENGINE_DATA_CATALOG_OPS, ENGINE_DATA_CATALOG_PREFIX } from '../shared/engine-data-ops.js';
import { createEngineCatalog } from '../shared/engine-catalog.js';
import {
  CATALOG_BLOCK_TYPES,
  CATALOG_OPS,
  CATALOG_TENANTS,
  isCatalogKey,
} from './catalog-schemas.js';
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

const ALLOWED_OPS = new Set(ENGINE_DATA_CATALOG_OPS);
const TENANTS = CATALOG_TENANTS.join('|');
const TYPES = CATALOG_BLOCK_TYPES.join('|');
const BLOCK_PK = new RegExp(`^BLOCK#(?:${TENANTS})#(?:${TYPES})#[^#]`);
const BLOCK_SK = /^V#(?:latest|[1-9][0-9]*)$/;
// The release record a fork pin's promotion check reads (release-registry
// getRelease). Channel pointers and every other registry row stay out.
const RELEASE_RECORD_PK = /^AIDLC_RELEASE#[^#]/;
const RELEASE_RECORD_SK = 'META';
const CATALOG_GSI1_PK = new RegExp(`^TENANT#(?:${TENANTS})#(?:${TYPES})$`);
const WORKFLOW_PK = new RegExp(`^WF#(?:${TENANTS})#[^#]`);
const WORKFLOW_VERSION_PREFIX = /^V#[1-9][0-9]*#$/;
// The two key conditions the loader issues (block-loader and release-resolver
// name the version placeholder differently).
const WORKFLOW_CONDITIONS = new Map([
  ['pk = :pk AND begins_with(sk, :vp)', ':vp'],
  ['pk = :pk AND begins_with(sk, :v)', ':v'],
]);
const DENIAL_CAUSE_DEPTH = 5;

const definedKeys = (input) => Object.keys(input).filter((key) => input[key] !== undefined);
const onlyKeys = (input, allowed) => definedKeys(input).every((key) => allowed.includes(key));

const confinedS3 = (s3, bucket) => ({
  send: async (command, ...rest) => {
    if (!(command instanceof GetObjectCommand)) deny('catalog_read_not_allowed');
    const { input } = command;
    if (
      !onlyKeys(input, ['Bucket', 'Key']) ||
      input.Bucket !== bucket ||
      !isCatalogKey(input.Key)
    ) {
      deny('catalog_key_not_allowed');
    }
    return s3.send(command, ...rest);
  },
});

const allowedQuery = (input) => {
  const values = input.ExpressionAttributeValues ?? {};
  if (input.IndexName === 'GSI1') {
    return (
      input.KeyConditionExpression === 'GSI1PK = :pk' &&
      onlyKeys(values, [':pk']) &&
      CATALOG_GSI1_PK.test(String(values[':pk']))
    );
  }
  const versionKey = WORKFLOW_CONDITIONS.get(input.KeyConditionExpression);
  return (
    input.IndexName === undefined &&
    Boolean(versionKey) &&
    onlyKeys(values, [':pk', versionKey]) &&
    WORKFLOW_PK.test(String(values[':pk'])) &&
    WORKFLOW_VERSION_PREFIX.test(String(values[versionKey]))
  );
};

const allowedRow = ({ pk, sk }) =>
  (BLOCK_PK.test(String(pk)) && BLOCK_SK.test(String(sk))) ||
  (RELEASE_RECORD_PK.test(String(pk)) && sk === RELEASE_RECORD_SK);

const confinedDdb = (ddb, tableName) => ({
  send: async (command, ...rest) => {
    const { input } = command;
    if (command instanceof GetCommand) {
      const key = input.Key ?? {};
      if (
        !onlyKeys(input, ['TableName', 'Key']) ||
        input.TableName !== tableName ||
        !onlyKeys(key, ['pk', 'sk']) ||
        !allowedRow(key)
      ) {
        deny('catalog_row_not_allowed');
      }
    } else if (command instanceof QueryCommand) {
      if (
        !onlyKeys(input, [
          'TableName',
          'IndexName',
          'KeyConditionExpression',
          'ExpressionAttributeValues',
          'ExclusiveStartKey',
        ]) ||
        input.TableName !== tableName ||
        !allowedQuery(input)
      ) {
        deny('catalog_row_not_allowed');
      }
    } else {
      deny('catalog_read_not_allowed');
    }
    return ddb.send(command, ...rest);
  },
});

const denialIn = (error) => {
  let current = error;
  for (let depth = 0; current && depth <= DENIAL_CAUSE_DEPTH; depth += 1) {
    if (current instanceof EngineDataAccessDenied) return current;
    current = current.cause;
  }
  return null;
};

const blockFor = ({ tenantId, ref }, refField) => ({
  ...(tenantId ? { tenantId } : {}),
  [refField]: ref ?? null,
});

const RUN = Object.freeze({
  loadLibrary: (catalog, input) => catalog.loadLibrary(input),
  listMergedBlocks: (catalog, { type }) => catalog.listMergedBlocks(type),
  listReleaseBlocks: (catalog, { type, methodologyRelease, methodologyPins }) =>
    catalog.listReleaseBlocks(type, methodologyRelease, methodologyPins ?? null),
  loadBlockBody: (catalog, input) =>
    catalog.loadBlockBody(blockFor(input, 'bodyRef'), {
      methodologyRelease: input.methodologyRelease ?? null,
    }),
  loadBlockScript: (catalog, input) =>
    catalog.loadBlockScript(blockFor(input, 'scriptRef'), {
      methodologyRelease: input.methodologyRelease ?? null,
    }),
  loadConductor: (catalog, { ref, methodologyRelease }) =>
    catalog.loadConductor(ref ?? null, { methodologyRelease: methodologyRelease ?? null }),
  loadScriptClosure: (catalog, input) => catalog.loadScriptClosure(input),
});

export const createCatalogGateway = ({
  verifyGrant,
  s3,
  ddb,
  bucket,
  blocksTable,
  audit = () => {},
  createCatalog = createEngineCatalog,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) => {
  const catalog =
    bucket && blocksTable
      ? createCatalog({
          s3: confinedS3(s3, bucket),
          ddb: confinedDdb(ddb, blocksTable),
          bucket,
          blocksTable,
        })
      : null;

  const authorize = async (event, record) => {
    const grant = await verifyGrantOrDeny(verifyGrant, event?.grant);
    Object.assign(record, grantAudit(grant));
    if (!ENGINE_GRANT_MODES.has(grant.mode)) deny('grant_mode_not_allowed');

    const op = typeof event.op === 'string' ? event.op : '';
    const name = op.startsWith(ENGINE_DATA_CATALOG_PREFIX)
      ? op.slice(ENGINE_DATA_CATALOG_PREFIX.length)
      : null;
    if (!name || !ALLOWED_OPS.has(name) || !Object.hasOwn(CATALOG_OPS, name)) {
      deny('op_not_allowed');
    }
    const { args } = event;
    if (!Array.isArray(args) || args.length !== 1 || hasPrototypeKey(args)) {
      deny('invalid_arguments');
    }
    const result = CATALOG_OPS[name].safeParse(args[0]);
    if (!result.success) deny('invalid_arguments', { issues: issuePaths(0, result.error) });
    return { name, input: result.data };
  };

  const denied = (record, startedAt, error) => {
    audit({
      ...record,
      ...error.detail,
      decision: 'deny',
      reason: error.reason,
      ms: Date.now() - startedAt,
    });
    return denialResponse(error);
  };

  const failed = (record, startedAt, outcome, error) => {
    audit({
      ...record,
      decision: outcome.decision,
      outcome: outcome.name,
      error: error?.name ?? 'Error',
      ms: Date.now() - startedAt,
    });
    return { error: serializeError(error) };
  };

  return async (event) => {
    const startedAt = Date.now();
    const record = { op: typeof event?.op === 'string' ? event.op : null };
    let authorized;
    try {
      authorized = await authorize(event, record);
    } catch (error) {
      if (error instanceof EngineDataAccessDenied) return denied(record, startedAt, error);
      return failed(record, startedAt, { decision: 'error', name: 'error' }, error);
    }
    if (!catalog) {
      audit({ ...record, decision: 'error', outcome: 'misconfigured', ms: Date.now() - startedAt });
      return {
        error: {
          name: 'EngineCatalogError',
          code: 'catalog_misconfigured',
          message: 'Engine data has no catalog bucket or blocks table',
          conflict: false,
        },
      };
    }

    let result;
    try {
      result = await RUN[authorized.name](catalog, authorized.input);
    } catch (error) {
      const denial = denialIn(error);
      if (denial) return denied(record, startedAt, denial);
      return failed(record, startedAt, { decision: 'allow', name: 'catalog_error' }, error);
    }
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
          name: 'EngineCatalogError',
          code: 'response_too_large',
          message: 'Catalog result is too large to return',
          conflict: false,
        },
      };
    }
    audit({ ...record, decision: 'allow', outcome: 'ok', ms: Date.now() - startedAt });
    return { ok: true, result };
  };
};
