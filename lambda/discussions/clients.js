// lambda/discussions — shared clients and connection seams.
//
// One Neptune client (query/close) and the AWS SDK clients are constructed once
// and shared across every module, so the whole lambda reuses a single warm
// connection. `close` is re-exported by index.js for test teardown only.

import gremlin from 'gremlin';
import { create } from 'neptune-lambda-client';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';

export const { cardinality, order, TextP } = gremlin.process;
export const __ = gremlin.process.statics;

// Tests point GREMLIN_PROTOCOL at a plain ws:// gremlin-server (no IAM); Neptune
// in production is wss:// + SigV4. Tying useIam to the protocol keeps the test
// seam to a single env var that globalSetup already sets.
const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

export const { query, close } = create(
  process.env.NEPTUNE_ENDPOINT,
  process.env.GREMLIN_PORT ?? '8182',
  {
    useIam: protocol === 'wss',
    protocol,
    partition: process.env.GREMLIN_PARTITION
      ? {
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }
      : undefined,
  },
);

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const ssm = new SSMClient();
export const agentcore = new BedrockAgentCoreClient({});

export const locksTable = () => process.env.LOCKS_TABLE;
export const readStateTable = () => process.env.READ_STATE_TABLE;
