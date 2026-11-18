// Deployment migration from Neptune HAS_MEMBER edges to DynamoDB space membership.
// Terraform invokes `copy` before updating the application Lambdas, then `report`
// after cutover to log source/destination differences. Copy is safe to retry;
// report is read-only and failures produce warnings. Both retain the graph edges
// for rollback; their cleanup is deferred to a later release.

import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { Logger } from '@aws-lambda-powertools/logger';
import { membershipStore } from '../shared/space-membership.js';
import { migrateMemberships, reportMembershipDifferences } from './migration.js';

const logger = new Logger({ persistentKeys: { component: 'migrate-memberships' } });

export const handler = async (event) => {
  let conn;
  try {
    const credentials = await fromNodeProviderChain()();
    credentials.region = process.env.AWS_REGION || 'us-east-1';
    const { url, headers } = getUrlAndHeaders(
      process.env.NEPTUNE_ENDPOINT,
      '8182',
      credentials,
      '/gremlin',
      'wss',
    );
    conn = new gremlin.driver.DriverRemoteConnection(url, { headers });
    const g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(conn);
    const options = { warn: (message, details) => logger.warn(message, details) };
    if (event?.action === 'report') {
      const result = await reportMembershipDifferences(g, membershipStore, options);
      logger.info('Membership differences reported; graph edges retained', result);
      return result;
    }
    if (event?.action !== 'copy') throw new Error('Expected copy or report');
    const result = await migrateMemberships(g, membershipStore, options);
    logger.info('Membership migration verified', result);
    return result;
  } catch (error) {
    if (event?.action !== 'report') throw error;
    logger.warn('Membership difference report incomplete; graph edges retained', {
      error: error.message,
    });
    return { reported: false };
  } finally {
    await conn?.close().catch(() => {});
  }
};
