import { describe, expect, it } from 'vitest';
import { NativeReleaseSelectionError, selectNativeRelease } from '../native-release-selection.js';
import { workflowSourceIdentity } from '../workflow-source-bindings.js';

const source = workflowSourceIdentity('github', 'my-org/workflow-fork');
const candidate = (tag, overrides = {}) => ({
  sourceId: source.sourceId,
  releaseId: tag,
  tag,
  published: true,
  draft: false,
  prerelease: false,
  ...overrides,
});
const input = (candidates, overrides = {}) => ({
  source,
  discovery: { sourceId: source.sourceId, complete: true, candidates },
  ...overrides,
});
const expectError = (value, code = 'native_release_selection_invalid') => {
  expect(() => selectNativeRelease(value)).toThrow(NativeReleaseSelectionError);
  expect(() => selectNativeRelease(value)).toThrow(expect.objectContaining({ code }));
};

describe('selectNativeRelease', () => {
  it('selects the highest stable semantic version, independently of dates or input order', () => {
    const candidates = [
      candidate('v2.9.99', { publishedAt: '2099-01-01', providerLatest: true }),
      candidate('v1.100.0'),
      candidate('v2.10.0', { publishedAt: '2000-01-01' }),
      candidate('v2.0.100'),
    ];
    for (const ordered of [candidates, candidates.toReversed()]) {
      expect(selectNativeRelease(input(ordered))).toEqual({
        source,
        requestedRelease: 'latest',
        releaseId: 'v2.10.0',
        tag: 'v2.10.0',
        version: '2.10.0',
        channel: 'stable',
        prerelease: false,
      });
    }
  });

  it.each([
    ['v2.0.0', 'v1.999.999'],
    ['v2.10.0', 'v2.9.999'],
    ['v2.10.10', 'v2.10.9'],
    ['v9007199254740993.0.0', 'v9007199254740992.99.99'],
    ['v2.9007199254740993.0', 'v2.9007199254740992.999'],
    ['v2.0.9007199254740993', 'v2.0.9007199254740992'],
  ])('orders %s above %s without floating-point rounding', (newer, older) => {
    expect(selectNativeRelease(input([candidate(older), candidate(newer)])).tag).toBe(newer);
    expect(selectNativeRelease(input([candidate(newer), candidate(older)])).tag).toBe(newer);
  });

  it.each(['github', 'gitlab', 'bitbucket'])('uses only the selected %s source', (provider) => {
    const selectedSource = workflowSourceIdentity(provider, 'team/fork');
    const result = selectNativeRelease({
      source: { provider, repository: 'TEAM/FORK' },
      discovery: {
        sourceId: selectedSource.sourceId,
        complete: true,
        candidates: [candidate('v1.0.0', { sourceId: selectedSource.sourceId })],
      },
    });
    expect(result.source).toEqual(selectedSource);
    expect(result.tag).toBe('v1.0.0');
  });

  it('supports GitLab subgroup identities from the shared source contract', () => {
    const selectedSource = workflowSourceIdentity('gitlab', 'team/subgroup/fork');
    expect(
      selectNativeRelease({
        source: selectedSource,
        discovery: {
          sourceId: selectedSource.sourceId,
          complete: true,
          candidates: [candidate('v2.0.0', { sourceId: selectedSource.sourceId })],
        },
      }).source,
    ).toEqual(selectedSource);
  });

  it('does not consult an official or another fork’s version when selecting latest', () => {
    const official = workflowSourceIdentity('github', 'awslabs/aidlc-workflows');
    const other = candidate('v999.0.0', { sourceId: official.sourceId });
    expectError(input([candidate('v1.0.0'), other]));
    expect(selectNativeRelease(input([candidate('v1.0.0')])).tag).toBe('v1.0.0');
  });

  it('excludes drafts and prereleases from latest, including preview tags without a flag', () => {
    const result = selectNativeRelease(
      input([
        candidate('v3.0.0', { draft: true }),
        candidate('v2.9.0', { prerelease: true }),
        candidate('v2.8.1-preview.20260918.1', { prerelease: true }),
        candidate('v9.0.0-preview.20260918.2'),
        candidate('v2.8.0'),
      ]),
    );
    expect(result.tag).toBe('v2.8.0');
  });

  it('does not treat an unpublished git tag as a release', () => {
    expect(
      selectNativeRelease(input([candidate('v99.0.0', { published: false }), candidate('v2.0.0')]))
        .tag,
    ).toBe('v2.0.0');
    expectError(input([candidate('v99.0.0', { published: false })]), 'native_release_not_found');
  });

  it('ignores non-native release tags when finding highest stable vX.Y.Z', () => {
    const result = selectNativeRelease(
      input([
        candidate('release-999.0.0'),
        candidate('v999.0.0-rc.1'),
        candidate('v03.0.0'),
        candidate('3.0.0'),
        candidate('v0.0.0'),
      ]),
    );
    expect(result.tag).toBe('v0.0.0');
  });

  it.each(
    [
      [],
      [candidate('v2.0.0', { draft: true })],
      [candidate('v2.0.0', { prerelease: true })],
      [candidate('v2.0.1-preview.20260918.1')],
      [candidate('release-2.0.0')],
    ].map((candidates) => [candidates]),
  )('reports no stable release without falling back to another source', (candidates) => {
    expectError(input(candidates), 'native_release_not_found');
  });

  it.each([[], [candidate('v2.0.0')]].map((candidates) => [candidates]))(
    'requires exhaustive discovery for latest',
    (candidates) => {
      expectError(
        input(candidates, {
          discovery: { sourceId: source.sourceId, complete: false, candidates },
        }),
        'native_release_discovery_incomplete',
      );
    },
  );

  it('selects an exact stable tag even when a newer stable release exists', () => {
    expect(
      selectNativeRelease(
        input([candidate('v1.0.0'), candidate('v2.0.0')], { requestedRelease: 'v1.0.0' }),
      ).tag,
    ).toBe('v1.0.0');
  });

  it('allows an explicit host-marked prerelease while latest still excludes it', () => {
    const candidates = [candidate('v2.0.0'), candidate('v9.0.0', { prerelease: true })];
    expect(selectNativeRelease(input(candidates))).toMatchObject({
      tag: 'v2.0.0',
      prerelease: false,
    });
    expect(selectNativeRelease(input(candidates, { requestedRelease: 'v9.0.0' }))).toMatchObject({
      tag: 'v9.0.0',
      channel: 'stable',
      prerelease: true,
    });
  });

  it.each([true, false])(
    'accepts an explicitly selected native preview (provider flag %s)',
    (prerelease) => {
      const tag = 'v2.5.1-preview.20260918.12';
      expect(
        selectNativeRelease(
          input([candidate(tag, { prerelease }), candidate('v3.0.0')], {
            requestedRelease: tag,
          }),
        ),
      ).toMatchObject({ tag, version: tag.slice(1), channel: 'preview', prerelease: true });
    },
  );

  it('permits an exact match from partial discovery but never interprets a miss as not found', () => {
    const candidates = [candidate('v2.5.1-preview.20260918.1', { prerelease: true })];
    const partial = input(candidates, {
      discovery: { sourceId: source.sourceId, complete: false, candidates },
      requestedRelease: candidates[0].tag,
    });
    expect(selectNativeRelease(partial).tag).toBe(candidates[0].tag);
    expectError({ ...partial, requestedRelease: 'v2.5.0' }, 'native_release_discovery_incomplete');
  });

  it('reports an exact miss from complete discovery without choosing another tag', () => {
    expectError(
      input([candidate('v1.0.0')], { requestedRelease: 'v2.0.0' }),
      'native_release_not_found',
    );
  });

  it.each([
    candidate('v2.0.0', { draft: true }),
    candidate('v2.0.0', { published: false }),
    candidate('v2.0.0', { draft: true, prerelease: true }),
    candidate('v2.0.0', { published: false, prerelease: true }),
    candidate('v2.0.1-preview.20260918.1', { draft: true, prerelease: true }),
  ])('rejects an unpublished exact selection instead of choosing a fallback', (selected) => {
    expectError(
      input([candidate('v1.0.0'), selected], { requestedRelease: selected.tag }),
      'native_release_not_selectable',
    );
  });

  it('selects highest stable before any compatibility or asset availability check', () => {
    const unavailable = candidate('v3.0.0');
    for (const field of ['available', 'compatible', 'assets', 'credentials', 'token']) {
      Object.defineProperty(unavailable, field, {
        get: () => {
          throw new Error('Selector must not inspect assets or credentials');
        },
      });
    }
    expect(
      selectNativeRelease(input([candidate('v2.0.0', { available: true }), unavailable])).tag,
    ).toBe('v3.0.0');
  });

  it('selects a still-listed Bitbucket release even when its Downloads bytes are unavailable', () => {
    const selectedSource = workflowSourceIdentity('bitbucket', 'team/workflows');
    const result = selectNativeRelease({
      source: selectedSource,
      discovery: {
        sourceId: selectedSource.sourceId,
        complete: true,
        candidates: [
          candidate('v2.0.0', { sourceId: selectedSource.sourceId, available: true }),
          candidate('v3.0.0', {
            sourceId: selectedSource.sourceId,
            available: false,
            compatible: false,
            assets: [],
          }),
        ],
      },
    });
    expect(result.tag).toBe('v3.0.0');
    expect(result).not.toHaveProperty('available');
    expect(result).not.toHaveProperty('assets');
  });

  it('selects only the current rolling Bitbucket publication, not higher historical tags/cache', () => {
    const selectedSource = workflowSourceIdentity('bitbucket', 'team/workflows');
    const current = candidate('v2.0.0', { sourceId: selectedSource.sourceId });
    const historical = candidate('v3.0.0', {
      sourceId: selectedSource.sourceId,
      published: false,
      cached: true,
    });
    const discovery = {
      sourceId: selectedSource.sourceId,
      complete: true,
      candidates: [current, historical],
      cachedPackages: [{ tag: 'v999.0.0', packageId: 'historical-package' }],
    };
    expect(selectNativeRelease({ source: selectedSource, discovery }).tag).toBe('v2.0.0');
    // Once the old publication disappears, its bare git tag/cache cannot keep
    // it in the eligible inventory. A sole visible package is sufficient.
    discovery.candidates = [current];
    expect(selectNativeRelease({ source: selectedSource, discovery }).tag).toBe('v2.0.0');
  });

  it('returns only frozen sanitized identity metadata', () => {
    const candidates = [
      candidate('v2.0.0', {
        releaseId: 'release-123',
        credentials: { token: 'private-secret' },
        assetUrl: 'https://user:secret@example.invalid/',
        source: { token: 'nested-secret' },
      }),
    ];
    const sourceInput = { ...source, authorization: 'private-secret' };
    const result = selectNativeRelease(input(candidates, { source: sourceInput }));
    expect(Object.keys(result).toSorted()).toEqual(
      [
        'source',
        'requestedRelease',
        'releaseId',
        'tag',
        'version',
        'channel',
        'prerelease',
      ].toSorted(),
    );
    expect(result.source).toEqual(source);
    expect(result.releaseId).toBe('release-123');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(() => {
      result.source.repository = 'other/repo';
    }).toThrow(TypeError);
    expect(() => {
      result.tag = 'v9.0.0';
    }).toThrow(TypeError);
    candidates[0].tag = 'v9.0.0';
    sourceInput.repository = 'other/repo';
    expect(result.tag).toBe('v2.0.0');
    expect(result.source.repository).toBe('my-org/workflow-fork');
  });

  it.each(
    [
      [candidate('v2.0.0'), candidate('v2.0.0')],
      [candidate('v2.0.0'), candidate('v2.0.0', { releaseId: 'different' })],
      [candidate('v2.0.0', { releaseId: 'same' }), candidate('v3.0.0', { releaseId: 'same' })],
      [candidate('other-tag'), candidate('other-tag', { releaseId: 'different' })],
    ].map((candidates) => [candidates]),
  )('rejects duplicate or ambiguous IDs/tags rather than deduplicating', (candidates) => {
    expectError(input(candidates));
  });

  it('rejects foreign-source candidates even when they would otherwise be excluded', () => {
    expectError(
      input([
        candidate('v2.0.0'),
        candidate('other-tag', { sourceId: 'f'.repeat(64), draft: true, prerelease: true }),
      ]),
    );
  });

  it.each([':', '@', '?', '#', '\\', '/'])(
    'rejects %s in source-local release IDs',
    (character) => {
      expectError(input([candidate('v2.0.0', { releaseId: `release${character}secret` })]));
    },
  );

  it.each(['12345', 'Opaque_Release-123', 'v2.0.0'])(
    'accepts safe source-local ID %s',
    (releaseId) => {
      expect(selectNativeRelease(input([candidate('v2.0.0', { releaseId })])).releaseId).toBe(
        releaseId,
      );
    },
  );

  it('bounds inventories without silently selecting from a truncated subset', () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) => candidate(`v1.0.${index}`));
    expect(selectNativeRelease(input(candidates)).tag).toBe('v1.0.9999');
    candidates.push(candidate('v2.0.0'));
    expectError(input(candidates));
  });

  it.each(
    [
      undefined,
      null,
      {},
      [],
      { sourceId: source.sourceId, candidates: [], complete: 'true' },
      { sourceId: source.sourceId, candidates: [], complete: 1 },
      { sourceId: source.sourceId, candidates: [] },
      { sourceId: 'f'.repeat(64), candidates: [], complete: true },
      { sourceId: source.sourceId, candidates: {}, complete: true },
    ].map((value) => [value]),
  )('requires an explicit discovery identity and boolean completeness: %s', (discovery) => {
    expectError(input([], { discovery }));
  });

  it.each(
    [
      null,
      [],
      {},
      candidate('v2.0.0', { sourceId: undefined }),
      candidate('v2.0.0', { releaseId: 123 }),
      candidate('v2.0.0', { releaseId: '' }),
      candidate('v2.0.0', { releaseId: 'x'.repeat(257) }),
      candidate('v2.0.0', { releaseId: 'private\nvalue' }),
      candidate('v2.0.0', { releaseId: 'https://user:secret@example.invalid/release' }),
      candidate('v2.0.0', { tag: 'v2.0.0\n' }),
      candidate('v2.0.0', { tag: null }),
      candidate('v2.0.0', { published: undefined }),
      candidate('v2.0.0', { published: 'true' }),
      candidate('v2.0.0', { draft: undefined }),
      candidate('v2.0.0', { draft: 'false' }),
      candidate('v2.0.0', { prerelease: undefined }),
      candidate('v2.0.0', { prerelease: 0 }),
    ].map((value) => [value]),
  )('rejects incomplete or unsafe normalized candidates', (value) => {
    expectError(input([value]));
  });

  it.each([
    null,
    '',
    'LATEST',
    '2.0.0',
    'refs/tags/v2.0.0',
    'v02.0.0',
    'v2.00.0',
    'v2.0.00',
    'v2.0.0+build.1',
    'v2.0.0-rc.1',
    'v2.0.1-preview.20260918.0',
    'v2.0.1-preview.20260918.01',
    'v2.0.1-preview.2026091.1',
    'v2.0.0\n',
    2,
  ])('rejects unsupported explicit tag protocols: %s', (requestedRelease) => {
    expectError(input([candidate('v2.0.0')], { requestedRelease }));
  });

  it.each(
    [
      undefined,
      null,
      [],
      { provider: 'github', repository: 'owner/repo', sourceId: 'f'.repeat(64) },
      { provider: 'unknown', repository: 'owner/repo' },
      { provider: 'github', repository: 'https://user:secret@github.com/owner/repo' },
    ].map((value) => [value]),
  )('rejects invalid selected sources without echoing their data', (selectedSource) => {
    expectError(input([], { source: selectedSource }));
    try {
      selectNativeRelease(input([], { source: selectedSource }));
    } catch (error) {
      expect(error.message).not.toContain('secret');
      expect(error).not.toHaveProperty('cause');
    }
  });

  it.each([undefined, null, [], false].map((value) => [value]))(
    'rejects missing or non-object input',
    (value) => {
      expectError(value);
    },
  );
});
