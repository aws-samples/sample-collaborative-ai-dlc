import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForAuthParentDns } from '../wait-for-auth-parent-dns.mjs';

test('checks the immediate parent A record without requiring the new auth record', async () => {
  const queries = [];
  const parent = await waitForAuthParentDns('auth.review.example.com', {
    lookup: async (name) => {
      queries.push(name);
      return ['192.0.2.10'];
    },
  });
  assert.equal(parent, 'review.example.com');
  assert.deepEqual(queries, ['review.example.com']);
});

test('waits for a newly created parent record to propagate before allowing Cognito creation', async () => {
  let calls = 0;
  const waits = [];
  const parent = await waitForAuthParentDns('auth.review.example.com', {
    attempts: 3,
    lookup: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('not propagated'), { code: 'ENOTFOUND' });
      if (calls === 2) return [];
      return ['192.0.2.10'];
    },
    delay: async (ms) => waits.push(ms),
  });
  assert.equal(parent, 'review.example.com');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5000, 5000]);
});

test('fails with the required parent name when no A record becomes available', async () => {
  let waits = 0;
  await assert.rejects(
    waitForAuthParentDns('auth.review.example.com', {
      attempts: 2,
      lookup: async () => {
        throw Object.assign(new Error('AAAA-only or missing parent'), { code: 'ENODATA' });
      },
      delay: async () => waits++,
    }),
    /public DNS A record for review\.example\.com/,
  );
  assert.equal(waits, 1);
});

test('rejects malformed domain input and unexpected resolver failures', async () => {
  await assert.rejects(waitForAuthParentDns('https://auth.example.com'), /bare lowercase hostname/);
  await assert.rejects(
    waitForAuthParentDns('auth.example.com', {
      lookup: async () => {
        throw Object.assign(new Error('resolver configuration failed'), { code: 'EINVAL' });
      },
    }),
    /resolver configuration failed/,
  );
});
