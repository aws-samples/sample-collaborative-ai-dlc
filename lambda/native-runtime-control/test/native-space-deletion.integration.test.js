import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { GenericContainer, Wait } from 'testcontainers';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { createNativeRuntimeLambda } from '../command-service.js';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../../shared/native-space-inventory.js';
import * as membership from '../../shared/workflow-source-membership.js';
import { initializeNativeSpaceInventory } from '../../../scripts/initialize-native-space-inventory.mjs';
import { localSpaceTables } from './fixtures/local-space-tables.js';
import { ACTOR, DEPLOYMENT, IMAGE, INTENT, event, binding, job, candidate } from './fixtures.js';

// The root graph fixture has LONG IDs. Native membership binds to Neptune's
// string vertex and edge identities, including replacement edges for one actor.
describe.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'owner teardown and member draft admission',
  () => {
    let container, conn, g, projects, graphUrl;
    let tables, projectId, vertex, ownerEdge, managedQuery, secrets, snapshots, queue;
    let native, beforeCreate, beforeFence, afterFence;
    const { t, statics: __ } = gremlin.process;
    const actor = (sub) => ({ requestContext: { authorizer: { claims: { sub } } } });
    const remove = (sub = 'owner') =>
      projects({ httpMethod: 'DELETE', pathParameters: { projectId }, ...actor(sub) });
    const draft = () =>
      native(
        event('create', {
          path: `/api/projects/${projectId}/native-intents`,
          pathParameters: { projectId },
        }),
      );
    const key = () => nativeRuntimeBindingKey({ projectId, executionId: INTENT });
    const get = async (TableName, Key) =>
      (await tables.ddb.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
    const tombstone = () => get(tables.yjsTable, { documentId: `scope#project:${projectId}` });
    const retained = () => get(tables.tableName, nativeSpaceRetentionKey(projectId));
    const put = (Item) => tables.ddb.send(new PutCommand({ TableName: tables.tableName, Item }));
    const initialize = () => initializeNativeSpaceInventory({ ...tables, pageSize: 1 });
    const noTeardown = async () => {
      expect(await tombstone()).toBeUndefined();
      expect(await g.V(vertex).hasNext()).toBe(true);
      expect(managedQuery).not.toHaveBeenCalled();
      expect(secrets).not.toHaveBeenCalled();
      expect(snapshots).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
    };
    beforeAll(async () => {
      container = await new GenericContainer('tinkerpop/gremlin-server:3.7.3')
        .withCopyContentToContainer([
          {
            target: '/opt/gremlin-server/conf/tinkergraph-empty.properties',
            content:
              'gremlin.graph=org.apache.tinkerpop.gremlin.tinkergraph.structure.TinkerGraph\n' +
              'gremlin.tinkergraph.vertexIdManager=ANY\ngremlin.tinkergraph.edgeIdManager=ANY\n',
          },
        ])
        .withExposedPorts(8182)
        .withWaitStrategy(Wait.forLogMessage(/Channel started at port 8182/))
        .start();
      const host = container.getHost();
      expect(['localhost', '127.0.0.1', '::1']).toContain(host);
      const port = container.getMappedPort(8182);
      vi.stubEnv('NEPTUNE_ENDPOINT', host);
      vi.stubEnv('GREMLIN_PROTOCOL', 'ws');
      vi.stubEnv('GREMLIN_PORT', String(port));
      vi.stubEnv('AWS_PROFILE', undefined);
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
      vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
      vi.stubEnv('ARTIFACTS_BUCKET', 'fixture-artifacts');
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/fixture');
      graphUrl = `ws://${host}:${port}/gremlin`;
      conn = new gremlin.driver.DriverRemoteConnection(graphUrl);
      g = gremlin.process.traversal().withRemote(conn);
      ({ handler: projects } = await import('../../projects/index.js'));
    }, 60000);
    beforeEach(async () => {
      tables = await localSpaceTables({ managed: true });
      projectId = randomUUID();
      vertex = randomUUID();
      ownerEdge = randomUUID();
      vi.stubEnv('NATIVE_RUNTIME_BINDINGS_TABLE', tables.tableName);
      vi.stubEnv('YJS_DOCUMENTS_TABLE', tables.yjsTable);
      vi.stubEnv('V2_PROCESS_TABLE', tables.processTable);
      await g.addV('Project').property(t.id, vertex).property('id', projectId).next();
      for (const [sub, role, edge] of [
        ['owner', 'owner', ownerEdge],
        [ACTOR, 'member', randomUUID()],
      ]) {
        const user = randomUUID();
        await g.addV('User').property(t.id, user).property('id', sub).next();
        await g
          .V(vertex)
          .addE('HAS_MEMBER')
          .property(t.id, edge)
          .property('role', role)
          .to(__.V(user))
          .next();
      }
      const send = tables.ddb.send.bind(tables.ddb);
      beforeCreate = beforeFence = afterFence = null;
      managedQuery = vi.fn();
      vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (cmd) => {
        if (cmd.input.TableName === tables.processTable && cmd instanceof QueryCommand)
          managedQuery(cmd);
        if (
          cmd instanceof TransactWriteCommand &&
          cmd.input.TransactItems.some(
            (op) => (op.ConditionCheck ?? op.Update)?.TableName === tables.yjsTable,
          )
        ) {
          const deleting = cmd.input.TransactItems.some(
            (op) => op.Update?.TableName === tables.yjsTable,
          );
          await (deleting ? beforeFence : beforeCreate)?.();
          const result = await send(cmd);
          if (deleting) await afterFence?.();
          return result;
        }
        return send(cmd);
      });
      secrets = vi.spyOn(SSMClient.prototype, 'send').mockResolvedValue({});
      snapshots = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({});
      for (const Client of [LambdaClient, BedrockAgentCoreClient])
        vi.spyOn(Client.prototype, 'send').mockRejectedValue(
          new Error('Unexpected external effect'),
        );
      queue = {
        send: vi.fn(async () => {
          throw new Error('Unexpected notification');
        }),
      };
      native = createNativeRuntimeLambda({
        ddb: tables.ddb,
        sqs: queue,
        openConnection: async () => new gremlin.driver.DriverRemoteConnection(graphUrl),
        sourceFactory: () => ({
          getAuthorizedBinding: async () => binding({ projectId, projectIdentity: vertex }),
        }),
        jobsFactory: () => ({
          get: async () => job({ projectId, candidate: candidate({ projectId }) }),
        }),
        env: {
          NATIVE_PREPARATION_ENABLED: 'true',
          NATIVE_RUNTIME_BINDINGS_TABLE: tables.tableName,
          YJS_DOCUMENTS_TABLE: tables.yjsTable,
          NATIVE_RUNTIME_ACCOUNT_ID: DEPLOYMENT.accountId,
          AWS_REGION: DEPLOYMENT.region,
          AWS_PARTITION: DEPLOYMENT.partition,
          NATIVE_RUNTIME_FILE_SYSTEM_ID: DEPLOYMENT.fileSystemId,
          NATIVE_RUNTIME_IMAGE_URI: IMAGE.uri,
          NATIVE_RUNTIME_IMAGE_DIGEST: IMAGE.digest,
        },
      });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await tables?.close();
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await conn?.close();
      await container?.stop();
    });

    it('retains the winning draft and its history before owner cleanup can start', async () => {
      await initialize();
      let admitted;
      beforeFence = async () => {
        admitted = await draft();
      };
      const blocked = await remove();
      expect(admitted.statusCode).toBe(201);
      expect(blocked.statusCode).toBe(409);
      expect(JSON.parse(blocked.body).code).toBe('space_has_native_intents');
      beforeFence = null;
      const bindingRow = await get(tables.tableName, key());
      const publication = { ...key(), sk: 'PUBLICATION#1', revision: 'fixture' };
      await put(publication);
      expect((await draft()).statusCode).toBe(200);
      expect((await remove()).statusCode).toBe(409);
      expect(await get(tables.tableName, key())).toEqual(bindingRow);
      expect(await get(tables.tableName, { pk: publication.pk, sk: publication.sk })).toEqual(
        publication,
      );
      await noTeardown();
    });
    it('finishes a supported owner delete and fences a member already authorized to create', async () => {
      await initialize();
      expect((await remove(ACTOR)).statusCode).toBe(403);
      await noTeardown();
      let deleted;
      beforeCreate = async () => {
        deleted = await remove();
      };
      const refused = await draft();
      expect(deleted.statusCode).toBe(204);
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body).code).toBe('NATIVE_PREPARATION_SPACE_DELETING');
      expect(await get(tables.tableName, key())).toBeUndefined();
      expect(await retained()).toBeUndefined();
      expect(await tombstone()).toMatchObject({ projectIdentity: vertex, cleanupState: 'fenced' });
      expect((await draft()).statusCode).toBe(403);
      expect((await remove()).statusCode).toBe(403);
      expect(queue.send).not.toHaveBeenCalled();
    });
    it('stops before cleanup on missing coverage or unavailable conditions and resumes an acknowledged-lost fence', async () => {
      expect((await remove()).statusCode).toBe(503);
      await noTeardown();
      await initialize();
      beforeFence = async () => {
        throw new Error('Read unavailable');
      };
      expect((await remove()).statusCode).toBe(503);
      await noTeardown();
      beforeFence = null;
      afterFence = async () => {
        throw new Error('Lost acknowledgement');
      };
      expect((await remove()).statusCode).toBe(503);
      const started = await tombstone();
      expect(started.cleanupState).toBe('pending');
      expect(managedQuery).not.toHaveBeenCalled();
      expect((await draft()).statusCode).toBe(409);
      afterFence = null;
      expect((await remove()).statusCode).toBe(204);
      expect(await tombstone()).toMatchObject({
        deletedAt: started.deletedAt,
        cleanupState: 'fenced',
      });
    });
    it('protects older bindings without indexed timestamps, status or current graph identity on every page', async () => {
      const historicalProjects = [];
      for (const status of ['DRAFT', 'READY', 'FAILED', undefined]) {
        const scope = { projectId: status ? randomUUID() : projectId, executionId: randomUUID() };
        historicalProjects.push(scope.projectId);
        await put({
          ...scope,
          ...nativeRuntimeBindingKey(scope),
          status,
          projectIdentity: 'earlier-vertex',
        });
      }
      await put({ ...key(), sk: 'PROMPT#old', prompt: 'fixture' });
      const pages = [];
      const ddb = {
        send: async (cmd) => {
          if (cmd instanceof ScanCommand && pages.push(cmd.input) === 2)
            throw new Error('Interrupted scan');
          return tables.ddb.send(cmd);
        },
      };
      await expect(initializeNativeSpaceInventory({ ...tables, ddb, pageSize: 1 })).rejects.toThrow(
        'Interrupted scan',
      );
      expect(await get(tables.tableName, nativeSpaceInventoryKey)).toBeUndefined();
      expect(pages[1].ExclusiveStartKey).toBeTruthy();
      expect(await initialize()).toEqual({ bindings: 4 });
      for (const id of historicalProjects)
        expect(await get(tables.tableName, nativeSpaceRetentionKey(id))).toEqual(
          nativeSpaceRetentionKey(id),
        );
      expect((await remove()).statusCode).toBe(409);
      await noTeardown();
    });
    it('cascades managed work in a native-empty space and leaves another space’s binding intact', async () => {
      const other = { projectId: randomUUID(), executionId: randomUUID() };
      const otherBinding = { ...nativeRuntimeBindingKey(other), ...other, status: 'READY' };
      await put(otherBinding);
      await initialize();
      const intentId = randomUUID();
      await g.addV('Intent').property('id', intentId).property('project_id', projectId).next();
      await g
        .V(vertex)
        .addE('CONTAINS')
        .to(__.V().has('Intent', 'id', intentId))
        .next();
      const meta = { pk: `EXEC#${intentId}`, sk: 'META' };
      await tables.ddb.send(
        new PutCommand({
          TableName: tables.processTable,
          Item: {
            ...meta,
            projectId,
            executionId: intentId,
            intentId,
            status: 'DRAFT',
            GSI1PK: `PROJECT#${projectId}`,
            GSI1SK: `STATUS#DRAFT#${intentId}`,
          },
        }),
      );
      expect((await remove()).statusCode).toBe(204);
      expect(await get(tables.processTable, meta)).toBeUndefined();
      expect(await g.V().has('Intent', 'id', intentId).hasNext()).toBe(false);
      expect(await get(tables.tableName, nativeRuntimeBindingKey(other))).toEqual(otherBinding);
    });
    it('preserves an existing draft replay and stops further teardown of a historically retained space with an old Yjs tombstone', async () => {
      expect((await draft()).statusCode).toBe(201);
      const original = await get(tables.tableName, key());
      const old = {
        documentId: `scope#project:${projectId}`,
        deletedAt: 1,
        cleanupState: 'pending',
      };
      await tables.ddb.send(new PutCommand({ TableName: tables.yjsTable, Item: old }));
      await initialize();
      expect((await draft()).statusCode).toBe(200);
      expect((await remove()).statusCode).toBe(409);
      expect(await tombstone()).toEqual(old);
      expect(await get(tables.tableName, key())).toEqual(original);
      expect(managedQuery).not.toHaveBeenCalled();
      expect(secrets).not.toHaveBeenCalled();
    });
    it('refuses to resume a prior graph incarnation’s cleanup', async () => {
      await initialize();
      const prior = {
        documentId: `scope#project:${projectId}`,
        deletedAt: 1,
        projectIdentity: randomUUID(),
      };
      await tables.ddb.send(new PutCommand({ TableName: tables.yjsTable, Item: prior }));
      expect((await remove()).statusCode).toBe(503);
      expect(await tombstone()).toEqual(prior);
      expect(await g.V(vertex).hasNext()).toBe(true);
      expect(secrets).not.toHaveBeenCalled();
      expect(managedQuery).not.toHaveBeenCalled();
    });
    it('rejects an owner edge replaced between the two graph observations', async () => {
      await initialize();
      const original = membership.fetchWorkflowSourceMembership;
      vi.spyOn(membership, 'fetchWorkflowSourceMembership').mockImplementationOnce(
        async (...args) => {
          const observed = await original(...args);
          const user = (await g.E(ownerEdge).inV().id().next()).value;
          await g.E(ownerEdge).drop().next();
          await g
            .V(vertex)
            .addE('HAS_MEMBER')
            .property(t.id, randomUUID())
            .property('role', 'owner')
            .to(__.V(user))
            .next();
          return observed;
        },
      );
      expect((await remove()).statusCode).toBe(403);
      await noTeardown();
    });
  },
);
