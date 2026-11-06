import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  buildExecutionMeta,
  buildHumanTaskRow,
  buildStageRow,
  outputKey,
} from '../../shared/v2-process-keys.js';
import {
  RECORD_TYPES,
  changeToRow,
  deserialize,
  isoUtc,
  lakeRow,
  partitionKeys,
  recordTypeOf,
  toMicroseconds,
} from '../lib/rows.js';

const TS_US = 1_793_361_600_123_456; // 2026-10-30T12:00:00.123456Z

const meta = () =>
  buildExecutionMeta({
    executionId: 'e1',
    projectId: 'p1',
    intentId: 'i1',
    workflowId: 'w1',
    workflowVersion: 3,
    startedAt: '2026-10-30T10:00:00.000Z',
    prompt: 'paste from a ticket',
    starterName: 'Ada',
    starterEmail: 'ada@example.com',
    credentialBinding: { scope: 'project' },
    customMcpServers: { jira: { env: { TOKEN: 'inline' } } },
  });

const kinesisChange = (eventName, image, { old = null, keys = null } = {}) => ({
  eventID: 'change-1',
  eventName,
  dynamodb: {
    ApproximateCreationDateTime: TS_US,
    ...(keys ? { Keys: marshall(keys) } : {}),
    ...(image ? { NewImage: marshall(image, { removeUndefinedValues: true }) } : {}),
    ...(old ? { OldImage: marshall(old, { removeUndefinedValues: true }) } : {}),
  },
});

describe('deserialize', () => {
  it('turns DynamoDB JSON into plain JSON, with sets as sorted arrays', () => {
    expect(
      deserialize({
        M: {
          s: { S: 'x' },
          n: { N: '1.5' },
          i: { N: '42' },
          b: { BOOL: true },
          z: { NULL: true },
          l: { L: [{ S: 'a' }, { N: '2' }] },
          ss: { SS: ['b', 'a'] },
          ns: { NS: ['10', '2'] },
        },
      }),
    ).toEqual({
      s: 'x',
      n: 1.5,
      i: 42,
      b: true,
      z: null,
      l: ['a', 2],
      ss: ['a', 'b'],
      ns: [2, 10],
    });
  });

  it('rejects an unknown attribute type', () => {
    expect(() => deserialize({ Q: 'x' })).toThrow(/unknown DynamoDB attribute type Q/);
  });
});

describe('record types', () => {
  it('maps every sort-key prefix and sends unknown ones to other', () => {
    expect(recordTypeOf('META')).toBe('meta');
    expect(recordTypeOf('STAGE#s1')).toBe('stage');
    expect(recordTypeOf('UNITPR#u1#repo')).toBe('unitpr');
    expect(recordTypeOf('SOMETHINGNEW#1')).toBe('other');
    expect(recordTypeOf(outputKey('e1', 's1', 1).sk)).toBeNull();
  });

  it('matches the Glue partition projection in Terraform', () => {
    const tf = readFileSync(
      new URL('../../../terraform/modules/reporting/main.tf', import.meta.url),
      'utf8',
    );
    expect(tf).toContain('lambda/reporting/record-types.json');
    expect(Object.values(RECORD_TYPES)).not.toContain('other');
  });
});

describe('timestamps', () => {
  it('accepts milliseconds or microseconds', () => {
    expect(toMicroseconds(1_793_361_600_123)).toBe(1_793_361_600_123_000);
    expect(toMicroseconds(TS_US)).toBe(TS_US);
  });

  it('formats microseconds as ISO 8601 UTC', () => {
    expect(isoUtc(TS_US)).toBe('2026-10-30T12:00:00.123456Z');
    expect(isoUtc(1_793_361_600_000_007)).toBe('2026-10-30T12:00:00.000007Z');
  });
});

describe('lakeRow', () => {
  it('keeps the envelope and drops GSI keys, the prompt, email and credential fields', () => {
    const { recordType, row } = lakeRow('ev1', 'INSERT', TS_US, meta());
    expect(recordType).toBe('meta');
    expect(row).toMatchObject({
      event_id: 'ev1',
      event_name: 'INSERT',
      event_time: '2026-10-30T12:00:00.123456Z',
      event_ts_us: TS_US,
      pk: 'EXEC#e1',
      sk: 'META',
      execution_id: 'e1',
      entity_type: 'Execution',
    });
    const item = JSON.parse(row.item);
    expect(item).toMatchObject({ projectId: 'p1', starterName: 'Ada', workflowVersion: 3 });
    for (const dropped of [
      'GSI1PK',
      'GSI2SK',
      'GSI3PK',
      'prompt',
      'starterEmail',
      'credentialBinding',
      'mcpServersByTier',
      'customMcpServers',
    ]) {
      expect(item).not.toHaveProperty(dropped);
    }
    expect(row.item).not.toContain('inline');
  });

  it('serialises item keys in a stable order', () => {
    const a = lakeRow('ev', 'INSERT', TS_US, {
      pk: 'EXEC#e1',
      sk: 'STEER#1',
      b: 1,
      a: { d: 1, c: 2 },
    });
    expect(a.row.item).toBe('{"a":{"c":2,"d":1},"b":1,"pk":"EXEC#e1","sk":"STEER#1"}');
  });

  it('only redacts META fields on the execution header', () => {
    const task = buildHumanTaskRow({
      executionId: 'e1',
      humanTaskId: 'h1',
      kind: 'question',
      prompt: 'Which database?',
      createdAt: '2026-10-30T10:00:00.000Z',
    });
    const { recordType, row } = lakeRow('ev', 'INSERT', TS_US, task);
    expect(recordType).toBe('human');
    expect(JSON.parse(row.item).prompt).toBe('Which database?');
  });

  it('skips transcripts, agent-auth bookkeeping and rows outside execution partitions', () => {
    expect(lakeRow('ev', 'INSERT', TS_US, { ...outputKey('e1', 's1', 1), text: 'x' })).toBeNull();
    expect(
      lakeRow('ev', 'INSERT', TS_US, { pk: 'EXEC#e1', sk: 'X', type: 'AgentInvocation' }),
    ).toBeNull();
    expect(lakeRow('ev', 'INSERT', TS_US, { pk: 'EXEC#e1', sk: 'X', agentAuthTtl: 1 })).toBeNull();
    expect(lakeRow('ev', 'INSERT', TS_US, { pk: 'PROJECT#p1', sk: 'META' })).toBeNull();
    expect(lakeRow('ev', 'INSERT', TS_US, { sk: 'META' })).toBeNull();
  });

  it('falls back to the partition key for the execution id', () => {
    const { row } = lakeRow('ev', 'INSERT', TS_US, { pk: 'EXEC#e9', sk: 'CHECKPOINT' });
    expect(row.execution_id).toBe('e9');
    expect(row.entity_type).toBeNull();
  });
});

describe('changeToRow', () => {
  it('uses the new image for inserts and modifies', () => {
    const stage = buildStageRow({
      executionId: 'e1',
      stageInstanceId: 'si1',
      stageId: 'requirements',
      phase: 'inception',
      state: 'RUNNING',
      startedAt: '2026-10-30T10:00:00.000Z',
    });
    const { recordType, row } = changeToRow(kinesisChange('MODIFY', stage));
    expect(recordType).toBe('stage');
    expect(JSON.parse(row.item)).toMatchObject({ stageInstanceId: 'si1', state: 'RUNNING' });
    expect(partitionKeys(recordType, row)).toEqual({ record_type: 'stage', dt: '2026-10-30' });
  });

  it('uses the old image for removes, or the keys when there is none', () => {
    const removed = changeToRow(
      kinesisChange('REMOVE', null, { old: { pk: 'EXEC#e1', sk: 'STEER#1', kind: 'rewind' } }),
    );
    expect(removed.row.event_name).toBe('REMOVE');
    expect(JSON.parse(removed.row.item).kind).toBe('rewind');

    const keysOnly = changeToRow(
      kinesisChange('REMOVE', null, { keys: { pk: 'EXEC#e1', sk: 'STEER#2' } }),
    );
    expect(keysOnly.row.sk).toBe('STEER#2');
  });
});
