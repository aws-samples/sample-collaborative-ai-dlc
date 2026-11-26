import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeSourceTransport,
  NativeSourceTransportError,
  NATIVE_SOURCE_LIMITS,
} from '../native-source-transport.js';

// Only fetch is injected. Responses, byte streams, file descriptors, and
// destination exclusivity are real; these tests never open network sockets.
const TOKEN = 'source-token-must-not-leak';
const SIGNATURE = 'signed-query-must-not-leak';
const COMMIT = 'a'.repeat(40);
const providers = [
  {
    provider: 'github',
    base: 'https://api.github.com',
    prefix: '/repos/team/workflow',
    list: '/repos/team/workflow/releases',
    asset: '/repos/team/workflow/releases/assets/42',
    delivery: 'https://release-assets.githubusercontent.com/release/binary',
    pageSize: 'per_page',
  },
  {
    provider: 'gitlab',
    base: 'https://gitlab.com/api/v4',
    prefix: '/projects/team%2Fworkflow',
    list: '/projects/team%2Fworkflow/releases',
    asset: 'https://gitlab.com/team/workflow/-/releases/v1.2.3/downloads/binary',
    delivery: 'https://storage.googleapis.com/gitlab-release/binary',
    pageSize: 'per_page',
  },
  {
    provider: 'bitbucket',
    base: 'https://api.bitbucket.org/2.0',
    prefix: '/repositories/team/workflow',
    list: '/repositories/team/workflow/downloads',
    asset: '/repositories/team/workflow/downloads/binary',
    delivery: 'https://bbuseruploads.s3.amazonaws.com/release/binary',
    pageSize: 'pagelen',
  },
];
const github = providers[0];
const source = (provider = 'github') => ({ provider, repository: 'team/workflow' });
const transport = (fetchImpl, provider = 'github', options = {}) =>
  createNativeSourceTransport({ source: source(provider), token: TOKEN, fetchImpl, ...options });
const assetOptions = { maxBytes: 64 };
const signed = (url) => `${url}?X-Amz-Signature=${SIGNATURE}`;
const text = (value) => Buffer.from(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const streamedResponse = (chunks, options = {}, onCancel = vi.fn()) => {
  let index = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, options);
};
const rejection = async (promise, code) => {
  const error = await promise.then(
    () => {
      throw new Error('Expected the transport to reject the request');
    },
    (reason) => reason,
  );
  expect(error).toBeInstanceOf(NativeSourceTransportError);
  if (code) expect(error.code).toBe(code);
  const rendered = [String(error), error.stack, JSON.stringify(error)].join('\n');
  expect(rendered).not.toContain(TOKEN);
  expect(rendered).not.toContain(SIGNATURE);
  expect(error.cause).toBeUndefined();
  return error;
};
const roots = [];
const privateDirectory = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'native-source-transport-'));
  roots.push(directory);
  await fs.chmod(directory, 0o700);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('native source authentication and fixed routes', () => {
  it.each(providers)('authenticates only the fixed $provider source routes', async (spec) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{"ok":true}')));
    const client = transport(fetchImpl, spec.provider);
    expect((await client.json(spec.list)).data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${spec.base}${spec.list}`);
    expect(options).toMatchObject({
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'manual',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(options.headers).toSorted()).toEqual(['Accept', 'Authorization']);
  });

  it.each(providers)('uses explicit token:null for anonymous $provider access', async (spec) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}')));
    const client = transport(fetchImpl, spec.provider, { token: null });
    await client.json(spec.list);
    await client.bytes(spec.asset, assetOptions);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(new Headers(options.headers).has('authorization')).toBe(false);
      expect(options.credentials).toBe('omit');
    }
  });

  it.each([undefined, '', 'has whitespace', 'line\nbreak', 123, {}])(
    'rejects an omitted or invalid token (%j) before fetch',
    (token) => {
      const fetchImpl = vi.fn();
      expect(() => transport(fetchImpl, 'github', { token })).toThrow(
        expect.objectContaining({ code: 'native_source_request_invalid' }),
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects a sourceId that does not identify the requested repository', () => {
    const fetchImpl = vi.fn();
    expect(() =>
      transport(fetchImpl, 'github', {
        source: { ...source(), sourceId: 'b'.repeat(64) },
      }),
    ).toThrow(expect.objectContaining({ code: 'native_source_request_invalid' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['github', '/repos/team/workflow'],
    ['github', '/repos/team/workflow/releases/1'],
    ['github', '/repos/team/workflow/releases/1/assets'],
    ['github', '/repos/team/workflow/git/ref/tags/v1.2.3'],
    ['github', `/repos/team/workflow/git/tags/${COMMIT}`],
    ['gitlab', '/projects/team%2Fworkflow'],
    ['gitlab', '/projects/team%2Fworkflow/releases/v1.2.3'],
    ['gitlab', '/projects/team%2Fworkflow/repository/tags/v1.2.3'],
    ['bitbucket', '/repositories/team/workflow'],
    ['bitbucket', '/repositories/team/workflow/refs/tags/v1.2.3'],
  ])('allows the documented %s metadata route %s', async (provider, path) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}')));
    await transport(fetchImpl, provider).json(path);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('supports GitLab subgroups without expanding the authorized project', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}')));
    const client = transport(fetchImpl, 'gitlab', {
      source: { provider: 'gitlab', repository: 'TEAM/Subgroup/Workflow' },
    });
    await client.json('/projects/team%2Fsubgroup%2Fworkflow/releases');
    await client.bytes(
      'https://gitlab.com/team/subgroup/workflow/-/releases/v1.2.3/downloads/bin/linux-arm64',
      assetOptions,
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://gitlab.com/api/v4/projects/team%2Fsubgroup%2Fworkflow/releases',
      'https://gitlab.com/team/subgroup/workflow/-/releases/v1.2.3/downloads/bin/linux-arm64',
    ]);
  });

  it.each([
    ['github', '/repos/team/other/releases'],
    ['github', '/repos/team/workflow-other/releases'],
    ['github', '/repos/team/workflow/contents/secrets'],
    ['github', '/repos/team/workflow/releases/../issues'],
    ['github', '/repos/team/workflow/releases/%2e%2e/issues'],
    ['github', 'https://api.github.com/repos/team/workflow/releases'],
    ['github', '//evil.example/repos/team/workflow/releases'],
    ['github', '/repos/team/workflow/releases#fragment'],
    ['gitlab', '/projects/other%2Fprivate/releases'],
    ['gitlab', '/projects/team%2Fworkflow%2Fother/releases'],
    ['gitlab', '/projects/team%252Fworkflow/releases'],
    ['gitlab', '/projects/team%2Fworkflow/repository/files/secret/raw'],
    ['bitbucket', '/repositories/team/other/downloads'],
    ['bitbucket', '/repositories/team/workflow/src/main/secret'],
    ['bitbucket', '/repositories/team/workflow/downloads/../pullrequests'],
  ])('rejects an arbitrary or cross-source %s route %s', async (provider, path) => {
    const fetchImpl = vi.fn();
    await rejection(transport(fetchImpl, provider).json(path), 'native_source_request_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'https://gitlab.com/other/private/-/releases/v1.2.3/downloads/binary',
    'https://gitlab.com/team/workflow-other/-/releases/v1.2.3/downloads/binary',
    'https://gitlab.com/api/v4/projects/other%2Fprivate/packages/generic/pkg/1/binary',
    'https://gitlab.com/team/workflow/-/releases/v1.2.3/downloads/../../../../other/private',
    'https://gitlab.com/team/workflow/-/releases/v1.2.3/downloads/%2e%2e%2fsecret',
    'https://gitlab.com/team/workflow/-/releases/v1.2.3/downloads/binary?private_token=secret',
    'https://gitlab.com/team/workflow/-/releases/latest/downloads/binary',
    'https://gitlab.com/team/workflow/-/raw/main/binary',
    'https://gitlab.com.evil.example/team/workflow/-/releases/v1.2.3/downloads/binary',
    'https://user:password@gitlab.com/team/workflow/-/releases/v1.2.3/downloads/binary',
    'https://gitlab.com:8443/team/workflow/-/releases/v1.2.3/downloads/binary',
    'http://gitlab.com/team/workflow/-/releases/v1.2.3/downloads/binary',
  ])('rejects an unsafe GitLab direct link without sending credentials: %s', async (url) => {
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl, 'gitlab').bytes(url, assetOptions),
      'native_source_request_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(providers)('does not interchange $provider metadata and asset routes', async (spec) => {
    const fetchImpl = vi.fn();
    const client = transport(fetchImpl, spec.provider);
    await rejection(client.json(spec.asset), 'native_source_request_invalid');
    await rejection(client.bytes(spec.list, assetOptions), 'native_source_request_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(providers)('does not authenticate an initial $provider CDN URL', async (spec) => {
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl, spec.provider).bytes(signed(spec.delivery), assetOptions),
      'native_source_request_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('native source pagination request boundaries', () => {
  it.each(providers)('allows bounded numbered pagination for $provider', async (spec) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('[]')));
    const path = `${spec.list}?${spec.pageSize}=100&page=101`;
    await transport(fetchImpl, spec.provider).json(path);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${spec.base}${path}`);
  });

  it.each([
    'page=0',
    'page=-1',
    'page=102',
    'page=0001',
    'page=1.5',
    'page=1e2',
    'page=1&page=2',
    'per_page=101',
    'per_page=0',
    'per_page=1&per_page=2',
    'pagelen=100',
    'next=https://evil.example',
    'private_token=secret',
    'page=1%26private_token%3Dsecret',
    'page=1?per_page=100',
  ])('rejects unbounded, duplicated, or unsupported query %s', async (query) => {
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl).json(`${github.list}?${query}`),
      'native_source_request_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not allow provider-specific pagination keys on another provider', async () => {
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl, 'bitbucket').json(`${providers[2].list}?per_page=100`),
      'native_source_request_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(providers)(
    'rejects query parameters on $provider initial asset requests',
    async (spec) => {
      const fetchImpl = vi.fn();
      await rejection(
        transport(fetchImpl, spec.provider).bytes(`${spec.asset}?page=1`, assetOptions),
        'native_source_request_invalid',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('returns pagination data without following a response-supplied next URL', async () => {
    const untrustedNext =
      'https://api.bitbucket.org/2.0/repositories/other/private/downloads?page=2';
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ values: [], next: untrustedNext }), {
          headers: { 'set-cookie': `secret=${TOKEN}`, location: signed(github.delivery) },
        }),
      ),
    );
    const result = await transport(fetchImpl, 'bitbucket').json(providers[2].list);
    expect(result.data.next).toBe(untrustedNext);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(result.headers.has('location')).toBe(false);
  });

  it('preserves the GitLab pagination evidence used by the catalog completeness checks', async () => {
    const headers = {
      'x-page': '1',
      'x-per-page': '100',
      'x-total-pages': '2',
      'set-cookie': `secret=${TOKEN}`,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('[{"tag_name":"v1.2.3"}]', { headers }));
    const result = await transport(fetchImpl, 'gitlab').json(
      `${providers[1].list}?page=1&per_page=100`,
    );
    expect(result.headers.get('x-page')).toBe('1');
    expect(result.headers.get('x-per-page')).toBe('100');
    expect(result.headers.get('x-total-pages')).toBe('2');
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves pagination links for catalog validation without fetching them', async () => {
    const link = `<https://api.github.com/repos/other/private/releases?page=2>; rel="next"`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response('[]', { headers: { link } }));
    const result = await transport(fetchImpl).json(github.list);
    expect(result.headers.get('link')).toBe(link);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('native source redirect handling', () => {
  it.each(providers)(
    'strips credentials on same- and cross-origin $provider redirects',
    async (spec) => {
      const sameOrigin = `${new URL(spec.base).origin}/other-project/private-asset`;
      const firstCancelled = vi.fn();
      const secondCancelled = vi.fn();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          streamedResponse([], { status: 302, headers: { location: sameOrigin } }, firstCancelled),
        )
        .mockResolvedValueOnce(
          streamedResponse(
            [],
            { status: 307, headers: { location: signed(spec.delivery) } },
            secondCancelled,
          ),
        )
        .mockResolvedValueOnce(streamedResponse([text('verified bytes')]));
      const result = await transport(fetchImpl, spec.provider).bytes(spec.asset, assetOptions);
      expect(result.toString()).toBe('verified bytes');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls[1][0]).toBe(sameOrigin);
      expect(fetchImpl.mock.calls[2][0]).toBe(signed(spec.delivery));
      expect(firstCancelled).toHaveBeenCalledTimes(1);
      expect(secondCancelled).toHaveBeenCalledTimes(1);
      fetchImpl.mock.calls.forEach(([, options], index) => {
        expect(options.method).toBe('GET');
        expect(options.redirect).toBe('manual');
        expect(options.credentials).toBe('omit');
        expect(options.referrerPolicy).toBe('no-referrer');
        expect(new Headers(options.headers).get('authorization')).toBe(
          index === 0 ? `Bearer ${TOKEN}` : null,
        );
        expect(Object.keys(options.headers).toSorted()).toEqual(
          index === 0 ? ['Accept', 'Authorization'] : ['Accept'],
        );
      });
    },
  );

  it.each([301, 302, 303, 307, 308])(
    'rejects a metadata %i redirect without following it',
    async (status) => {
      const cancel = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue(
        streamedResponse(
          [],
          {
            status,
            headers: { location: signed(github.delivery) },
          },
          cancel,
        ),
      );
      await rejection(transport(fetchImpl).json(github.list), 'native_source_redirect_invalid');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['https://evil.example/binary', 'native_source_delivery_unsupported'],
    [
      'https://release-assets.githubusercontent.com.evil.example/binary',
      'native_source_delivery_unsupported',
    ],
    ['https://bucket.s3.amazonaws.com/binary', 'native_source_delivery_unsupported'],
    ['https://127.0.0.1/binary', 'native_source_delivery_unsupported'],
    [
      'https://user:password@release-assets.githubusercontent.com/binary',
      'native_source_request_invalid',
    ],
    ['https://release-assets.githubusercontent.com:8443/binary', 'native_source_request_invalid'],
    ['http://release-assets.githubusercontent.com/binary', 'native_source_request_invalid'],
    ['file:///tmp/binary', 'native_source_request_invalid'],
    [
      'https://release-assets.githubusercontent.com/binary#fragment',
      'native_source_request_invalid',
    ],
  ])('rejects unsupported delivery URL %s', async (location, code) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 302, headers: { location } }));
    await rejection(transport(fetchImpl).bytes(github.asset, assetOptions), code);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect loops and never restores credentials on a later API hop', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('', {
          status: 302,
          headers: { location: `${github.base}${github.asset}` },
        }),
      ),
    );
    await rejection(
      transport(fetchImpl).bytes(github.asset, assetOptions),
      'native_source_redirect_invalid',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(NATIVE_SOURCE_LIMITS.redirects + 1);
    for (const [, options] of fetchImpl.mock.calls.slice(1)) {
      expect(new Headers(options.headers).has('authorization')).toBe(false);
    }
  });

  it('rejects a missing Location without another request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 302 }));
    await rejection(
      transport(fetchImpl).bytes(github.asset, assetOptions),
      'native_source_request_invalid',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500])(
    'sanitizes a signed delivery response with status %i',
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('', { status: 302, headers: { location: signed(github.delivery) } }),
        )
        .mockResolvedValueOnce(new Response(`${TOKEN} ${SIGNATURE}`, { status }));
      await rejection(
        transport(fetchImpl).bytes(github.asset, assetOptions),
        'native_source_read_failed',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('sanitizes fetch errors containing the signed URL and source token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: signed(github.delivery) } }),
      )
      .mockRejectedValueOnce(new Error(`Failed ${signed(github.delivery)} with ${TOKEN}`));
    await rejection(
      transport(fetchImpl).bytes(github.asset, assetOptions),
      'native_source_read_failed',
    );
  });

  it('rejects a fetch implementation that already followed a redirect', async () => {
    const response = new Response('unscoped bytes');
    // An injected fetch can expose a real Response with the observable
    // redirected flag normally supplied by the network implementation.
    Object.defineProperty(response, 'redirected', { value: true });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await rejection(
      transport(fetchImpl).bytes(github.asset, assetOptions),
      'native_source_request_invalid',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('native source stream bounds and response validation', () => {
  it('accepts an exactly bounded multi-chunk response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamedResponse([text('ab'), text('cd')], {
        headers: { 'content-length': '4' },
      }),
    );
    expect(await transport(fetchImpl).bytes(github.asset, { maxBytes: 4 })).toEqual(text('abcd'));
  });

  it.each(['65', '-1', '1.5', 'NaN', 'Infinity', '4, 4', '9007199254740993'])(
    'rejects invalid or excessive Content-Length %s before consuming the body',
    async (declared) => {
      const pull = vi.fn();
      const cancel = vi.fn();
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { 'content-length': declared },
        }),
      );
      await rejection(
        transport(fetchImpl).bytes(github.asset, assetOptions),
        'native_source_limit',
      );
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, '1'])('enforces actual bytes when Content-Length is %s', async (declared) => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(text('1234'));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: declared === undefined ? {} : { 'content-length': declared },
      }),
    );
    await rejection(
      transport(fetchImpl).bytes(github.asset, { maxBytes: 7 }),
      'native_source_limit',
    );
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['truncated', '8', 'short'],
    ['underdeclared', '2', 'longer'],
    ['empty but declared nonempty', '1', ''],
  ])(
    'rejects an identity-encoded %s body instead of accepting a partial file',
    async (_name, declared, content) => {
      const directory = await privateDirectory();
      const fetchImpl = vi.fn().mockResolvedValue(
        streamedResponse([text(content)], {
          headers: { 'content-length': declared },
        }),
      );
      await rejection(
        transport(fetchImpl).download(github.asset, {
          directory,
          name: 'binary',
          maxBytes: 32,
        }),
      );
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it('bounds actual decoded bytes independently of compressed Content-Length', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      streamedResponse([Buffer.alloc(65)], {
        headers: { 'content-length': '10', 'content-encoding': 'gzip' },
      }),
    );
    await rejection(transport(fetchImpl).bytes(github.asset, assetOptions), 'native_source_limit');
  });

  it('bounds metadata bytes before attempting JSON parsing', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamedResponse([Buffer.alloc(NATIVE_SOURCE_LIMITS.jsonBytes, 32), text('x')], {}, cancel),
      );
    await rejection(transport(fetchImpl).json(github.list), 'native_source_limit');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON without echoing the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(`{"secret": "${TOKEN} ${SIGNATURE}`));
    await rejection(transport(fetchImpl).json(github.list), 'native_source_response_invalid');
  });

  it.each([200, 204, 206, 304])(
    'rejects a bodyless or partial HTTP %i response',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
      await rejection(
        transport(fetchImpl).bytes(github.asset, assetOptions),
        'native_source_read_failed',
      );
    },
  );

  it('propagates a stream failure only as a sanitized transport error', async () => {
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(text('partial'));
          else controller.error(new Error(`${signed(github.delivery)} ${TOKEN}`));
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));
    const directory = await privateDirectory();
    await rejection(
      transport(fetchImpl).download(github.asset, {
        directory,
        name: 'binary',
        ...assetOptions,
      }),
      'native_source_read_failed',
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, NATIVE_SOURCE_LIMITS.assetBytes + 1])(
    'rejects an invalid caller byte bound %s before fetch',
    async (maxBytes) => {
      const fetchImpl = vi.fn();
      await rejection(
        transport(fetchImpl).bytes(github.asset, { maxBytes }),
        'native_source_request_invalid',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('bounds the number of requests across one transport', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}')));
    const client = transport(fetchImpl);
    for (let i = 0; i < NATIVE_SOURCE_LIMITS.requests; i += 1) await client.json(github.list);
    await rejection(client.json(github.list), 'native_source_limit');
    expect(fetchImpl).toHaveBeenCalledTimes(NATIVE_SOURCE_LIMITS.requests);
  });
});

describe('native source private destinations and cleanup', () => {
  it.each(providers)(
    'downloads $provider bytes exclusively with the correct digest and permissions',
    async (spec) => {
      const directory = await privateDirectory();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(streamedResponse([text('first'), text('second')]));
      const result = await transport(fetchImpl, spec.provider).download(spec.asset, {
        directory,
        name: 'binary',
        ...assetOptions,
      });
      expect(result).toEqual({ bytes: 11, sha256: digest('firstsecond') });
      expect(await fs.readFile(join(directory, 'binary'))).toEqual(text('firstsecond'));
      expect((await fs.stat(join(directory, 'binary'))).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(directory)).toEqual(['binary']);
    },
  );

  it('never overwrites or removes an existing destination', async () => {
    const directory = await privateDirectory();
    await fs.writeFile(join(directory, 'binary'), 'existing');
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl).download(github.asset, {
        directory,
        name: 'binary',
        ...assetOptions,
      }),
      'native_source_read_failed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fs.readFile(join(directory, 'binary'), 'utf8')).toBe('existing');
  });

  it('never follows or removes a preexisting destination symlink', async () => {
    const directory = await privateDirectory();
    await fs.writeFile(join(directory, 'target'), 'existing');
    await fs.symlink(join(directory, 'target'), join(directory, 'binary'));
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl).download(github.asset, {
        directory,
        name: 'binary',
        ...assetOptions,
      }),
      'native_source_read_failed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fs.lstat(join(directory, 'binary'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(directory, 'target'), 'utf8')).toBe('existing');
  });

  it.each(['../outside', '/absolute', '.', '..', 'sub/file', 'a\\b', 'with space', 'line\nbreak'])(
    'rejects unsafe destination filename %j before fetching or creating files',
    async (name) => {
      const directory = await privateDirectory();
      const fetchImpl = vi.fn();
      await rejection(
        transport(fetchImpl).download(github.asset, {
          directory,
          name,
          ...assetOptions,
        }),
        'native_source_request_invalid',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it.each(['public', 'symlink', 'regular-file', 'missing', 'relative'])(
    'rejects a %s destination directory before fetch',
    async (kind) => {
      const root = await privateDirectory();
      let directory = join(root, kind);
      if (kind === 'public') await fs.mkdir(directory, { mode: 0o755 });
      if (kind === 'symlink') await fs.symlink(root, directory);
      if (kind === 'regular-file') await fs.writeFile(directory, 'not a directory');
      if (kind === 'relative') directory = '.';
      const fetchImpl = vi.fn();
      await rejection(
        transport(fetchImpl).download(github.asset, {
          directory,
          name: 'binary',
          ...assetOptions,
        }),
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).not.toContain('binary');
    },
  );

  it('rejects an invalid source path before creating a destination', async () => {
    const directory = await privateDirectory();
    const fetchImpl = vi.fn();
    await rejection(
      transport(fetchImpl).download('/repos/other/private/releases/assets/42', {
        directory,
        name: 'binary',
        ...assetOptions,
      }),
      'native_source_request_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('removes a partially written file on byte overflow', async () => {
    const directory = await privateDirectory();
    const fetchImpl = vi.fn().mockResolvedValue(streamedResponse([text('1234'), text('5678')]));
    await rejection(
      transport(fetchImpl).download(github.asset, {
        directory,
        name: 'binary',
        maxBytes: 7,
      }),
      'native_source_limit',
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('allows exactly one concurrent writer to a destination', async () => {
    const directory = await privateDirectory();
    const fetchImpl = vi.fn(() => Promise.resolve(streamedResponse([text('winning bytes')])));
    const client = transport(fetchImpl);
    const options = { directory, name: 'binary', ...assetOptions };
    const outcomes = await Promise.allSettled([
      client.download(github.asset, options),
      client.download(github.asset, options),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(join(directory, 'binary'), 'utf8')).toBe('winning bytes');
  });
});

describe('native source bounded deadlines', () => {
  it.each([
    ['request timeout', { requestTimeoutMs: 100, deadlineMs: 500 }],
    ['overall deadline', { requestTimeoutMs: 500, deadlineMs: 100 }],
  ])(
    'aborts a stalled fetch at the %s and never writes its late response',
    async (_label, timing) => {
      const directory = await privateDirectory();
      const responseGate = deferred();
      const cancel = vi.fn();
      const lateResponse = streamedResponse([text('late secret bytes')], {}, cancel);
      const fetchImpl = vi.fn(() => responseGate.promise);
      const client = transport(fetchImpl, 'github', timing);
      try {
        await rejection(
          client.download(github.asset, {
            directory,
            name: 'binary',
            ...assetOptions,
          }),
          'native_source_timeout',
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
        expect(await fs.readdir(directory)).toEqual([]);
        responseGate.resolve(lateResponse);
        await nextTurn();
        await nextTurn();
        expect(await fs.readdir(directory)).toEqual([]);
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        responseGate.resolve(lateResponse);
        await nextTurn();
        if (!lateResponse.body.locked) await lateResponse.body.cancel().catch(() => {});
      }
    },
    1000,
  );

  it('cancels a stalled body at the deadline and cannot write later chunks', async () => {
    const directory = await privateDirectory();
    const cancel = vi.fn();
    let controller;
    const body = new ReadableStream(
      {
        start(streamController) {
          controller = streamController;
          controller.enqueue(text('partial'));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));
    const client = transport(fetchImpl, 'github', { requestTimeoutMs: 500, deadlineMs: 100 });
    try {
      await rejection(
        client.download(github.asset, {
          directory,
          name: 'binary',
          ...assetOptions,
        }),
        'native_source_timeout',
      );
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
      expect(await fs.readdir(directory)).toEqual([]);
      const cancellationsAtTimeout = cancel.mock.calls.length;
      if (cancellationsAtTimeout === 0) {
        controller.enqueue(text('late bytes must not be written'));
        controller.close();
      }
      await nextTurn();
      await nextTurn();
      expect(await fs.readdir(directory)).toEqual([]);
      expect(cancellationsAtTimeout).toBe(1);
      expect(body.locked).toBe(false);
    } finally {
      if (body.locked) {
        try {
          controller.error(new Error('test cleanup'));
        } catch {}
        await nextTurn();
      }
      if (!body.locked) await body.cancel().catch(() => {});
    }
  }, 1000);

  it('reports timeout when fetch cooperatively rejects on abort', async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException(`${SIGNATURE} ${TOKEN}`, 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    await rejection(
      transport(fetchImpl, 'github', {
        requestTimeoutMs: 25,
        deadlineMs: 500,
      }).bytes(github.asset, assetOptions),
      'native_source_timeout',
    );
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  }, 1000);

  it('does not reset the overall deadline for later requests', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockImplementationOnce(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
    const client = transport(fetchImpl, 'github', { requestTimeoutMs: 500, deadlineMs: 35 });
    await client.json(github.list);
    await rejection(client.bytes(github.asset, assetOptions), 'native_source_timeout');
    await rejection(client.json(github.list), 'native_source_timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 1000);

  it('bounds a stalled redirect-body cancellation and never fetches its late destination', async () => {
    const cancellationGate = deferred();
    const cancel = vi.fn(() => cancellationGate.promise);
    const body = new ReadableStream({ cancel }, { highWaterMark: 0 });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 302,
        headers: { location: signed(github.delivery) },
      }),
    );
    try {
      await rejection(
        transport(fetchImpl, 'github', {
          requestTimeoutMs: 25,
          deadlineMs: 500,
        }).bytes(github.asset, assetOptions),
        'native_source_timeout',
      );
      cancellationGate.resolve();
      await nextTurn();
      await nextTurn();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancellationGate.resolve();
    }
  }, 1000);
});
