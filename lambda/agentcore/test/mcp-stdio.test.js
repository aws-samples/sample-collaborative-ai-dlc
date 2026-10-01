import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entrypoint = fileURLToPath(new URL('../mcp/index.js', import.meta.url));
const clients = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

describe('MCP stdio transport', () => {
  it('keeps startup and tool-trace diagnostics off the JSON-RPC stdout stream', async () => {
    const protocolErrors = [];
    const stderr = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      stderr: 'pipe',
      env: {
        AWS_ACCESS_KEY_ID: 'stdio-regression',
        AWS_SECRET_ACCESS_KEY: 'stdio-regression',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:9',
        AWS_MAX_ATTEMPTS: '1',
        AWS_REGION: 'us-east-1',
        POWERTOOLS_SERVICE_NAME: 'collaborative-aidlc',
        V2_EXECUTION_ID: 'stdio-regression-execution',
        V2_INTENT_ID: 'stdio-regression-intent',
        V2_PROJECT_ID: 'stdio-regression-project',
        V2_PROCESS_TABLE: 'stdio-regression-unused',
        V2_MCP_ROLE: 'author',
      },
    });
    transport.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

    const client = new Client({ name: 'stdio-regression-client', version: '1.0.0' });
    clients.push(client);
    client.onerror = (error) => protocolErrors.push(error);

    await client.connect(transport);
    const result = await client.listTools();
    const call = await client.callTool({
      name: 'collect_metric',
      arguments: { metrics: { tokensInput: 1 } },
    });

    expect(result.tools.length).toBeGreaterThan(0);
    expect(call.isError).toBe(true);
    expect(protocolErrors).toEqual([]);
    expect(stderr.join('')).toContain('[agentcore-mcp] connected');
    expect(stderr.join('')).toContain('[mcp-trace] collect_metric');
  }, 10_000);
});
