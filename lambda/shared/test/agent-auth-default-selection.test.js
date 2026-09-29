import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  AUTH_POLICY_KEY,
  createAgentConnectionRepository,
} from '../agent-connection-repository.js';
import { createAgentAuthChangeService } from '../agent-auth-changes.js';
import { resolvePolicyBindings, connectionBinding } from '../agent-binding-selection.js';
import {
  AUTH_SELECTION_STRATEGIES,
  selectConnectionBinding,
  selectionStrategyFor,
  spaceConnectionIdFor,
} from '../agent-auth-selection-strategies.js';
import { normalizeConnection } from '../agent-auth-contracts.js';
import { TEST_CONNECTION_MODE } from './helpers/auth-modes.js';
import { cleanup, createAuthTable, ddb, requireDynamoDbLocal } from './helpers/auth-table.js';

// The default strategy is reached only through registration, so the suite registers an
// available synthetic mode (and a planned twin) instead of relying on any real provider.
vi.mock('../agent-auth-modes.js', async (importOriginal) => {
  const { TEST_CONNECTION_MODE: mode, withAuthModes } = await import('./helpers/auth-modes.js');
  return withAuthModes(importOriginal, [mode, { ...mode, id: 'planned-test-mode', planned: true }]);
});

beforeAll(requireDynamoDbLocal);
afterAll(cleanup);

const MODE = TEST_CONNECTION_MODE.id;
const connection = (id, projectId) =>
  normalizeConnection({
    id,
    revision: 1,
    mode: MODE,
    backend: 'bedrock',
    mechanism: 'oauth-machine',
    source: projectId ? 'space' : 'platform',
    projectId,
    configuration: { region: 'eu-west-1' },
  });
// Personal key overrides that the keys strategy would honour; the default strategy must not.
const legacy = {
  bedrock: { provider: 'bedrock', source: 'user', userId: 'u1' },
  kiro: { provider: 'kiro', source: 'user', userId: 'u1' },
};

const setup = async () => {
  const tableName = await createAuthTable();
  const repository = createAgentConnectionRepository({ ddb, tableName });
  await repository.initializeInventory();
  const service = createAgentAuthChangeService({ repository });
  const review = (candidate) => service.preview(candidate, 'admin');
  const apply = async (candidate) => service.apply((await review(candidate)).id, 'admin');
  const resolve = (overrides = {}) =>
    resolvePolicyBindings({
      repository,
      projectId: 'p1',
      userId: 'u1',
      resolveLegacy: async () => ({ ...legacy }),
      ...overrides,
    });
  const put = (Item) => ddb.send(new PutCommand({ TableName: tableName, Item }));
  const rows = async (prefix) =>
    ((await ddb.send(new ScanCommand({ TableName: tableName }))).Items ?? []).filter((row) =>
      row.pk.startsWith(prefix),
    );
  const selections = async () =>
    (await repository.scanInventory()).filter((row) => row.type === 'AgentSelection');
  return { repository, service, review, apply, resolve, put, rows, selections };
};
const create = (target) => ({ kind: 'connection-create', select: true, connection: target });
// The shape authActionWrites stores; mode is present only when a selection was written for one.
const spaceSelectionRow = (projectId, connectionId, mode) => ({
  pk: `AGENTAUTH#SPACE#${projectId}`,
  sk: 'META',
  type: 'AgentSpaceSelection',
  projectId,
  connectionId,
  ...(mode ? { mode } : {}),
});

describe('default policy-connection selection with DynamoDB', () => {
  it('activates a reviewed platform connection and selects it while Kiro keeps its key', async () => {
    const { repository, review, service, resolve, selections } = await setup();
    const platform = connection('test-platform');
    const pending = await review(create(platform));
    expect(await repository.getConnection(platform.id)).toBeNull();
    expect((await repository.getPolicy()).mode).toBe('keys');
    expect(await service.apply(pending.id, 'admin')).toEqual({ saved: true, revision: 1 });
    expect(await repository.getConnection(platform.id, 1)).toMatchObject(platform);
    expect(await repository.getPolicy()).toMatchObject({
      mode: MODE,
      defaultConnectionId: platform.id,
      revision: 1,
    });
    expect(await resolve()).toEqual({
      bedrock: connectionBinding(platform, 1),
      kiro: legacy.kiro,
    });
    expect(await resolve({ projectId: undefined })).toEqual({
      bedrock: connectionBinding(platform, 1),
      kiro: legacy.kiro,
    });
    expect(await resolve({ providers: ['kiro'] })).toEqual({ kiro: legacy.kiro });
    const reserved = await resolve({ reserve: true, providers: ['bedrock'] });
    expect(reserved).toEqual({ bedrock: connectionBinding(platform, 1) });
    expect((await selections()).map((row) => row.credentialBinding)).toEqual([reserved.bedrock]);
  });

  it('selects a space override, restores inheritance, and re-applies idempotently', async () => {
    const { repository, review, service, apply, resolve } = await setup();
    const platform = connection('test-platform');
    const space = connection('test-space', 'p1');
    await apply(create(platform));
    expect(await apply(create(space))).toEqual({ saved: true, revision: 1 });
    expect((await repository.getSpaceSelection('p1')).mode).toBe(MODE);
    expect((await resolve()).bedrock).toEqual(connectionBinding(space, 1));
    // The override belongs to its space only.
    expect((await resolve({ projectId: 'p2' })).bedrock).toEqual(connectionBinding(platform, 1));
    const inherit = await review({ kind: 'space-selection', projectId: 'p1', connectionId: null });
    expect(await service.apply(inherit.id, 'admin')).toEqual({ saved: true, revision: 2 });
    expect(await repository.getSpaceSelection('p1')).toBeNull();
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 1));
    expect(await repository.getConnection(space.id, 1)).toMatchObject(space);
    expect(await service.apply(inherit.id, 'admin')).toEqual({ saved: true, revision: 2 });
    expect((await repository.getPolicy()).revision).toBe(1);
    expect((await repository.getScopeState({ source: 'space', projectId: 'p1' })).revision).toBe(2);
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 1));
  });

  it('rejects stale activations and overrides without writing connection or selection rows', async () => {
    const { repository, review, service, apply, resolve, rows } = await setup();
    const stale = await review(create(connection('test-stale')));
    await repository.claimSelection(0);
    await expect(service.apply(stale.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect(await rows('AGENTAUTH#CONNECTION#')).toEqual([]);
    expect((await repository.getPolicy()).mode).toBe('keys');

    const platform = connection('test-platform');
    await apply(create(platform));
    const override = await review(create(connection('test-space', 'p1')));
    // The platform default changes after the space override was reviewed against it.
    const replacement = connection('test-replacement');
    await apply(create(replacement));
    await expect(service.apply(override.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect(await repository.getConnection('test-space')).toBeNull();
    expect(await rows('AGENTAUTH#SPACE#')).toEqual([]);
    expect((await resolve()).bedrock).toEqual(connectionBinding(replacement, 2));
  });

  it('ignores a mode-less or other-mode space selection and uses the platform default', async () => {
    const { apply, resolve, put, repository } = await setup();
    const platform = connection('test-platform');
    const space = connection('test-space', 'p1');
    await apply(create(platform));
    await repository.putConnection(space);
    await put(spaceSelectionRow('p1', space.id, MODE));
    expect((await resolve()).bedrock).toEqual(connectionBinding(space, 1));
    // Same target, but the row does not claim the policy mode.
    await put(spaceSelectionRow('p1', space.id));
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 1));
    // A keys-era override left behind by the mode switch.
    await put(spaceSelectionRow('p1', 'legacy-space-bedrock-p1', 'keys'));
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 1));
  });

  it('refuses a foreign-space or not-ready connection without reserving, while Kiro resolves', async () => {
    const { apply, resolve, put, repository, selections } = await setup();
    const platform = connection('test-platform');
    const foreign = connection('test-foreign', 'p2');
    await apply(create(platform));
    await repository.putConnection(foreign);
    await put(spaceSelectionRow('p1', foreign.id, MODE));
    await expect(resolve({ reserve: true })).rejects.toMatchObject({
      code: 'AGENT_AUTH_MODE_MISMATCH',
    });
    // The same connection is valid in the space that owns it.
    await put(spaceSelectionRow('p2', foreign.id, MODE));
    expect((await resolve({ projectId: 'p2' })).bedrock).toEqual(connectionBinding(foreign, 1));

    await repository.putConnection({ ...platform, revision: 2, state: 'reconnect-required' });
    await expect(resolve({ projectId: 'p3', reserve: true })).rejects.toMatchObject({
      code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE',
    });
    expect(await selections()).toEqual([]);
    expect(await resolve({ projectId: 'p3', reserve: true, providers: ['kiro'] })).toEqual({
      kiro: legacy.kiro,
    });
  });

  it('refuses a persisted planned mode but still resolves Kiro', async () => {
    const { put, resolve } = await setup();
    await put({
      ...AUTH_POLICY_KEY,
      type: 'AgentAuthPolicy',
      mode: 'planned-test-mode',
      revision: 1,
      activityRevision: 0,
      defaultConnectionId: 'planned-platform',
    });
    await expect(resolve()).rejects.toMatchObject({ code: 'AGENT_AUTH_MODE_UNAVAILABLE' });
    expect(await resolve({ providers: ['kiro'] })).toEqual({ kiro: legacy.kiro });
  });
});

describe('selectConnectionBinding', () => {
  const policy = { mode: MODE, revision: 4, defaultConnectionId: 'test-platform' };
  const ready = {
    ...connection('test-platform'),
    secretReference: '/unused',
  };
  const stored = {
    'test-platform': ready,
    'test-space': connection('test-space', 'p1'),
    'test-foreign': connection('test-foreign', 'p2'),
    'test-personal': { ...ready, id: 'test-personal', source: 'user', userId: 'u1' },
    'test-broken': { ...ready, id: 'test-broken', state: 'revoked' },
    'legacy-space-bedrock-p1': { ...ready, id: 'legacy-space-bedrock-p1', mode: 'keys' },
  };
  const select = async (connectionId) => {
    const repository = { getConnection: vi.fn(async (id) => stored[id] ?? null) };
    const selected = selectConnectionBinding({
      policy,
      spaceSelection: connectionId ? spaceSelectionRow('p1', connectionId, MODE) : null,
      projectId: 'p1',
      repository,
    });
    await selected.catch(() => {});
    expect(repository.getConnection.mock.calls).toEqual([[connectionId ?? 'test-platform']]);
    return selected;
  };

  it('binds the selected connection at the policy revision without its storage reference', async () => {
    expect(await select()).toEqual(connectionBinding(connection('test-platform'), 4));
    expect(await select('test-space')).toEqual(
      connectionBinding(connection('test-space', 'p1'), 4),
    );
  });

  it.each([
    ['a missing connection', 'test-missing', 'AGENT_AUTH_MODE_MISMATCH'],
    ['a connection of another mode', 'legacy-space-bedrock-p1', 'AGENT_AUTH_MODE_MISMATCH'],
    ['a personal connection', 'test-personal', 'AGENT_AUTH_MODE_MISMATCH'],
    ['another space connection', 'test-foreign', 'AGENT_AUTH_MODE_MISMATCH'],
    ['a connection that is not ready', 'test-broken', 'AGENT_AUTH_CONNECTION_UNAVAILABLE'],
  ])('refuses %s', async (_label, connectionId, code) => {
    await expect(select(connectionId)).rejects.toMatchObject({ code });
  });

  it('reads the space connection only for a selection of the policy mode', () => {
    const selection = (mode, connectionId = 'test-space') =>
      spaceConnectionIdFor({ policy, spaceSelection: spaceSelectionRow('p1', connectionId, mode) });
    expect(selection(MODE)).toBe('test-space');
    expect(selection(undefined)).toBeNull();
    expect(selection('keys')).toBeNull();
    expect(spaceConnectionIdFor({ policy, spaceSelection: null })).toBeNull();
  });
});

describe('selectionStrategyFor', () => {
  it('keeps explicit strategies and defaults only registered, available modes', () => {
    expect(selectionStrategyFor('keys')).toBe(AUTH_SELECTION_STRATEGIES.keys);
    expect(selectionStrategyFor(MODE)).toBe(selectConnectionBinding);
    for (const mode of ['planned-test-mode', 'unregistered-test-mode', 'kiro', 'toString'])
      expect(selectionStrategyFor(mode)).toBeNull();
    const custom = vi.fn();
    expect(selectionStrategyFor(MODE, { [MODE]: custom })).toBe(custom);
  });
});
