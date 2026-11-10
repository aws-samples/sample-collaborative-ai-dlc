import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GATEWAY_TOOL_NAMES, gatewayToolDefinitions } from '../scripts/tool-definitions.js';
import { toolsForRole } from '../../shared/mcp/server.js';

const committed = JSON.parse(readFileSync(new URL('../gateway-tools.json', import.meta.url)));

describe('Gateway tool definitions', () => {
  it('match the committed target schema (run scripts/generate-gateway-tools.mjs)', () => {
    expect(committed).toEqual(gatewayToolDefinitions());
  });

  it('cover every tool any role, policy or session option can register', () => {
    const policy = { summaryConfirmation: 'required', planApproval: 'required' };
    const sessionOptions = [{}, { checkpointOwner: true, canAsk: true, describeChanges: true }];
    for (const role of ['author', 'reviewer', 'reader']) {
      for (const stageId of [null, 'workspace-detection']) {
        for (const options of sessionOptions) {
          for (const name of toolsForRole(role, stageId, policy, options)) {
            expect(GATEWAY_TOOL_NAMES).toContain(name);
          }
        }
      }
    }
  });

  it('register describe_changes on the target for stage owner sessions', () => {
    const owner = toolsForRole('author', null, null, { describeChanges: true });
    expect(owner).toContain('describe_changes');
    expect(committed.map((tool) => tool.name)).toContain('describe_changes');
  });

  it('use only the schema keywords Gateway accepts and fit its inline limit', () => {
    const allowed = new Set(['type', 'description', 'properties', 'required', 'items']);
    const walk = (schema) => {
      for (const key of Object.keys(schema)) expect(allowed).toContain(key);
      Object.values(schema.properties ?? {}).forEach(walk);
      if (schema.items) walk(schema.items);
    };
    committed.forEach((tool) => {
      expect(tool.inputSchema.type).toBe('object');
      walk(tool.inputSchema);
    });
    expect(Buffer.byteLength(JSON.stringify(committed))).toBeLessThan(1_000_000);
  });
});
