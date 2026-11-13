import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { IAMClient } from '@aws-sdk/client-iam';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { isDeepStrictEqual } from 'node:util';
import { createNativeRuntimeStore } from './store.js';
import { createNativeExecutionStore } from './execution-store.js';
import { nativePreparedConfigurationPins, nativeExecutionDeployment } from './execution-config.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { createNativePackageArchive } from '../shared/native-package-archive.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeInteractions } from '../shared/native-interaction.js';
import { createNativeEngineObjects } from '../shared/native-workflow-objects.js';
import { engineFailure } from '../shared/native-workflow-protocol.js';
import { verifyNativeInputAccess, invokeNativeInputOwner } from './input-access.js';
import { createNativeEngineStore } from './workflow-engine/store.js';
import { createNativeWorkflowEngine } from './workflow-engine/service.js';
import { createNativeEngineJobs } from './workflow-engine/jobs.js';
import { createNativeReviewRole } from './workflow-engine/job-roles.js';

const openNeptune = async (env) => {
  const credentials = await fromNodeProviderChain()();
  const { url, headers } = getUrlAndHeaders(
    env.NEPTUNE_ENDPOINT,
    env.GREMLIN_PORT ?? '8182',
    { ...credentials, region: env.AWS_REGION },
    '/gremlin',
    env.GREMLIN_PROTOCOL ?? 'wss',
  );
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};
export const createNativeWorkflowEngineLambda =
  ({
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3 = new S3Client({}),
    lambda = new LambdaClient({}),
    iam = new IAMClient({}),
    codebuild = new CodeBuildClient({ maxAttempts: 1 }),
    env = process.env,
    openConnection = openNeptune,
    membershipSnapshot = fetchWorkflowSourceMembership,
    preparationFactory = createNativeRuntimeStore,
    executionFactory = createNativeExecutionStore,
    serviceFactory = createNativeWorkflowEngine,
  } = {}) =>
  async (payload, context) => {
    let connection;
    let graph;
    try {
      const membership = async (projectId, actorId) => {
        graph ??= Promise.resolve()
          .then(() => openConnection(env))
          .then((opened) => {
            connection = opened;
            return gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection);
          });
        return membershipSnapshot(await graph, projectId, actorId);
      };
      const preparationStore = preparationFactory({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        deployment: {
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          region: env.AWS_REGION,
          partition: env.AWS_PARTITION || 'aws',
          fileSystemId: env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
        },
      });
      const executionStore = executionFactory({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        preparationStore,
      });
      const journal = createNativeEngineStore({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        readExecution: executionStore.get,
      });
      const objects = createNativeEngineObjects({
        s3,
        bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const sources = createWorkflowSourceService({ ddb, getMembershipSnapshot: membership });
      const images = createNativeRuntimeImagePolicy({
        ddb,
        tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        env,
      });
      const invokeTracker = (input) => invokeNativeInputOwner(lambda, env.TRACKERS_FUNCTION, input);
      const authorizeAccess = async ({ row, draft }) => {
        const member = await membership(row.scope.projectId, row.startedBy);
        if (
          !draft ||
          draft.bindingId !== row.bindingId ||
          !['member', 'admin', 'owner'].includes(member?.role) ||
          member.projectIdentity !== draft.projectIdentity
        )
          throw engineFailure('NATIVE_ENGINE_FORBIDDEN');
        if (row.response) {
          const answer = await executionStore.response(row, row.response.interactionId);
          const respondent = await membership(row.scope.projectId, row.response.actorId);
          if (
            !answer ||
            !['member', 'admin', 'owner'].includes(respondent?.role) ||
            respondent.projectIdentity !== draft.projectIdentity ||
            respondent.membershipId !== answer.member?.membershipId
          )
            throw engineFailure('NATIVE_ENGINE_FORBIDDEN');
        }
        const currentDraft = await preparationStore.get(row.scope);
        if (
          !currentDraft ||
          currentDraft.bindingId !== row.bindingId ||
          !isDeepStrictEqual(
            nativePreparedConfigurationPins(currentDraft),
            nativePreparedConfigurationPins(draft),
          )
        )
          throw engineFailure('NATIVE_ENGINE_CONFIGURATION_CHANGED');
        const pins = nativePreparedConfigurationPins(draft);
        if (
          Object.entries(pins).some(
            ([key, value]) => !isDeepStrictEqual(value, row.configuration[key]),
          )
        )
          throw engineFailure('NATIVE_ENGINE_CONFIGURATION_CHANGED');
        await sources.getAuthorizedBinding({
          projectId: draft.projectId,
          actorId: row.startedBy,
          sourceId: draft.request.sourceId,
          expectedRevision: draft.request.bindingRevision,
        });
        const repository = row.configuration.repository;
        const access = await invokeNativeInputOwner(lambda, env.SOURCE_CONTROL_FUNCTION, {
          action: 'native-source-access',
          projectId: draft.projectId,
          userId: row.startedBy,
          provider: repository.provider,
          repository: repository.repository,
          bindingRevision: repository.bindingRevision,
        });
        if (
          access.ok !== true ||
          access.source?.bindingRevision !== repository.bindingRevision ||
          access.source?.credentialIdentity !== repository.credentialIdentity
        )
          throw engineFailure('NATIVE_ENGINE_SOURCE_CHANGED');
        await verifyNativeInputAccess({
          inputs: row.configuration.inputs,
          projectId: draft.projectId,
          userId: row.startedBy,
          invokeTracker,
        });
        await images.authorize({
          image: row.configuration.image,
          row,
          deployment: nativeExecutionDeployment(env),
        });
      };
      const archives = createNativePackageArchive({
        s3,
        bucket: env.NATIVE_PACKAGES_BUCKET,
        expectedBucketOwner: env.NATIVE_RUNTIME_ACCOUNT_ID,
        workRoot: '/tmp/native-package-reader',
        // The shared archive owner requires a materializer for its write/restore
        // operations. This entry exposes only its immutable runtime read.
        materialize: () => {
          throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
        },
      });
      const handler = serviceFactory({
        executionStore,
        preparationStore,
        journal,
        objects,
        authorizeAccess,
        env,
        publications: createNativePublications({
          s3,
          bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        }),
        interactions: createNativeInteractions({
          s3,
          bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        }),
        loadArchive: ({ draft, authorize }) =>
          archives.readRuntime({
            projectId: draft.projectId,
            sourceId: draft.request.sourceId,
            pin: draft.candidate.packagePin,
            attestation: draft.candidate.attestation,
            materializationId: draft.candidate.materializationId,
            receipt: draft.archiveReceipt,
            beforeReturn: authorize,
          }),
        loadSettings: async ({ row, authorize }) => {
          const repository = row.configuration.repository;
          const result = await invokeNativeInputOwner(lambda, env.SOURCE_CONTROL_FUNCTION, {
            action: 'native-workflow-settings',
            projectId: row.scope.projectId,
            userId: row.startedBy,
            provider: repository.provider,
            repository: repository.repository,
            bindingRevision: repository.bindingRevision,
            commit: repository.commit,
          });
          if (
            result.ok !== true ||
            result.source?.bindingRevision !== repository.bindingRevision ||
            result.source?.credentialIdentity !== repository.credentialIdentity
          )
            throw engineFailure('NATIVE_ENGINE_SOURCE_CHANGED');
          await authorize();
          return result.source.settings;
        },
        jobsFactory: (input) =>
          createNativeEngineJobs({
            ...input,
            codebuild,
            s3,
            objects,
            journal,
            env,
            reviewRole: createNativeReviewRole({ iam, lambda, env, authorize: input.authorize }),
          }),
      });
      return await handler(payload, context);
    } catch (error) {
      return {
        ok: false,
        code: /^NATIVE_[A-Z0-9_]+$/.test(error?.code ?? '')
          ? error.code
          : 'NATIVE_ENGINE_UNAVAILABLE',
      };
    } finally {
      if (connection) await connection.close().catch(() => {});
    }
  };
export const handler = (payload, context) => createNativeWorkflowEngineLambda()(payload, context);
