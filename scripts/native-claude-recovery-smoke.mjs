// Run INSIDE a disposable --network none container, with this checkout mounted
// read-only and /tmp on tmpfs. Uses the image's installed CLI and an inert
// loopback response server: no provider, credentials, user files or model.
// Optional argv[2] selects the image's old adapter for failure-before evidence.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';

const adapter = await import(
  process.argv[2] || '../lambda/agentcore/native/session-recovery-files.js'
);
const root = await fs.mkdtemp('/tmp/native-cli-fixture-');
const project = `${root}/project`;
const home = `${root}/home`;
await fs.mkdir(project, { mode: 0o700 });
await fs.mkdir(home, { mode: 0o700 });
let turn = 1;
let toolSent = false;
let calls = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) {
      req.destroy();
      return;
    }
  }
  if (!req.url.startsWith('/v1/messages') || ++calls > 12) {
    res.writeHead(400).end('{}');
    return;
  }
  const request = JSON.parse(raw);
  const tool = turn === 2 && !toolSent;
  if (tool) toolSent = true;
  const content = tool
    ? {
        type: 'tool_use',
        id: 'tool-fixture-cwd',
        name: 'Bash',
        input: { command: 'mkdir -p nested && cd nested && pwd' },
      }
    : { type: 'text', text: `Fixture question ${turn}?` };
  const message = {
    id: `msg-fixture-${calls}`,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const reason = tool ? 'tool_use' : 'end_turn';
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        ...message,
        content: [content],
        stop_reason: reason,
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('message_start', { message });
  send('content_block_start', {
    index: 0,
    content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' },
  });
  send('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
      : { type: 'text_delta', text: content.text },
  });
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', {});
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const id = randomUUID();
const options = { project, home, harness: 'claude', nativeSessionId: id };
try {
  const installed = JSON.parse(
    await fs.readFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json', 'utf8'),
  ).version;
  assert.equal(installed, adapter.NATIVE_RECOVERY_HARNESS_VERSIONS.claude);
  let first;
  for (turn = 1; turn <= 3; turn++) {
    const output = createNativeTurnOutput({
      harness: 'claude',
      nativeSessionId: turn > 1 ? id : null,
    });
    const command = await runNativeCommand({
      command: '/usr/local/bin/claude',
      args: [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--model',
        'claude-sonnet-4-6',
        '--dangerously-skip-permissions',
        ...(turn === 1 ? ['--session-id', id] : ['--resume', id]),
      ],
      cwd: project,
      // Explicit environment: never inherit host/provider credentials.
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        CLAUDE_CONFIG_DIR: `${home}/.claude`,
        ANTHROPIC_API_KEY: 'fixture-no-provider',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        CI: '1',
      },
      stdin: turn === 1 ? 'Present fixture question.' : `Fixture answer ${turn - 1}.`,
      timeoutMs: 60_000,
      onStdoutChunk: (chunk) => output.write(chunk),
    });
    assert.equal(command.exitCode, 0, 'CLI fixture exit');
    assert.equal(command.cleanupComplete, true, 'CLI descendants reaped');
    assert.deepEqual(output.finish().messages, [
      { type: 'text', text: `Fixture question ${turn}?` },
    ]);
    console.log(JSON.stringify({ turn, cli: installed, cliCompleted: true }));
    const captured = await adapter.captureNativeSessionRecovery(options);
    const transcript = captured.files.find(
      (file) => file.scope === 'home' && file.path.endsWith(`/${id}.jsonl`),
    );
    assert.ok(transcript);
    if (turn === 1) first = Buffer.from(transcript.content);
    if (turn === 2) {
      const rows = transcript.content.toString().trim().split('\n').map(JSON.parse);
      assert.ok(rows.some((row) => row.cwd === `${project}/nested`));
      assert.ok(rows.every((row) => row.sessionId === undefined || row.sessionId === id));
      assert.ok(transcript.content.subarray(0, first.length).equals(first));
      await fs.rename(project, `${root}/old-project`);
      await fs.rename(home, `${root}/old-home`);
      await fs.mkdir(project, { mode: 0o700 });
      await fs.mkdir(home, { mode: 0o700 });
      await adapter.restoreNativeSessionRecovery({ ...options, ...captured });
      assert.deepEqual(await fs.readFile(`${home}/${transcript.path}`), transcript.content);
    }
    console.log(JSON.stringify({ turn, checkpointVerified: true, files: captured.files.length }));
  }
  console.log(JSON.stringify({ passed: 3, restoredBeforeTurn: 3, providerCalls: 0 }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
