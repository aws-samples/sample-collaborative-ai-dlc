// Pinned installed Codex's public app-server pagination/fork protocol.
// Invoked as a child of runNativeCommand, so its app-server is also owned/reaped.
// Only counts, IDs and hashes leave this process; no history bodies are reported.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { localProviderInvocation } from './native-qualification-provider.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { project, url, sessionId, forkId, createFork } = JSON.parse(input);
const invocation = localProviderInvocation(
  'codex',
  {
    command: '/usr/local/bin/codex',
    args: ['app-server'],
    env: process.env,
  },
  url,
);
const child = spawn(invocation.command, invocation.args, {
  cwd: project,
  env: invocation.env,
  stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let sequence = 0;
let count = 0;
let check = 'startup';
const reader = createInterface({ input: child.stdout });
reader.on('line', (line) => {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('codex_page_bound');
  const message = JSON.parse(line);
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
});
const rpc = async (method, params) => {
  check = method;
  assert.ok(++count <= 64, 'Bounded page requests');
  const id = ++sequence;
  const response = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const message = await response;
  assert.ok(!message.error, `Codex ${method} rejected`);
  return message.result;
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const pages = async (threadId) => {
  await rpc('thread/resume', { threadId, excludeTurns: true });
  const turns = [];
  const cursors = new Set();
  let cursor;
  let pageCount = 0;
  do {
    const page = await rpc('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'asc',
      itemsView: 'full',
      ...(cursor ? { cursor } : {}),
    });
    check = 'nonempty-page';
    assert.equal(page.data.length, 1, 'A genuine nonempty installed page');
    turns.push(...page.data);
    pageCount++;
    cursor = page.nextCursor;
    assert.ok(!cursor || !cursors.has(cursor), 'Pagination makes progress');
    cursors.add(cursor);
  } while (cursor);
  assert.ok(pageCount >= 2, 'History actually spans pages');
  return { pages: pageCount, turns: turns.length, sha256: digest(turns) };
};
try {
  await rpc('initialize', {
    clientInfo: { name: 'native-qualification', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  let selectedFork = forkId;
  if (createFork) {
    const fork = await rpc('thread/fork', { threadId: sessionId, excludeTurns: true });
    selectedFork = fork.thread.id;
    assert.notEqual(selectedFork, sessionId);
  }
  const root = await pages(sessionId);
  const inherited = selectedFork ? await pages(selectedFork) : null;
  console.log(JSON.stringify({ root, inherited, forkId: selectedFork, requests: count }));
} catch {
  console.log(JSON.stringify({ error: 'native_qualification_codex_paging_failed', check }));
  process.exitCode = 1;
} finally {
  reader.close();
  const closed = once(child, 'close');
  child.stdin.end();
  // Let installed writers flush. The enclosing owner's deadline still bounds
  // an app-server that fails to shut down and reaps all startup descendants.
  child.stdout.resume();
  await closed;
}
