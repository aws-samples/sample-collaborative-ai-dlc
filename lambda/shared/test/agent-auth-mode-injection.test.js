import { describe, expect, it, vi } from 'vitest';
import { normalizeAuthAction } from '../agent-auth-actions.js';
import { normalizeConnection } from '../agent-auth-contracts.js';
import { AGENT_AUTH_MODES_CATALOG, authModeDescriptor } from '../agent-auth-providers.js';
import { normalizeAuthPolicy } from '../agent-connection-repository.js';
import { createAuthModeRegistry } from '../agent-auth-mode-registry.js';
import { TEST_CONNECTION_MODE } from './helpers/auth-modes.js';

vi.mock('../agent-auth-modes.js', async (importOriginal) => {
  const { TEST_CONNECTION_MODE: mode, withAuthModes } = await import('./helpers/auth-modes.js');
  return withAuthModes(importOriginal, [mode, { ...mode, id: 'planned-test-mode', planned: true }]);
});

const connection = (overrides = {}) => ({
  id: 'test-platform',
  revision: 1,
  mode: TEST_CONNECTION_MODE.id,
  backend: 'bedrock',
  mechanism: 'oauth-machine',
  source: 'platform',
  configuration: { region: ' eu-west-1 ' },
  ...overrides,
});

// Later suites register synthetic modes this way, so the mock must reach the hosts that
// build their views from the root at module load.
describe('synthetic modes injected through the shared root', () => {
  it('appends them after every real registration', async () => {
    const { AGENT_AUTH_MODE_DESCRIPTORS } = await vi.importActual('../agent-auth-modes.js');
    expect(AGENT_AUTH_MODES_CATALOG).toEqual([
      ...createAuthModeRegistry(AGENT_AUTH_MODE_DESCRIPTORS).catalog,
      {
        id: 'test-connection-mode',
        label: 'Test connection',
        backend: 'bedrock',
        mechanisms: ['oauth-machine'],
        available: true,
      },
      {
        id: 'planned-test-mode',
        label: 'Test connection',
        backend: 'bedrock',
        mechanisms: ['oauth-machine'],
        available: false,
      },
    ]);
    expect(authModeDescriptor('test-connection-mode')).toEqual(TEST_CONNECTION_MODE);
  });

  it('normalizes connections of the synthetic mode through its descriptor', () => {
    expect(normalizeConnection(connection())).toEqual({
      id: 'test-platform',
      revision: 1,
      mode: 'test-connection-mode',
      backend: 'bedrock',
      mechanism: 'oauth-machine',
      source: 'platform',
      state: 'ready',
      configuration: { region: 'eu-west-1' },
    });
    expect(() => normalizeConnection(connection({ configuration: { endpoint: 'x' } }))).toThrow(
      'Connection configuration contains unsupported fields',
    );
    expect(() => normalizeConnection(connection({ mechanism: 'api-key' }))).toThrow(
      'do not match its mode',
    );
    expect(() => normalizeConnection(connection({ backend: 'litellm' }))).toThrow(
      'do not match its mode',
    );
  });

  it('gates policy and connection changes on the registered availability', async () => {
    const repository = { getConnection: vi.fn(async () => null) };
    const policyChange = (mode) =>
      normalizeAuthAction({ kind: 'policy-change', mode, defaultConnectionId: 'c1' }, repository);
    await expect(policyChange('planned-test-mode')).rejects.toMatchObject({
      code: 'AGENT_AUTH_MODE_UNAVAILABLE',
    });
    expect(repository.getConnection).not.toHaveBeenCalled();
    // Available, so the change proceeds to the connection lookup.
    await expect(policyChange('test-connection-mode')).rejects.toMatchObject({
      code: 'AGENT_AUTH_INVALID',
    });
    expect(repository.getConnection).toHaveBeenCalledWith('c1');
    await expect(
      normalizeAuthAction(
        { kind: 'connection-create', connection: connection({ mode: 'planned-test-mode' }) },
        repository,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_MODE_UNAVAILABLE' });
    for (const mode of ['test-connection-mode', 'planned-test-mode']) {
      expect(normalizeAuthPolicy({ mode, revision: 1, defaultConnectionId: 'c1' }).mode).toBe(mode);
    }
  });
});
