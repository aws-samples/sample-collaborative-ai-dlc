// Agents Lambda — v1 agent HISTORY (read-only) + shared admin/model plumbing.
//
// The v1 execution engine (ECS pool dispatch) was removed when v2 became the
// only runtime: v1 projects are read-only, no new v1 executions can start.
// What remains here:
//   - GET  /projects/{projectId}/agents        — sprint agent status (read;
//     lazily settles any non-terminal state left behind by the retired engine)
//   - GET  /projects/{projectId}/agents/tasks  — per-task agent statuses (read)
//   - GET  /agents/{taskId}                    — execution status/output (read)
//   - GET  /agents/{taskId}/questions          — recorded agent questions (read)
//   - GET  /agents/capabilities                — CLI/model discovery for the v2
//     model picker (probes the AgentCore runtime; refreshes model-pricing SSM)
//   - GET/PUT /agents/settings                 — Admin CLI auth + model defaults
//     (SSM parameters consumed by the v2 AgentCore runtime and intents lambda)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';
import { requirePlatformAdmin, isPlatformAdmin } from '../shared/authz.js';
import { normalizeCliModels, parseCliModels } from '../shared/cli-models.js';
import { normalizeTierModels, parseTierModels } from '../shared/tier-models.js';
import { validateMcpServersJson } from '../shared/mcp-validator.js';
import { listClaudeModels } from '../shared/bedrock-models.js';
import { refreshPricing } from '../shared/model-pricing.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock = new BedrockClient({ region: process.env.AWS_REGION || 'us-east-1' });
const agentcore = new BedrockAgentCoreClient({ region: process.env.AWS_REGION || 'us-east-1' });
// The AWS Price List API only serves us-east-1 / ap-south-1 — pin to the nearest.
const pricing = new PricingClient({
  region: (process.env.AWS_REGION || '').startsWith('ap-') ? 'ap-south-1' : 'us-east-1',
});

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const { cardinality } = gremlin.process;

const RUNTIME_MODEL_OVERRIDE = {
  kiro: true,
  claude: true,
  opencode: true,
};
// The v2 AgentCore runtime ARN — the models endpoint invokes its `capabilities`
// command (the only source of Kiro's model list, which is CLI-native, not
// Bedrock, plus per-CLI install/auth state).
const AGENTCORE_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN || '';
// A session id >= 33 chars is required by InvokeAgentRuntime; the capabilities
// command is stateless so any stable id works.
const CAPABILITIES_SESSION_ID = 'aidlc-capabilities-probe-00000001';

// Fetch the runtime's capabilities (installed + authed CLIs, Kiro model list) by
// invoking its `capabilities` command. Best-effort: returns null when no v2
// runtime is configured or the invoke fails, so the endpoint still returns
// Bedrock models + SSM auth state.
const fetchRuntimeCapabilities = async () => {
  if (!AGENTCORE_RUNTIME_ARN) return null;
  try {
    const res = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: AGENTCORE_RUNTIME_ARN,
        runtimeSessionId: CAPABILITIES_SESSION_ID,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify({ command: 'capabilities' })),
      }),
    );
    const text = res.response ? await res.response.transformToString() : '';
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error('[capabilities] runtime invoke failed:', e.message);
    return null;
  }
};

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';
  const credentials = await fromNodeProviderChain()();
  credentials.region = region;
  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

async function withNeptune(fn) {
  const conn = await getConnection();
  try {
    const g = traversal().withRemote(conn);
    return await fn(g);
  } finally {
    await conn.close();
  }
}

function modelPricingPath() {
  const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
  return prefix ? `${prefix}/model-pricing` : '';
}

// Fetch all Anthropic-on-Bedrock token SKUs from the AWS Price List API.
// Paginated; returns the flat PriceList array the shared parser expects.
async function fetchBedrockProducts() {
  const products = [];
  let token;
  do {
    const res = await pricing.send(
      new GetProductsCommand({
        ServiceCode: 'AmazonBedrock',
        Filters: [{ Type: 'TERM_MATCH', Field: 'provider', Value: 'Anthropic' }],
        NextToken: token,
      }),
    );
    products.push(...(res.PriceList ?? []));
    token = res.NextToken;
  } while (token);
  return products;
}

// Refresh the SSM model-pricing table from the Price List API. Best-effort: the
// intents lambda reads this table (with a static fallback), so a failed refresh
// just means cost is priced from the fallback until the next successful refresh.
// Piggy-backs on the model-discovery call (GET /agents/capabilities?models=1) so
// prices track whatever models the picker can select, without a separate cron.
async function refreshModelPricing() {
  const path = modelPricingPath();
  if (!path) return;
  try {
    const table = await refreshPricing({ getProducts: fetchBedrockProducts });
    await ssm.send(
      new PutParameterCommand({
        Name: path,
        Value: JSON.stringify(table),
        Type: 'String',
        Overwrite: true,
      }),
    );
  } catch (e) {
    console.error('[pricing] refresh failed:', e.message);
  }
}

// --- Handler ---

export const handler = async (event) => {
  const response = buildResponse(event);
  const { httpMethod, path = '', pathParameters, body } = event;
  const projectId = pathParameters?.projectId;
  const taskId = pathParameters?.taskId ? decodeURIComponent(pathParameters.taskId) : null;

  try {
    // ===== AGENT SETTINGS (SSM-backed, editable via Admin UI) =====

    // GET /agents/settings — read bearer token, Kiro API key, and model defaults from SSM
    if (httpMethod === 'GET' && path.endsWith('/settings')) {
      const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
      const bearerPath = `${prefix}/bedrock-bearer-token`;
      const kiroApiKeyPath = `${prefix}/kiro-api-key`;
      const cliModelsPath = `${prefix}/cli-models`;
      const tierModelsPath = `${prefix}/tier-models`;
      const deriveEnrichmentPath = `${prefix}/derive-enrichment`;
      const customMcpServersPath = `${prefix}/custom-mcp-servers`;
      const stageSkippingPath = `${prefix}/stage-skipping`;
      const composeLlmBypassPath = `${prefix}/compose-llm-bypass`;
      try {
        const result = await ssm.send(
          new GetParametersCommand({
            Names: [
              bearerPath,
              kiroApiKeyPath,
              cliModelsPath,
              tierModelsPath,
              deriveEnrichmentPath,
              customMcpServersPath,
              stageSkippingPath,
              composeLlmBypassPath,
            ],
            WithDecryption: true,
          }),
        );
        const byName = {};
        for (const p of result.Parameters || []) byName[p.Name] = p.Value;
        const bearerToken = byName[bearerPath] || '';
        const kiroApiKey = byName[kiroApiKeyPath] || '';
        const cliModels = parseCliModels(byName[cliModelsPath] || '{}');
        // Tier-model config: per-agent-tier model rows (judgment/balanced/
        // templated) + the fallback and Quorum rows (shared/tier-models.js).
        const tierModels = parseTierModels(byName[tierModelsPath] || '{}');
        const deriveEnrichment = byName[deriveEnrichmentPath] === 'llm' ? 'llm' : 'off';
        // Platform stage-skipping toggle (shared/stage-skip.js): fail-safe to
        // 'disabled' — anything but an explicit 'enabled' means off.
        const stageSkipping = byName[stageSkippingPath] === 'enabled' ? 'enabled' : 'disabled';
        // Composer LLM bypass: when 'enabled' (default) a clean keyword match
        // answers a front compose deterministically without an LLM call;
        // 'disabled' forces every compose through the composer agent.
        const composeLlmBypass =
          byName[composeLlmBypassPath] === 'disabled' ? 'disabled' : 'enabled';
        // Custom MCP servers may carry secrets in env/headers — only expose the
        // raw config to platform admins (the only ones who can edit it). Others
        // get an empty object so the non-secret settings fields still load.
        const rawCustomMcp = byName[customMcpServersPath] || '{}';
        const customMcpServers = isPlatformAdmin(event) ? rawCustomMcp : '{}';
        // Server NAMES only (no command/env/headers) are non-sensitive, so any
        // authenticated caller gets them — lets the project MCP UI show which
        // servers are already provided globally.
        let customMcpServerNames = [];
        try {
          const parsedMcp = JSON.parse(rawCustomMcp);
          if (parsedMcp && typeof parsedMcp === 'object' && !Array.isArray(parsedMcp)) {
            customMcpServerNames = Object.keys(parsedMcp);
          }
        } catch {
          customMcpServerNames = [];
        }
        // Return secrets as masked flags (never send the raw values to the browser)
        return response(200, {
          bedrockBearerTokenSet: bearerToken !== '' && bearerToken !== 'placeholder',
          kiroApiKeySet: kiroApiKey !== '' && kiroApiKey !== 'placeholder',
          cliModels,
          tierModels,
          deriveEnrichment,
          stageSkipping,
          composeLlmBypass,
          customMcpServers,
          customMcpServerNames,
        });
      } catch (err) {
        console.error('[settings] GET failed:', err.message);
        return response(500, { error: 'Failed to load settings from SSM' });
      }
    }

    // PUT /agents/settings — write bearer token, Kiro API key, and/or model defaults to SSM
    if (httpMethod === 'PUT' && path.endsWith('/settings')) {
      const denied = requirePlatformAdmin(event);
      if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });
      const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
      const input = JSON.parse(body || '{}');
      const errors = [];

      if (typeof input.bedrockBearerToken === 'string') {
        // Empty string clears the token (stored as literal "placeholder" sentinel)
        const value = input.bedrockBearerToken.trim() || 'placeholder';
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/bedrock-bearer-token`,
              Value: value,
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write bearer token:', err.message);
          errors.push('bedrockBearerToken: ' + err.message);
        }
      }

      if (typeof input.kiroApiKey === 'string') {
        const value = input.kiroApiKey.trim() || 'placeholder';
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/kiro-api-key`,
              Value: value,
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write Kiro API key:', err.message);
          errors.push('kiroApiKey: ' + err.message);
        }
      }

      if (input.cliModels !== undefined) {
        const validation = normalizeCliModels(input.cliModels);
        if (!validation.valid) {
          return response(400, {
            error: 'Invalid CLI model configuration',
            issues: validation.issues,
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/cli-models`,
              Value: JSON.stringify(validation.value),
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write CLI models:', err.message);
          errors.push('cliModels: ' + err.message);
        }
      }

      if (input.tierModels !== undefined) {
        // Tier-model config: what model each agent tier (judgment/balanced/
        // templated) runs per CLI, plus the fallback row (no tier resolvable)
        // and the Quorum row (discussion/edit one-shots). Validated with the
        // same per-CLI rules as the flat map.
        const validation = normalizeTierModels(input.tierModels);
        if (!validation.valid) {
          return response(400, {
            error: 'Invalid tier model configuration',
            issues: validation.issues,
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/tier-models`,
              Value: JSON.stringify(validation.value),
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write tier models:', err.message);
          errors.push('tierModels: ' + err.message);
        }
      }

      if (input.deriveEnrichment !== undefined) {
        // Derive-time graph enrichment mode. Strict allowlist: it gates model
        // spend (one bounded CLI call per approved artifact when "llm").
        if (input.deriveEnrichment !== 'off' && input.deriveEnrichment !== 'llm') {
          return response(400, {
            error: 'Invalid deriveEnrichment value',
            issues: ['deriveEnrichment must be "off" or "llm"'],
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/derive-enrichment`,
              Value: input.deriveEnrichment,
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write derive enrichment mode:', err.message);
          errors.push('deriveEnrichment: ' + err.message);
        }
      }

      if (input.stageSkipping !== undefined) {
        // Platform stage-skipping toggle (shared/stage-skip.js): gates whether
        // intents may deselect CONDITIONAL stages at create and whether
        // validation gates offer "skip to stage X". Snapshotted per intent at
        // create — flipping this never changes an in-flight run.
        if (input.stageSkipping !== 'enabled' && input.stageSkipping !== 'disabled') {
          return response(400, {
            error: 'Invalid stageSkipping value',
            issues: ['stageSkipping must be "enabled" or "disabled"'],
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/stage-skipping`,
              Value: input.stageSkipping,
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write stage skipping mode:', err.message);
          errors.push('stageSkipping: ' + err.message);
        }
      }

      if (input.composeLlmBypass !== undefined) {
        // Composer LLM bypass toggle: 'enabled' lets a clean keyword match
        // answer a front compose without the LLM; 'disabled' routes every
        // compose through the composer agent.
        if (input.composeLlmBypass !== 'enabled' && input.composeLlmBypass !== 'disabled') {
          return response(400, {
            error: 'Invalid composeLlmBypass value',
            issues: ['composeLlmBypass must be "enabled" or "disabled"'],
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/compose-llm-bypass`,
              Value: input.composeLlmBypass,
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write compose LLM bypass mode:', err.message);
          errors.push('composeLlmBypass: ' + err.message);
        }
      }

      if (input.customMcpServers !== undefined) {
        // Global custom MCP servers injected into every agent session (merged
        // with project-level entries at intent-create; project wins by name).
        const raw =
          typeof input.customMcpServers === 'string'
            ? input.customMcpServers
            : JSON.stringify(input.customMcpServers ?? {});
        const validation = validateMcpServersJson(raw || '{}');
        if (!validation.valid) {
          return response(400, {
            error: 'Invalid MCP servers configuration',
            issues: validation.issues,
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/custom-mcp-servers`,
              Value: raw || '{}',
              // SecureString: the config may carry secrets in env/headers. Note
              // the project-tier equivalent lives on the Neptune vertex and is
              // NOT encrypted (documented tradeoff — treat projects as trusted).
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write custom MCP servers:', err.message);
          errors.push('customMcpServers: ' + err.message);
        }
      }

      if (errors.length > 0) return response(500, { error: errors.join('; ') });
      return response(200, { saved: true });
    }

    // GET /agents/capabilities — CLI availability + (with ?models=1) the model
    // catalog for the v2 project-settings model picker:
    //   models.claude / models.opencode — region-valid Bedrock inference profiles
    //   models.kiro                     — Kiro-native models (from the runtime)
    //   runtimeClis                     — per-CLI {installed, authed, available}
    //                                     from the v2 AgentCore runtime
    // The v2 AgentCore runtime is the sole authority for CLI availability.
    if (httpMethod === 'GET' && path.endsWith('/capabilities')) {
      if (event.queryStringParameters?.models !== '1') {
        const caps = await fetchRuntimeCapabilities();
        const available = (caps?.clis ?? [])
          .filter((c) => c.available)
          .map((c) => c.cli)
          .filter(Boolean);
        return response(200, { available, runtimeModelOverride: RUNTIME_MODEL_OVERRIDE });
      }

      // Piggy-back a pricing refresh on model discovery so the SSM price table
      // tracks the selectable models. Fire-and-forget: never blocks or fails the
      // models response (the intents read path has a static fallback regardless).
      refreshModelPricing().catch(() => {});

      // Bedrock (claude/opencode) + runtime (kiro + auth state) discovery, in
      // parallel. Both are best-effort — a failure yields empty models, never a 500.
      const [claudeModels, runtimeCaps] = await Promise.all([
        listClaudeModels({
          listInferenceProfiles: async () => {
            const out = await bedrock.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
            return out.inferenceProfileSummaries ?? [];
          },
        }),
        fetchRuntimeCapabilities(),
      ]);
      const kiroModels = runtimeCaps?.kiroModels?.models ?? [];
      // OpenCode drives the SAME Bedrock profiles as claude but requires the
      // `amazon-bedrock/` provider prefix (see cli-models validation).
      const opencodeModels = claudeModels.map((m) => ({
        ...m,
        id: `amazon-bedrock/${m.id}`,
      }));
      const available = (runtimeCaps?.clis ?? [])
        .filter((c) => c.available)
        .map((c) => c.cli)
        .filter(Boolean);
      return response(200, {
        available,
        runtimeModelOverride: RUNTIME_MODEL_OVERRIDE,
        // Per-CLI availability from the v2 runtime (installed + authed).
        runtimeClis: runtimeCaps?.clis ?? null,
        models: {
          claude: claudeModels,
          opencode: opencodeModels,
          kiro: kiroModels,
        },
      });
    }

    // ===== V1 AGENT HISTORY (read-only) =====

    // GET /projects/{projectId}/agents/tasks - Per-task agent status for construction
    if (httpMethod === 'GET' && path.endsWith('/agents/tasks') && projectId) {
      const sprintId = event.queryStringParameters?.sprintId;
      if (!sprintId) return response(400, { error: 'sprintId query parameter required' });
      return await withNeptune(async (g) => {
        const tasks = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .valueMap(true)
          .toList();
        const taskStatuses = tasks.map((t) => {
          const props = {};
          t.forEach((v, k) => {
            props[k] = Array.isArray(v) ? v[0] : v;
          });
          return {
            taskId: props.id,
            title: props.title,
            status: props.status,
            executionId: props.task_execution_id || null,
            executionArn: props.task_execution_arn || null,
            executionStatus: props.task_execution_status || null,
          };
        });
        return response(200, { tasks: taskStatuses });
      });
    }

    // GET /projects/{projectId}/agents
    //
    // Historical status read. The execution engine is gone, so nothing can be
    // RUNNING anymore — but sprints abandoned mid-run by the retired engine may
    // still carry a non-terminal current_agent_status. This read lazily settles
    // such rows: the recorded final status from agent-outputs wins; anything
    // else is marked failed so the UI never shows a perpetual spinner.
    if (httpMethod === 'GET' && path.endsWith('/agents') && projectId) {
      const sprintId = event.queryStringParameters?.sprintId;

      return await withNeptune(async (g) => {
        // Use Sprint vertex if sprintId provided, otherwise fallback to Project
        const vertexLabel = sprintId ? 'Sprint' : 'Project';
        const vertexId = sprintId || projectId;

        const result = await g.V().has(vertexLabel, 'id', vertexId).valueMap().next();
        const v = result.value;
        if (!v) return response(200, { executionArn: null, executionId: null, status: null });

        const arn = v?.get?.('current_execution_arn')?.[0] || null;
        const execId = v?.get?.('current_execution_id')?.[0] || null;
        const currentStatus = v?.get?.('current_agent_status')?.[0] || null;

        if (!arn) return response(200, { executionArn: null, executionId: null, status: null });

        // Helper to write terminal status to Sprint and AgentRun nodes
        const writeTerminalStatus = async (statusStr, execIdForRun) => {
          const completedAt = new Date().toISOString();
          await g
            .V()
            .has(vertexLabel, 'id', vertexId)
            .property(cardinality.single, 'current_agent_status', statusStr)
            .property(cardinality.single, 'agent_completed_at', completedAt)
            .next();
          if (execIdForRun) {
            await g
              .V()
              .hasLabel('AgentRun')
              .has('execution_id', execIdForRun)
              .property(cardinality.single, 'status', statusStr)
              .property(cardinality.single, 'completed_at', completedAt)
              .next()
              .catch(() => {});
          }
        };

        // The recorded final status from agent-outputs is authoritative.
        if (process.env.AGENT_OUTPUTS_TABLE && execId) {
          const outputQuery = await ddb.send(
            new QueryCommand({
              TableName: process.env.AGENT_OUTPUTS_TABLE,
              KeyConditionExpression: 'executionId = :eid',
              ExpressionAttributeValues: { ':eid': execId },
              Limit: 1,
            }),
          );
          const outputItem = outputQuery.Items?.[0];
          if (outputItem) {
            const s = outputItem.status;
            const mapped = s === 'completed' ? 'SUCCEEDED' : s === 'failed' ? 'FAILED' : 'FAILED';
            const statusStr = mapped.toLowerCase();
            if (statusStr !== currentStatus) {
              await writeTerminalStatus(statusStr, execId);
            }
            return response(200, { executionArn: arn, executionId: execId, status: mapped });
          }
        }

        // No recorded output: the run was lost with the retired engine. Settle
        // any non-terminal state as failed.
        const TERMINAL = ['succeeded', 'failed', 'cancelled'];
        if (currentStatus && TERMINAL.includes(currentStatus)) {
          return response(200, {
            executionArn: arn,
            executionId: execId,
            status: currentStatus.toUpperCase(),
          });
        }
        await writeTerminalStatus('failed', execId);
        return response(200, { executionArn: arn, executionId: execId, status: 'FAILED' });
      });
    }

    // GET /agents/{taskId}/questions
    if (httpMethod === 'GET' && taskId && path.endsWith('/questions')) {
      const result = await ddb.send(
        new QueryCommand({
          TableName: process.env.QUESTIONS_TABLE,
          IndexName: 'AgentTaskIdIndex',
          KeyConditionExpression: 'agentTaskId = :taskId',
          ExpressionAttributeValues: { ':taskId': taskId },
        }),
      );
      return response(200, { questions: result.Items });
    }

    // GET /agents/{taskId}
    if (httpMethod === 'GET' && taskId) {
      // taskId may be an executionId (exec-...) or a legacy ECS task ARN
      if (process.env.AGENT_OUTPUTS_TABLE) {
        // Try taskId directly as executionId
        let outputQuery = await ddb.send(
          new QueryCommand({
            TableName: process.env.AGENT_OUTPUTS_TABLE,
            KeyConditionExpression: 'executionId = :eid',
            ExpressionAttributeValues: { ':eid': taskId },
            Limit: 1,
          }),
        );
        // Also try the executionId query param if provided
        if (!outputQuery.Items?.length && event.queryStringParameters?.executionId) {
          outputQuery = await ddb.send(
            new QueryCommand({
              TableName: process.env.AGENT_OUTPUTS_TABLE,
              KeyConditionExpression: 'executionId = :eid',
              ExpressionAttributeValues: { ':eid': event.queryStringParameters.executionId },
              Limit: 1,
            }),
          );
        }
        const outputItem = outputQuery.Items?.[0];
        if (outputItem) {
          const s = outputItem.status;
          const mapped = s === 'completed' ? 'SUCCEEDED' : s === 'failed' ? 'FAILED' : 'FAILED';
          return response(200, {
            status: mapped,
            executionArn: taskId,
            outputText: outputItem.outputText,
            errorMessage: outputItem.errorMessage,
          });
        }
      }
      // No recorded output — the run predates output tracking or was lost with
      // the retired engine. Nothing can be running anymore.
      return response(200, { status: 'FAILED', executionArn: taskId });
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
