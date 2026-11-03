// listMemberships against gremlin-server: the role rules must match
// fetchMembershipRole, which gates every project-scoped route.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fetchMembershipRole, listMemberships } from '../../shared/trackers.js';
const __ = gremlin.process.statics;
const PARTITION = `t-${randomUUID()}`;
let conn;
let g;
const addProject = (id, props = {}) => {
  let t = g.addV('Project').property('id', id);
  for (const [k, v] of Object.entries(props)) t = t.property(k, v);
  return t.next();
};
const addMember = (projectId, userId, role) => {
  let t = g.V().has('Project', 'id', projectId).addE('HAS_MEMBER');
  if (role !== undefined) t = t.property('role', role);
  return t.to(__.V().has('User', 'id', userId)).next();
};
beforeAll(async () => {
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
  await g.addV('User').property('id', 'alice').next();
  await g.addV('User').property('id', 'bob').next();
  await g.addV('User').property('id', 'carol').next();
  await addProject('p-owner', { name: 'Owner space', kind: 'v2' });
  await addProject('p-admin', { name: 'Admin space', kind: 'v2' });
  await addProject('p-member', { name: 'Member space', kind: 'v2' });
  await addProject('p-empty', { name: 'Empty role', kind: 'v2' });
  await addProject('p-norole', { name: 'No role', kind: 'v2' });
  await addProject('p-legacy', { name: 'Legacy' });
  await addProject('p-bob', { name: 'Bob only', kind: 'v2' });
  await addMember('p-owner', 'alice', 'owner');
  await addMember('p-admin', 'alice', 'admin');
  await addMember('p-member', 'alice', 'member');
  await addMember('p-empty', 'alice', '');
  await addMember('p-norole', 'alice', undefined);
  await addMember('p-legacy', 'alice', 'member');
  await addMember('p-bob', 'bob', 'owner');
});
afterAll(async () => {
  await conn?.close();
});
describe('listMemberships', () => {
  it('returns every role-bearing membership sorted by projectId', async () => {
    expect(await listMemberships(g, 'alice')).toEqual([
      { projectId: 'p-admin', projectName: 'Admin space', kind: 'v2', role: 'admin' },
      { projectId: 'p-empty', projectName: 'Empty role', kind: 'v2', role: 'member' },
      { projectId: 'p-legacy', projectName: 'Legacy', kind: 'v1', role: 'member' },
      { projectId: 'p-member', projectName: 'Member space', kind: 'v2', role: 'member' },
      { projectId: 'p-owner', projectName: 'Owner space', kind: 'v2', role: 'owner' },
    ]);
  });
  it('agrees with fetchMembershipRole on empty and missing roles', async () => {
    expect(await fetchMembershipRole(g, 'p-empty', 'alice')).toBe('member');
    expect(await fetchMembershipRole(g, 'p-norole', 'alice')).toBeNull();
  });
  it("does not return another user's spaces", async () => {
    expect(await listMemberships(g, 'bob')).toEqual([
      { projectId: 'p-bob', projectName: 'Bob only', kind: 'v2', role: 'owner' },
    ]);
  });
  it('returns [] for a user with no memberships or no vertex', async () => {
    expect(await listMemberships(g, 'carol')).toEqual([]);
    expect(await listMemberships(g, 'nobody')).toEqual([]);
  });
});
