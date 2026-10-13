import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_ACTIVITY_LIMITS,
  createNativeActivityLog,
  readNativeActivitySpool,
  createNativeSecretGuard,
  nativePublicActivity,
  truncateUtf8,
} from '../native/activity.js';

const MODEL = 'ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlLXNlY3JldC12YWx1ZS0wMTIzNDU2Nzg5';
// Deterministic synthetic token for split-secret redaction tests.
const GIT = `gho_${'0123456789abcdef'.repeat(3).slice(0, 36)}`;
const codex = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const thread = { type: 'thread.started', thread_id: 'native-thread-1' };
const message = (id, text) => ({
  type: 'item.completed',
  item: { id, type: 'agent_message', text },
});
const shell = (id, command, output, exit = 0) => ({
  type: 'item.completed',
  item: {
    id,
    type: 'command_execution',
    command,
    aggregated_output: output,
    exit_code: exit,
    status: 'completed',
  },
});
const turnOf = ({ harness = 'codex', forbiddenBytes = [MODEL, GIT], limits } = {}) => {
  const log = createNativeActivityLog({
    writerGeneration: 1,
    now: () => 1_790_000_000_000,
    ...(limits ? { limits } : {}),
  });
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
  events
    .flatMap((event) => [
      event.content,
      event.display.title,
      event.display.summary,
      event.display.details,
    ])
    .filter(Boolean);
// No released field, and no concatenation of released fields, may contain the
// secret or any 12-character fragment of it.
const expectNoSecret = (events, secret) => {
  const fields = visible(events);
  const stream = fields.join('');
  for (const text of [...fields, stream]) {
    expect(text).not.toContain(secret);
    for (let i = 0; i + 12 <= secret.length; i++)
      expect(text).not.toContain(secret.slice(i, i + 12));
  }
};

describe('native activity public boundary', () => {
  it.each([
    [
      'codex',
      { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } },
      'openai.gpt-5.5',
      'Cost unavailable',
    ],
    [
      'claude',
      { type: 'result', usage: { input_tokens: 20, output_tokens: 5 } },
      'us.anthropic.claude-sonnet-4-6',
      'Input/output cost estimate: USD',
    ],
    [
      'opencode',
      { type: 'step_finish', part: { tokens: { input: 20, output: 5 } } },
      'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
      'Input/output cost estimate: USD',
    ],
  ])(
    'reports numeric %s usage with pinned model attribution and explicit pricing limits',
    (harness, event, model, cost) => {
      let time = 1000;
      const log = createNativeActivityLog({ writerGeneration: 1, now: () => time });
      const turn = log.turn({ sequence: 2, harness, model });
      write(turn, codex(event), [4, 13, 31]);
      time = 1250;
      turn.close();
      const text = visible(log.pull(0).events).join('\n');
      expect(text).toContain(`Turn 2 · ${harness} · model ${model}`);
      expect(text).toContain('input tokens: 20');
      expect(text).toContain('output tokens: 5');
      expect(text).toContain('cache-read tokens: unavailable');
      expect(text).toContain(cost);
      expect(text).toContain('Capture wall time: 250 ms');
      expect(text).toContain('reviewer attribution unavailable');
      expect(text).not.toContain('workflow complete');
    },
  );

  it.each(['codex', 'opencode', 'claude', 'kiro'])(
    'keeps missing %s usage unavailable, including null/malformed counters',
    (harness) => {
      const log = createNativeActivityLog({ writerGeneration: 1 });
      const turn = log.turn({ sequence: 1, harness, model: null });
      write(
        turn,
        codex(
          { type: 'turn.completed', usage: { input_tokens: null, output_tokens: '0' } },
          { type: 'step_finish', part: { tokens: { input: null, output: false } } },
          { type: 'result', usage: { input_tokens: null, output_tokens: -1 } },
        ),
      );
      turn.close();
      const text = visible(log.pull(0).events).join('\n');
      expect(text).toContain('model unavailable');
      expect(text).toContain('Usage and cost unavailable');
      expect(text).not.toContain('input tokens: 0');
      expect(text).not.toContain('USD 0');
    },
  );

  it('drains a pressured multi-segment spool in full pages without losing split redactions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-activity-pages-'));
    try {
      const log = createNativeActivityLog({
        writerGeneration: 1,
        spoolDirectory: join(root, 'spool'),
        limits: { ...NATIVE_ACTIVITY_LIMITS, spoolBytes: 4096, segmentBytes: 2048 },
      });
      const turn = log.turn({ sequence: 1, harness: 'codex', forbiddenBytes: [MODEL] });
      const bytes = Buffer.from(
        codex(
          ...Array.from({ length: 193 }, (_, i) =>
            message(
              `m${i}`,
              i === 63 ? MODEL.slice(0, 15) : i === 64 ? MODEL.slice(15) : `Message ${i}.`,
            ),
          ),
        ),
      );
      turn.write(bytes.subarray(0, 37));
      const pressure = turn.write(bytes.subarray(37));
      expect(pressure).toBeInstanceOf(Promise);
      const seen = [];
      let after = 0;
      for (let page = 0; page < 4; page++) {
        const batch = log.pull(after);
        expect(log.pull(after)).toEqual(batch); // No ACK: exact replay.
        seen.push(...batch.events);
        after = batch.events.at(-1).index;
      }
      log.pull(after);
      await pressure;
      turn.close();
      expect(seen.map((event) => event.index)).toEqual(
        Array.from({ length: 193 }, (_, i) => i + 1),
      );
      expectNoSecret(seen, MODEL);
      expect(log.pull(after)).toMatchObject({ events: [], complete: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams parsed codex messages and tool calls through the existing normalizer', () => {
    const { log, turn } = turnOf({ forbiddenBytes: [] });
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
    expect(before.events[0]).toMatchObject({
      sequence: 1,
      writerGeneration: 1,
      kind: 'stdout',
      content: 'I will read the scaffold first.',
    });
    expect(before.events[1].content).toContain('cat src/game.js');
    expect(before.events[1].content).not.toContain('/mnt/native/project');
    turn.close();
    const after = log.pull(2);
    expect(after).toMatchObject({ events: [], complete: true, last: 2 });
  });

  it('withholds reasoning and raw diagnostics, reporting only a count', () => {
    const { log, turn } = turnOf();
    write(
      turn,
      codex(thread, {
        type: 'item.completed',
        item: { id: 'r', type: 'reasoning', text: 'private chain of thought' },
      }),
    );
    write(turn, 'not json at all\n');
    turn.close();
    const { events } = log.pull(0);
    expect(JSON.stringify(events)).not.toContain('private chain of thought');
    expect(JSON.stringify(events)).not.toContain('not json at all');
    expect(events).toHaveLength(1);
    expect(events[0].display).toMatchObject({
      type: 'system',
      title: '2 unparsed harness output entries were withheld',
    });
  });

  it('redacts a forbidden credential in messages, tool input and output', () => {
    const { log, turn } = turnOf();
    write(
      turn,
      codex(
        thread,
        message('m1', `The model key is ${MODEL}.`),
        shell(
          'c1',
          `curl -H "Authorization: token ${GIT}" https://api.github.com`,
          `echo ${MODEL}\n`,
        ),
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
    // A safely redacted prefix may already be visible.
    expectNoSecret(log.pull(0).events, MODEL);
    write(turn, codex(message('m2', `${MODEL.slice(cut)} was the rest.`)), [9]);
    turn.close();
    const { events } = log.pull(0);
    expect(events.map((event) => event.content)).toEqual([
      'Part one: [REDACTED]',
      '[REDACTED] was the rest.',
    ]);
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
    const { turn } = turnOf();
    const event = {
      content: `Running tool shell\n${GIT.slice(0, 20)}`,
      display: {
        type: 'tool',
        level: 'error',
        title: 'Shell failed',
        details: `${GIT.slice(20)} rejected`,
      },
    };
    turn.write(Buffer.alloc(0));
    // Feed the normalized event directly through the same public boundary.
    const sanitized = nativePublicActivity(event);
    expect(sanitized.display.details).toContain(GIT.slice(20));
    const guard = createNativeSecretGuard([GIT]);
    const marks = guard.mark(
      `${sanitized.content}${sanitized.display.title}${sanitized.display.details}`,
    );
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
        shell(
          'c1',
          'env',
          `GIT_PASSWORD=${encodeURIComponent(secret)}\nAWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE\nHOME=/home/node\n`,
        ),
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
        shell(
          'c1',
          'cat /home/node/.native-homes/b/a/.codex/sessions/rollout.jsonl',
          '{"role":"user","content":"hidden transcript"}',
        ),
        shell('c2', 'cat /proc/self/environ', 'AWS_BEARER_TOKEN_BEDROCK=unknown-value'),
        shell('c3', 'cat /mnt/native/.native-control/writer-2/status.json', '{"status":"running"}'),
        shell(
          'c4',
          'cat aidlc/spaces/default/intents/x/.aidlc-engine/steering-token-key',
          'key-material',
        ),
        shell('c5', 'cat .git/config', '[remote "origin"]'),
        message('m1', 'I checked /home/node/.native-homes/b/a/.codex/config.toml earlier.'),
      ),
    );
    turn.close();
    const { events } = log.pull(0);
    const text = JSON.stringify(events);
    for (const hidden of [
      'hidden transcript',
      'unknown-value',
      '"running"',
      'key-material',
      'remote "origin"',
      '/home/node',
    ])
      expect(text).not.toContain(hidden);
    expect(
      events
        .slice(0, 5)
        .every((event) =>
          event.content.includes('[Input and output withheld: private runtime path]'),
        ),
    ).toBe(true);
    expect(events[5].content).toBe('I checked ‹private path› earlier.');
  });

  it('bounds every field without splitting characters', () => {
    const long = `${'🐦'.repeat(5000)}tail`;
    const event = nativePublicActivity({
      content: long,
      display: { type: 'message', summary: long, title: long },
    });
    expect(Buffer.byteLength(event.content)).toBeLessThanOrEqual(
      NATIVE_ACTIVITY_LIMITS.contentBytes,
    );
    expect(Buffer.byteLength(event.display.title)).toBeLessThanOrEqual(
      NATIVE_ACTIVITY_LIMITS.titleBytes,
    );
    expect(event.content).toMatch(/bytes omitted\]$/);
    expect(truncateUtf8('short', 100)).toBe('short');
  });

  it('preserves every unacknowledged event under pressure', async () => {
    const limits = { ...NATIVE_ACTIVITY_LIMITS, memoryEvents: 2, batchEvents: 2 };
    const { log, turn } = turnOf({ limits, forbiddenBytes: [] });
    const pressure = turn.write(
      Buffer.from(
        codex(thread, ...Array.from({ length: 4 }, (_, i) => message(`m${i}`, `message ${i}`))),
      ),
    );
    expect(pressure).toBeInstanceOf(Promise);
    let resumed = false;
    pressure.then(() => {
      resumed = true;
    });
    const first = log.pull(0);
    expect(first.events.map((e) => e.index)).toEqual([1, 2]);
    expect(log.pull(0)).toEqual(first);
    expect(resumed).toBe(false);
    expect(log.pull(2).events.map((e) => e.index)).toEqual([3, 4]);
    log.pull(4);
    await pressure;
    expect(resumed).toBe(true);
    turn.close();
  });

  it('replays a closed cold spool and distinguishes an open next turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-cold-activity-'));
    const spoolDirectory = join(root, 'spool');
    try {
      const log = createNativeActivityLog({ writerGeneration: 1, spoolDirectory });
      const turn = log.turn({ sequence: 1, harness: 'codex' });
      write(turn, codex(message('m1', 'Saved before process loss.')));
      expect(readNativeActivitySpool({ spoolDirectory, writerGeneration: 1 }).complete).toBe(false);
      turn.close();
      expect(readNativeActivitySpool({ spoolDirectory, writerGeneration: 1 })).toMatchObject({
        complete: true,
        last: 1,
      });
      expect(
        readNativeActivitySpool({ spoolDirectory, writerGeneration: 1, after: 1 }),
      ).toMatchObject({ complete: true, events: [] });
      const next = log.turn({ sequence: 2, harness: 'codex' });
      expect(
        readNativeActivitySpool({ spoolDirectory, writerGeneration: 1, after: 1 }),
      ).toMatchObject({ complete: false, events: [] });
      next.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains older disk records before memory after a partial spool failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-activity-'));
    let calls = 0;
    try {
      const log = createNativeActivityLog({
        writerGeneration: 1,
        limits: { ...NATIVE_ACTIVITY_LIMITS, memoryEvents: 2, batchEvents: 2 },
        spoolDirectory: join(root, 'spool'),
        writeSpool(fd, buffer, offset, length) {
          if (++calls === 5) {
            writeSync(fd, buffer, offset, 8);
            throw new Error('disk full');
          }
          return writeSync(fd, buffer, offset, length);
        },
      });
      const turn = log.turn({ sequence: 1, harness: 'codex' });
      const pressure = turn.write(
        Buffer.from(
          codex(...Array.from({ length: 7 }, (_, i) => message(`m${i}`, `message ${i}`))),
        ),
      );
      expect(pressure).toBeInstanceOf(Promise);
      let cursor = 0;
      const seen = [];
      for (let n = 0; n < 4; n++) {
        const batch = log.pull(cursor);
        expect(log.pull(cursor)).toEqual(batch);
        seen.push(...batch.events.map((e) => e.index));
        cursor = batch.events.at(-1).index;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(log.pull(7).events).toEqual([]);
      await pressure;
      turn.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases masked sparse output within a bounded delay while the turn stays open', async () => {
    vi.useFakeTimers();
    try {
      const { log, turn } = turnOf();
      write(turn, codex(message('sparse', 'I am inspecting the scaffold')));
      await vi.advanceTimersByTimeAsync(NATIVE_ACTIVITY_LIMITS.flushMs);
      const batch = log.pull(0);
      expect(batch.complete).toBe(false);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0].content).toMatch(/^I am inspecting/);
      expectNoSecret(batch.events, MODEL);
      turn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases pressure waiters on interruption without deleting pending output', async () => {
    const controller = new AbortController();
    const log = createNativeActivityLog({
      writerGeneration: 1,
      limits: { ...NATIVE_ACTIVITY_LIMITS, memoryEvents: 1 },
    });
    const turn = log.turn({ sequence: 1, harness: 'codex', signal: controller.signal });
    const pressure = turn.write(Buffer.from(codex(message('m1', 'Preserve this output.'))));
    expect(pressure).toBeInstanceOf(Promise);
    controller.abort();
    await pressure;
    expect(log.pull(0).events[0].content).toBe('Preserve this output.');
    expect(log.open).toBe(false);
  });

  it('redacts secrets before display truncation', () => {
    const { log, turn } = turnOf({
      limits: { ...NATIVE_ACTIVITY_LIMITS, contentBytes: 96, summaryBytes: 96 },
    });
    write(turn, codex(message('m1', `${'prefix '.repeat(8)}${MODEL} ending.`)));
    turn.close();
    expectNoSecret(log.pull(0).events, MODEL);
  });

  it('discards an oversized parser line and resumes on the next complete record', () => {
    const { log, turn } = turnOf({
      forbiddenBytes: [],
      limits: { ...NATIVE_ACTIVITY_LIMITS, lineChars: 160 },
    });
    for (let i = 0; i < 200; i++) turn.write(Buffer.from('x'.repeat(100)));
    write(turn, '\n' + codex(message('next', 'After oversized diagnostics.')));
    turn.close();
    const text = JSON.stringify(log.pull(0));
    expect(text).toContain('After oversized diagnostics.');
    expect(text).not.toContain('x'.repeat(160));
  });

  it('never resends acknowledged events and keeps unacknowledged ones after a failed ingestion', () => {
    const { log, turn } = turnOf({ forbiddenBytes: [] });
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
    write(
      turn,
      `${JSON.stringify({ schemaVersion: 1, transport: 'kiro-acp', ok: true, text: 'Which title?' })}\n`,
    );
    turn.close({ failed: false });
    expect(
      log.pull(0).events.map((event) => [event.kind, event.display.title ?? event.content]),
    ).toEqual([
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
      expect.objectContaining({
        sequence: 2,
        writerGeneration: 2,
        display: expect.objectContaining({ level: 'error' }),
      }),
    ]);
    expect(log.open).toBe(true);
  });
});
