// Run INSIDE a disposable --network none container, with this checkout mounted
// read-only and /tmp on tmpfs. Uses the image's installed CLI and an inert
// loopback response server: no provider, credentials, user files or model.
// Optional argv[2] selects the image's old adapter for failure-before evidence.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';
import {
  buildNativePendingInput,
  nativeAnswerText,
} from '../lambda/shared/native-pending-input.js';

import { prepareQualificationPackage } from './native-qualification-package.mjs';
import { sendClaudeResponse } from './native-qualification-provider.mjs';

try {
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
  let parentResponse;
  let releaseChild;
  let backgroundSynchronized = false;
  let engineSent = false;
  let parentReplies = 0;
  let invocationStarted = 0;
  let requestSamples = [];
  const packageDirectory = process.env.NATIVE_QUALIFICATION_PACKAGE;
  const engineEnv = {};
  if (packageDirectory) {
    const { directory: pkg, tools } = await prepareQualificationPackage(root, packageDirectory);
    Object.assign(engineEnv, {
      PATH: `${tools}:${root}/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
      AIDLC_INSTALL_ROOT: `${root}/data`,
      AIDLC_BIN_DIR: `${root}/bin`,
      AIDLC_OFFLINE: '1',
      AIDLC_PROJECT_DIR: project,
    });
    const run = async (phase, command, args) => {
      const started = performance.now();
      const result = await runNativeCommand({
        command,
        args,
        cwd: project,
        env: { HOME: home, ...engineEnv },
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 0, 'Offline pinned installer failed');
      assert.equal(result.cleanupComplete, true);
      console.log(
        JSON.stringify({
          probe: 'installed-initialization',
          phase,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
    };
    await run('package-installation', `${pkg}/aidlc-linux-arm64`, [
      'use',
      '2.11.0',
      '--from',
      pkg,
      '--offline',
      '--json',
    ]);
    await run('project-pin', `${root}/bin/aidlc`, [
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
    await run('harness-configuration', `${root}/bin/aidlc`, [
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
    requestSamples.push({
      atMs: Math.round(performance.now() - invocationStarted),
      bytes: Buffer.byteLength(raw),
      systemBytes: Buffer.byteLength(JSON.stringify(request.system ?? null)),
      toolsBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
      messagesBytes: Buffer.byteLength(JSON.stringify(request.messages ?? [])),
      toolDefinitions: request.tools?.length ?? 0,
    });
    if (turn === 2 && agentSent && !request.tools?.some((tool) => tool.name === 'Agent')) {
      // The child must finish after the parent's model response, so its
      // notification cannot be consumed by that same response. The CLI may
      // defer its terminal frame until children drain; observe assistant
      // output instead of waiting for that terminal frame or using a timer.
      await parentResponse;
      backgroundSynchronized = true;
    }
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
          run_in_background: true,
        },
      };
    } else {
      const silentFollowUp =
        turn === 2 && request.tools?.some((tool) => tool.name === 'Agent') && parentReplies++ > 0;
      content = {
        type: 'text',
        text: silentFollowUp
          ? 'No response requested.'
          : turn === 4
            ? '<cc-memory filenames="fixture.md">Fixture question 4?</cc-memory>'
            : `Fixture question ${turn}?`,
      };
    }
    const tool = content.type === 'tool_use';
    const contentBlocks =
      turn === 3 && !tool ? [{ type: 'text', text: 'Fixture proposal 3.' }, content] : [content];
    sendClaudeResponse(res, request, contentBlocks, `msg-fixture-${calls}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const id = randomUUID();
  const options = { project, home, harness: 'claude', nativeSessionId: id };
  try {
    const installed = JSON.parse(
      await fs.readFile(
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json',
        'utf8',
      ),
    ).version;
    assert.equal(installed, adapter.NATIVE_RECOVERY_HARNESS_VERSIONS.claude);
    let first;
    for (turn = 1; turn <= 4; turn++) {
      if (turn === 2)
        parentResponse = new Promise((resolve) => {
          releaseChild = resolve;
        });
      const output = createNativeTurnOutput({
        harness: 'claude',
        nativeSessionId: turn > 1 ? id : null,
      });
      let trace = '';
      let resultLine = '';
      requestSamples = [];
      invocationStarted = performance.now();
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
          if (turn === 2 && !backgroundSynchronized) {
            resultLine += chunk.toString();
            let newline;
            while ((newline = resultLine.indexOf('\n')) !== -1) {
              const line = resultLine.slice(0, newline);
              resultLine = resultLine.slice(newline + 1);
              const event = JSON.parse(line);
              if (
                event.type === 'assistant' &&
                event.parent_tool_use_id == null &&
                event.message?.content?.some((part) => part.type === 'text')
              )
                releaseChild();
            }
          }
        },
      });
      assert.equal(command.exitCode, 0, 'CLI fixture exit');
      assert.equal(command.cleanupComplete, true, 'CLI descendants reaped');
      const elapsedMs = Math.round(performance.now() - invocationStarted);
      const frames = trace
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const hooks = frames.filter(
        (event) =>
          event.type === 'system' &&
          ['hook_started', 'hook_response', 'hook_progress'].includes(event.subtype),
      );
      const results = frames.filter(
        (event) => event.type === 'result' && event.parent_tool_use_id == null,
      );
      console.log(
        JSON.stringify({
          probe: 'installed-turn',
          turn,
          elapsedMs,
          requests: requestSamples,
          observedHookFrames: hooks.length,
          completedParentQueries: results.length,
          assistantTextBlocks: frames
            .filter((event) => event.type === 'assistant' && event.parent_tool_use_id == null)
            .map((event) => event.message.content.filter((part) => part.type === 'text').length),
          terminalResultBytes: results.map((event) => Buffer.byteLength(event.result ?? '')),
          reportedApiMs: results.map((event) =>
            Number.isSafeInteger(event.duration_api_ms) ? event.duration_api_ms : null,
          ),
          externalProviderCalls: 0,
        }),
      );
      // Prove the installed CLI emitted the intended variants. A fixture that
      // happens not to consume its background notification must not pass this tier.
      if (turn === 2) {
        assert.equal(backgroundSynchronized, true, 'Child reply follows observed parent response');
        assert.ok(results.length >= 2, 'background notification starts another parent query');
        assert.equal(results.at(-1).result, '', 'CLI suppresses the silent response sentinel');
        assert.equal(results.at(-1).terminal_reason, 'completed');
        assert.equal(results.at(-1).stop_reason, 'end_turn');
      }
      if (turn === 4)
        assert.equal(results.at(-1).result, 'Fixture question 4?', 'CLI removes memory markup');
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
          (message) =>
            message.type === 'text' &&
            (message.text === `Fixture question ${turn}?` ||
              (turn === 3 && message.text === 'Fixture proposal 3.') ||
              (turn === 4 &&
                message.text ===
                  '<cc-memory filenames="fixture.md">Fixture question 4?</cc-memory>')),
        ),
      );
      if (turn === 3)
        assert.ok(completed.messages.some((message) => message.text === 'Fixture proposal 3.'));
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
      const captureStarted = performance.now();
      const captured = await adapter.captureNativeSessionRecovery(options);
      console.log(
        JSON.stringify({
          probe: 'installed-capture',
          turn,
          elapsedMs: Math.round(performance.now() - captureStarted),
          files: captured.files.length,
          bytes: captured.files.reduce((n, file) => n + file.bytes, 0),
        }),
      );
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
            (file) =>
              file.scope === 'home' && /subagents\/agent-[^/]+\.meta\.json$/.test(file.path),
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
    console.log(JSON.stringify({ passed: 4, restoredBeforeTurn: 3, providerCalls: 0 }));
  } finally {
    releaseChild?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
} catch (error) {
  // Assertion diffs may contain CLI text. Report only the stable failure code.
  console.error(
    JSON.stringify({
      probe: 'installed-claude-baseline',
      status: 'FAIL',
      code: /^(?:native_[a-z_]+|ERR_ASSERTION)$/.test(error.code ?? '')
        ? error.code
        : 'fixture_failure',
    }),
  );
  process.exitCode = 1;
}
