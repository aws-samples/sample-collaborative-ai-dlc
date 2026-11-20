import { describe, expect, it, vi } from 'vitest';
import { createMembershipStore } from '../../shared/space-membership.js';
import { createPermissionLookup, createMembershipLookup } from '../permissions.js';

describe('current permission lookup', () => {
  it('passes verified identity and scope and consumes the backend decisions', async () => {
    const permissions = { read: true, write: false, manage: false, spaceId: 'p' };
    const client = {
      send: vi.fn().mockResolvedValue({ Payload: Buffer.from(JSON.stringify(permissions)) }),
    };
    const lookup = createPermissionLookup({ client, functionName: 'projects' });
    expect(await lookup({ sub: 'u', scope: 'intent:i', projectId: 'p' })).toEqual(permissions);
    const [command, options] = client.send.mock.calls[0];
    expect(command.input.FunctionName).toBe('projects');
    expect(JSON.parse(Buffer.from(command.input.Payload))).toEqual({
      action: 'realtime-permissions',
      sub: 'u',
      scope: 'intent:i',
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { FunctionError: 'Unhandled', Payload: Buffer.from('{}') },
    { Payload: Buffer.from('{"read":true}') },
    { Payload: Buffer.from('not-json') },
  ])('never interprets an invalid response as a write grant', async (response) => {
    const lookup = createPermissionLookup({
      client: { send: async () => response },
      functionName: 'projects',
    });
    await expect(lookup({ sub: 'u', scope: 'project:p' })).rejects.toThrow();
  });

  it('propagates unavailable membership checks and requires deployment wiring', async () => {
    expect(() => createPermissionLookup({ functionName: '' })).toThrow('required');
    const lookup = createPermissionLookup({
      client: {
        send: async () => {
          throw new Error('Unavailable');
        },
      },
      functionName: 'projects',
    });
    await expect(lookup({ sub: 'u', scope: 'project:p' })).rejects.toThrow('Unavailable');
  });
});

describe('in-task membership authorization', () => {
  it('uses exact consistent reads for every frame and evaluates current roles in Cedar', async () => {
    const ddb = { send: vi.fn() };
    const lookup = createMembershipLookup({
      accessTable: 'access',
      store: createMembershipStore({ ddb, accessTable: 'access' }),
    });
    const target = { sub: 'u', spaceId: 'p' };
    ddb.send
      .mockResolvedValueOnce({ Item: { membershipRole: 'member' } })
      .mockResolvedValueOnce({ Item: { membershipRole: 'viewer', localRoles: ['developer'] } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Unavailable'));
    expect(await lookup(target)).toEqual({ read: true, write: true, manage: false });
    expect(await lookup(target)).toEqual({ read: true, write: false, manage: false });
    expect(await lookup(target)).toEqual({ read: false, write: false, manage: false });
    await expect(lookup(target)).rejects.toThrow('Unavailable');
    expect(ddb.send).toHaveBeenCalledTimes(4);
    for (const [command] of ddb.send.mock.calls)
      expect(command.input).toEqual({
        TableName: 'access',
        Key: { pk: 'SPACE#p', sk: 'MEMBER#u' },
        ConsistentRead: true,
      });
    expect(await lookup({ sub: 'u' })).toEqual({ read: false, write: false, manage: false });
    expect(ddb.send).toHaveBeenCalledTimes(4);
    expect(() => createMembershipLookup({ accessTable: '' })).toThrow('ACCESS_TABLE');
  });
});
