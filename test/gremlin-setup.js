import { GenericContainer, Wait } from 'testcontainers';

let container;

export async function setup() {
  container = await new GenericContainer('tinkerpop/gremlin-server:3.7.3')
    .withExposedPorts(8182)
    .withWaitStrategy(Wait.forLogMessage(/Channel started at port 8182/))
    .start();

  // globalSetup runs in a separate process before vitest workers start, so
  // vi.stubEnv is not available here. Direct process.env assignment is the
  // supported channel for handing the container's address to test workers.
  process.env.NEPTUNE_ENDPOINT = container.getHost();
  process.env.GREMLIN_PORT = String(container.getMappedPort(8182));
  process.env.GREMLIN_PROTOCOL = 'ws';

  // SigV4 still runs against the test container — it ignores the signed headers,
  // but fromNodeProviderChain raises if it can't find creds at all. Plant inert
  // ones for CI runners that have no AWS creds.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'us-east-1';
}

export async function teardown() {
  await container?.stop();
}
