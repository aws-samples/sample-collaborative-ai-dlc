import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { makeDdb, createV2Table, deleteV2Table } from './helpers/v2-table.js';
import { localE2eModelFor, normalizeLocalE2eClis } from './local-e2e-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  path.join(here, '..', '..', '..', 'scripts', 'agent-e2e-testing.sh'),
  'utf8',
);
const harness = readFileSync(path.join(here, 'local-e2e-harness.mjs'), 'utf8');
const dockerignore = readFileSync(path.join(here, '..', '..', '.dockerignore'), 'utf8');

describe('local E2E configuration', () => {
  it('routes the runtime process client to DynamoDB Local', async () => {
    const tableName = `aidlc-e2e-client-${process.pid}-${Date.now()}`;
    const { client } = makeDdb();
    try {
      await createV2Table(client, tableName);
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: 'LOCAL', sk: 'MCP', value: 'reachable' },
        }),
      );
      await expect(
        ddb.send(new GetCommand({ TableName: tableName, Key: { pk: 'LOCAL', sk: 'MCP' } })),
      ).resolves.toMatchObject({ Item: { value: 'reachable' } });
    } finally {
      await deleteV2Table(client, tableName);
      client.destroy();
    }
  });

  it('filters, deduplicates, and validates requested CLIs', () => {
    expect(normalizeLocalE2eClis(' opencode,claude,opencode ')).toEqual(['opencode', 'claude']);
    expect(() => normalizeLocalE2eClis('cursor')).toThrow(/unsupported/);
    expect(() => normalizeLocalE2eClis(' , ')).toThrow(/no E2E CLIs/);
  });

  it('maps OpenCode to the Bedrock provider namespace and preserves Kiro models', () => {
    expect(
      localE2eModelFor({
        cli: 'opencode',
        bedrockModel: 'us.anthropic.claude-sonnet-4-6',
      }),
    ).toBe('amazon-bedrock/us.anthropic.claude-sonnet-4-6');
    expect(
      localE2eModelFor({
        cli: 'opencode',
        bedrockModel: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
      }),
    ).toBe('amazon-bedrock/us.anthropic.claude-sonnet-4-6');
    expect(localE2eModelFor({ cli: 'kiro', kiroModel: 'auto' })).toBe('auto');
  });

  it('gives Codex its own openai.* model, never the Bedrock/Kiro values', () => {
    expect(localE2eModelFor({ cli: 'codex' })).toBe('openai.gpt-5.5');
    expect(
      localE2eModelFor({
        cli: 'codex',
        bedrockModel: 'us.anthropic.claude-sonnet-4-6',
        codexModel: 'openai.gpt-5.6-sol',
      }),
    ).toBe('openai.gpt-5.6-sol');
    expect(normalizeLocalE2eClis('codex')).toEqual(['codex']);
  });
});

describe('local E2E shell safety contract', () => {
  it('uses a restrictive mounted secret file and always deletes it in the trap', () => {
    expect(script).toContain('umask 077');
    expect(script).toContain('chmod 600 "$SECRET_FILE"');
    expect(script).toContain('$SECRET_FILE:/run/secrets/aidlc-e2e.env:ro');
    expect(script).toContain('rm -f "$SECRET_FILE"');
    expect(script).not.toMatch(/--env ["']?AWS_BEARER_TOKEN_BEDROCK/);
    expect(script).not.toMatch(/--env ["']?KIRO_API_KEY/);
  });

  it('uses a DynamoDB Local-compatible inert access key', () => {
    const accessKey = script.match(/AWS_ACCESS_KEY_ID=([^"]+)/)?.[1];
    expect(accessKey).toMatch(/^[A-Za-z0-9_]+$/);
    expect(script).not.toContain('local-inert');
  });

  it('continues per CLI, records flat results, and has no deployed-stack dependency', () => {
    expect(script).toContain('SELECTED_CLI_COUNT=0');
    expect(script).toContain('if [ "$SELECTED_CLI_COUNT" -gt 0 ]; then');
    expect(script).toContain('for cli in "${SELECTED_CLIS[@]}"');
    expect(script).toContain('run_harness "$cli" report "$volume"');
    expect(script).toContain('generate-agent-output-fixtures.mjs');
    expect(script).toContain('set_result "$cli" "FAIL"');
    expect(script).toContain('Claude:');
    expect(script).toContain('OpenCode:');
    expect(script).toContain('Codex:');
    expect(script).not.toContain('phaseb.sh');
    expect(script).not.toContain('API_BASE_URL');
    expect(script).not.toContain('E2E_ID_TOKEN');
  });

  it('includes the internal harness dependency closure in the AgentCore image', () => {
    expect(dockerignore).toContain('!agentcore/test/local-e2e-harness.mjs');
    expect(dockerignore).toContain('!agentcore/test/local-e2e-config.js');
    expect(dockerignore).toContain('!agentcore/test/helpers/v2-table.js');
  });

  it('uses Gremlin 3.7-compatible cleanup terminals', () => {
    expect(harness).toContain('.drop().next()');
    expect(harness).not.toContain('.drop().iterate()');
  });

  it('verifies parsed edits and server timestamps and exposes normalized reports', () => {
    expect(harness).toContain("row.display?.type === 'edit'");
    expect(harness).toContain('output row has no valid server timestamp');
    expect(harness).toContain('numbered patch line leaked through as a message event');
    expect(harness).toContain('async report()');
  });
});
