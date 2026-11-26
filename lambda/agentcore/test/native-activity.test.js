import { describe, expect, it } from 'vitest';
import {
  NATIVE_ACTIVITY_LIMITS,
  createNativeActivityLog,
  createNativeSecretGuard,
  nativePublicActivity,
  truncateUtf8,
} from '../native/activity.js';

const MODEL = 'ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlLXNlY3JldC12YWx1ZS0wMTIzNDU2Nzg5';
const GIT = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
const codex = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const thread = { type: 'thread.started', thread_id: 'native-thread-1' };
const message = (id, text) => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const shell = (id, command, output, exit = 0) => ({
  type: 'item.completed',
  item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exit, status: 'completed' },
});
const turnOf = ({ harness = 'codex', forbiddenBytes = [MODEL, GIT], limits } = {}) => {
  const log = createNativeActivityLog({ writerGeneration: 1, now: () => 1_790_000_000_000, ...(limits ? { limits } : {}) });
  const turn = log.turn({ sequence: 1, harness, forbiddenBytes });
  return { log, turn };
};
const write = (turn, text, splits = []) => {
  // Deliver arbitrary byte chunks, including splits inside JSON and secrets.
  const bytes = Buffer.from(text);
  let start = 0;
  for (const end of [...splits, bytes.length]) {
    turn.write(bytes.subarray(start, end));
    start = end;
  }
};
const visible = (events) =>
  events.flatMap((event) => [event.content, event.display.title, event.display.summary, event.display.details]).filter(Boolean);
// No released field, and no concatenation of released fields, may contain the
// secret or any 12-character fragment of it.
const expectNoSecret = (events, secret) => {
  const fields = visible(events);
  const stream = fields.join('');
  for (const text of [...fields, stream]) {
    expect(text).not.toContain(secret);
    for (let i = 0; i + 12 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 12));
  }
};

describe('native activity public boundary', () => {
  it('streams parsed codex messages and tool calls through the existing normalizer', () => {
    const { log, turn } = turnOf();
    write(
      turn,
      codex(
        thread,
        { type: 'turn.started' },
        message('m1', 'I will read the scaffold first.'),
        shell('c1', 'cat /mnt/native/project/src/game.js', 'const bird = 1;\n'),
      ),
    );
    const before = log.pull(0);
    expect(before.complete).toBe(false);
    expect(before.events.map((event) => [event.index, event.display.type])).toEqual([
      [1, 'message'],
      [2, 'tool'],
    ]);
    expect(before.events[0]).toMatchObject({ sequence: 1, writerGeneration: 1, kind: 'stdout', content: 'I will read the scaffold first.' });
    expect(before.events[1].content).toContain('cat src/game.js');
    expect(before.events[1].content).not.toContain('/mnt/native/project');
    turn.close();
    const after = log.pull(2);
    expect(after).toMatchObject({ events: [], complete: true, last: 2 });
  });

  it('withholds reasoning and raw diagnostics, reporting only a count', () => {
    const { log, turn } = turnOf();
    write(turn, codex(thread, { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'private chain of thought' } }));
    write(turn, 'not json at all\n');
    turn.close();
    const { events } = log.pull(0);
    expect(JSON.stringify(events)).not.toContain('private chain of thought');
    expect(JSON.stringify(events)).not.toContain('not json at all');
    expect(events).toHaveLength(1);
    expect(events[0].display).toMatchObject({ type: 'system', title: '2 unparsed harness output entries were withheld', hiddenByDefault: true });
  });

  it('redacts a forbidden credential in messages, tool input and output', () => {
    const { log, turn } = turnOf();
    write(
      turn,
      codex(
        thread,
        message('m1', `The model key is ${MODEL}.`),
        shell('c1', `curl -H "Authorization: token ${GIT}" https://api.github.com`, `echo ${MODEL}\n`),
      ),
      [17, 40, 95, 160],
    );
    turn.close();
    const { events } = log.pull(0);
    expectNoSecret(events, MODEL);
    expectNoSecret(events, GIT);
    expect(events[0].content).toBe('The model key is [REDACTED].');
  });

  it('redacts a credential split across adjacent assistant messages and stdout chunks', () => {
    const { log, turn } = turnOf();
    const cut = 23;
    write(turn, codex(thread, message('m1', `Part one: ${MODEL.slice(0, cut)}`)), [30, 61]);
    // The first part could continue a secret: nothing is released yet.
    expect(log.pull(0).events).toHaveLength(0);
    write(turn, codex(message('m2', `${MODEL.slice(cut)} was the rest.`)), [9]);
    turn.close();
    const { events } = log.pull(0);
    expect(events.map((event) => event.content)).toEqual(['Part one: [REDACTED]', '[REDACTED] was the rest.']);
    expectNoSecret(events, MODEL);
  });

  it('redacts a credential micro-split into many short events', () => {
    const { log, turn } = turnOf();
    const pieces = MODEL.match(/.{1,5}/g);
    write(turn, codex(thread, ...pieces.map((piece, index) => message(`m${index}`, piece))));
    turn.close();
    const { events } = log.pull(0);
    expectNoSecret(events, MODEL);
    // At most HOLD-1 characters can precede detection.
    const stream = visible(events).join('');
    for (let i = 0; i + 4 <= MODEL.length; i++) expect(stream).not.toContain(MODEL.slice(i, i + 4));
  });

  it('redacts a credential split between a tool title and its details', () => {
    const { log, turn } = turnOf();
    const event = { content: `Running tool shell\n${GIT.slice(0, 20)}`, display: { type: 'tool', level: 'error', title: 'Shell failed', details: `${GIT.slice(20)} rejected` } };
    turn.write(Buffer.alloc(0));
    // Feed the normalized event directly through the same public boundary.
    const sanitized = nativePublicActivity(event);
    expect(sanitized.display.details).toContain(GIT.slice(20));
    const guard = createNativeSecretGuard([GIT]);
    const marks = guard.mark(`${sanitized.content}${sanitized.display.title}${sanitized.display.details}`);
    expect(marks.some(Boolean)).toBe(true);
    turn.close();
  });

  it('redacts URL-encoded and JSON-escaped credential forms and credential shapes', () => {
    const secret = 'pa$$word+with/slash=and"quote"-0123456789';
    const { log, turn } = turnOf({ forbiddenBytes: [secret] });
    write(
      turn,
      codex(
        thread,
        shell('c1', 'env', `GIT_PASSWORD=${encodeURIComponent(secret)}\nAWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE\nHOME=/home/node\n`),
        shell(
          'c2',
          'curl $AWS_CONTAINER_CREDENTIALS_FULL_URI',
          '{"AccessKeyId":"ASIAABCDEFGHIJKLMNOP","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","Token":"FwoGZXIvYXdzEXAMPLE"}',
        ),
        message('m1', `Escaped: ${JSON.stringify(secret)}`),
      ),
    );
    turn.close();
    const text = JSON.stringify(log.pull(0).events);
    for (const value of [
      encodeURIComponent(secret),
      secret,
      'IQoJb3JpZ2luX2VjEXAMPLE',
      'ASIAABCDEFGHIJKLMNOP',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'FwoGZXIvYXdzEXAMPLE',
    ])
      expect(text).not.toContain(value);
  });

  it('withholds tool payloads that touch harness homes, runtime control or process state', () => {
    const { log, turn } = turnOf();
    write(
      turn,
      codex(
        thread,
        shell('c1', 'cat /home/node/.native-homes/b/a/.codex/sessions/rollout.jsonl', '{"role":"user","content":"hidden transcript"}'),
        shell('c2', 'cat /proc/self/environ', 'AWS_BEARER_TOKEN_BEDROCK=unknown-value'),
        shell('c3', 'cat /mnt/native/.native-control/writer-2/status.json', '{"status":"running"}'),
        shell('c4', 'cat aidlc/spaces/default/intents/x/.aidlc-engine/steering-token-key', 'key-material'),
        shell('c5', 'cat .git/config', '[remote "origin"]'),
        message('m1', 'I checked /home/node/.native-homes/b/a/.codex/config.toml earlier.'),
      ),
    );
    turn.close();
    const { events } = log.pull(0);
    const text = JSON.stringify(events);
    for (const hidden of ['hidden transcript', 'unknown-value', '"running"', 'key-material', 'remote "origin"', '/home/node'])
      expect(text).not.toContain(hidden);
    expect(events.slice(0, 5).every((event) => event.content.includes('[Input and output withheld: private runtime path]'))).toBe(true);
    expect(events[5].content).toBe('I checked ‹private path› earlier.');
  });

  it('bounds every field without splitting characters', () => {
    const long = `${'🐦'.repeat(5000)}tail`;
    const event = nativePublicActivity({ content: long, display: { type: 'message', summary: long, title: long } });
    expect(Buffer.byteLength(event.content)).toBeLessThanOrEqual(NATIVE_ACTIVITY_LIMITS.contentBytes);
    expect(Buffer.byteLength(event.display.title)).toBeLessThanOrEqual(NATIVE_ACTIVITY_LIMITS.titleBytes);
    expect(event.content).toMatch(/bytes omitted\]$/);
    expect(truncateUtf8('short', 100)).toBe('short');
  });

  it('keeps bounded memory and reports an explicit gap instead of silently dropping', () => {
    const limits = { ...NATIVE_ACTIVITY_LIMITS, bufferEvents: 5, batchEvents: 2 };
    const { log, turn } = turnOf({ limits });
    write(turn, codex(thread, ...Array.from({ length: 8 }, (_, index) => message(`m${index}`, `message ${index}`))));
    turn.close();
    const first = log.pull(0);
    expect(first.gap).toEqual({ from: 1, through: 3 });
    expect(first.events.map((event) => event.index)).toEqual([4, 5]);
    expect(first.complete).toBe(false);
    const second = log.pull(5);
    expect(second.gap).toBeUndefined();
    expect(second.events.map((event) => event.index)).toEqual([6, 7]);
    const third = log.pull(7);
    expect(third.events.map((event) => event.index)).toEqual([8]);
    expect(third.complete).toBe(true);
    // Acknowledged events are released from memory; re-pulling cannot resend them.
    expect(log.pull(8).events).toEqual([]);
  });

  it('never resends acknowledged events and keeps unacknowledged ones after a failed ingestion', () => {
    const { log, turn } = turnOf();
    write(turn, codex(thread, message('m1', 'one'), message('m2', 'two')));
    expect(log.pull(0).events.map((event) => event.index)).toEqual([1, 2]);
    // The controller could not persist: the same cursor returns the same events.
    expect(log.pull(0).events.map((event) => event.content)).toEqual(['one', 'two']);
    expect(log.pull(1).events.map((event) => event.content)).toEqual(['two']);
    turn.close();
  });

  it('streams the final native Kiro ACP text and lifecycle markers in order', () => {
    const { log, turn } = turnOf({ harness: 'kiro' });
    turn.lifecycle({ title: 'Starting Kiro' });
    write(turn, `${JSON.stringify({ schemaVersion: 1, transport: 'kiro-acp', ok: true, text: 'Which title?' })}\n`);
    turn.close({ failed: false });
    expect(log.pull(0).events.map((event) => [event.kind, event.display.title ?? event.content])).toEqual([
      ['lifecycle', 'Starting Kiro'],
      ['stdout', 'Which title?'],
    ]);
  });

  it('marks an unpublished turn and a replaced open turn as failed', () => {
    const log = createNativeActivityLog({ writerGeneration: 2, now: () => 1 });
    const first = log.turn({ sequence: 2, harness: 'codex', forbiddenBytes: [] });
    log.turn({ sequence: 3, harness: 'codex', forbiddenBytes: [] });
    first.write(Buffer.from('ignored after close\n'));
    const { events } = log.pull(0);
    expect(events).toEqual([
      expect.objectContaining({ sequence: 2, writerGeneration: 2, display: expect.objectContaining({ level: 'error' }) }),
    ]);
    expect(log.open).toBe(true);
  });
});
