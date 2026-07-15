#!/usr/bin/env node
// Internal harness for scripts/agent-e2e-testing.sh. It runs inside the AgentCore image
// against DynamoDB Local + Gremlin Server and exercises the real runStage/MCP
// lifecycle. The shell script is the supported entrypoint.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeDdb, createV2Table } from './helpers/v2-table.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { runStage } from '../commands/run-stage.js';
import {
  materializeStage,
  renderRulesDoc,
  materializeMcpConfig,
  materializeKiroAgent,
  materializeOpenCodeConfig,
} from '../stage-materializer.js';
import { ddb as runtimeDdb, openGraph } from '../clients.js';
import { closeGraphSource } from '../mcp/graph-writer.js';
import { ensureIntentVertex } from '../commands/init-ws.js';
import { ensureRuntimeExcludes } from '../git-engine.js';
import { LOCAL_E2E_CLIS, localE2eModelFor } from './local-e2e-config.js';

const execFileAsync = promisify(execFile);
const command = process.argv[2];
const cli = process.argv[3] || process.env.E2E_CLI;
const tableName = process.env.V2_PROCESS_TABLE || 'aidlc-local-e2e';
const workspaceDir = process.env.V2_WORKSPACE_DIR || '/mnt/workspace';
const mcpEntry = process.env.V2_MCP_ENTRY || '/opt/agentcore/mcp/index.js';

const loadSecretFile = async () => {
  const filename = process.env.E2E_SECRET_FILE || '/run/secrets/aidlc-e2e.env';
  const body = await readFile(filename, 'utf8').catch(() => '');
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split <= 0) continue;
    process.env[line.slice(0, split)] = line.slice(split + 1);
  }
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.BEDROCK_API_KEY) {
    process.env.AWS_BEARER_TOKEN_BEDROCK = process.env.BEDROCK_API_KEY;
  }
};

await loadSecretFile();

const idsFor = (selectedCli) => ({
  projectId: `local-e2e-project-${selectedCli}`,
  intentId: `local-e2e-intent-${selectedCli}`,
  executionId: `local-e2e-execution-${selectedCli}`,
  artifactId: `local-e2e-${selectedCli}-artifact`,
});

const assertCli = () => {
  if (!LOCAL_E2E_CLIS.includes(cli)) {
    throw new Error(`expected CLI argument claude|kiro|opencode, got ${cli || '(missing)'}`);
  }
};

const { client, doc } = makeDdb();
const store = createProcessStore({ ddb: doc, tableName });

const cleanupGraph = async (intentId) => {
  let g;
  try {
    g = await openGraph();
    // Gremlin-JS 3.8 implements iterate() with discard(), which is unavailable
    // on the pinned 3.7.3 test server. next() executes drop() compatibly.
    await g.V().has('intent_id', intentId).drop().next();
    await g.V().has('Intent', 'id', intentId).drop().next();
  } finally {
    await closeGraphSource(g);
  }
};

const ensureTable = async () => {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
    await createV2Table(client, tableName);
  }
};

const verifyRuntimeDdb = async () => {
  try {
    await runtimeDdb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'E2E#PREFLIGHT', sk: 'E2E#PREFLIGHT' },
      }),
    );
  } catch (error) {
    throw new Error(`MCP bridge DynamoDB preflight failed: ${error?.message ?? String(error)}`, {
      cause: error,
    });
  }
};

const git = async (args) =>
  execFileAsync('git', args, {
    cwd: workspaceDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'AI-DLC E2E',
      GIT_AUTHOR_EMAIL: 'aidlc-e2e@example.invalid',
      GIT_COMMITTER_NAME: 'AI-DLC E2E',
      GIT_COMMITTER_EMAIL: 'aidlc-e2e@example.invalid',
    },
  });

const setupWorkspaceGit = async () => {
  await mkdir(workspaceDir, { recursive: true });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'AI-DLC E2E']);
  await git(['config', 'user.email', 'aidlc-e2e@example.invalid']);
  const readme = `${workspaceDir}/README.md`;
  await writeFile(readme, 'local e2e\n', { flag: 'wx' }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await git(['add', 'README.md']);
  await git(['commit', '-q', '--allow-empty', '-m', 'local e2e fixture']);
  await ensureRuntimeExcludes({ dir: workspaceDir });
};

const stageBody = ({ selectedCli, artifactId }) =>
  `
This is a controlled two-leg runtime lifecycle test for ${selectedCli}.

On the first turn, call ask_question exactly once with:
- text: "Should the local E2E continue?"
- type: "single"
- options: one option labeled "Proceed"

When ask_question returns parked:true, STOP IMMEDIATELY. Do not call another tool.

On the resumed turn, after receiving the human answer, do not ask another question.
Call these tools exactly once and in this order:
1. create_artifact with artifactType "e2e-result", id "${artifactId}", title
   "Local ${selectedCli} E2E", and content that states the cold resume succeeded.
2. send_output with content "Local ${selectedCli} cold resume completed."
3. collect_metric with metrics {"e2eLifecycle": 1}.
Then end with a short non-empty final sentence.
`.trim();

const libraryFor = (selectedCli) => {
  const ids = idsFor(selectedCli);
  return {
    workflow: {
      id: 'local-e2e',
      version: 1,
      placements: [
        { stageId: 'local-e2e-stage', order: 0, scopeMembership: { feature: 'EXECUTE' } },
      ],
      ruleRefs: [],
      scopeRefs: [{ scopeId: 'feature' }],
    },
    library: {
      stagesById: {
        'local-e2e-stage': {
          id: 'local-e2e-stage',
          version: 1,
          phase: 'inception',
          mode: 'inline',
          leadAgent: 'local-e2e-agent',
          produces: ['e2e-result'],
          consumes: [],
          sensors: [],
          humanValidation: 'none',
          bodyRef: { inline: 'stage' },
        },
      },
      agentsById: {
        'local-e2e-agent': {
          id: 'local-e2e-agent',
          tier: null,
          modelOverride: null,
          bodyRef: { inline: 'agent' },
        },
      },
      sensorsById: {},
      rulesById: {},
      artifactsById: { 'e2e-result': { id: 'e2e-result', terminal: true } },
      knowledgeById: {},
    },
    stageText: stageBody({ selectedCli, artifactId: ids.artifactId }),
  };
};

const modelFor = (selectedCli) => {
  return localE2eModelFor({
    cli: selectedCli,
    bedrockModel: process.env.BEDROCK_MODEL,
    kiroModel: process.env.KIRO_MODEL,
  });
};

const runLifecycleLeg = async ({ selectedCli, resumeFrom = null }) => {
  const ids = idsFor(selectedCli);
  const fixture = libraryFor(selectedCli);
  return runStage(
    {
      ...ids,
      stageId: 'local-e2e-stage',
      workflowId: 'local-e2e',
      workflowVersion: 1,
      scope: 'feature',
      requestedCli: selectedCli,
      cliModels: { [selectedCli]: modelFor(selectedCli) },
      mcpServersByTier: { global: {}, project: {} },
      workspaceDir,
      repos: [],
      resumeFrom,
    },
    {
      store,
      loadLibrary: async () => ({
        workflow: fixture.workflow,
        library: fixture.library,
      }),
      loadBlockBody: async (block) =>
        block?.id === 'local-e2e-stage'
          ? fixture.stageText
          : 'You execute the local lifecycle test exactly as instructed.',
      loadConductor: async () => '',
      materializeStage,
      materializeMcpConfig,
      materializeKiroAgent,
      materializeOpenCodeConfig,
      renderRulesDoc,
      mcpEntry,
      openGraph,
      availableClis: [selectedCli],
      env: process.env,
      broadcast: async () => {},
    },
  );
};

const latestGate = async (executionId, status) => {
  const records = await store.getExecutionRecords(executionId);
  return records.humanTasks
    .filter((row) => row.status === status)
    .toSorted((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
};

const snapshotKey = (executionId) => ({
  pk: `EXEC#${executionId}`,
  sk: 'E2E#SESSION_SNAPSHOT',
});

const handlers = {
  async bootstrap() {
    await ensureTable();
    await verifyRuntimeDdb();
    return { ok: true, tableName };
  },

  async setup() {
    assertCli();
    await ensureTable();
    const ids = idsFor(cli);
    await store.deleteExecution(ids.executionId);
    await cleanupGraph(ids.intentId);
    await setupWorkspaceGit();
    await store.createExecution({
      executionId: ids.executionId,
      projectId: ids.projectId,
      intentId: ids.intentId,
      status: 'CREATED',
      workflowId: 'local-e2e',
      workflowVersion: 1,
      scope: 'feature',
      startedBy: 'local-e2e',
      title: `Local ${cli} E2E`,
      prompt: `Validate ${cli} park/resume across containers.`,
      agentCli: cli,
      cliModels: { [cli]: modelFor(cli) },
      repos: [],
    });
    let g;
    try {
      g = await openGraph();
      await ensureIntentVertex({
        g,
        projectId: ids.projectId,
        intentId: ids.intentId,
        title: `Local ${cli} E2E`,
        now: new Date().toISOString(),
      });
    } finally {
      await closeGraphSource(g);
    }
    return { ok: true, cli, ...ids };
  },

  async fresh() {
    assertCli();
    const result = await runLifecycleLeg({ selectedCli: cli });
    if (result.state !== 'WAITING_FOR_HUMAN' || !result.cliSessionId) {
      throw new Error(
        `fresh ${cli} did not park with a session id: ${JSON.stringify({
          state: result.state,
          reason: result.reason,
          hasSession: Boolean(result.cliSessionId),
        })}`,
      );
    }
    const gate = await latestGate(idsFor(cli).executionId, 'pending');
    if (!gate) throw new Error(`fresh ${cli} created no pending gate`);
    return {
      ok: true,
      cli,
      state: result.state,
      humanTaskId: gate.humanTaskId,
      hasSession: true,
    };
  },

  async answer() {
    assertCli();
    const ids = idsFor(cli);
    const gate = await latestGate(ids.executionId, 'pending');
    if (!gate) throw new Error(`no pending ${cli} gate to answer`);
    const stage = (await store.getExecutionRecords(ids.executionId)).stages[0];
    if (!stage?.cliSessionId) throw new Error(`${cli} stage has no session before answer`);
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...snapshotKey(ids.executionId),
          type: 'E2ESnapshot',
          cli,
          cliSessionId: stage.cliSessionId,
        },
      }),
    );
    await store.answerHumanTask({
      executionId: ids.executionId,
      humanTaskId: gate.humanTaskId,
      status: 'answered',
      answer: {
        perQuestion: [{ text: 'Should the local E2E continue?', answer: 'Proceed' }],
      },
      answeredBy: 'local-e2e',
      answeredByName: 'Local E2E',
    });
    await store.updateExecution({
      executionId: ids.executionId,
      status: 'RUNNING',
      pendingHumanTaskId: null,
    });
    return { ok: true, cli, humanTaskId: gate.humanTaskId };
  },

  async resume() {
    assertCli();
    const ids = idsFor(cli);
    const gate = await latestGate(ids.executionId, 'answered');
    if (!gate) throw new Error(`no answered ${cli} gate to resume`);
    const result = await runLifecycleLeg({
      selectedCli: cli,
      resumeFrom: gate.humanTaskId,
    });
    if (result.state !== 'SUCCEEDED') {
      throw new Error(
        `resume ${cli} failed: ${JSON.stringify({
          state: result.state,
          reason: result.reason,
          detail: result.detail,
        })}`,
      );
    }
    return { ok: true, cli, state: result.state };
  },

  async verify() {
    assertCli();
    const ids = idsFor(cli);
    const records = await store.getExecutionRecords(ids.executionId);
    const stage = records.stages[0];
    const { Item: snapshot } = await doc.send(
      new GetCommand({ TableName: tableName, Key: snapshotKey(ids.executionId) }),
    );
    if (stage?.state !== 'SUCCEEDED') throw new Error(`${cli} stage is ${stage?.state}`);
    if (stage.cli !== cli) throw new Error(`${cli} stage resumed with ${stage.cli}`);
    if (!snapshot?.cliSessionId || snapshot.cliSessionId !== stage.cliSessionId) {
      throw new Error(`${cli} did not preserve the same session id across containers`);
    }
    if (!records.outputs.some((row) => row.kind === 'text')) {
      throw new Error(`${cli} send_output row is missing`);
    }
    if (!records.metrics.some((row) => Number(row.metrics?.e2eLifecycle) === 1)) {
      throw new Error(`${cli} collect_metric row is missing`);
    }

    let g;
    let anchored = false;
    try {
      g = await openGraph();
      anchored = await g
        .V()
        .has('Intent', 'id', ids.intentId)
        .out('CONTAINS')
        .has('Artifact', 'id', ids.artifactId)
        .hasNext();
    } finally {
      await closeGraphSource(g);
    }
    if (!anchored) throw new Error(`${cli} artifact is not anchored to the Intent`);

    const { stdout } = await git([
      'ls-files',
      '.aidlc',
      '.claude',
      '.kiro',
      '.kiro-data',
      '.opencode-data',
    ]);
    if (stdout.trim()) throw new Error(`${cli} runtime state entered Git: ${stdout.trim()}`);
    return {
      ok: true,
      cli,
      state: stage.state,
      outputs: records.outputs.length,
      metrics: records.metrics.length,
      artifactAnchored: true,
      sessionPreserved: true,
    };
  },

  async cleanup() {
    assertCli();
    const ids = idsFor(cli);
    await store.deleteExecution(ids.executionId);
    await cleanupGraph(ids.intentId);
    return { ok: true, cli };
  },
};

try {
  if (!handlers[command]) throw new Error(`unknown command "${command || ''}"`);
  const result = await handlers[command]();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      command,
      cli: cli || null,
      error: error?.message ?? String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
