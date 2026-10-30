// Firehose record transformation for the reporting lake.
//
// Each input record is one DynamoDB change from the v2-executions table,
// delivered through Kinesis Data Streams for DynamoDB. It becomes one JSON
// line in the lake, partitioned by record type and day (dynamic partitioning
// reads the partition keys from the record metadata).
import { Logger } from '@aws-lambda-powertools/logger';
import { changeToRow, partitionKeys, toJsonLine } from './lib/rows.js';

const logger = new Logger();

export const transformRecord = (record) => {
  let result;
  try {
    const change = JSON.parse(Buffer.from(record.data, 'base64').toString('utf8'));
    result = changeToRow(change);
  } catch (error) {
    // One bad record mustn't fail the batch: Firehose writes it to the error
    // prefix instead.
    logger.error('Could not transform change', { recordId: record.recordId, error });
    return { recordId: record.recordId, result: 'ProcessingFailed', data: record.data };
  }
  if (result === null) {
    return { recordId: record.recordId, result: 'Dropped', data: record.data };
  }
  const { recordType, row } = result;
  return {
    recordId: record.recordId,
    result: 'Ok',
    data: Buffer.from(toJsonLine(row)).toString('base64'),
    metadata: { partitionKeys: partitionKeys(recordType, row) },
  };
};

export const handler = async (event) => ({ records: event.records.map(transformRecord) });
