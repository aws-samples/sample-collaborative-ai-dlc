import { describe, expect, it } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { beginCredentialInvocation } from '../invocation-accounting.js';
import { INVOCATION_ACCOUNTING_TTL_SECONDS } from '../invocation-accounting-ticket.js';
import { isMaterialAuthInventoryRow } from '../agent-auth-inventory.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');

const recordingDdb = () => {
  const writes = [];
  return {
    writes,
    send: async (command) => {
      if (command instanceof TransactWriteCommand) {
        writes.push(...command.input.TransactItems);
        return {};
      }
      return { Item: undefined };
    },
  };
};

describe('beginCredentialInvocation retention', () => {
  it('gives an abandoned invocation and its inventory references a TTL past the ticket lifetime', async () => {
    const ddb = recordingDdb();
    await beginCredentialInvocation({
      ddb,
      tableName: 'v2',
      id: 'inv-1',
      now: () => NOW,
      payload: { projectId: 'p-1', executionId: 'e-1', command: 'run-stage' },
      bindings: [{ scope: 'project', projectId: 'p-1', profileId: 'prof-1' }],
    });

    const expected = Math.floor(NOW / 1000) + INVOCATION_ACCOUNTING_TTL_SECONDS + 86400;
    const invocation = ddb.writes.find((w) => w.Put?.Item.type === 'AgentInvocation').Put.Item;
    expect(invocation.agentAuthTtl).toBe(expected);
    const references = ddb.writes
      .filter((w) => w.Put?.Item.type === 'AgentAuthInventoryReference')
      .map((w) => w.Put.Item);
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((r) => r.agentAuthTtl === expected)).toBe(true);

    // Still material while its ticket can heartbeat or finish, not after.
    expect(isMaterialAuthInventoryRow(invocation, NOW + 1000)).toBe(true);
    expect(
      isMaterialAuthInventoryRow(invocation, NOW + INVOCATION_ACCOUNTING_TTL_SECONDS * 1000),
    ).toBe(false);
  });
});
