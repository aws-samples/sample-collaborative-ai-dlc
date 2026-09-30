// Intent release-pin lookup.
//
// The workflows Lambda serves the compiled/preview views for an existing
// intent, which means it has to know which AI-DLC release that intent is
// pinned to. It cannot answer that itself: it is deliberately outside the VPC,
// so it cannot query Neptune to check that the caller is a member of the
// intent's project.
//
// This function is that one read, and nothing else. It takes an already
// authenticated subject, verifies project membership in Neptune, verifies the
// intent belongs to that project, and returns a minimal projection of the
// intent's methodology coordinates. It has no HTTP route, no write path, and a
// role with read-only access to the process table and Neptune.
//
// TRUST BOUNDARY: `sub` is supplied by the caller. The workflows Lambda takes
// it from the API Gateway authorizer claims of the request it is serving, so it
// is a Cognito-verified subject, not user input. The IAM grant to invoke this
// function is attached only to the workflows role for exactly that reason —
// anything able to invoke it can ask about any user's intents.

import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { fetchMembershipRole } from '../shared/trackers.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const store = createProcessStore({ ddb });

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  if (protocol === 'ws') {
    return new DriverRemoteConnection(`ws://${host}:${port}/gremlin`);
  }
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

// One shape only. An event carrying HTTP fields would mean something tried to
// reach this function through API Gateway, which it is not wired to.
const invalidRequest = (event) =>
  event?.httpMethod != null ||
  event?.requestContext != null ||
  ![event?.sub, event?.projectId, event?.intentId].every(isNonEmptyString);

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  logger.resetKeys();
  if (invalidRequest(event)) return { statusCode: 400 };

  const { sub, projectId, intentId } = event;
  logger.appendKeys({ projectId, intentId, userId: sub });

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }
    // Opaque 404 for both "not a member" and "intent is not in this project":
    // the caller must not learn whether an intent id exists.
    if (!(await fetchMembershipRole(g, projectId, sub))) return { statusCode: 404 };
    const meta = await store.getExecution(intentId);
    if (!meta || meta.projectId !== projectId) return { statusCode: 404 };
    return {
      statusCode: 200,
      workflowIntent: {
        id: meta.intentId,
        projectId: meta.projectId,
        workflowId: meta.workflowId,
        workflowVersion: meta.workflowVersion,
        methodologyRelease: meta.methodologyRelease ?? null,
        methodologyPins: meta.methodologyPins ?? null,
      },
    };
  } catch (error) {
    // 5xx, so the caller reports a dependency failure rather than "not found".
    logger.error('intent pin lookup failed', error);
    return { statusCode: 500 };
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        /* best-effort */
      }
    }
  }
};
