import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKiroAcpClient, KIRO_ACP_LIMITS } from '../native/kiro-acp-client.js';

const clients = [];
const wire = (value) => `${JSON.stringify(value)}\n`;
const response = (id, result = {}) => ({ jsonrpc: '2.0', id, result });
const update = (text) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'A', update: { sessionUpdate: 'agent_message_chunk', text } },
});
const permission = (id = 'permission-1') => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: { sessionId: 'A', options: [{ optionId: 'once', kind: 'allow_once' }] },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fixture = (options = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      sent.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const client = createKiroAcpClient({ input, output, ...options });
  clients.push(client);
  return { client, input, output, sent, send: (value) => input.write(wire(value)) };
};
const caught = (promise) => promise.catch((error) => error);

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

describe('bounded Kiro ACP transport', () => {
  it('supports a prompt without a deadline while retaining bounded transport requests', async () => {
    vi.useFakeTimers();
    const { client, send } = fixture();
    let settled = false;
    const prompt = client.request('session/prompt', {}, { timeoutMs: null }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    send(response(1, { stopReason: 'end_turn' }));
    await vi.runAllTicks();
    expect(await prompt).toEqual({ stopReason: 'end_turn' });
  });

  it('allows cumulative production traffic beyond capture budgets while validating each frame', async () => {
    let updates = 0;
    const { client, send } = fixture({
      maxInputBytes: null,
      maxOutputBytes: null,
      onUpdate: () => {
        updates++;
      },
    });
    const prompt = client.request('session/prompt', {}, { timeoutMs: null });
    for (let i = 0; i < 600; i++) send(update('x'.repeat(32 * 1024)));
    expect(updates).toBe(600);
    send(response(1, { stopReason: 'end_turn' }));
    expect(await prompt).toEqual({ stopReason: 'end_turn' });
    await expect(client.request('session/prompt', {}, { timeoutMs: -1 })).rejects.toMatchObject({
      code: 'KIRO_ACP_INVALID_REQUEST',
    });
    expect(() => fixture({ maxFrameBytes: null })).toThrow('INVALID_OPTIONS');
  });
  it('matches the wrapper API and correlates out-of-order new/load responses', async () => {
    const { client, sent, send } = fixture();
    const initialized = client.request('initialize', { protocolVersion: 1 });
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    send(response(1, { protocolVersion: 1 }));
    await expect(initialized).resolves.toEqual({ protocolVersion: 1 });
    const created = client.request('session/new', { cwd: '/synthetic', mcpServers: [] });
    const loaded = client.request('session/load', { sessionId: 'A' });
    send(response(3, { sessionId: 'A' }));
    send(response(2, { sessionId: 'B' }));
    await expect(created).resolves.toEqual({ sessionId: 'B' });
    await expect(loaded).resolves.toEqual({ sessionId: 'A' });
  });

  it('accepts fragmented UTF-8 and coalesced CRLF frames in order', async () => {
    const seen = [];
    const { client, input } = fixture({ onUpdate: (params) => seen.push(params.update.text) });
    const result = client.request('session/prompt', { sessionId: 'A' });
    const bytes = Buffer.from(
      wire(update('Blue💡Lake')).replace(/\n$/, '\r\n') +
        wire(response(1, { stopReason: 'end_turn' })),
    );
    for (const byte of bytes) input.write(Buffer.from([byte]));
    await expect(result).resolves.toEqual({ stopReason: 'end_turn' });
    expect(seen).toEqual(['Blue💡Lake']);
  });

  it('defaults permission to cancelled and replies -32601 to unknown server requests', () => {
    const { sent, send } = fixture();
    send(permission());
    send({ jsonrpc: '2.0', id: 91, method: 'fs/read_text_file', params: {} });
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 91, error: { code: -32601, message: 'Method not found' } },
    ]);
  });

  it('delegates permission policy and does not wrap the ACP outcome twice', async () => {
    const callback = vi.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'once' } }));
    const { sent, send } = fixture({ onPermission: callback });
    send(permission());
    await tick();
    expect(callback).toHaveBeenCalledWith(permission().params);
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'once' } },
      },
    ]);
  });

  it('sends cancel notifications without request IDs or pending slots', async () => {
    const { client, sent, send } = fixture({ maxPendingRequests: 1 });
    const active = client.request('session/prompt');
    client.notify('session/cancel', { sessionId: 'A' });
    expect(sent[1]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'A' },
    });
    send(response(1, { stopReason: 'cancelled' }));
    await expect(active).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('sanitizes remote RPC failures and never retries or falls back', async () => {
    const { client, send, sent } = fixture();
    const rejected = caught(client.request('session/load', { sessionId: 'missing' }));
    send({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'secret-token', data: 'private' },
    });
    const error = await rejected;
    expect(error).toMatchObject({ code: 'KIRO_ACP_RPC_ERROR', rpcCode: -32001 });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toMatch(/secret-token|private/);
    expect(sent).toHaveLength(1);
    const next = client.request('initialize');
    send(response(2));
    await expect(next).resolves.toEqual({});
  });

  it.each([
    'not JSON\n',
    '[]\n',
    wire({ jsonrpc: '1.0', id: 1, result: {} }),
    wire({ jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'private' } }),
    wire({ jsonrpc: '2.0', id: 1, error: { code: 'private', message: 'private' } }),
    wire({ jsonrpc: '2.0', id: 1 }),
    wire({ jsonrpc: '2.0', method: 'session/update', params: 'private' }),
    wire({ jsonrpc: '2.0', method: 'session/update', result: {} }),
    Buffer.from([0xff, 10]),
  ])('fails closed on malformed input %# without echoing it', async (bytes) => {
    const { client, input } = fixture();
    const active = caught(client.request('initialize'));
    input.write(bytes);
    const error = await active;
    expect(error.code).toMatch(/^KIRO_ACP_INVALID_(JSON|MESSAGE)$/);
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain('private');
    await expect(client.request('session/new')).rejects.toBe(error);
  });

  it('rejects unknown and duplicate response IDs', async () => {
    for (const id of [1, 99]) {
      const { client, send } = fixture();
      const first = client.request('initialize');
      send(response(1));
      await first;
      const pending = caught(client.request('session/new'));
      send(response(id));
      expect(await pending).toMatchObject({ code: 'KIRO_ACP_UNEXPECTED_RESPONSE' });
    }
  });

  it.each(['sync', 'async'])('contains %s update callback failures', async (mode) => {
    const failure = () => {
      throw new Error('callback-secret');
    };
    const { client, send } = fixture({
      onUpdate: mode === 'sync' ? failure : async () => failure(),
    });
    const pending = caught(client.request('session/prompt'));
    send(update('text'));
    send(response(1));
    const error = await pending;
    expect(error).toMatchObject({ code: 'KIRO_ACP_CALLBACK_ERROR' });
    expect(error.stack).not.toContain('callback-secret');
  });

  it.each(['sync', 'async'])(
    'a response then bad %s update in one chunk prevents the next write',
    async (mode) => {
      const failure = () => {
        throw new Error('private-update');
      };
      const { client, input, sent } = fixture({
        onUpdate: mode === 'sync' ? failure : async () => failure(),
      });
      const next = caught(client.request('initialize').then(() => client.request('session/new')));
      input.write(wire(response(1)) + wire(update('invalid')));
      expect(await next).toMatchObject({ code: 'KIRO_ACP_CALLBACK_ERROR' });
      expect(sent).toHaveLength(1);
      await expect(client.request('session/load')).rejects.toMatchObject({
        code: 'KIRO_ACP_CALLBACK_ERROR',
      });
      expect(sent).toHaveLength(1);
    },
  );

  it.each(['json', 'envelope', 'callback', 'async-callback'])(
    'rejects a final response followed by invalid %s in the same chunk',
    async (mode) => {
      const failure = () => {
        throw new Error('private-final-update');
      };
      const { client, input } = fixture({
        onUpdate: mode === 'async-callback' ? async () => failure() : failure,
      });
      const final = caught(client.request('session/prompt'));
      const invalid =
        mode === 'json'
          ? 'not JSON\n'
          : mode === 'envelope'
            ? wire({ jsonrpc: '2.0', method: 'session/update', params: 'private' })
            : wire(update('invalid'));
      input.write(wire(response(1, { stopReason: 'end_turn' })) + invalid);
      expect(await final).toMatchObject({
        code:
          mode === 'json'
            ? 'KIRO_ACP_INVALID_JSON'
            : mode === 'envelope'
              ? 'KIRO_ACP_INVALID_MESSAGE'
              : 'KIRO_ACP_CALLBACK_ERROR',
      });
    },
  );

  it.each([false, true])(
    'accepts a complete response followed by EOF (async update: %s)',
    async (asyncUpdate) => {
      const { client, input } = fixture({
        onUpdate: asyncUpdate ? () => tick() : () => {},
      });
      const final = client.request('session/prompt');
      const unanswered = caught(client.request('initialize'));
      input.end(wire(update('done')) + wire(response(1, { stopReason: 'end_turn' })));
      await expect(final).resolves.toEqual({ stopReason: 'end_turn' });
      expect(await unanswered).toMatchObject({ code: 'KIRO_ACP_EOF' });
      await expect(client.request('session/new')).rejects.toMatchObject({
        code: 'KIRO_ACP_EOF',
      });
    },
  );

  it('rejects a complete response if EOF reveals a trailing partial frame', async () => {
    const { client, input } = fixture();
    const final = caught(client.request('session/prompt'));
    input.end(wire(response(1, { stopReason: 'end_turn' })) + '{"jsonrpc":');
    expect(await final).toMatchObject({ code: 'KIRO_ACP_TRUNCATED_FRAME' });
  });

  it('waits for async updates before returning a response', async () => {
    let finish;
    let updated = false;
    const { client, send } = fixture({
      onUpdate: () =>
        new Promise((resolve) => {
          finish = () => {
            updated = true;
            resolve();
          };
        }),
    });
    const result = client.request('session/load').then(() => expect(updated).toBe(true));
    send(update('history'));
    send(response(1));
    await tick();
    expect(updated).toBe(false);
    finish();
    await result;
  });

  it.each(['throws', 'rejects', 'invalid'])(
    'contains permission callback failure: %s',
    async (mode) => {
      const { client, send, sent } = fixture({
        onPermission: () => {
          if (mode === 'throws') throw new Error('permission-secret');
          if (mode === 'rejects') return Promise.reject(new Error('permission-secret'));
          return { outcome: { outcome: 'allow_all' } };
        },
      });
      const active = caught(client.request('session/prompt'));
      send(permission());
      expect(await active).toMatchObject({ code: 'KIRO_ACP_CALLBACK_ERROR' });
      expect(sent.filter((item) => item.id === 'permission-1')).toHaveLength(0);
    },
  );

  it('bounds unresolved callbacks and duplicate server request IDs', async () => {
    for (const duplicate of [false, true]) {
      const { client, send } = fixture({
        maxPendingRequests: 1,
        onPermission: () => new Promise(() => {}),
      });
      const active = caught(client.request('session/prompt'));
      send(permission('one'));
      send(permission(duplicate ? 'one' : 'two'));
      expect(await active).toMatchObject({
        code: duplicate ? 'KIRO_ACP_INVALID_MESSAGE' : 'KIRO_ACP_PENDING_LIMIT',
      });
    }
  });

  it('bounds complete and unterminated frames', async () => {
    for (const suffix of ['', '\n']) {
      const { client, input } = fixture({ maxFrameBytes: 128 });
      const active = caught(client.request('initialize'));
      input.write(' '.repeat(129) + suffix);
      expect(await active).toMatchObject({ code: 'KIRO_ACP_FRAME_LIMIT' });
    }
  });

  it('counts cumulative input even when individual frames fit', async () => {
    const bytes = wire({ jsonrpc: '2.0', method: 'ignored' });
    const { client, input } = fixture({ maxInputBytes: Buffer.byteLength(bytes) * 2 });
    const active = caught(client.request('initialize'));
    input.write(bytes);
    input.write(bytes);
    input.write(bytes);
    expect(await active).toMatchObject({ code: 'KIRO_ACP_INPUT_LIMIT' });
  });

  it('bounds outbound frames and cumulative notifications', async () => {
    const one = fixture({ maxFrameBytes: 128 });
    await expect(
      one.client.request('session/prompt', { text: 'x'.repeat(128) }),
    ).rejects.toMatchObject({ code: 'KIRO_ACP_FRAME_LIMIT' });
    const two = fixture({ maxOutputBytes: 130 });
    const active = caught(two.client.request('initialize'));
    two.client.notify('session/cancel');
    expect(() => two.client.notify('session/cancel')).toThrow('OUTPUT_LIMIT');
    expect(await active).toMatchObject({ code: 'KIRO_ACP_OUTPUT_LIMIT' });
  });

  it('refuses extra pending requests without disturbing the accepted one', async () => {
    const { client, sent, send } = fixture({ maxPendingRequests: 1 });
    const active = client.request('initialize');
    await expect(client.request('session/new')).rejects.toMatchObject({
      code: 'KIRO_ACP_PENDING_LIMIT',
    });
    expect(sent).toHaveLength(1);
    send(response(1));
    await expect(active).resolves.toEqual({});
  });

  it('uses a bounded default and fails the connection on a per-call deadline', async () => {
    vi.useFakeTimers();
    expect(KIRO_ACP_LIMITS).toMatchObject({
      maxFrameBytes: 1024 * 1024,
      maxInputBytes: 16 * 1024 * 1024,
      defaultTimeoutMs: 30_000,
    });
    const { client } = fixture();
    const a = caught(client.request('initialize', {}, { timeoutMs: 5 }));
    const b = caught(client.request('session/new'));
    await vi.advanceTimersByTimeAsync(5);
    expect(await a).toMatchObject({ code: 'KIRO_ACP_TIMEOUT' });
    expect(await b).toBe(await a);
    await expect(client.request('session/new')).rejects.toBe(await a);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out stalled callback work', async () => {
    vi.useFakeTimers();
    const { client, send } = fixture({
      defaultTimeoutMs: 5,
      onPermission: () => new Promise(() => {}),
    });
    const active = caught(client.request('session/prompt', {}, { timeoutMs: 100 }));
    send(permission());
    await vi.advanceTimersByTimeAsync(5);
    expect(await active).toMatchObject({ code: 'KIRO_ACP_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['end', 'partial', 'input-error', 'output-error'])(
    'fails pending on %s',
    async (mode) => {
      const { client, input, output } = fixture();
      const active = caught(client.request('initialize'));
      if (mode === 'partial') input.end('{"jsonrpc":');
      else if (mode === 'end') input.end();
      else (mode === 'input-error' ? input : output).emit('error', new Error('stream-secret'));
      const expected =
        mode === 'partial' ? 'TRUNCATED_FRAME' : mode === 'end' ? 'EOF' : 'STREAM_ERROR';
      const error = await active;
      expect(error).toMatchObject({ code: `KIRO_ACP_${expected}` });
      expect(error.stack).not.toContain('stream-secret');
    },
  );

  it('handles asynchronous write errors and a blocked writable without hanging', async () => {
    for (const blocked of [false, true]) {
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          if (!blocked) setImmediate(() => callback(new Error('write-secret')));
        },
      });
      const { client } = fixture({ output });
      const error = await caught(client.request('initialize', {}, { timeoutMs: 20 }));
      expect(error).toMatchObject({ code: blocked ? 'KIRO_ACP_TIMEOUT' : 'KIRO_ACP_STREAM_ERROR' });
      expect(error.stack).not.toContain('write-secret');
      output.destroy();
    }
  });

  it('disposes idempotently without closing streams and absorbs late errors', async () => {
    const { client, input, output } = fixture();
    const active = caught(client.request('initialize'));
    client.dispose();
    client.dispose();
    expect(await active).toMatchObject({ code: 'KIRO_ACP_CLOSED' });
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    expect(output.writableEnded).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.readableFlowing).toBe(true);
    expect(() => {
      input.write('late non-JSON output\n');
      input.emit('error', new Error('late-input-secret'));
      output.emit('error', new Error('late-output-secret'));
      output.end();
      input.end();
    }).not.toThrow();
    await expect(client.request('initialize')).rejects.toMatchObject({ code: 'KIRO_ACP_CLOSED' });
    expect(output.writableEnded).toBe(true);
  });

  it('rejects invalid caller options and unserializable requests with fixed errors', async () => {
    expect(() => fixture({ maxPendingRequests: 0 })).toThrow('INVALID_OPTIONS');
    const { client } = fixture();
    await expect(client.request('initialize', {}, { timeoutMs: NaN })).rejects.toMatchObject({
      code: 'KIRO_ACP_INVALID_REQUEST',
    });
    const cyclic = {};
    cyclic.self = cyclic;
    await expect(client.request('initialize', cyclic)).rejects.toMatchObject({
      code: 'KIRO_ACP_INVALID_REQUEST',
    });
  });
});
