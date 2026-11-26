import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gremlin from 'gremlin';
import { fetchWorkflowSourceMembership } from '../workflow-source-membership.js';

const edge = (overrides = {}) => ({
  membershipId: 'neptune-edge-1',
  roles: ['owner'],
  ...overrides,
});
const project = (overrides = {}) => ({
  projectIdentity: 'neptune-project-1',
  memberships: [edge()],
  ...overrides,
});

describe('existing Neptune workflow source membership snapshots', () => {
  let g;
  let toList;
  beforeEach(() => {
    // Real traversal construction; no remote connection or graph writes.
    g = new gremlin.structure.Graph().traversal();
    toList = vi.spyOn(gremlin.process.GraphTraversal.prototype, 'toList');
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['owner', 'admin', 'member'])(
    'reads %s from the edge, preserving actual IDs instead of logical user/project IDs',
    async (role) => {
      toList.mockResolvedValue([
        new Map([
          ['projectIdentity', 'neptune-project-1'],
          [
            'memberships',
            [
              new Map([
                ['membershipId', 'neptune-edge-1'],
                ['roles', [role]],
              ]),
            ],
          ],
        ]),
      ]);
      const result = await fetchWorkflowSourceMembership(g, 'logical-project', 'logical-user');
      expect(result).toEqual({
        role,
        membershipId: 'neptune-edge-1',
        projectIdentity: 'neptune-project-1',
      });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it('bounds both duplicate detection reads and projects edge role and actual vertex/edge IDs', async () => {
    let bytecode;
    toList.mockImplementation(function () {
      bytecode = this.getBytecode();
      return Promise.resolve([project()]);
    });
    await fetchWorkflowSourceMembership(g, 'logical-project', 'logical-user');
    expect(toList).toHaveBeenCalledTimes(1);
    const instructions = JSON.parse(JSON.stringify(bytecode));
    const idToken = { typeName: 'T', elementName: 'id' };
    expect(instructions).toEqual({
      sourceInstructions: [],
      stepInstructions: [
        ['V'],
        ['has', 'Project', 'id', 'logical-project'],
        ['limit', 2],
        ['project', 'projectIdentity', 'memberships'],
        ['by', idToken],
        [
          'by',
          [
            ['outE', 'HAS_MEMBER'],
            ['where', [['inV'], ['has', 'User', 'id', 'logical-user']]],
            ['limit', 2],
            ['project', 'membershipId', 'roles'],
            ['by', idToken],
            ['by', [['values', 'role'], ['fold']]],
            ['fold'],
          ],
        ],
      ],
    });
  });

  it.each([{ rows: [] }, { rows: [project({ memberships: [] })] }])(
    'returns null for an absent project or membership',
    async ({ rows }) => {
      toList.mockResolvedValue(rows);
      expect(await fetchWorkflowSourceMembership(g, 'p1', 'u1')).toBeNull();
    },
  );

  it.each([
    ['duplicate logical projects', [project(), project({ projectIdentity: 'another-project' })]],
    ['duplicate edges', [project({ memberships: [edge(), edge()] })]],
    [
      'different edges for the same logical user',
      [project({ memberships: [edge(), edge({ membershipId: 'another-edge' })] })],
    ],
    ['missing role', [project({ memberships: [edge({ roles: [] })] })]],
    ['multiple roles', [project({ memberships: [edge({ roles: ['owner', 'member'] })] })]],
    ['repeated role', [project({ memberships: [edge({ roles: ['owner', 'owner'] })] })]],
    ['unknown role', [project({ memberships: [edge({ roles: ['super-admin'] })] })]],
    ['role casing', [project({ memberships: [edge({ roles: ['OWNER'] })] })]],
    ['malformed role projection', [project({ memberships: [edge({ roles: 'owner' })] })]],
    ['absent edge ID', [project({ memberships: [edge({ membershipId: undefined })] })]],
    ['coercible edge ID', [project({ memberships: [edge({ membershipId: 42 })] })]],
    ['unsafe edge ID', [project({ memberships: [edge({ membershipId: 'secret\nid' })] })]],
    ['empty edge ID', [project({ memberships: [edge({ membershipId: '' })] })]],
    ['overlong edge ID', [project({ memberships: [edge({ membershipId: 'e'.repeat(513) })] })]],
    ['missing project ID', [project({ projectIdentity: undefined })]],
    ['coercible project ID', [project({ projectIdentity: 42 })]],
    ['whitespace project ID', [project({ projectIdentity: ' project ' })]],
    ['unsafe project ID', [project({ projectIdentity: 'secret\x7fid' })]],
    ['overlong project ID', [project({ projectIdentity: 'p'.repeat(513) })]],
    ['malformed project', [null]],
    ['missing membership projection', [project({ memberships: undefined })]],
    ['invalid traversal result', { privateGraphResult: 'secret' }],
  ])('rejects %s without choosing a first result or leaking graph data', async (_name, rows) => {
    toList.mockResolvedValue(rows);
    await expect(fetchWorkflowSourceMembership(g, 'p1', 'u1')).rejects.toMatchObject({
      name: 'WorkflowSourceError',
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
      message: 'Project membership could not be verified',
    });
  });

  it.each([
    ['', 'u1'],
    ['p1', null],
    ['p1', ' user '],
    ['p1\n', 'u1'],
    ['p'.repeat(257), 'u1'],
  ])('rejects invalid lookup identities before querying', async (projectId, userId) => {
    await expect(fetchWorkflowSourceMembership(g, projectId, userId)).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(toList).not.toHaveBeenCalled();
  });

  it('sanitizes a failed graph read without granting membership or using a fallback', async () => {
    toList.mockRejectedValue(new Error('private graph host and credentials'));
    await expect(fetchWorkflowSourceMembership(g, 'p1', 'u1')).rejects.toMatchObject({
      name: 'WorkflowSourceError',
      code: 'WORKFLOW_SOURCE_UNAVAILABLE',
      message: 'Project membership lookup is unavailable',
    });
  });
});
