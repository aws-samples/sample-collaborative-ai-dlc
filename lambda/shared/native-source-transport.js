// Broker-only, source-scoped reads. Never pass this transport or its token to
// agent code. Provider catalog data cannot expand authenticated request scope.
import { createHash } from 'node:crypto';
import { lstat, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { workflowSourceIdentity } from './workflow-source-bindings.js';

export const NATIVE_SOURCE_LIMITS = Object.freeze({
  jsonBytes: 8 * 1024 * 1024,
  assetBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  requests: 512,
  redirects: 3,
  requestTimeoutMs: 30_000,
  deadlineMs: 120_000,
});

const BASES = Object.freeze({
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com/api/v4',
  bitbucket: 'https://api.bitbucket.org/2.0',
});
// Compatibility is deliberately narrower than arbitrary release-link URLs.
// Additional delivery origins require a reviewed provider adapter. Redirects
// never carry the source credential, including same-origin redirects.
const DELIVERY_ORIGINS = Object.freeze({
  github: ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'],
  gitlab: ['https://gitlab.com', 'https://storage.googleapis.com'],
  bitbucket: [
    'https://api.bitbucket.org',
    'https://bbuseruploads.s3.amazonaws.com',
    'https://api.media.atlassian.com',
  ],
});
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const SHA = /^[a-f0-9]{40}$/;
const positiveId = (value) => /^[1-9]\d{0,19}$/.test(value);
const fileName = (value) =>
  typeof value === 'string' &&
  value.length <= 256 &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
  !/[\r\n]/.test(value);

export class NativeSourceTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeSourceTransportError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new NativeSourceTransportError(code, message);
};
const invalid = () =>
  fail('native_source_request_invalid', 'Unsupported native workflow source request');
const denied = () => fail('native_source_read_failed', 'Native workflow source could not be read');
const expired = () =>
  fail('native_source_timeout', 'Native workflow source read exceeded its deadline');
const limit = () =>
  fail('native_source_limit', 'Native workflow source read exceeded its resource limit');

const boundedInteger = (value, maximum) =>
  Number.isSafeInteger(value) && value > 0 && value <= maximum;

const unsafeUrlText = (value) =>
  typeof value !== 'string' ||
  value.length > 16_384 ||
  [...value].some(
    (character) =>
      character.codePointAt(0) < 32 ||
      character === '\x7f' ||
      character === '\\' ||
      /\s/u.test(character),
  );

const cancelQuietly = (streamOrReader) => {
  try {
    void streamOrReader?.cancel().catch(() => {});
  } catch {
    // Cleanup must not expose stream/provider details or block the deadline.
  }
};

const safeUrl = (value) => {
  if (unsafeUrlText(value)) {
    invalid();
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) invalid();
  return url;
};

const pagination = (search, provider) => {
  const seen = new Set();
  for (const [name, value] of new URLSearchParams(search)) {
    const pageSize = provider === 'bitbucket' ? 'pagelen' : 'per_page';
    if (
      seen.has(name) ||
      !['page', pageSize].includes(name) ||
      !/^[1-9]\d{0,3}$/.test(value) ||
      Number(value) > (name === 'page' ? 101 : 100)
    ) {
      invalid();
    }
    seen.add(name);
  }
};

const apiRouteKind = (source, pathname) => {
  const { provider, repository } = source;
  const prefix =
    provider === 'github'
      ? `/repos/${repository}`
      : provider === 'gitlab'
        ? `/projects/${encodeURIComponent(repository)}`
        : `/repositories/${repository}`;
  if (pathname === prefix) return 'json';
  if (!pathname.startsWith(`${prefix}/`)) invalid();
  const parts = pathname.slice(prefix.length + 1).split('/');
  if (provider === 'github') {
    if (parts[0] === 'releases') {
      if (parts.length === 1) return 'json';
      if (parts.length === 2 && positiveId(parts[1])) return 'json';
      if (parts.length === 3 && positiveId(parts[1]) && parts[2] === 'assets') return 'json';
      if (parts.length === 3 && parts[1] === 'assets' && positiveId(parts[2])) return 'asset';
    }
    if (parts.join('/').startsWith('git/ref/tags/') && parts.length === 4 && TAG.test(parts[3])) {
      return 'json';
    }
    if (parts.length === 3 && parts[0] === 'git' && parts[1] === 'tags' && SHA.test(parts[2])) {
      return 'json';
    }
  } else if (provider === 'gitlab') {
    if (
      parts[0] === 'releases' &&
      (parts.length === 1 || (parts.length === 2 && TAG.test(parts[1])))
    ) {
      return 'json';
    }
    if (
      parts.length === 3 &&
      parts[0] === 'repository' &&
      parts[1] === 'tags' &&
      TAG.test(parts[2])
    ) {
      return 'json';
    }
  } else {
    if (parts[0] === 'downloads') {
      if (parts.length === 1) return 'json';
      if (parts.length === 2 && fileName(parts[1])) return 'asset';
    }
    if (parts.length === 3 && parts[0] === 'refs' && parts[1] === 'tags' && TAG.test(parts[2])) {
      return 'json';
    }
  }
  invalid();
};

const initialUrl = (source, locator, kind) => {
  if (unsafeUrlText(locator)) invalid();
  const base = BASES[source.provider];
  if (locator.startsWith('/') && !locator.startsWith('//')) {
    const [pathname, query, extra] = locator.split('?');
    if (extra !== undefined || pathname.includes('#')) invalid();
    if (apiRouteKind(source, pathname) !== kind) invalid();
    pagination(query ?? '', source.provider);
    if (kind === 'asset' && query) invalid();
    return safeUrl(`${base}${locator}`);
  }
  // GitLab's generated direct_asset_url is a source-scoped download route.
  // Never authenticate an arbitrary link supplied in release metadata.
  const url = safeUrl(locator);
  const prefix = `/${source.repository}/-/releases/`;
  if (
    kind !== 'asset' ||
    source.provider !== 'gitlab' ||
    url.origin !== 'https://gitlab.com' ||
    url.search ||
    !url.pathname.toLowerCase().startsWith(prefix)
  ) {
    invalid();
  }
  const [tag, downloads, ...parts] = url.pathname.slice(prefix.length).split('/');
  if (
    !TAG.test(tag) ||
    downloads !== 'downloads' ||
    parts.length === 0 ||
    parts.some((part) => !fileName(part) || part === '.' || part === '..')
  ) {
    invalid();
  }
  return url;
};

const redirectedUrl = (source, previous, location) => {
  if (typeof location !== 'string' || location.length === 0) invalid();
  const next = safeUrl(new URL(location, previous).href);
  const origins = new Set([
    new URL(BASES[source.provider]).origin,
    ...DELIVERY_ORIGINS[source.provider],
  ]);
  if (!origins.has(next.origin)) {
    fail(
      'native_source_delivery_unsupported',
      'Native release uses an unsupported delivery origin',
    );
  }
  return next;
};

/**
 * json(relativeApiPath) -> { data, headers: Headers }
 * bytes(assetLocator, { maxBytes }) -> Buffer
 * download(assetLocator, { directory, name, maxBytes }) -> { sha256, bytes }
 *
 * An explicit null token selects anonymous access; omission never silently
 * downgrades a private source. All requests use GET with no ambient cookies.
 * Paths are constructed by the catalog and checked against a closed route set.
 * Download results and errors never include URLs or signed redirect queries.
 * JSON responses and pagination headers are internal, untrusted catalog data.
 */
export const createNativeSourceTransport = ({
  source,
  token,
  fetchImpl = fetch,
  requestTimeoutMs = NATIVE_SOURCE_LIMITS.requestTimeoutMs,
  deadlineMs = NATIVE_SOURCE_LIMITS.deadlineMs,
}) => {
  let identity;
  try {
    identity = workflowSourceIdentity(source?.provider, source?.repository);
  } catch {
    invalid();
  }
  if (
    (source.sourceId !== undefined && source.sourceId !== identity.sourceId) ||
    (token !== null &&
      (typeof token !== 'string' ||
        token.length === 0 ||
        token.length > 16_384 ||
        /\s/u.test(token))) ||
    typeof fetchImpl !== 'function' ||
    !boundedInteger(requestTimeoutMs, NATIVE_SOURCE_LIMITS.requestTimeoutMs) ||
    !boundedInteger(deadlineMs, NATIVE_SOURCE_LIMITS.deadlineMs)
  ) {
    invalid();
  }
  const deadline = Date.now() + deadlineMs;
  let requests = 0;
  let totalBytes = 0;

  const read = async (locator, kind, maxBytes, consume) => {
    const first = initialUrl(identity, locator, kind);
    if (
      !boundedInteger(
        maxBytes,
        kind === 'json' ? NATIVE_SOURCE_LIMITS.jsonBytes : NATIVE_SOURCE_LIMITS.assetBytes,
      )
    ) {
      invalid();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) expired();
    const controller = new AbortController();
    let timer;
    let body;
    let reader;
    const checkActive = () => {
      if (controller.signal.aborted || Date.now() >= deadline) expired();
    };
    const work = async () => {
      let url = first;
      for (let hop = 0; ; hop += 1) {
        checkActive();
        if (++requests > NATIVE_SOURCE_LIMITS.requests) limit();
        const headers = {
          Accept:
            kind === 'asset'
              ? 'application/octet-stream'
              : identity.provider === 'github'
                ? 'application/vnd.github+json'
                : 'application/json',
          ...(hop === 0 && token !== null ? { Authorization: `Bearer ${token}` } : {}),
        };
        const response = await fetchImpl(url.href, {
          method: 'GET',
          headers,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'manual',
          signal: controller.signal,
        });
        // A fetch implementation may settle after the deadline despite abort.
        // Dispose that response here: the caller's finally has already run.
        if (controller.signal.aborted || Date.now() >= deadline) {
          cancelQuietly(response.body);
          expired();
        }
        body = response.body;
        checkActive();
        if (response.redirected) invalid();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (kind !== 'asset' || hop >= NATIVE_SOURCE_LIMITS.redirects) {
            fail('native_source_redirect_invalid', 'Native source redirect is not supported');
          }
          const next = redirectedUrl(identity, url, response.headers.get('location'));
          await body?.cancel();
          body = undefined;
          url = next;
          continue;
        }
        if (response.status !== 200 || !body) denied();
        const declared = response.headers.get('content-length');
        const encoding =
          response.headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity';
        if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) denied();
        const encoded = encoding !== 'identity';
        // fetch returns decoded bytes. For an encoded response Content-Length
        // describes the wire representation, not the bytes hashed/written here.
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) ||
            !Number.isSafeInteger(Number(declared)) ||
            Number(declared) > (encoded ? NATIVE_SOURCE_LIMITS.assetBytes : maxBytes))
        )
          limit();
        let bytes = 0;
        const activeReader = body.getReader();
        reader = activeReader;
        try {
          while (true) {
            const { value: chunk, done } = await activeReader.read();
            checkActive();
            if (done) break;
            bytes += chunk.byteLength;
            totalBytes += chunk.byteLength;
            if (bytes > maxBytes || totalBytes > NATIVE_SOURCE_LIMITS.totalBytes) limit();
            await consume(chunk);
          }
        } finally {
          activeReader.releaseLock();
          if (reader === activeReader) reader = undefined;
        }
        if (!encoded && declared !== null && Number(declared) !== bytes) denied();
        body = undefined;
        checkActive();
        return {
          bytes,
          headers: new Headers(
            ['link', 'x-page', 'x-per-page', 'x-next-page', 'x-total', 'x-total-pages']
              .filter((name) => response.headers.has(name))
              .map((name) => [name, response.headers.get(name)]),
          ),
        };
      }
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          cancelQuietly(reader ?? body);
          reject(
            new NativeSourceTransportError(
              'native_source_timeout',
              'Native workflow source read exceeded its deadline',
            ),
          );
        },
        Math.min(requestTimeoutMs, remaining),
      );
    });
    try {
      return await Promise.race([work(), timeout]);
    } catch (error) {
      if (error instanceof NativeSourceTransportError) throw error;
      denied();
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Do not let a broken provider body hold cleanup indefinitely.
      cancelQuietly(reader ?? body);
    }
  };

  const buffer = async (locator, kind, maxBytes) => {
    const chunks = [];
    const result = await read(locator, kind, maxBytes, (chunk) => chunks.push(Buffer.from(chunk)));
    return { ...result, content: Buffer.concat(chunks) };
  };

  return Object.freeze({
    async json(path) {
      const result = await buffer(path, 'json', NATIVE_SOURCE_LIMITS.jsonBytes);
      let data;
      try {
        data = JSON.parse(result.content.toString('utf8'));
      } catch {
        fail('native_source_response_invalid', 'Native workflow source returned invalid metadata');
      }
      return { data, headers: result.headers };
    },

    async bytes(locator, { maxBytes }) {
      const result = await buffer(locator, 'asset', maxBytes);
      return result.content;
    },

    async download(locator, { directory, name, maxBytes }) {
      // Reject destination and request errors before creating any output file.
      initialUrl(identity, locator, 'asset');
      if (
        typeof directory !== 'string' ||
        !isAbsolute(directory) ||
        !fileName(name) ||
        !boundedInteger(maxBytes, NATIVE_SOURCE_LIMITS.assetBytes)
      ) {
        invalid();
      }
      let output;
      let failure;
      let result;
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) invalid();
        output = await open(join(directory, name), 'wx', 0o600);
        const hash = createHash('sha256');
        const readResult = await read(locator, 'asset', maxBytes, async (chunk) => {
          hash.update(chunk);
          await output.writeFile(chunk);
        });
        result = { bytes: readResult.bytes, sha256: hash.digest('hex') };
      } catch (error) {
        failure = error;
      }
      try {
        await output?.close();
        if (failure && output) await rm(join(directory, name));
      } catch {
        fail('native_source_cleanup_failed', 'Native source download could not be cleaned up');
      }
      if (failure instanceof NativeSourceTransportError) throw failure;
      if (failure) denied();
      return result;
    },
  });
};
