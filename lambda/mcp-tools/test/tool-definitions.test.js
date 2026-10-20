import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GATEWAY_TOOL_NAMES, gatewayToolDefinitions } from '../scripts/tool-definitions.js';
import { toolsForRole } from '../../shared/mcp/server.js';

const committed = JSON.parse(readFileSync(new URL('../gateway-tools.json', import.meta.url)));

describe('Gateway tool definitions', () => {
  it('match the committed target schema (run scripts/generate-gateway-tools.mjs)', () => {
    expect(committed).toEqual(gatewayToolDefinitions());
  });

  it('cover every tool any role or policy can register', () => {
    const policy = { summaryConfirmation: 'required', planApproval: 'required' };
    for (const role of ['author', 'reviewer', 'reader']) {
      for (const stageId of [null, 'workspace-detection']) {
        for (const name of toolsForRole(role, stageId, policy)) {
          expect(GATEWAY_TOOL_NAMES).toContain(name);
        }
      }
    }
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
