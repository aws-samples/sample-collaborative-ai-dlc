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
