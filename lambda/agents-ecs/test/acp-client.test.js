import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const acpClient = readFileSync(new URL('../acp-client.js', import.meta.url), 'utf8');

// acp-client.js runs main() at import time (it is the container entrypoint),
// so these invariants are pinned at source level, matching the conventions of
// this workspace's tests (see pool-worker.test.js).
describe('acp-client connection-cache token expiry (plan §4a, review round 4)', () => {
  it('caches {connectionId, tokenExp} pairs instead of bare connection IDs', () => {
    // The cache fill must project tokenExp alongside connectionId.
    expect(acpClient).toMatch(
      /connectionId:\s*item\.connectionId\.S,\s*\n\s*tokenExp:\s*item\.tokenExp\?\.N/,
    );
    // The legacy bare-ID mapping must be gone.
    expect(acpClient).not.toMatch(/\.map\(\(item\) => item\.connectionId\.S\)/);
  });

  it('applies the liveness filter per send in broadcastEvent, not at cache-fill time', () => {
    const broadcastEventSrc = acpClient.slice(
      acpClient.indexOf('function broadcastEvent('),
      acpClient.indexOf('// Text chunk batching'),
    );
    expect(broadcastEventSrc).toContain('isTokenLive(');

    const getConnectionsSrc = acpClient.slice(
      acpClient.indexOf('async function getConnections('),
      acpClient.indexOf('function broadcastEvent('),
    );
    expect(getConnectionsSrc).not.toContain('isTokenLive(');
  });

  it('treats rows without tokenExp as live (pre-enforcement legacy grace)', () => {
    expect(acpClient).toMatch(
      /function isTokenLive\([\s\S]*?if \(tokenExp === undefined \|\| tokenExp === null \|\| tokenExp === ''\) return true;/,
    );
  });
});

describe('acp-client discussion-assist integration (plan §6/§8)', () => {
  it('includes executionId in EVERY broadcast payload (stream correlation)', () => {
    expect(acpClient).toMatch(
      /const payload = JSON\.stringify\(\{\s*type,\s*agentTaskId: env\.agentTaskId \|\| undefined,\s*executionId: env\.executionId,/,
    );
  });

  it('gates the Sprint completion-status write on phase !== discussion', () => {
    expect(acpClient).toContain("if (env.sprintId && env.agentType !== 'discussion')");
  });

  it('runs the fallback-post guard before saving completed status', () => {
    const successPath = acpClient.slice(
      acpClient.indexOf("console.log('[acp] Prompt completed')"),
      acpClient.indexOf("broadcastEvent('agent.completed'"),
    );
    expect(successPath).toContain('await fallbackPostDiscussionReply()');
    // The fallback checks the MCP marker file and the discussion phase.
    expect(acpClient).toMatch(/discussion-posted-\$\{env\.executionId\}/);
    expect(acpClient).toMatch(
      /if \(env\.agentType !== 'discussion' \|\| !env\.discussionId\) return;/,
    );
  });

  it('forwards the discussion context to the graph MCP server', () => {
    for (const name of [
      'DISCUSSION_ID',
      'DISCUSSION_COMMAND',
      'DISCUSSION_REQUESTED_BY',
      'DISCUSSION_REQUESTED_BY_NAME',
    ]) {
      expect(acpClient).toContain(`{ name: '${name}', value: env.`);
    }
  });
});
