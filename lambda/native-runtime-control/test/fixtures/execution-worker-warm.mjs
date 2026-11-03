import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [workerPath, mode = 'execution'] = process.argv.slice(2);
if (!workerPath || !['execution', 'cancellation'].includes(mode)) throw new Error('Invalid probe');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AWS_') || key.startsWith('NATIVE_')) delete process.env[key];
}
const sockets = new Set();
const requests = [];
let maximumConnections = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, value: null }));
});
server.keepAliveTimeout = 600_000;
server.on('connection', (socket) => {
  sockets.add(socket);
  maximumConnections = Math.max(maximumConnections, sockets.size);
  socket.on('close', () => sockets.delete(socket));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  AWS_PARTITION: 'aws',
  AWS_ACCESS_KEY_ID: 'probe-only',
  AWS_SECRET_ACCESS_KEY: 'probe-only',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ENDPOINT_URL: endpoint,
  AWS_MAX_ATTEMPTS: '1',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  NATIVE_PREPARATION_PROJECT_IDS: '["warm-client-probe"]',
  NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
  NATIVE_RUNTIME_FILE_SYSTEM_ID: 'fs-1234567890abcdef0',
  NATIVE_RUNTIME_IMAGE_URI: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'a'.repeat(64)}`,
  NATIVE_RUNTIME_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  NATIVE_RUNTIME_SUBNET_IDS: '["subnet-123abc"]',
  NATIVE_RUNTIME_SECURITY_GROUP_IDS: '["sg-123abc"]',
  NATIVE_RUNTIME_ROLE_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/native-probe-boundary',
  NATIVE_RUNTIME_ECR_REPOSITORY_ARN: 'arn:aws:ecr:us-east-1:123456789012:repository/agentcore',
  NATIVE_AUTHORITY_FUNCTION: 'native-probe-authority',
  NATIVE_EXECUTION_PUBLICATION_BUCKET: 'native-probe-publications',
  NATIVE_RUNTIME_BINDINGS_TABLE: 'native-probe-bindings',
  NATIVE_CANCELLATION_ONLY: String(mode === 'cancellation'),
});
const output = console.log.bind(console);
console.info = () => {};
const warnings = [];
console.warn = (value) => warnings.push(value);
try {
  const { handler } = await import(pathToFileURL(resolve(workerPath)));
  const expected = [];
  let failedInvocations = 0;
  for (let index = 1; index <= 64; index++) {
    const identity = {
      projectId: 'warm-client-probe',
      executionId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    };
    expected.push(identity);
    const result = await handler(
      { Records: [{ messageId: `message-${index}`, body: JSON.stringify(identity) }] },
      { getRemainingTimeInMillis: () => 120_000 },
    );
    failedInvocations += result.batchItemFailures.length;
  }
  const identitiesMatch =
    requests.length === expected.length &&
    requests.every(
      (request, index) =>
        request.aggregate === 'execution' &&
        request.operation === (mode === 'cancellation' ? 'observeRevocation' : 'get') &&
        JSON.stringify(request.args) === JSON.stringify([expected[index]]),
    );
  output(
    JSON.stringify({
      mode,
      invocations: expected.length,
      requests: requests.length,
      failedInvocations,
      identitiesMatch,
      maximumConnections,
      finalConnections: sockets.size,
      warnings: warnings.length,
      boundedConnections: maximumConnections <= 2,
      sdkTransport: 'real',
      endpoint: 'loopback-only',
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
