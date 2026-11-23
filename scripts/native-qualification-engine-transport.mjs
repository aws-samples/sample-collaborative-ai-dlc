// Transport for the installed aidlc child. The SDK never resolves credentials.
// The child can submit coding inputs and read versioned results for its own
// attempt. The authority journal, engine snapshots and member routes stay private.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { mock } from 'node:test';
import {
  nativeEngineArn,
  nativeEngineObjectPrefix,
} from '../lambda/shared/native-workflow-protocol.js';

export async function engineTransport({ identity, pin, lambda, s3 }) {
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      const input = JSON.parse(await buffer(req));
      let result;
      if (req.url === '/invoke') {
        assert.equal(input.FunctionName, nativeEngineArn(identity(), pin));
        result = await lambda.send({
          input: { ...input, Payload: Buffer.from(input.Payload, 'base64') },
        });
        result.Payload = result.Payload.toString('base64');
      } else {
        const put = req.url === '/put';
        assert.ok(put || req.url === '/get');
        const allowed = put ? ['input'] : ['input', 'output'];
        assert.ok(
          allowed.some((purpose) =>
            input.Key.startsWith(nativeEngineObjectPrefix(identity(), purpose)),
          ),
        );
        if (put) input.Body = Buffer.from(input.Body, 'base64');
        else assert.ok(input.VersionId);
        const { PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
        result = await s3.send(put ? new PutObjectCommand(input) : new GetObjectCommand(input));
        if (!put) result.Body = (await buffer(result.Body)).toString('base64');
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400).end(error.code ?? 'fixture_transport_refused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    env: {
      NODE_OPTIONS: `--import=${import.meta.url}`,
      NATIVE_FIXTURE_PORT: String(server.address().port),
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Only the workflow dispatcher's SDK transports are substituted. Its argument
// relocation, context checks, immutable readback and command validator run normally.
if (process.argv[1] === '/opt/agentcore/native/workflow-cli.mjs') {
  const require = createRequire(process.argv[1]);
  const endpoint = `http://127.0.0.1:${process.env.NATIVE_FIXTURE_PORT}`;
  const send = async (route, input) => {
    const response = await fetch(`${endpoint}/${route}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  mock.method(
    require('@aws-sdk/client-lambda').LambdaClient.prototype,
    'send',
    async ({ input }) => {
      const result = await send('invoke', {
        ...input,
        Payload: Buffer.from(input.Payload).toString('base64'),
      });
      return { Payload: Buffer.from(result.Payload, 'base64') };
    },
  );
  mock.method(require('@aws-sdk/client-s3').S3Client.prototype, 'send', async (command) => {
    const input = command.input;
    if (command.constructor.name === 'PutObjectCommand')
      return send('put', { ...input, Body: Buffer.from(input.Body).toString('base64') });
    assert.equal(command.constructor.name, 'GetObjectCommand');
    const result = await send('get', input);
    return { ...result, Body: Readable.from([Buffer.from(result.Body, 'base64')]) };
  });
}
