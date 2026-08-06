import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanupCodexHome,
  findCodexRollout,
  persistCodexRollout,
  resolveCodexStore,
  restoreCodexRollout,
} from '../cli/codex-store.js';

const roots = [];

const world = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aidlc-codex-store-'));
  roots.push(root);
  const codexHome = path.join(root, 'local', 'home');
  const durableHome = path.join(root, 'durable', 'codex-home');
  const env = {
    V2_CODEX_HOME_ROOT: path.join(root, 'local'),
    V2_CODEX_STORE_DIR: durableHome,
  };
  return { root, codexHome, durableHome, env };
};

const rolloutBody = (threadId, extra = []) =>
  [
    JSON.stringify({
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId },
    }),
    ...extra.map((event) => JSON.stringify(event)),
    '',
  ].join('\n');

const putRollout = async ({ home, threadId, day = '01', body = rolloutBody(threadId) }) => {
  const filename = path.join(
    home,
    'sessions',
    '2026',
    '08',
    day,
    `rollout-2026-08-${day}T00-00-00-${threadId}.jsonl`,
  );
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, body, 'utf8');
  return filename;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex rollout store', () => {
  it('resolves separate local and durable homes only when configured', async () => {
    const { codexHome, durableHome, env } = await world();
    expect(resolveCodexStore({ codexHome, env })).toEqual({
      localHome: path.resolve(codexHome),
      durableHome: path.resolve(durableHome),
    });
    expect(resolveCodexStore({ codexHome, env: {} })).toBeNull();
    expect(resolveCodexStore({ env })).toBeNull();
  });

  it('finds a legacy-layout rollout by validated thread metadata', async () => {
    const { durableHome } = await world();
    const filename = await putRollout({
      home: durableHome,
      threadId: 'thread-old',
      day: '02',
    });
    const result = await findCodexRollout({
      homeDir: durableHome,
      threadId: 'thread-old',
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'found',
      filename,
      relativePath: path.join('2026', '08', '02', 'rollout-2026-08-02T00-00-00-thread-old.jsonl'),
    });
  });

  it('restores only the selected rollout and clears stale local sessions', async () => {
    const { codexHome, durableHome, env } = await world();
    const durable = await putRollout({ home: durableHome, threadId: 'thread-resume' });
    await putRollout({ home: durableHome, threadId: 'thread-other', day: '02' });
    const stale = await putRollout({ home: codexHome, threadId: 'thread-stale', day: '03' });

    const result = await restoreCodexRollout({
      codexHome,
      env,
      threadId: 'thread-resume',
    });

    expect(result).toMatchObject({ ok: true, status: 'restored' });
    const restored = path.join(codexHome, 'sessions', result.relativePath);
    expect(await readFile(restored, 'utf8')).toBe(await readFile(durable, 'utf8'));
    await expect(readFile(stale, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const localFiles = await readdir(path.join(codexHome, 'sessions', '2026', '08', '01'));
    expect(localFiles).toEqual([path.basename(restored)]);
  });

  it('atomically persists only the selected rollout without replacing sibling sessions', async () => {
    const { codexHome, durableHome, env } = await world();
    const local = await putRollout({
      home: codexHome,
      threadId: 'thread-live',
      extra: [{ type: 'event_msg', payload: { message: 'new' } }],
    });
    const sibling = await putRollout({ home: durableHome, threadId: 'thread-sibling', day: '02' });

    const result = await persistCodexRollout({
      codexHome,
      env,
      threadId: 'thread-live',
      ids: () => 'fixed',
    });

    expect(result).toMatchObject({ ok: true, status: 'persisted', attempts: 1 });
    expect(await readFile(path.join(durableHome, 'sessions', result.relativePath), 'utf8')).toBe(
      await readFile(local, 'utf8'),
    );
    expect(await readFile(sibling, 'utf8')).toContain('thread-sibling');
    const destinationDir = path.dirname(path.join(durableHome, 'sessions', result.relativePath));
    expect((await readdir(destinationDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('retries transient write-back failures with bounded backoff', async () => {
    const { codexHome, env } = await world();
    await putRollout({ home: codexHome, threadId: 'thread-retry' });
    let copies = 0;
    const sleep = vi.fn(async () => {});
    const result = await persistCodexRollout({
      codexHome,
      env,
      threadId: 'thread-retry',
      sleep,
      ids: () => `attempt-${copies}`,
      fs: {
        async copyFile(source, destination) {
          copies += 1;
          if (copies < 3) {
            const error = new Error('Write failed: waiting to be backed up');
            error.code = 'ENOSPC';
            throw error;
          }
          await copyFile(source, destination);
        },
      },
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it('stops after five transient failures and leaves no temporary file', async () => {
    const { codexHome, durableHome, env } = await world();
    await putRollout({ home: codexHome, threadId: 'thread-full' });
    const sleep = vi.fn(async () => {});
    const result = await persistCodexRollout({
      codexHome,
      env,
      threadId: 'thread-full',
      sleep,
      ids: () => 'fixed',
      fs: {
        async copyFile() {
          const error = new Error('Write failed: waiting to be backed up');
          error.code = 'ENOSPC';
          throw error;
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'persist_failed',
      attempts: 5,
      error: { code: 'ENOSPC' },
    });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000, 2000]);
    const files = await readdir(path.join(durableHome, 'sessions', '2026', '08', '01'));
    expect(files).toEqual([]);
  });

  it('persists valid rollout records before a truncated final JSONL line', async () => {
    const { codexHome, durableHome, env } = await world();
    const validBody = rolloutBody('thread-tail', [
      { type: 'response_item', payload: { text: 'preserve me' } },
    ]);
    await putRollout({
      home: codexHome,
      threadId: 'thread-tail',
      body: `${validBody}{"type":`,
    });

    const result = await persistCodexRollout({
      codexHome,
      env,
      threadId: 'thread-tail',
    });

    expect(result).toMatchObject({ ok: true, status: 'persisted' });
    const durable = path.join(durableHome, 'sessions', result.relativePath);
    expect(await readFile(durable, 'utf8')).toBe(validBody);
  });

  it('rejects a truncated rollout without a valid session header', async () => {
    const { codexHome } = await world();
    await putRollout({
      home: codexHome,
      threadId: 'thread-empty',
      body: '{"type":',
    });

    expect(await findCodexRollout({ homeDir: codexHome, threadId: 'thread-empty' })).toEqual({
      ok: false,
      status: 'corrupt',
    });
  });

  it('does not overwrite a durable rollout with malformed middle JSONL', async () => {
    const { codexHome, durableHome, env } = await world();
    const durable = await putRollout({ home: durableHome, threadId: 'thread-safe' });
    const original = await readFile(durable, 'utf8');
    await putRollout({
      home: codexHome,
      threadId: 'thread-safe',
      body: `${rolloutBody('thread-safe')}{"type":\n${JSON.stringify({ type: 'event' })}\n`,
    });

    const result = await persistCodexRollout({
      codexHome,
      env,
      threadId: 'thread-safe',
    });
    expect(result).toEqual({ ok: false, status: 'corrupt' });
    expect(await readFile(durable, 'utf8')).toBe(original);
  });

  it('reports missing, ambiguous, and unsafe thread selections', async () => {
    const { codexHome } = await world();
    expect(await findCodexRollout({ homeDir: codexHome, threadId: '../escape' })).toEqual({
      ok: false,
      status: 'invalid_thread_id',
    });
    expect(await findCodexRollout({ homeDir: codexHome, threadId: 'thread-missing' })).toEqual({
      ok: false,
      status: 'missing',
    });

    await putRollout({ home: codexHome, threadId: 'thread-duplicate', day: '01' });
    await putRollout({ home: codexHome, threadId: 'thread-duplicate', day: '02' });
    expect(await findCodexRollout({ homeDir: codexHome, threadId: 'thread-duplicate' })).toEqual({
      ok: false,
      status: 'ambiguous',
    });
  });

  it('cleans generated local homes but refuses paths outside the configured root', async () => {
    const { root, codexHome, env } = await world();
    await mkdir(codexHome, { recursive: true });
    expect(await cleanupCodexHome({ codexHome, env })).toBe(true);
    await expect(readdir(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cleanupCodexHome({ codexHome: root, env })).toBe(false);
  });
});
