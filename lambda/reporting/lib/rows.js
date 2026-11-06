// v2-executions change -> reporting lake row.
//
// Every lake row has the same envelope, so one Athena table reads them all:
//
//   event_id, event_name (INSERT | MODIFY | REMOVE | SNAPSHOT), event_time
//   (ISO 8601 UTC), event_ts_us, pk, sk, execution_id, entity_type, item (the
//   row as a JSON string; the old image for REMOVE)
//
// Left out: rows outside EXEC# partitions, agent-auth bookkeeping, OUTPUT#
// transcript chunks (large, and may contain anything an agent printed), the
// GSI key attributes, and the META fields in REDACTED_FIELDS.
import RECORD_TYPES from '../record-types.json' with { type: 'json' };

// Sort-key prefixes of v2-executions (lambda/shared/v2-process-keys.js),
// lower-cased into the record_type partition. Terraform reads the same file
// for the Glue partition projection; anything else lands in "other".
export { RECORD_TYPES };
export const OTHER_RECORD_TYPE = 'other';

const DROPPED_RECORD_TYPES = new Set(['OUTPUT']);
const DROPPED_ENTITY_TYPES = new Set(['AgentInvocation', 'AgentAuthInventoryReference']);
const DROPPED_ATTRIBUTES = new Set(['GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'GSI3PK', 'GSI3SK']);
// The intent prompt can hold anything pasted or imported from a ticket, the
// starter's email is personal data, and the rest are credential and MCP
// references (the legacy customMcpServers map can hold secrets inline). None
// is needed to report progress or decisions.
const REDACTED_FIELDS = {
  meta: new Set([
    'prompt',
    'starterEmail',
    'credentialBinding',
    'mcpServersByTier',
    'customMcpServers',
  ]),
};
const NO_REDACTIONS = new Set();

const EXEC_PREFIX = 'EXEC#';

const toNumber = (text) => Number(text);
const sorted = (values) => values.toSorted();

// One DynamoDB attribute value ({ S: 'x' }, { M: {...} }, ...) as plain JSON.
// Sets become sorted arrays so the same row always serialises the same way.
// (@aws-sdk/util-dynamodb's unmarshall returns Set objects, which
// JSON.stringify turns into {}.)
export const deserialize = (value) => {
  const [[kind, inner]] = Object.entries(value);
  switch (kind) {
    case 'S':
      return inner;
    case 'N':
      return toNumber(inner);
    case 'BOOL':
      return Boolean(inner);
    case 'NULL':
      return null;
    case 'M':
      return deserializeImage(inner);
    case 'L':
      return inner.map(deserialize);
    case 'SS':
      return sorted(inner);
    case 'NS':
      return inner.map(toNumber).toSorted((a, b) => a - b);
    // The process table stores no binary attributes; keep any opaque.
    case 'B':
      return typeof inner === 'string' ? inner : Buffer.from(inner).toString('base64');
    case 'BS':
      return sorted(
        inner.map((b) => (typeof b === 'string' ? b : Buffer.from(b).toString('base64'))),
      );
    default:
      throw new Error(`unknown DynamoDB attribute type ${kind}`);
  }
};

export const deserializeImage = (image) =>
  Object.fromEntries(Object.entries(image ?? {}).map(([k, v]) => [k, deserialize(v)]));

export const recordTypeOf = (sk) => {
  const prefix = sk.split('#', 1)[0];
  if (DROPPED_RECORD_TYPES.has(prefix)) return null;
  return RECORD_TYPES[prefix] ?? OTHER_RECORD_TYPE;
};

// Kinesis Data Streams for DynamoDB stamps milliseconds, or microseconds when
// the destination's precision is MICROSECOND. Epoch milliseconds stay below
// 1e14 until the year 5138, so the magnitude tells them apart.
export const toMicroseconds = (approximateCreation) => {
  const value = Math.trunc(Number(approximateCreation));
  return value >= 1e14 ? value : value * 1000;
};

// ISO 8601 UTC with microseconds, e.g. 2026-10-30T12:00:00.123456Z.
export const isoUtc = (tsUs) => {
  const ms = Math.floor(tsUs / 1000);
  const micros = String(tsUs % 1000).padStart(3, '0');
  return new Date(ms).toISOString().replace('Z', `${micros}Z`);
};

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
};

// The lake row for one item state, or null when the item isn't reported.
export const lakeRow = (eventId, eventName, tsUs, item) => {
  const { pk, sk } = item;
  if (typeof pk !== 'string' || !pk.startsWith(EXEC_PREFIX) || typeof sk !== 'string') return null;
  if (DROPPED_ENTITY_TYPES.has(item.type) || 'agentAuthTtl' in item) return null;
  const recordType = recordTypeOf(sk);
  if (recordType === null) return null;
  const redacted = REDACTED_FIELDS[recordType] ?? NO_REDACTIONS;
  const kept = Object.fromEntries(
    Object.entries(item).filter(([k]) => !DROPPED_ATTRIBUTES.has(k) && !redacted.has(k)),
  );
  return {
    recordType,
    row: {
      event_id: eventId,
      event_name: eventName,
      event_time: isoUtc(tsUs),
      event_ts_us: tsUs,
      pk,
      sk,
      execution_id: kept.executionId || pk.slice(EXEC_PREFIX.length),
      entity_type: kept.type ?? null,
      item: JSON.stringify(sortKeys(kept)),
    },
  };
};

// One Kinesis-for-DynamoDB change record -> { recordType, row } or null.
export const changeToRow = (change) => {
  const ddb = change.dynamodb;
  const { eventName } = change;
  let item = deserializeImage(eventName === 'REMOVE' ? ddb.OldImage : ddb.NewImage);
  // A REMOVE without an old image still carries the keys.
  if (Object.keys(item).length === 0) item = deserializeImage(ddb.Keys);
  return lakeRow(change.eventID, eventName, toMicroseconds(ddb.ApproximateCreationDateTime), item);
};

export const partitionKeys = (recordType, row) => ({
  record_type: recordType,
  dt: row.event_time.slice(0, 10),
});

export const toJsonLine = (row) => `${JSON.stringify(row)}\n`;
