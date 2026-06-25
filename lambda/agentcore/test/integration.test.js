// End-to-end stage execution against the real testcontainers (gremlin-server +
// DynamoDB Local). This is the "execute a single stage and verify output"
// harness: init-ws bootstraps the Intent + state, then run-stage drives a FAKE
// agent that calls the real MCP tool handlers (create_artifact, send_output) —
// exactly what a headless CLI would do over stdio — and we assert the business
// artifact landed in Neptune and the process state + output landed in DynamoDB.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createRequire } from 'node:module';
import { makeDdb, createV2Table, deleteV2Table } from './helpers/v2-table.js';
import { initWs } from '../commands/init-ws.js';
import { runStage } from '../commands/run-stage.js';
import { renderRulesDoc, materializeStage } from '../stage-materializer.js';
import { createGraphWriter } from '../mcp/graph-writer.js';
import { createProcessBridge } from '../mcp/process-bridge.js';
import { buildToolHandlers } from '../mcp/server.js';

const require = createRequire(import.meta.url);
const { createProcessStore } = require('../../shared/v2-process-store.js');

const PARTITION = 'agentcore-integration';
const TABLE = 'v2-proc-integration';

let conn;
let g;
let ddbClient;
let doc;
let store;

const library = () => ({
  stagesById: {
    'requirements-analysis': {
      id: 'requirements-analysis',
      version: 1,
      phase: 'inception',
      mode: 'inline',
      leadAgent: 'aidlc-product-agent',
      produces: ['requirements-analysis'],
      consumes: [],
      sensors: [],
      humanValidation: 'required',
    },
  },
  agentsById: { 'aidlc-product-agent': { id: 'aidlc-product-agent' } },
  sensorsById: {},
  rulesById: {},
  artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
  knowledgeById: {},
});

const workflow = () => ({
  id: 'aidlc-v2',
  version: 1,
  placements: [
    { stageId: 'requirements-analysis', order: 0, scopeMembership: { feature: 'EXECUTE' } },
  ],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }],
});

beforeAll(async () => {
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
  ({ client: ddbClient, doc } = makeDdb());
  await createV2Table(ddbClient, TABLE);
  store = createProcessStore({ ddb: doc, tableName: TABLE });
});

afterAll(async () => {
  await deleteV2Table(ddbClient, TABLE);
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
});

describe('end-to-end: init-ws → run-stage with a real agent-equivalent MCP session', () => {
  it('bootstraps the intent, executes the stage, and lands artifact + state + output', async () => {
    const scope = { projectId: 'p1', intentId: 'i1', executionId: 'e1', scope: 'feature' };

    // 1. init-ws: create Intent + seed state (git checkout stubbed).
    const init = await initWs(
      { ...scope, repos: [], workflowId: 'aidlc-v2', workflowVersion: 1, title: 'Build login' },
      {
        store,
        openGraph: async () => g,
        checkoutRepos: async () => [],
        workspaceDir: '/tmp/aidlc-int',
      },
    );
    expect(init.ok).toBe(true);
    expect(await store.getExecution('e1')).toMatchObject({ status: 'CREATED', intentId: 'i1' });

    // 2. run-stage: the spawnFn simulates the headless CLI by driving the SAME MCP
    // tool handlers the real agent would call over stdio.
    const fakeAgentSpawn = (command, args) => {
      // Find the mcp-config the materializer wrote and act as the agent: build a
      // writer+bridge with the trusted scope and create the expected artifact.
      const run = async () => {
        const stageScope = {
          executionId: 'e1',
          intentId: 'i1',
          projectId: 'p1',
          stageInstanceId: undefined,
        };
        // Resolve the real stageInstanceId from the running stage record.
        const { stages } = await store.getExecutionRecords('e1');
        stageScope.stageInstanceId =
          stages.find((s) => s.state === 'RUNNING')?.stageInstanceId ?? null;

        const writer = createGraphWriter({ g, scope: stageScope });
        const bridge = createProcessBridge({
          store,
          graphWriter: writer,
          scope: stageScope,
          broadcast: async () => {},
        });
        const handlers = buildToolHandlers({ writer, bridge });
        await handlers.send_output({ content: 'Analyzing the intent…' });
        await handlers.create_artifact({
          artifactType: 'requirements-analysis',
          id: 'ra-1',
          title: 'Requirements',
          content: '## Functional\n- login',
        });
        await handlers.collect_metric({
          metrics: { tokensInput: 120, tokensOutput: 340, contextWindowPct: 18 },
        });
      };
      // Mimic a child process that runs, then exits 0.
      const child = {
        stdin: { end() {} },
        on(ev, cb) {
          if (ev === 'close')
            run().then(
              () => cb(0),
              () => cb(1),
            );
        },
      };
      void command;
      void args;
      return child;
    };

    const res = await runStage(
      {
        ...scope,
        stageId: 'requirements-analysis',
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        workspaceDir: '/tmp/aidlc-int',
      },
      {
        store,
        loadLibrary: async () => ({ workflow: workflow(), library: library() }),
        loadBlockBody: async () => 'stage body',
        materializeStage,
        renderRulesDoc,
        mcpEntry: '/opt/agentcore/mcp/index.js',
        availableClis: ['claude'],
        env: { V2_PROCESS_TABLE: TABLE, NEPTUNE_ENDPOINT: process.env.NEPTUNE_ENDPOINT },
        spawnFn: fakeAgentSpawn,
      },
    );

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'claude' });

    // 3a. Business artifact landed in Neptune, typed + anchored to the Intent.
    const anchored = await g
      .V()
      .has('Intent', 'id', 'i1')
      .out('CONTAINS')
      .has('Artifact', 'id', 'ra-1')
      .valueMap(true)
      .next();
    expect(anchored.value).toBeTruthy();
    const artifact = createGraphWriter({ g, scope: { intentId: 'i1' } });
    const reqs = await artifact.lookupArtifacts({ artifactType: 'requirements-analysis' });
    expect(reqs.map((a) => a.id)).toContain('ra-1');

    // 3b. Process state advanced to SUCCEEDED + current phase/stage recorded.
    const { meta, stages, outputs, metrics } = await store.getExecutionRecords('e1');
    expect(meta).toMatchObject({
      status: 'RUNNING',
      currentStage: 'requirements-analysis',
      currentPhase: 'inception',
    });
    expect(stages.find((s) => s.stageId === 'requirements-analysis')).toMatchObject({
      state: 'SUCCEEDED',
    });

    // 3c. Output persisted for restore-on-reload, metric recorded.
    expect(outputs.map((o) => o.content)).toContain('Analyzing the intent…');
    expect(metrics[0].metrics).toMatchObject({ tokensInput: 120, contextWindowPct: 18 });
  });
});
