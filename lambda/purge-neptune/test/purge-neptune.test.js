import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler } = await import('../index.js'));

  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.close();
});

const seed = async (n) => {
  for (let i = 0; i < n; i++) {
    await g.addV('Seed').property('id', `s-${randomUUID()}`).next();
  }
};

beforeEach(async () => {
  await g.V().drop().next();
});

describe('purge-neptune handler', () => {
  it('returns 200 with dropped: 0 on an empty graph', async () => {
    const res = await handler();
    expect(res).toEqual({ statusCode: 200, dropped: 0 });
  });

  it('drops every vertex in the partition and reports the count', async () => {
    await seed(5);
    expect((await g.V().count().next()).value).toBe(5);

    const res = await handler();
    expect(res).toEqual({ statusCode: 200, dropped: 5 });
    expect((await g.V().count().next()).value).toBe(0);
  });

  it('does not touch vertices outside its partition', async () => {
    const otherPartition = `t-${randomUUID()}`;
    const otherG = gremlin.process.AnonymousTraversalSource.traversal()
      .withRemote(conn)
      .withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: otherPartition,
          readPartitions: [otherPartition],
        }),
      );
    await otherG.addV('Seed').property('id', `s-${randomUUID()}`).next();
    await seed(2);

    const res = await handler();
    expect(res).toEqual({ statusCode: 200, dropped: 2 });
    expect((await otherG.V().count().next()).value).toBe(1);

    await otherG.V().drop().next();
  });
});
