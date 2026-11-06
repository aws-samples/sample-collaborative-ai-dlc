import { describe, expect, it } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import { handler } from '../transform.js';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (data) => Buffer.from(data, 'base64').toString('utf8');

const change = (item) => ({
  eventID: 'change-1',
  eventName: 'INSERT',
  dynamodb: { ApproximateCreationDateTime: 1_793_361_600_123_456, NewImage: marshall(item) },
});

describe('transform handler', () => {
  it('returns one JSON line per change with partition keys for dynamic partitioning', async () => {
    const { records } = await handler({
      records: [
        {
          recordId: 'r1',
          data: encode(change({ pk: 'EXEC#e1', sk: 'STAGE#s1', state: 'RUNNING' })),
        },
      ],
    });
    expect(records).toHaveLength(1);
    const [out] = records;
    expect(out).toMatchObject({
      recordId: 'r1',
      result: 'Ok',
      metadata: { partitionKeys: { record_type: 'stage', dt: '2026-10-30' } },
    });
    const line = decode(out.data);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ sk: 'STAGE#s1', execution_id: 'e1' });
  });

  it('drops unreported rows and fails only the bad record in a batch', async () => {
    const { records } = await handler({
      records: [
        { recordId: 'out', data: encode(change({ pk: 'EXEC#e1', sk: 'OUTPUT#1', text: 'x' })) },
        { recordId: 'bad', data: Buffer.from('not json').toString('base64') },
        { recordId: 'ok', data: encode(change({ pk: 'EXEC#e1', sk: 'META', type: 'Execution' })) },
      ],
    });
    expect(records.map((r) => [r.recordId, r.result])).toEqual([
      ['out', 'Dropped'],
      ['bad', 'ProcessingFailed'],
      ['ok', 'Ok'],
    ]);
    // Firehose requires the original data back for dropped and failed records.
    expect(records[1].data).toBe(Buffer.from('not json').toString('base64'));
  });
});
