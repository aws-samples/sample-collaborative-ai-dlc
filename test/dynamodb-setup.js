import { GenericContainer, Wait } from 'testcontainers';

// One DynamoDB Local container for the whole vitest run, shared across projects
// (parallels test/gremlin-setup.js). Tests create their own tables against it and
// tear them down per-suite, so the single endpoint is enough. globalSetup runs in
// a separate process before workers start, so we hand the endpoint over via
// process.env (vi.stubEnv isn't available here).

let container;

export async function setup() {
  container = await new GenericContainer('amazon/dynamodb-local:2.5.2')
    .withExposedPorts(8000)
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  process.env.DYNAMODB_LOCAL_ENDPOINT = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
  // DynamoDB Local ignores credentials but the SDK still requires some present.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'us-east-1';
}

export async function teardown() {
  await container?.stop();
}
