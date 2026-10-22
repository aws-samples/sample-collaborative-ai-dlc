// Deterministic provider wire fixtures, not CLI substitutes. No raw request,
// prompt, response or tool arguments are retained in reports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

export function sendClaudeResponse(res, request, blocks, id) {
  const tool = blocks.some((block) => block.type === 'tool_use');
  const message = {
    id,
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
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ...message, content: blocks, stop_reason: reason }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('message_start', { message });
  for (const [index, block] of blocks.entries()) {
    const isTool = block.type === 'tool_use';
    send('content_block_start', {
      index,
      content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' },
    });
    send('content_block_delta', {
      index,
      delta: isTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text },
    });
    send('content_block_stop', { index });
  }
  send('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', {});
  res.end();
}

function sendCodexResponse(res, text, command, id) {
  const item = command
    ? {
        id: `fc_${id}`,
        call_id: `call_${id}`,
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: command, max_output_tokens: 1000, yield_time_ms: 10_000 }),
        status: 'completed',
      }
    : {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of [
    ['response.created', { response: { id: `resp_${id}`, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } }],
    ['response.output_item.done', { output_index: 0, item }],
    [
      'response.completed',
      {
        response: {
          id: `resp_${id}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      },
    ],
  ])
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

function sendOpenCodeResponse(res, request, text, tool, id) {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call_${id}`,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input),
            },
          },
        ],
      }
    : { role: 'assistant', content: text };
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        choices: [{ index: 0, message: delta, finish_reason: 'stop' }],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' },
  ])
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [choice], usage })}\n\n`,
    );
  res.end('data: [DONE]\n\n');
}

export async function qualificationProvider(harness, { claudeReply, requestLimit = 32 } = {}) {
  assert.ok(Number.isSafeInteger(requestLimit) && requestLimit >= 1 && requestLimit <= 64);
  let turn = 0;
  let started;
  let toolSent = false;
  let incompleteSent = false;
  let command;
  let expectedAnswer;
  let expectedHistory = [];
  let openCodeWorkflow;
  let writeSent = false;
  let engineAsk;
  let mode = 'normal';
  let failure;
  let samples = [];
  let calls = 0;
  let commandCallId;
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const bytes of req) {
        raw += bytes;
        assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024, 'Bounded fixture input');
      }
      assert.ok(++calls <= requestLimit, 'Bounded fixture request count');
      assert.equal(
        new URL(req.url, 'http://fixture').pathname,
        harness === 'claude'
          ? '/v1/messages'
          : harness === 'codex'
            ? '/v1/responses'
            : '/v1/chat/completions',
      );
      const request = JSON.parse(raw);
      const tools = request.tools ?? [];
      const toolName = { claude: 'Bash', codex: 'exec_command', opencode: 'bash' }[harness];
      const primary = tools.some((tool) => (tool.name ?? tool.function?.name) === toolName);
      samples.push({
        atMs: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(raw),
        contextBytes: Buffer.byteLength(JSON.stringify(request.messages ?? request.input ?? [])),
        instructionBytes: Buffer.byteLength(
          JSON.stringify(request.system ?? request.instructions ?? null),
        ),
        toolsBytes: Buffer.byteLength(JSON.stringify(tools)),
        toolDefinitions: tools.length,
        primary,
      });
      if (primary && expectedAnswer)
        assert.ok(raw.includes(expectedAnswer), 'Protected answer delivered');
      if (primary)
        for (const text of expectedHistory)
          assert.ok(raw.includes(text), 'Restored history reaches the installed provider request');
      if (mode === 'hang') return;
      if (mode === 'failed' || (mode === 'incomplete' && primary && incompleteSent)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: 'fixture failure' },
          }),
        );
        return;
      }
      if (mode === 'incomplete' && primary) {
        incompleteSent = true;
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"type":');
        return;
      }
      if (harness === 'claude' && claudeReply) {
        const blocks = await claudeReply(request);
        assert.ok(Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 4);
        sendClaudeResponse(res, request, blocks, `fixture${calls}`);
        return;
      }
      const nextCommand = primary && !toolSent ? command : null;
      if (nextCommand) toolSent = true;
      const text = primary ? `Fixture question ${turn}?` : 'Fixture title';
      const id = `fixture${calls}`;
      if (harness === 'codex' && primary) {
        if (nextCommand) commandCallId = `call_${id}`;
        else if (commandCallId) {
          const result = request.input?.findLast(
            (item) => item.type === 'function_call_output' && item.call_id === commandCallId,
          );
          assert.match(
            result?.output ?? '',
            /(?:^|\n)Process exited with code 0(?:\n|$)/,
            'The scripted provider requires successful tool completion before its next question',
          );
          commandCallId = undefined;
        }
      }
      if (harness === 'claude')
        sendClaudeResponse(
          res,
          request,
          [
            nextCommand
              ? { type: 'tool_use', id, name: toolName, input: { command: nextCommand } }
              : { type: 'text', text },
          ],
          id,
        );
      else if (harness === 'codex') sendCodexResponse(res, text, nextCommand, id);
      else {
        let tool = nextCommand
          ? {
              name: 'bash',
              input: { command: nextCommand, description: 'Run offline fixture step' },
            }
          : null;
        if (primary && openCodeWorkflow && !tool && !writeSent) {
          let content = 'fixture cwd witness';
          if (openCodeWorkflow.questionPath || openCodeWorkflow.directivePath) {
            const result = request.messages.findLast((message) => message.role === 'tool');
            const output =
              typeof result?.content === 'string'
                ? result.content
                : result?.content?.map((part) => part.text ?? '').join('');
            assert.ok(output, 'Actual engine tool result is required');
            // OpenCode may append bash metadata after the engine JSON.
            engineAsk = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
            if (openCodeWorkflow.questionPath) {
              assert.equal(engineAsk.ask_type, 'compose-offer');
              assert.ok(
                engineAsk.scope_commands.length > 0,
                'Real workflow supplied typed choices',
              );
            }
            content = JSON.stringify(
              openCodeWorkflow.questionPath ? { version: 3, ask: engineAsk } : engineAsk,
            );
          }
          assert.ok(
            tools.some((entry) => entry.function?.name === 'write'),
            'Installed write tool',
          );
          tool = {
            name: 'write',
            input: {
              filePath:
                openCodeWorkflow.questionPath ??
                openCodeWorkflow.directivePath ??
                openCodeWorkflow.writePath,
              content,
            },
          };
          toolSent = true;
          writeSent = true;
        }
        sendOpenCodeResponse(res, request, text, tool, id);
      }
    } catch (error) {
      failure ??= error;
      res.writeHead(400).end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    begin(input) {
      ({
        turn,
        command,
        expectedAnswer,
        expectedHistory = [],
        openCodeWorkflow,
        mode = 'normal',
      } = input);
      started = performance.now();
      toolSent = false;
      incompleteSent = false;
      writeSent = false;
      commandCallId = undefined;
      samples = [];
    },
    engineAsk: () => engineAsk,
    result() {
      if (failure) throw failure;
      return {
        totalRequests: calls,
        requests: samples,
        toolSent,
        incompleteSent,
        writeSent,
        historyWitnesses: expectedHistory.length,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function localProviderInvocation(harness, input, url) {
  const env = {
    ...input.env,
    AWS_EC2_METADATA_DISABLED: 'true',
    CI: '1',
  };
  const args = [...input.args];
  if (harness === 'claude') {
    // Production normally selects Bedrock; this fixture selects Anthropic's
    // documented compatible transport at an inert loopback address.
    delete env.CLAUDE_CODE_USE_BEDROCK;
    Object.assign(env, {
      ANTHROPIC_API_KEY: 'fixture-no-provider',
      ANTHROPIC_BASE_URL: url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    });
  } else if (harness === 'codex') {
    args.splice(
      args.length - 1,
      0,
      '-c',
      'model_provider="fixture"',
      '-c',
      'model_providers.fixture.name="Offline fixture"',
      '-c',
      `model_providers.fixture.base_url="${url}/v1"`,
      '-c',
      'model_providers.fixture.env_key="FIXTURE_TOKEN"',
      '-c',
      'model_providers.fixture.wire_api="responses"',
      '-c',
      'model_providers.fixture.request_max_retries=0',
      '-c',
      'model_providers.fixture.stream_max_retries=0',
    );
    env.FIXTURE_TOKEN = 'fixture-no-provider';
  } else if (harness === 'opencode') {
    Object.assign(env, {
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          fixture: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `${url}/v1`, apiKey: 'fixture-no-provider' },
            models: { test: { name: 'Offline fixture' } },
          },
        },
      }),
    });
  }
  return { ...input, args, env };
}
