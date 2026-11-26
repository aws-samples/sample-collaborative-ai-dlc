// This Lambda must have a dedicated gateway/role. Membership comes from the
// existing Neptune HAS_MEMBER edges; no roster/bootstrap authority is added.
// D18 graph-identity lifecycle checks are implemented; live IAM validation
// remains pending.
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { createWorkflowSourcesHandler, workflowSourceInternalError } from './handler.js';
import { createNativePackageJobs } from '../shared/native-package-jobs.js';
import { createWorkflowPackageJobsService } from './package-jobs.js';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const openNeptuneConnection = async () => {
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(
    process.env.NEPTUNE_ENDPOINT,
    process.env.GREMLIN_PORT ?? '8182',
    credentials,
    '/gremlin',
    process.env.GREMLIN_PROTOCOL ?? 'wss',
  );
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};

// Host ports allow focused boundary/lifecycle tests without AWS or Neptune.
// A connection is lazy and scoped to one request, including membership rechecks.
export const createWorkflowSourcesLambda =
  ({
    ddb = ddbClient,
    ssm = ssmClient,
    secrets = secretsClient,
    openConnection = openNeptuneConnection,
    membershipSnapshot = fetchWorkflowSourceMembership,
    serviceFactory = createWorkflowSourceService,
    jobsFactory = createNativePackageJobs,
    packageJobsEnabled = false,
    packageJobsTableName = process.env.NATIVE_PACKAGE_JOBS_TABLE,
    enabled = false,
  } = {}) =>
  async (event) => {
    let connection;
    let graph;
    let result;
    try {
      let domainService;
      const getService = () => {
        domainService ??= serviceFactory({
          ddb,
          ssm,
          secrets,
          getMembershipSnapshot: async (projectId, actorId) => {
            // Share initialization even when the service checks two memberships
            // concurrently; each request must own and close exactly one socket.
            graph ??= Promise.resolve()
              .then(() => openConnection())
              .then((opened) => {
                connection = opened;
                return traversal().withRemote(connection);
              });
            return membershipSnapshot(await graph, projectId, actorId);
          },
        });
        return domainService;
      };
      // Defer service construction too: disabled/preflight/invalid requests need
      // neither membership storage nor credentials to produce their fixed reply.
      const service = {
        list: (input) => getService().list(input),
        configure: (input) => getService().configure(input),
        remove: (input) => getService().remove(input),
      };
      let jobService;
      const getJobs = () => {
        jobService ??= createWorkflowPackageJobsService({
          jobs: jobsFactory({ ddb, tableName: packageJobsTableName }),
          workflowSources: getService(),
        });
        return jobService;
      };
      result = await createWorkflowSourcesHandler({
        service,
        enabled,
        packageJobsEnabled,
        packageJobs: {
          create: (input) => getJobs().create(input),
          get: (input) => getJobs().get(input),
        },
      })(event);
    } catch {
      result = workflowSourceInternalError(event);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {
          result = workflowSourceInternalError(event);
        }
      }
    }
    return result;
  };

export const handler = (event) =>
  createWorkflowSourcesLambda({
    enabled: process.env.WORKFLOW_SOURCE_API_ENABLED === 'true',
    packageJobsEnabled: process.env.NATIVE_PACKAGE_JOBS_ENABLED === 'true',
  })(event);
