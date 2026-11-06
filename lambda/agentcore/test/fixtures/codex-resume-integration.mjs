// Run inside the AgentCore image with --network none. No credentials or model
// response are needed: this exercises Codex's native session storage and resume.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createCredentialSession } from '../../credential-session.js';
import { materializeCodexHome, resolveCodexHome } from '../../stage-materializer.js';
import {
  cleanupCodexHome,
  persistCodexRollout,
  restoreCodexRollout,
} from '../../cli/codex-store.js';

async function startCodex(home, legacySqliteHome) {
  const child = spawn(
    'codex',
    [
      '-c',
      'mcp_servers.aidlc.enabled=false',
      ...(legacySqliteHome ? ['-c', `sqlite_home=${JSON.stringify(legacySqliteHome)}`] : []),
      'app-server',
      '--listen',
      'stdio://',
    ],
    {
      env: { ...process.env, CODEX_HOME: home, AWS_EC2_METADATA_DISABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const pending = new Map();
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const request = async (method, params) => {
    const requestId = ++id;
    const response = new Promise((resolve) => pending.set(requestId, resolve));
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    let timer;
    try {
      const message = await Promise.race([
        response,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 15_000);
        }),
      ]);
      assert.equal(message.error, undefined, `${method}: ${JSON.stringify(message.error)}`);
      return message.result;
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  };
  const close = async () => {
    lines.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  };
  try {
    await request('initialize', {
      clientInfo: { name: 'aidlc-resume-test', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    return { request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test(
  'Codex resumes a durable rollout in new invocation homes despite a stale shared index',
  {
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aidlc-codex-resume-'));
    const env = {
      V2_CODEX_HOME_ROOT: path.join(root, 'homes'),
      V2_CODEX_STORE_DIR: path.join(root, 'durable'),
      // Reproduce an existing runtime's old setting; updated code must not share it.
      V2_CODEX_SQLITE_HOME: path.join(root, 'legacy-sqlite'),
    };
    const scope = { executionId: 'resume-test', intentId: 'resume-test', stageInstanceId: 'stage' };
    let threadId;
    const homes = new Set();
    try {
      // First create a legacy conversation, then resume it twice in the same
      // container. Each invocation owns a new home; the old SQLite index remains.
      for (let invocation = 0; invocation < 3; invocation += 1) {
        const credentials = createCredentialSession();
        await credentials
          .run(async () => {
            const home = resolveCodexHome({ scope, env });
            assert.equal(homes.has(home), false, 'each invocation needs its own home');
            homes.add(home);
            if (threadId) {
              assert.equal(
                (await restoreCodexRollout({ threadId, codexHome: home, env })).ok,
                true,
              );
            }
            await materializeCodexHome({
              mcpEntry: '/opt/agentcore/mcp/index.js',
              scope,
              env,
              reset: !threadId,
            });
            const codex = await startCodex(
              home,
              invocation === 0 ? env.V2_CODEX_SQLITE_HOME : null,
            );
            try {
              if (!threadId) {
                const result = await codex.request('thread/start', {
                  modelProvider: 'amazon-bedrock',
                  model: 'openai.gpt-5.6-sol',
                  cwd: root,
                });
                threadId = result.thread.id;
                // Starting a turn flushes the real rollout. Inference fails without
                // credentials/network, which is unrelated to restoring that rollout.
                await codex.request('turn/start', {
                  threadId,
                  input: [{ type: 'text', text: 'Storage regression fixture.' }],
                });
              } else {
                const result = await codex.request('thread/resume', { threadId });
                assert.equal(result.thread.id, threadId);
              }
            } finally {
              await codex.close();
            }
            assert.equal((await persistCodexRollout({ threadId, codexHome: home, env })).ok, true);
            assert.equal(await cleanupCodexHome({ codexHome: home, env }), true);
          })
          .finally(() => credentials.release());
      }
      assert.deepEqual(await readdir(env.V2_CODEX_STORE_DIR), ['sessions']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
