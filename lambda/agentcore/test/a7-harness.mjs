// A7 local harness — set up everything a real `claude` CLI needs to drive our
// MCP server against a local gremlin + DynamoDB Local, using a REAL upstream
// stage body. Proves the MCP execution annex overrides the filesystem/bun prose.
//
//   node test/a7-harness.mjs setup    # create table, seed Intent + execution + RUNNING stage, write mcp-config + prompt
//   node test/a7-harness.mjs verify   # inspect gremlin + DynamoDB for what the agent did
//
// Backing services (started outside this script):
//   gremlin-server  -> ws://localhost:8183/gremlin   (GREMLIN_PORT=8183, GREMLIN_PROTOCOL=ws)
//   dynamodb-local  -> http://localhost:8000

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import gremlin from 'gremlin';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ensureIntentVertex } from '../commands/init-ws.js';
import { buildStagePrompt } from '../stage-materializer.js';

const require = createRequire(import.meta.url);
const { createProcessStore } = require('../../shared/v2-process-store.js');
const { createV2Table } = await import('./helpers/v2-table.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..'); // lambda/agentcore

// Fixed scope for the run.
const SCOPE = {
  projectId: 'a7-proj',
  intentId: 'a7-intent',
  executionId: 'a7-exec',
  stageInstanceId: 'a7-stage',
};
const TABLE = 'a7-v2-executions';
const GREMLIN_URL = 'ws://localhost:8183/gremlin';
const DDB_ENDPOINT = 'http://localhost:8000';
const MCP_ENTRY = path.join(ROOT, 'mcp', 'index.js');
const CONFIG_PATH = path.join(here, 'a7-mcp-config.json');
const PROMPT_PATH = path.join(here, 'a7-prompt.txt');

// No PartitionStrategy — the production MCP server's openGraph (clients.js) uses a
// plain traversal, so the harness must too, or its seeded Intent lands in a
// partition the agent's writes can never see.
const openGraph = () => {
  const conn = new gremlin.driver.DriverRemoteConnection(GREMLIN_URL);
  const g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(conn);
  return { conn, g };
};

const makeStore = () => {
  const client = new DynamoDBClient({
    endpoint: DDB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const doc = DynamoDBDocumentClient.from(client);
  return { client, store: createProcessStore({ ddb: doc, tableName: TABLE }) };
};

const setup = async () => {
  const { client, store } = makeStore();
  await createV2Table(client, TABLE).catch((e) => {
    if (!String(e).includes('preexist') && !String(e).includes('Table already exists')) throw e;
  });

  const { conn, g } = openGraph();
  await ensureIntentVertex({
    g,
    projectId: SCOPE.projectId,
    intentId: SCOPE.intentId,
    title: 'A7 annex check',
    now: new Date().toISOString(),
  });
  await conn.close();

  // Seed execution META + a RUNNING stage row so the process bridge has scope.
  await store
    .createExecution({
      executionId: SCOPE.executionId,
      projectId: SCOPE.projectId,
      intentId: SCOPE.intentId,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      status: 'RUNNING',
    })
    .catch(() => {});
  await store.putStage({
    executionId: SCOPE.executionId,
    stageInstanceId: SCOPE.stageInstanceId,
    stageId: 'requirements-analysis',
    phase: 'inception',
    state: 'RUNNING',
  });

  // Build the prompt from the REAL upstream stage body fixture.
  const stageBody = readFileSync(path.join(here, 'fixtures', 'requirements-analysis.md'), 'utf8');
  const prompt = buildStagePrompt({
    stage: {
      stageId: 'requirements-analysis',
      phase: 'inception',
      agentRef: 'aidlc-product-agent',
      inputArtifacts: [],
      outputArtifacts: [{ artifact: 'requirements-analysis' }],
      humanValidation: 'required',
    },
    stageBody,
    agentPersona: 'You are aidlc-product-agent, an expert product manager.',
  });
  // Append a concrete project request so the agent has input upfront — this
  // isolates the create_artifact behaviour rather than re-running the Q&A dance.
  const projectRequest = [
    '',
    '## Project request (the user description for this stage)',
    '',
    'Build a minimal URL shortener web service: anyone can shorten a long URL and',
    'get a 7-char code; visiting the code 3xx-redirects to the original (unknown/',
    'expired/deleted → 404). Email+password sign-in unlocks per-link analytics',
    '(total clicks + last-clicked) and link management (optional expiry, owner',
    'delete). One API service + small web UI, Postgres storage. Target ~1000',
    'redirects/sec, p99 < 50ms. Validate URLs are http(s), well-formed, reject',
    'private/localhost hosts, ≤2048 chars. No custom aliases, no malware scanning,',
    'no rate-limiting in the MVP. Proceed with these as the requirements input;',
    'only ask if something is genuinely blocking.',
  ].join('\n');
  writeFileSync(PROMPT_PATH, prompt + '\n' + projectRequest, 'utf8');

  const mcpConfig = {
    mcpServers: {
      aidlc: {
        command: 'node',
        args: [MCP_ENTRY],
        env: {
          V2_EXECUTION_ID: SCOPE.executionId,
          V2_INTENT_ID: SCOPE.intentId,
          V2_PROJECT_ID: SCOPE.projectId,
          V2_STAGE_INSTANCE_ID: SCOPE.stageInstanceId,
          V2_MCP_ROLE: 'author',
          V2_PROCESS_TABLE: TABLE,
          NEPTUNE_ENDPOINT: 'localhost',
          GREMLIN_PROTOCOL: 'ws',
          GREMLIN_PORT: '8183',
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          DYNAMODB_LOCAL_ENDPOINT: DDB_ENDPOINT,
          AWS_ENDPOINT_URL_DYNAMODB: DDB_ENDPOINT,
        },
      },
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(mcpConfig, null, 2), 'utf8');

  console.log('A7 setup complete.');
  console.log(`  prompt:      ${PROMPT_PATH}`);
  console.log(`  mcp-config:  ${CONFIG_PATH}`);
  console.log('\nRun the agent:\n');
  console.log(
    `  claude -p "$(cat ${PROMPT_PATH})" --mcp-config ${CONFIG_PATH} --permission-mode bypassPermissions\n`,
  );
};

const verify = async () => {
  const { store } = makeStore();
  const { conn, g } = openGraph();
  const artifacts = await g
    .V()
    .has('Intent', 'id', SCOPE.intentId)
    .out('CONTAINS')
    .hasLabel('Artifact')
    .valueMap(true)
    .toList();
  await conn.close();

  const records = await store.getExecutionRecords(SCOPE.executionId);
  console.log('=== Neptune artifacts anchored to the Intent ===');
  for (const a of artifacts) {
    console.log(`  - type=${a.get('artifact_type')} id=${a.get('id')} title=${a.get('title')}`);
  }
  if (artifacts.length === 0) console.log('  (none — agent created no artifact)');

  console.log('\n=== DynamoDB process records ===');
  console.log(`  outputs (send_output): ${records.outputs?.length ?? 0}`);
  for (const o of records.outputs ?? []) console.log(`    • ${String(o.content).slice(0, 80)}`);
  console.log(`  metrics (collect_metric): ${records.metrics?.length ?? 0}`);
  console.log(`  human gates (ask_question): ${records.humanTasks?.length ?? 0}`);
};

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'verify') await verify();
else {
  console.error('usage: node test/a7-harness.mjs <setup|verify>');
  process.exit(1);
}
process.exit(0);
