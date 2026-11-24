import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { createNativePackageJobs } from '../shared/native-package-jobs.js';
import { isNativeSourceCommit } from '../shared/native-application-source.js';
import { createNativeRuntimeApi, nativePreparationInternalError } from './api.js';
import { createNativeInputApi } from './input-api.js';
import { invokeNativeInputOwner } from './input-access.js';
import { createNativeRuntimeStore, fail } from './store.js';
import { createNativeIntentListing } from './listing.js';
import { createNativeExecutionStore } from './execution-store.js';
import { createNativeExecutionConfiguration } from './execution-config.js';
import { createNativeExecutionApi, nativeExecutionSummaries } from './execution-api.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeInteractions } from '../shared/native-interaction.js';
import { createNativeArtifactRevisions } from '../shared/native-artifact-revision.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import { nativeExecutionDeployment } from './execution-config.js';
import { createNativeActivityStore } from './activity-store.js';
import { nativeProjectionStatus } from './projection-store.js';
import { createNativeResultStore, resultFailure } from './result-store.js';
import { createNativeResultStorage } from './result-storage.js';
import { createNativeEngineObjects } from '../shared/native-workflow-objects.js';
import { createNativeEngineProofReader } from './historical-workflow-evidence.js';

const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const defaultSqs = new SQSClient({});
const defaultS3 = new S3Client({});
const defaultSsm = new SSMClient({});
const defaultLambda = new LambdaClient({});
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const openNeptune = async () => {
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

export const createNativeRuntimeLambda =
  ({
    ddb = defaultDdb,
    sqs = defaultSqs,
    s3 = defaultS3,
    ssm = defaultSsm,
    lambda = defaultLambda,
    env = process.env,
    openConnection = openNeptune,
    membershipSnapshot = fetchWorkflowSourceMembership,
    sourceFactory = createWorkflowSourceService,
    jobsFactory = createNativePackageJobs,
    storeFactory = createNativeRuntimeStore,
  } = {}) =>
  async (event) => {
    let connection;
    let graph;
    let sourceService;
    let packageJobs;
    let runtimeStore;
    let listing;
    let executionApi;
    let result;
    const getMembershipSnapshot = async (projectId, actorId) => {
      graph ??= Promise.resolve()
        .then(openConnection)
        .then((opened) => {
          connection = opened;
          return traversal().withRemote(connection);
        });
      return membershipSnapshot(await graph, projectId, actorId);
    };
    const sources = () => (sourceService ??= sourceFactory({ ddb, getMembershipSnapshot }));
    const jobs = () =>
      (packageJobs ??= jobsFactory({ ddb, tableName: env.NATIVE_PACKAGE_JOBS_TABLE }));
    const store = () =>
      (runtimeStore ??= storeFactory({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        yjsTable: env.YJS_DOCUMENTS_TABLE,
        deployment: {
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          region: env.AWS_REGION,
          partition: env.AWS_PARTITION || 'aws',
          fileSystemId: env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
        },
      }));
    const invokeInputOwner = (functionName, payload) =>
      invokeNativeInputOwner(lambda, functionName, payload);
    const invokeTracker = (payload) => invokeInputOwner(env.TRACKERS_FUNCTION, payload);
    const executionReadPorts = () => ({
      store: createNativeExecutionStore({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        preparationStore: store(),
      }),
      images: createNativeRuntimeImagePolicy({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        env,
      }),
      deployment: () => nativeExecutionDeployment(env),
    });
    const executions = () => {
      if (executionApi) return executionApi;
      const publications = createNativePublications({
        s3,
        bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      executionApi = createNativeExecutionApi({
        enabled: true,
        ssm,
        settingsPrefix: env.AGENT_SETTINGS_SSM_PREFIX,
        admissionEnabled:
          (env.NATIVE_EXECUTION_ADMISSION_ENABLED ?? env.NATIVE_EXECUTION_ENABLED) === 'true',
        ...executionReadPorts(),
        projectionStatus: (row) =>
          nativeProjectionStatus(ddb, env.NATIVE_RUNTIME_BINDINGS_TABLE, row),
        configure: createNativeExecutionConfiguration({
          ddb,
          ssm,
          s3,
          graph: () => graph,
          env,
          invokeTracker,
          captureSource: ({ metadataOnly = false, ...input }) =>
            invokeInputOwner(env.SOURCE_CONTROL_FUNCTION, {
              action: metadataOnly ? 'native-source-access' : 'native-source-snapshot',
              ...input,
            }),
        }),
        publications,
        completionProof: createNativeEngineProofReader({
          ddb,
          tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          objects: createNativeEngineObjects({
            s3,
            bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
            accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          }),
        }),
        revisions: createNativeArtifactRevisions({
          ddb,
          nativeTable: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          publications,
        }),
        results: {
          jobs: createNativeResultStore({ ddb, tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE }),
          storage: createNativeResultStorage({
            s3,
            bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
            accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          }),
          observeBranch: async ({ row, actorId, branch }) => {
            const pin = row.configuration.repository;
            const reply = await invokeInputOwner(env.SOURCE_CONTROL_FUNCTION, {
              action: 'native-delivery-ref',
              sourceBranch: pin.branch,
              projectId: row.scope.projectId,
              userId: actorId,
              executionId: row.scope.executionId,
              provider: pin.provider,
              repository: pin.repository,
              bindingRevision: pin.bindingRevision,
              credentialIdentity: pin.credentialIdentity,
            });
            if (
              !reply.ok ||
              reply.source?.branch !== branch ||
              reply.source.bindingRevision !== pin.bindingRevision ||
              reply.source.credentialIdentity !== pin.credentialIdentity ||
              (reply.source.commit !== null && !isNativeSourceCommit(reply.source.commit))
            )
              throw resultFailure();
            return reply.source.commit;
          },
          enqueue: async (input, format) => {
            const functionName =
              format === 'git' ? env.NATIVE_GIT_RESULT_FUNCTION : env.NATIVE_RESULT_FUNCTION;
            if (!functionName) throw resultFailure();
            const invocation = await lambda.send(
              new InvokeCommand({
                FunctionName: functionName,
                InvocationType: 'Event',
                Payload: Buffer.from(JSON.stringify(input)),
              }),
            );
            if (invocation.StatusCode !== 202) throw resultFailure();
          },
        },
        interactions: createNativeInteractions({
          s3,
          bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        }),
        activity: createNativeActivityStore({ ddb, tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE }),
        authorizeSource: (draft, actorId) =>
          sources().getAuthorizedBinding({
            projectId: draft.projectId,
            actorId,
            sourceId: draft.request.sourceId,
            expectedRevision: draft.request.bindingRevision,
          }),
        enqueue: async (identity) => {
          const sent = await sqs.send(
            new SendMessageCommand({
              QueueUrl: env.NATIVE_EXECUTION_QUEUE_URL,
              MessageBody: JSON.stringify(identity),
            }),
          );
          if (!sent.MessageId) fail('UNAVAILABLE');
        },
      });
      return executionApi;
    };
    const execution = env.NATIVE_EXECUTION_PUBLICATION_BUCKET
      ? {
          enabled:
            (env.NATIVE_EXECUTION_ADMISSION_ENABLED ?? env.NATIVE_EXECUTION_ENABLED) === 'true',
          outputs: (...args) => executions().outputs(...args),
          summaries: (drafts) => nativeExecutionSummaries(drafts, executionReadPorts()),
          status: (...args) => executions().status(...args),
          start: (...args) => executions().start(...args),
          cancel: (...args) => executions().cancel(...args),
          recover: (...args) => executions().recover(...args),
          publication: (...args) => executions().publication(...args),
          history: (...args) => executions().history(...args),
          revision: (...args) => executions().revision(...args),
          revisionFile: (...args) => executions().revisionFile(...args),
          revisionInteraction: (...args) => executions().revisionInteraction(...args),
          requestResult: (...args) => executions().requestResult(...args),
          result: (...args) => executions().result(...args),
          file: (...args) => executions().file(...args),
          graph: (...args) => executions().graph(...args),
          interaction: (...args) => executions().interaction(...args),
          respond: (...args) => executions().respond(...args),
        }
      : undefined;
    try {
      result = await createNativeRuntimeApi({
        enabled: env.NATIVE_PREPARATION_ENABLED === 'true',
        admissionEnabled:
          (env.NATIVE_PREPARATION_ADMISSION_ENABLED ?? env.NATIVE_PREPARATION_ENABLED) === 'true',
        getMembershipSnapshot,
        listNativeIntents: (input) => {
          listing ??= createNativeIntentListing({
            ddb,
            tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
            store: store(),
          });
          return listing.list(input);
        },
        workflowSources: { getAuthorizedBinding: (input) => sources().getAuthorizedBinding(input) },
        jobs: { get: (input) => jobs().get(input) },
        store: {
          get: (input) => store().get(input),
          create: (input) => store().create(input),
          prepare: (input) => store().prepare(input),
          savePrompt: (input) => store().savePrompt(input),
        },
        image: { uri: env.NATIVE_RUNTIME_IMAGE_URI, digest: env.NATIVE_RUNTIME_IMAGE_DIGEST },
        execution,
        inputs: {
          handle: (context) =>
            createNativeInputApi({
              store: store(),
              executionStore: createNativeExecutionStore({
                ddb,
                tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
                preparationStore: store(),
              }),
              s3,
              bucket: env.ARTIFACTS_BUCKET,
              accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
              invokeTracker,
            }).handle(context),
        },
        enqueue: async ({ projectId, executionId }) => {
          if (!env.NATIVE_RUNTIME_QUEUE_URL) fail('UNAVAILABLE');
          const sent = await sqs.send(
            new SendMessageCommand({
              QueueUrl: env.NATIVE_RUNTIME_QUEUE_URL,
              MessageBody: JSON.stringify({ projectId, executionId }),
            }),
          );
          if (typeof sent?.MessageId !== 'string' || !sent.MessageId) fail('UNAVAILABLE');
        },
      })(event);
    } catch {
      result = nativePreparationInternalError(event);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {
          result = nativePreparationInternalError(event);
        }
      }
    }
    return result;
  };

export const handler = (event) => createNativeRuntimeLambda()(event);
