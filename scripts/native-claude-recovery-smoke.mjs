// Run INSIDE a disposable --network none container, with this checkout mounted
// read-only and /tmp on tmpfs. Uses the image's installed CLI and an inert
// loopback response server: no provider, credentials, user files or model.
// Optional argv[2] selects the image's old adapter for failure-before evidence.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';
import {
  buildNativePendingInput,
  nativeAnswerText,
} from '../lambda/shared/native-pending-input.js';

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
let agentSent = false;
let engineSent = false;
const packageDirectory = process.env.NATIVE_QUALIFICATION_PACKAGE;
const engineEnv = {};
if (packageDirectory) {
  // This qualification case is for the incident's exact public package. These
  // are fixture checks, not production package selection or a version upgrade.
  const pins = {
    'aidlc-linux-arm64': '18e6fefcd3591aefd66d8a485fba5deaa870c6bbc6fd3e389d4b0b2032ce9f35',
    'aidlc-runtime-2.11.0.tar.gz':
      '68906435223b47d6dfda59d79def78974d7b37e38b5649a56402a0007a41fad4',
    'version.json': '5711b7af08fc8c293576fdde9252b6b9fe13a7041f7db5f0dd33f6b56223c1e9',
    'checksums.txt': 'c49098da9ce425afbc5c5beeaae395aa8480c6f887107b0b455cc1143cac2ac9',
  };
  const pkg = `${root}/package`,
    tools = `${root}/tools`;
  await fs.mkdir(pkg);
  await fs.mkdir(tools);
  for (const [name, hash] of Object.entries(pins)) {
    const bytes = await fs.readFile(`${packageDirectory}/${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    await fs.writeFile(`${pkg}/${name}`, bytes);
  }
  await fs.copyFile(
    `${packageDirectory}/aidlc-release.intoto.jsonl`,
    `${pkg}/aidlc-release.intoto.jsonl`,
  );
  await fs.chmod(`${pkg}/aidlc-linux-arm64`, 0o700);
  const gh = ['/usr/bin/gh', '/usr/local/bin/gh'].find((path) => {
    try {
      return process.getBuiltinModule('node:fs').existsSync(path);
    } catch {
      return false;
    }
  });
  assert.ok(gh);
  // Fixture-only transport of public trust roots. All signature, issuer,
  // repository, ref and source-digest checks in the real installer still run.
  await fs.writeFile(
    `${tools}/gh`,
    `#!/bin/sh\nexec ${gh} "$@" --custom-trusted-root ${packageDirectory}/trusted-root.jsonl\n`,
    { mode: 0o700 },
  );
  Object.assign(engineEnv, {
    PATH: `${tools}:${root}/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
    AIDLC_INSTALL_ROOT: `${root}/data`,
    AIDLC_BIN_DIR: `${root}/bin`,
    AIDLC_OFFLINE: '1',
    AIDLC_PROJECT_DIR: project,
  });
  const run = async (command, args) => {
    const result = await runNativeCommand({
      command,
      args,
      cwd: project,
      env: { HOME: home, ...engineEnv },
      timeoutMs: 120000,
    });
    assert.equal(
      result.exitCode,
      0,
      `Offline pinned installer failed: ${result.stdout} ${result.stderr}`,
    );
    assert.equal(result.cleanupComplete, true);
  };
  await run(`${pkg}/aidlc-linux-arm64`, ['use', '2.11.0', '--from', pkg, '--offline', '--json']);
  await run(`${root}/bin/aidlc`, [
    'config',
    '--pin',
    '2.11.0',
    '--project-dir',
    project,
    '--from',
    pkg,
    '--offline',
    '--json',
  ]);
  await run(`${root}/bin/aidlc`, [
    'config',
    '--harness',
    'claude',
    '--project-dir',
    project,
    '--from',
    `${root}/data/versions/2.11.0/runtime/claude`,
    '--mcp',
    'none',
    '--yes',
    '--json',
  ]);
  await fs.mkdir(`${project}/.native-control`, { mode: 0o700 });
}

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
  let content;
  if (packageDirectory && turn === 1 && !engineSent) {
    engineSent = true;
    content = {
      type: 'tool_use',
      id: 'tool-fixture-engine',
      name: 'Bash',
      input: {
        command:
          'aidlc engine orchestrate next "Build a bounded qualification fixture" > .native-control/engine-ask.json',
      },
    };
  } else if (turn === 2 && !toolSent) {
    toolSent = true;
    content = {
      type: 'tool_use',
      id: 'tool-fixture-cwd',
      name: 'Bash',
      input: { command: 'mkdir -p nested && cd nested && pwd' },
    };
  } else if (turn === 2 && !agentSent && request.tools?.some((tool) => tool.name === 'Agent')) {
    agentSent = true;
    content = {
      type: 'tool_use',
      id: 'tool-fixture-agent',
      name: 'Agent',
      input: {
        description: 'Inspect fixture folder',
        prompt: 'Return a brief fixture observation.',
        subagent_type: 'Explore',
      },
    };
  } else content = { type: 'text', text: `Fixture question ${turn}?` };
  const tool = content.type === 'tool_use';
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
    let trace = '';
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
        ...engineEnv,
      },
      stdin: turn === 1 ? 'Present fixture question.' : `Fixture answer ${turn - 1}.`,
      timeoutMs: 60_000,
      onStdoutChunk: (chunk) => {
        output.write(chunk);
        if (trace.length < 1024 * 1024) trace += chunk.toString();
      },
    });
    assert.equal(command.exitCode, 0, 'CLI fixture exit');
    assert.equal(command.cleanupComplete, true, 'CLI descendants reaped');
    let completed;
    try {
      completed = output.finish();
    } catch (error) {
      console.error(
        JSON.stringify({
          turn,
          frames: trace
            .trim()
            .split('\n')
            .map((line) => {
              try {
                const value = JSON.parse(line);
                return Object.fromEntries(
                  [
                    'type',
                    'subtype',
                    'stop_reason',
                    'terminal_reason',
                    'prevent_continuation',
                    'parent_tool_use_id',
                    'is_error',
                  ]
                    .filter((k) => Object.hasOwn(value, k))
                    .map((k) => [k, value[k]]),
                );
              } catch {
                return { invalid: true };
              }
            }),
        }),
      );
      throw error;
    }
    assert.ok(completed.messages.length >= 1);
    assert.ok(
      completed.messages.every(
        (message) => message.type === 'text' && message.text === `Fixture question ${turn}?`,
      ),
    );
    console.log(JSON.stringify({ turn, cli: installed, cliCompleted: true }));
    if (turn === 1 && packageDirectory) {
      const ask = JSON.parse(
        await fs.readFile(`${project}/.native-control/engine-ask.json`, 'utf8'),
      );
      assert.equal(ask.kind, 'ask', `Expected typed intake ask, received ${ask.kind}`);
      assert.equal(ask.ask_type, 'compose-offer');
      const input = buildNativePendingInput({
        spec: { version: 3, ask },
        messagesText: 'Different explanatory prose.',
      });
      assert.ok(input);
      assert.deepEqual(
        input.questions[0].options.map((o) => o.label),
        ['compose', ...ask.scope_commands.map((row) => row.scope)],
      );
      assert.equal(
        nativeAnswerText(input, { answers: [{ selectedOptions: [1] }] }),
        ask.scope_commands[0].scope,
      );
      assert.ok(ask.scope_commands.every((row) => row.command.includes('--request')));
      console.log(
        JSON.stringify({
          workflow: '2.11.0',
          typedAsk: ask.ask_type,
          options: input.questions[0].options.length,
          provenanceVerified: true,
        }),
      );
    }
    const captured = await adapter.captureNativeSessionRecovery(options);
    const transcript = captured.files.find(
      (file) => file.scope === 'home' && file.path.endsWith(`/${id}.jsonl`),
    );
    assert.ok(transcript);
    if (turn === 1) first = Buffer.from(transcript.content);
    if (turn === 2) {
      const rows = transcript.content.toString().trim().split('\n').map(JSON.parse);
      assert.ok(rows.some((row) => row.cwd === `${project}/nested`));
      assert.equal(agentSent, true, 'Installed CLI exposed and ran its Agent tool');
      assert.ok(
        captured.files.some(
          (file) => file.scope === 'home' && /subagents\/agent-[^/]+\.meta\.json$/.test(file.path),
        ),
        'Actual CLI subagent metadata was captured',
      );
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
