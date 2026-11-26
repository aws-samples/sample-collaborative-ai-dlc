import { describe, expect, it, vi } from 'vitest';
import { discoverNativeRelease, NativeReleaseCatalogError } from '../native-release-catalog.js';
import { workflowSourceIdentity } from '../workflow-source-bindings.js';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const COMMIT = 'a'.repeat(40);
const ANNOTATION = 'b'.repeat(40);
const REPO = 'team/fork';
const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
const names = (version = '2.0.0') => [
  'version.json',
  'checksums.txt',
  'aidlc-linux-arm64',
  `aidlc-runtime-${version}.tar.gz`,
  ATTESTATION_NAME,
];
const response = (data, headers = {}) => ({ data, headers: new Headers(headers) });
const ghRelease = (id = 1, tag = 'v2.0.0', overrides = {}) => ({
  id,
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-01-01T00:00:00Z',
  ...overrides,
});
const ghAssets = (version = '2.0.0') =>
  names(version).map((name, index) => ({ id: index + 100, name, state: 'uploaded' }));
const glRelease = (tag = 'v2.0.0', overrides = {}) => ({
  tag_name: tag,
  released_at: '2026-01-01T00:00:00Z',
  upcoming_release: false,
  assets: {
    links: names(tag.slice(1)).map((name, index) => ({
      id: index + 100,
      name,
      url: `https://publisher.invalid/${name}`,
      direct_asset_url: `https://gitlab.com/${REPO}/-/releases/${tag}/downloads/${name}`,
    })),
  },
  ...overrides,
});
const manifest = (overrides = {}) => ({
  schemaVersion: 1,
  version: '2.0.0',
  sourceRef: 'refs/tags/v2.0.0',
  sourceDigest: COMMIT,
  ...overrides,
});
const mockTransport = (routes, byteRoutes = {}) => ({
  json: vi.fn(async (path) => {
    if (!Object.hasOwn(routes, path)) throw new Error(`Unexpected route: ${path}`);
    return typeof routes[path] === 'function' ? routes[path]() : routes[path];
  }),
  bytes: vi.fn(async (path) => {
    if (!Object.hasOwn(byteRoutes, path)) throw new Error(`Unexpected download: ${path}`);
    return byteRoutes[path];
  }),
});
const fixture = (provider, overrides = {}) => {
  const source = workflowSourceIdentity(provider, REPO);
  let root;
  let routes;
  const byteRoutes = {};
  if (provider === 'github') {
    root = `/repos/${REPO}`;
    routes = {
      [`${root}/releases?per_page=100&page=1`]: response([ghRelease()]),
      [`${root}/releases/1/assets?per_page=100&page=1`]: response(ghAssets()),
      [`${root}/git/ref/tags/v2.0.0`]: response({
        ref: 'refs/tags/v2.0.0',
        object: { type: 'commit', sha: COMMIT },
      }),
    };
  } else if (provider === 'gitlab') {
    root = `/projects/${encodeURIComponent(REPO)}`;
    routes = {
      [`${root}/releases?per_page=100&page=1`]: response([glRelease()]),
      [`${root}/repository/tags/v2.0.0`]: response({
        name: 'v2.0.0',
        commit: { id: COMMIT },
        target: ANNOTATION,
      }),
    };
  } else {
    root = `/repositories/${REPO}`;
    routes = {
      [`${root}/downloads?pagelen=100&page=1`]: response({
        page: 1,
        pagelen: 100,
        values: names().map((name) => ({ name })),
      }),
      [`${root}/refs/tags/v2.0.0`]: response({
        name: 'v2.0.0',
        target: { hash: COMMIT },
      }),
    };
    byteRoutes[`${root}/downloads/version.json`] = Buffer.from(
      `${JSON.stringify(manifest(), null, 2)}\n`,
    );
  }
  const transport = mockTransport(routes, byteRoutes);
  return {
    source,
    root,
    routes,
    byteRoutes,
    transport,
    run: (input = {}) =>
      discoverNativeRelease({ source, transport, now: NOW, ...overrides, ...input }),
  };
};
const rejects = (promise, code = 'native_release_catalog_invalid') =>
  expect(promise).rejects.toMatchObject({ name: 'NativeReleaseCatalogError', code });
const listedAssets = (f, provider) =>
  provider === 'github'
    ? f.routes[`${f.root}/releases/1/assets?per_page=100&page=1`].data
    : provider === 'gitlab'
      ? f.routes[`${f.root}/releases?per_page=100&page=1`].data[0].assets.links
      : f.routes[`${f.root}/downloads?pagelen=100&page=1`].data.values;

describe('native release catalog provider contracts', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'returns only the selected %s identity, immutable commit and five asset locators',
    async (provider) => {
      const f = fixture(provider);
      const result = await f.run();
      expect(result.selection).toMatchObject({
        source: f.source,
        tag: 'v2.0.0',
        version: '2.0.0',
        prerelease: false,
      });
      expect(result.source).toEqual({
        provider,
        repository: REPO,
        release: 'v2.0.0',
        commit: COMMIT,
      });
      expect(result.assets.map((asset) => asset.name)).toEqual(names());
      expect(result.assets.every((asset) => Object.isFrozen(asset))).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.source)).toBe(true);
      expect(Object.isFrozen(result.assets)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('publisher.invalid');
      if (provider !== 'bitbucket') expect(f.transport.bytes).not.toHaveBeenCalled();
    },
  );

  it('finds the highest stable GitHub release on page two and uses its own assets endpoint', async () => {
    const f = fixture('github');
    f.routes[`${f.root}/releases?per_page=100&page=1`] = response([ghRelease(1, 'v1.99.0')], {
      link: `<https://api.github.com${f.root}/releases?page=2&per_page=100>; rel="next"`,
    });
    f.routes[`${f.root}/releases?per_page=100&page=2`] = response([
      ghRelease(2, 'v2.0.0', { assets: [{ name: 'not-authoritative' }] }),
      ghRelease(3, 'v99.0.0', { prerelease: true }),
    ]);
    f.routes[`${f.root}/releases/2/assets?per_page=100&page=1`] = response(ghAssets());
    const result = await f.run();
    expect(result.selection.releaseId).toBe('2');
    expect(result.assets[0].locator).toBe(`${f.root}/releases/assets/100`);
    expect(f.transport.json).not.toHaveBeenCalledWith(
      `${f.root}/releases/1/assets?per_page=100&page=1`,
    );
  });

  it('exhausts GitHub asset pagination even when the first page has fewer than 100 entries', async () => {
    const f = fixture('github');
    const endpoint = `${f.root}/releases/1/assets`;
    f.routes[`${endpoint}?per_page=100&page=1`] = response(ghAssets().slice(0, 2), {
      link: `<https://api.github.com${endpoint}?per_page=100&page=2>; rel="next"`,
    });
    f.routes[`${endpoint}?per_page=100&page=2`] = response(ghAssets().slice(2));
    expect((await f.run()).assets).toHaveLength(5);
  });

  it('continues full GitHub pages without Link headers instead of silently truncating', async () => {
    const f = fixture('github');
    f.routes[`${f.root}/releases?per_page=100&page=1`] = response(
      Array.from({ length: 100 }, (_, i) => ghRelease(i + 10, `v1.0.${i}`)),
    );
    f.routes[`${f.root}/releases?per_page=100&page=2`] = response([ghRelease()]);
    expect((await f.run()).selection.tag).toBe('v2.0.0');
  });

  it('uses generated GitLab pages and commit.id rather than an annotated tag target', async () => {
    const f = fixture('gitlab');
    f.routes[`${f.root}/releases?per_page=100&page=1`] = response([glRelease('v1.99.0')], {
      'x-page': '1',
      'x-next-page': '2',
      'x-per-page': '100',
      'x-total-pages': '2',
    });
    f.routes[`${f.root}/releases?per_page=100&page=2`] = response([glRelease()], {
      'x-page': '2',
      'x-next-page': '',
      'x-total-pages': '2',
    });
    const result = await f.run();
    expect(result.source.commit).toBe(COMMIT);
    expect(result.assets[0].locator).toBe(
      `https://gitlab.com/${REPO}/-/releases/v2.0.0/downloads/version.json`,
    );
  });

  it('accepts safe GitLab download subpaths, preserving the required filename', async () => {
    const f = fixture('gitlab');
    const release = f.routes[`${f.root}/releases?per_page=100&page=1`].data[0];
    release.assets.links[0].direct_asset_url = release.assets.links[0].direct_asset_url.replace(
      '/downloads/',
      '/downloads/native/',
    );
    expect((await f.run()).assets[0].locator).toContain('/downloads/native/version.json');
  });

  it.each(['github', 'gitlab'])(
    'accepts provider %s repository casing without changing source identity',
    async (provider) => {
      const f = fixture(provider);
      const release = f.routes[`${f.root}/releases?per_page=100&page=1`].data[0];
      if (provider === 'github') {
        release.url = 'https://api.github.com/repos/Team/Fork/releases/1';
      } else {
        for (const asset of release.assets.links) {
          asset.direct_asset_url = asset.direct_asset_url.replace('/team/fork/', '/Team/Fork/');
        }
      }
      expect((await f.run()).source.repository).toBe(REPO);
    },
  );

  it.each(['github', 'gitlab'])(
    'selects %s latest before compatibility and never falls back to the older complete release',
    async (provider) => {
      const f = fixture(provider);
      f.routes[`${f.root}/releases?per_page=100&page=1`] = response(
        provider === 'github'
          ? [ghRelease(1, 'v1.0.0'), ghRelease(2, 'v2.0.0')]
          : [glRelease('v1.0.0'), glRelease('v2.0.0', { assets: { links: [] } })],
      );
      if (provider === 'github') {
        f.routes[`${f.root}/releases/2/assets?per_page=100&page=1`] = response([]);
      }
      await rejects(f.run(), 'native_release_assets_unavailable');
      expect(f.transport.json.mock.calls.flat().some((path) => path.includes('/tags/v1.0.0'))).toBe(
        false,
      );
    },
  );

  it('does not inspect incompatible GitLab assets on an unselected older release', async () => {
    const f = fixture('gitlab');
    f.routes[`${f.root}/releases?per_page=100&page=1`].data.unshift(
      glRelease('v1.0.0', { assets: null }),
    );
    expect((await f.run()).selection.tag).toBe('v2.0.0');
  });

  it.each(['github', 'gitlab'])(
    'excludes future %s publications using the injected clock',
    async (provider) => {
      const f = fixture(provider);
      const rows = f.routes[`${f.root}/releases?per_page=100&page=1`].data;
      rows.push(
        provider === 'github'
          ? ghRelease(2, 'v99.0.0', { published_at: '2026-09-19T00:00:00Z' })
          : glRelease('v99.0.0', { released_at: '2026-09-19T00:00:00Z' }),
      );
      expect((await f.run()).selection.tag).toBe('v2.0.0');
    },
  );

  it('excludes GitLab upcoming releases even when their timestamp is in the past', async () => {
    const f = fixture('gitlab');
    f.routes[`${f.root}/releases?per_page=100&page=1`].data.push(
      glRelease('v99.0.0', { upcoming_release: true }),
    );
    expect((await f.run()).selection.tag).toBe('v2.0.0');
  });

  it('permits an explicit GitHub host-marked prerelease, but denies a draft', async () => {
    const f = fixture('github');
    const release = f.routes[`${f.root}/releases?per_page=100&page=1`].data[0];
    release.prerelease = true;
    expect((await f.run({ requestedRelease: 'v2.0.0' })).selection.prerelease).toBe(true);
    await rejects(f.run(), 'native_release_not_found');
    release.draft = true;
    await rejects(f.run({ requestedRelease: 'v2.0.0' }), 'native_release_not_selectable');
  });

  it('peels nested GitHub annotated tags to the immutable commit', async () => {
    const f = fixture('github');
    const second = 'c'.repeat(40);
    f.routes[`${f.root}/git/ref/tags/v2.0.0`].data.object = { type: 'tag', sha: ANNOTATION };
    f.routes[`${f.root}/git/tags/${ANNOTATION}`] = response({
      sha: ANNOTATION,
      object: { type: 'tag', sha: second },
    });
    f.routes[`${f.root}/git/tags/${second}`] = response({
      sha: second,
      object: { type: 'commit', sha: COMMIT },
    });
    expect((await f.run()).source.commit).toBe(COMMIT);
  });

  it('rejects an annotation cycle without repeating the request', async () => {
    const f = fixture('github');
    f.routes[`${f.root}/git/ref/tags/v2.0.0`].data.object = { type: 'tag', sha: ANNOTATION };
    f.routes[`${f.root}/git/tags/${ANNOTATION}`] = response({
      sha: ANNOTATION,
      object: { type: 'tag', sha: ANNOTATION },
    });
    await rejects(f.run());
    expect(
      f.transport.json.mock.calls.filter(([path]) => path.includes('/git/tags/')),
    ).toHaveLength(1);
  });

  it('bounds annotation depth even for unique tag objects', async () => {
    const f = fixture('github');
    const shas = Array.from({ length: 10 }, (_, i) => String(i).repeat(40));
    f.routes[`${f.root}/git/ref/tags/v2.0.0`].data.object = { type: 'tag', sha: shas[0] };
    for (let i = 0; i < shas.length - 1; i += 1) {
      f.routes[`${f.root}/git/tags/${shas[i]}`] = response({
        sha: shas[i],
        object: { type: 'tag', sha: shas[i + 1] },
      });
    }
    await rejects(f.run());
    expect(
      f.transport.json.mock.calls.filter(([path]) => path.includes('/git/tags/')),
    ).toHaveLength(8);
  });

  it.each(['tree', 'blob', 'unknown'])('rejects a GitHub tag pointing to %s', async (type) => {
    const f = fixture('github');
    f.routes[`${f.root}/git/ref/tags/v2.0.0`].data.object.type = type;
    await rejects(f.run());
  });
});

describe('Bitbucket rolling publication', () => {
  it('uses only the current manifest and returns its exact original bytes', async () => {
    const f = fixture('bitbucket');
    const original = f.byteRoutes[`${f.root}/downloads/version.json`];
    f.routes[`${f.root}/downloads?pagelen=100&page=1`].data.values.push({
      name: 'aidlc-runtime-999.0.0.tar.gz',
    });
    const result = await f.run();
    expect(result.selection.tag).toBe('v2.0.0');
    expect(result.initialFiles['version.json']).toEqual(original);
    expect(result.initialFiles['version.json']).not.toBe(original);
    expect(f.transport.bytes).toHaveBeenCalledExactlyOnceWith(`${f.root}/downloads/version.json`, {
      maxBytes: 1024 * 1024,
    });
    expect(f.transport.json).not.toHaveBeenCalledWith(`${f.root}/refs/tags/v999.0.0`);
    original.fill(0);
    expect(result.initialFiles['version.json'].toString()).toContain('"version": "2.0.0"');
  });

  it('enumerates Downloads pages using generated numbers', async () => {
    const f = fixture('bitbucket');
    f.routes[`${f.root}/downloads?pagelen=100&page=1`].data = {
      values: [{ name: 'version.json' }],
      next: `https://api.bitbucket.org/2.0${f.root}/downloads?page=2&pagelen=100`,
    };
    f.routes[`${f.root}/downloads?pagelen=100&page=2`] = response({
      values: names()
        .slice(1)
        .map((name) => ({ name })),
    });
    expect((await f.run()).assets).toHaveLength(5);
  });

  it('rejects an explicit version different from the currently published manifest', async () => {
    const f = fixture('bitbucket');
    await rejects(f.run({ requestedRelease: 'v1.0.0' }), 'native_release_not_found');
    expect(f.transport.json).toHaveBeenCalledTimes(1);
  });

  it.each([
    { sourceDigest: 'd'.repeat(40) },
    { sourceRef: 'refs/tags/v1.0.0' },
    { sourceDigest: undefined },
  ])('rejects a rolling manifest whose source pin mismatches the tag', async (changes) => {
    const f = fixture('bitbucket');
    f.byteRoutes[`${f.root}/downloads/version.json`] = Buffer.from(
      JSON.stringify(manifest(changes)),
    );
    await rejects(f.run(), 'native_release_pin_mismatch');
  });

  it('supports explicit native previews but offers no latest stable for a preview-only publication', async () => {
    const f = fixture('bitbucket');
    const version = '2.0.1-preview.20260918.1';
    f.routes[`${f.root}/downloads?pagelen=100&page=1`].data.values = names(version).map((name) => ({
      name,
    }));
    f.byteRoutes[`${f.root}/downloads/version.json`] = Buffer.from(
      JSON.stringify(manifest({ version, sourceRef: 'refs/heads/main' })),
    );
    f.routes[`${f.root}/refs/tags/v${version}`] = response({
      name: `v${version}`,
      target: { hash: COMMIT },
    });
    await rejects(f.run(), 'native_release_not_found');
    expect((await f.run({ requestedRelease: `v${version}` })).selection.prerelease).toBe(true);
  });

  it.each([
    Buffer.alloc(0),
    Buffer.alloc(1024 * 1024 + 1),
    Buffer.from([0xff]),
    Buffer.from('{bad-json'),
    Buffer.from(JSON.stringify({ schemaVersion: 2, version: '2.0.0' })),
    '{"version":"2.0.0"}',
  ])('rejects malformed or oversized rolling metadata', async (bytes) => {
    const f = fixture('bitbucket');
    f.byteRoutes[`${f.root}/downloads/version.json`] = bytes;
    await rejects(f.run());
  });
});

describe('catalog rejection and source boundaries', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects a foreign sourceId before %s I/O',
    async (provider) => {
      const f = fixture(provider);
      await rejects(f.run({ source: { ...f.source, sourceId: 'f'.repeat(64) } }));
      expect(f.transport.json).not.toHaveBeenCalled();
    },
  );

  it.each(['https://github.com/team/fork', 'team/../fork', 'team/fork?token=secret'])(
    'rejects unsafe repository identity %s before I/O',
    async (repository) => {
      const f = fixture('github');
      await rejects(f.run({ source: { provider: 'github', repository } }));
      expect(f.transport.json).not.toHaveBeenCalled();
    },
  );

  it('uses canonical GitLab subgroup source identity in both API and asset routes', async () => {
    const repository = 'team/subgroup/fork';
    const f = fixture('gitlab');
    const release = glRelease();
    for (const asset of release.assets.links) {
      asset.direct_asset_url = asset.direct_asset_url.replace(`/${REPO}/`, `/${repository}/`);
    }
    const root = `/projects/${encodeURIComponent(repository)}`;
    f.routes[`${root}/releases?per_page=100&page=1`] = response([release]);
    f.routes[`${root}/repository/tags/v2.0.0`] = response({
      name: 'v2.0.0',
      commit: { id: COMMIT },
    });
    const result = await f.run({
      source: { provider: 'gitlab', repository: repository.toUpperCase() },
    });
    expect(result.source.repository).toBe(repository);
  });

  it.each(['v01.0.0', 'v2.0.0?token=secret', 'latest\n'])(
    'rejects unsupported requested tags before I/O',
    async (requestedRelease) => {
      const f = fixture('github');
      await rejects(f.run({ requestedRelease }), 'native_release_selection_invalid');
      expect(f.transport.json).not.toHaveBeenCalled();
    },
  );

  it.each(['github', 'gitlab'])('rejects duplicate %s release tags', async (provider) => {
    const f = fixture(provider);
    f.routes[`${f.root}/releases?per_page=100&page=1`].data.push(
      provider === 'github' ? ghRelease(2) : glRelease(),
    );
    await rejects(f.run(), 'native_release_selection_invalid');
  });

  it('rejects duplicate GitHub release IDs across pages', async () => {
    const f = fixture('github');
    f.routes[`${f.root}/releases?per_page=100&page=1`] = response([ghRelease()], {
      link: `<https://api.github.com${f.root}/releases?page=2>; rel="next"`,
    });
    f.routes[`${f.root}/releases?per_page=100&page=2`] = response([ghRelease(1, 'v3.0.0')]);
    await rejects(f.run(), 'native_release_selection_invalid');
  });

  it.each(['github', 'gitlab', 'bitbucket'])('rejects duplicate %s filenames', async (provider) => {
    const f = fixture(provider);
    const rows =
      provider === 'github'
        ? f.routes[`${f.root}/releases/1/assets?per_page=100&page=1`].data
        : provider === 'gitlab'
          ? f.routes[`${f.root}/releases?per_page=100&page=1`].data[0].assets.links
          : f.routes[`${f.root}/downloads?pagelen=100&page=1`].data.values;
    rows.push({ ...rows[0], id: 999 });
    await rejects(f.run());
  });

  it.each(['github', 'gitlab'])('rejects duplicate %s asset IDs', async (provider) => {
    const f = fixture(provider);
    const assets =
      provider === 'github'
        ? f.routes[`${f.root}/releases/1/assets?per_page=100&page=1`].data
        : f.routes[`${f.root}/releases?per_page=100&page=1`].data[0].assets.links;
    assets[1].id = assets[0].id;
    await rejects(f.run());
  });

  it.each(['../version.json', 'file?token=secret', 'file\n', 'x/y'])(
    'rejects unsafe asset names',
    async (name) => {
      const f = fixture('github');
      f.routes[`${f.root}/releases/1/assets?per_page=100&page=1`].data.push({ id: 999, name });
      await rejects(f.run());
    },
  );

  it.each([
    'https://attacker.invalid/team/fork/-/releases/v2.0.0/downloads/version.json',
    'https://gitlab.com/other/fork/-/releases/v2.0.0/downloads/version.json',
    'https://gitlab.com/team/fork/-/releases/v1.0.0/downloads/version.json',
    'https://gitlab.com/team/fork/-/releases/v2.0.0/downloads/version.json?token=secret',
    'https://gitlab.com/team/fork/-/releases/v2.0.0/downloads/../version.json',
    'https://gitlab.com/team/fork/-/releases/v2.0.0/downloads/%2e%2e/version.json',
    'https://gitlab.com/team/fork/-/releases/v2.0.0/downloads/wrong.json',
    undefined,
  ])('rejects unsupported GitLab direct asset routes without using link.url', async (url) => {
    const f = fixture('gitlab');
    f.routes[`${f.root}/releases?per_page=100&page=1`].data[0].assets.links[0].direct_asset_url =
      url;
    await rejects(f.run(), 'native_release_catalog_unsupported');
    expect(f.transport.bytes).not.toHaveBeenCalled();
  });

  it.each([
    'https://attacker.invalid/repos/team/fork/releases?page=2',
    'https://api.github.com/repos/other/fork/releases?page=2',
    'https://api.github.com/repos/team/fork/releases?page=1',
    'https://api.github.com/repos/team/fork/releases?page=3',
    'https://api.github.com/repos/team/fork/releases?page=2&page=2',
    'https://api.github.com/repos/team/fork/releases?page=2&token=secret',
  ])('rejects unsafe GitHub next links before another request', async (url) => {
    const f = fixture('github');
    f.routes[`${f.root}/releases?per_page=100&page=1`].headers = new Headers({
      link: `<${url}>; rel="next"`,
    });
    await rejects(f.run());
    expect(f.transport.json).toHaveBeenCalledTimes(1);
  });

  it.each([
    { 'x-next-page': '1' },
    { 'x-page': '2' },
    { 'x-per-page': '50' },
    { 'x-next-page': '', 'x-total-pages': '2' },
  ])('rejects contradictory GitLab pagination', async (headers) => {
    const f = fixture('gitlab');
    f.routes[`${f.root}/releases?per_page=100&page=1`].headers = new Headers(headers);
    await rejects(f.run());
  });

  it.each([
    'https://attacker.invalid/downloads?page=2',
    'https://api.bitbucket.org/2.0/repositories/team/fork/downloads?page=1',
    'https://api.bitbucket.org/2.0/repositories/team/fork/downloads?page=opaque',
    'https://api.bitbucket.org/2.0/repositories/other/fork/downloads?page=2',
  ])('rejects foreign, cyclic and unsupported Bitbucket cursors', async (next) => {
    const f = fixture('bitbucket');
    f.routes[`${f.root}/downloads?pagelen=100&page=1`].data.next = next;
    await rejects(f.run());
    expect(f.transport.json).toHaveBeenCalledTimes(1);
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects malformed %s list bodies',
    async (provider) => {
      const f = fixture(provider);
      const path = Object.keys(f.routes)[0];
      f.routes[path].data = { message: 'token=secret' };
      await rejects(f.run());
    },
  );

  it('fails rather than selecting from a catalog larger than 10,000 entries', async () => {
    const transport = {
      json: vi.fn(async (path) => {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        return response(
          Array.from({ length: 100 }, (_, index) =>
            ghRelease(page * 100 + index, `v1.${page}.${index}`),
          ),
        );
      }),
      bytes: vi.fn(),
    };
    await rejects(
      discoverNativeRelease({
        source: { provider: 'github', repository: REPO },
        transport,
        now: NOW,
      }),
      'native_release_catalog_incomplete',
    );
    expect(transport.json).toHaveBeenCalledTimes(101);
  });

  it('rejects a bare Bitbucket array instead of accepting it as an empty inventory', async () => {
    const f = fixture('bitbucket');
    f.routes[`${f.root}/downloads?pagelen=100&page=1`].data = [];
    await rejects(f.run());
  });

  it.each(['gitlab', 'bitbucket'])(
    'rejects %s pagination that omits declared remaining entries',
    async (provider) => {
      const f = fixture(provider);
      const page = f.routes[Object.keys(f.routes)[0]];
      if (provider === 'gitlab') {
        page.headers = new Headers({ 'x-total': '10', 'x-next-page': '' });
      } else {
        page.data.size = 10;
      }
      await rejects(f.run());
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects a different %s returned tag',
    async (provider) => {
      const f = fixture(provider);
      const tagPath = Object.keys(f.routes).find((path) => path.includes('/tags/'));
      if (provider === 'github') f.routes[tagPath].data.ref = 'refs/tags/v1.0.0';
      else f.routes[tagPath].data.name = 'v1.0.0';
      await rejects(f.run(), 'native_release_pin_mismatch');
    },
  );

  it('rejects a GitHub release explicitly declaring a different source', async () => {
    const f = fixture('github');
    f.routes[`${f.root}/releases?per_page=100&page=1`].data[0].url =
      'https://api.github.com/repos/other/fork/releases/1';
    await rejects(f.run());
  });

  it('never exposes transport exception bodies, URLs or credentials', async () => {
    const f = fixture('github');
    f.transport.json.mockRejectedValue(new Error('https://user:secret@host/?token=secret'));
    const error = await f.run().catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeReleaseCatalogError);
    expect(error.code).toBe('native_release_catalog_unavailable');
    expect(error.message).toBe('Native release catalog could not be read');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});

describe('D17 optional release attestations', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'accepts an unsigned %s publication with exactly the four mandatory files',
    async (provider) => {
      const f = fixture(provider);
      listedAssets(f, provider).pop();
      const result = await f.run();
      expect(result.assets.map((asset) => asset.name)).toEqual(names().slice(0, 4));
      expect(result.source.commit).toBe(COMMIT);
      expect(f.transport.bytes.mock.calls.some(([path]) => path.includes(ATTESTATION_NAME))).toBe(
        false,
      );
    },
  );

  it.each(
    ['github', 'gitlab', 'bitbucket'].flatMap((provider) =>
      names()
        .slice(0, 4)
        .map((name) => [provider, name]),
    ),
  )('still requires %s core asset %s when proof is absent', async (provider, name) => {
    const f = fixture(provider);
    const assets = listedAssets(f, provider);
    assets.pop();
    assets.splice(
      assets.findIndex((asset) => asset.name === name),
      1,
    );
    await rejects(f.run(), 'native_release_assets_unavailable');
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'exposes proof appearance and disappearance in subsequent %s catalog results',
    async (provider) => {
      const f = fixture(provider);
      const assets = listedAssets(f, provider);
      const proof = assets.pop();
      const absent = await f.run();
      assets.push(proof);
      const present = await f.run();
      assets.pop();
      const absentAgain = await f.run();
      expect(absent.source).toEqual(present.source);
      expect(absent.assets).toEqual(absentAgain.assets);
      expect(present.assets.slice(0, 4)).toEqual(absent.assets);
      expect(present.assets.at(-1).name).toBe(ATTESTATION_NAME);
      expect(present.assets).toHaveLength(5);
      expect(absent.assets).toHaveLength(4);
    },
  );

  it.each(['github', 'bitbucket'])(
    'includes optional %s proof discovered on a later asset page',
    async (provider) => {
      const f = fixture(provider);
      const proof = listedAssets(f, provider).pop();
      const endpoint =
        provider === 'github' ? `${f.root}/releases/1/assets` : `${f.root}/downloads`;
      if (provider === 'github') {
        f.routes[`${endpoint}?per_page=100&page=1`].headers = new Headers({
          link: `<https://api.github.com${endpoint}?page=2&per_page=100>; rel="next"`,
        });
        f.routes[`${endpoint}?per_page=100&page=2`] = response([proof]);
      } else {
        f.routes[`${endpoint}?pagelen=100&page=1`].data.next =
          `https://api.bitbucket.org/2.0${endpoint}?page=2&pagelen=100`;
        f.routes[`${endpoint}?pagelen=100&page=2`] = response({ values: [proof] });
      }
      expect((await f.run()).assets.at(-1).name).toBe(ATTESTATION_NAME);
    },
  );

  it.each(['github', 'gitlab'])(
    'selects the highest unsigned %s release over an older signed release',
    async (provider) => {
      const f = fixture(provider);
      listedAssets(f, provider).pop();
      f.routes[`${f.root}/releases?per_page=100&page=1`].data.push(
        provider === 'github' ? ghRelease(2, 'v1.0.0') : glRelease('v1.0.0'),
      );
      const result = await f.run();
      expect(result.selection.tag).toBe('v2.0.0');
      expect(result.assets).toHaveLength(4);
      expect(f.transport.json.mock.calls.flat().some((path) => path.includes('/tags/v1.0.0'))).toBe(
        false,
      );
    },
  );

  it.each(['github', 'gitlab'])(
    'rejects malformed present %s proof on the highest release without fallback',
    async (provider) => {
      const f = fixture(provider);
      const proof = listedAssets(f, provider).at(-1);
      if (provider === 'github') proof.state = 'starter';
      else proof.direct_asset_url = `https://attacker.invalid/${ATTESTATION_NAME}`;
      f.routes[`${f.root}/releases?per_page=100&page=1`].data.push(
        provider === 'github' ? ghRelease(2, 'v1.0.0') : glRelease('v1.0.0'),
      );
      await rejects(
        f.run(),
        provider === 'github'
          ? 'native_release_assets_unavailable'
          : 'native_release_catalog_unsupported',
      );
      expect(f.transport.json.mock.calls.flat().some((path) => path.includes('/tags/v1.0.0'))).toBe(
        false,
      );
    },
  );

  it.each(['github', 'gitlab'])('rejects an invalid optional %s proof ID', async (provider) => {
    const f = fixture(provider);
    listedAssets(f, provider).at(-1).id = 'https://user:secret@host/';
    await rejects(f.run());
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects malformed %s proof names rather than treating them as absent',
    async (provider) => {
      const f = fixture(provider);
      listedAssets(f, provider).at(-1).name = `${ATTESTATION_NAME}\n`;
      await rejects(f.run());
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects duplicate optional %s proof entries',
    async (provider) => {
      const f = fixture(provider);
      const assets = listedAssets(f, provider);
      assets.push({ ...assets.at(-1), id: 999 });
      await rejects(f.run());
    },
  );
});
