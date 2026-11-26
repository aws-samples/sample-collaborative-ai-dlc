// Read-only provider metadata, used by the trusted controller before checkout
// and model invocation. Provider hosts come only from the existing registry.
import { getProvider } from '../shared/git-providers.js';
import { isSafeRef } from '../shared/repo-validation.js';
import { workflowSourceIdentity } from '../shared/workflow-source-bindings.js';

export const NATIVE_SOURCE_READ_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const failure = () =>
  Object.assign(new Error('The native repository branch and commit could not be verified'), {
    code: 'NATIVE_SOURCE_RESOLUTION_FAILED',
  });
export const isNativeSourceBranch = (branch) =>
  isSafeRef(branch) &&
  ![...branch].some((character) => character.codePointAt(0) <= 32 || character === '\x7f') &&
  !branch.endsWith('.') &&
  branch.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
export const isNativeSourceCommit = (commit) =>
  typeof commit === 'string' && [40, 64].includes(commit.length) && !/[^a-f0-9]/.test(commit);

const boundedJson = async (response, signal) => {
  if (!response.body?.getReader) throw failure();
  const declaredLength = response.headers?.get('content-length');
  if (
    declaredLength !== null &&
    declaredLength !== undefined &&
    (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  )
    throw failure();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw failure();
      chunks.push(Buffer.from(result.value));
    }
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure();
    return value;
  } finally {
    // Do not let an uncooperative stream's cancel promise defeat the deadline.
    signal.removeEventListener('abort', cancel);
    cancel();
  }
};

export const resolveNativeSourceCommit = async ({
  provider,
  repository,
  branch = null,
  token,
  fetchImpl = globalThis.fetch,
}) => {
  const controller = new AbortController();
  let timer;
  try {
    const identity = workflowSourceIdentity(provider, repository);
    if (
      typeof token !== 'string' ||
      !token.trim() ||
      token.length > 65536 ||
      [...token].some((character) => character.codePointAt(0) <= 32 || character === '\x7f') ||
      typeof fetchImpl !== 'function' ||
      (branch !== null && !isNativeSourceBranch(branch))
    )
      throw failure();
    const adapter = getProvider(identity.provider);
    const base = new URL(adapter.apiBase);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.port ||
      base.search ||
      base.hash
    ) {
      throw failure();
    }
    const repoPath =
      provider === 'gitlab'
        ? `${adapter.apiBase}/projects/${encodeURIComponent(identity.repository)}`
        : `${adapter.apiBase}/${provider === 'github' ? 'repos' : 'repositories'}/${identity.repository}`;
    let allowedUrl = repoPath;
    let count = 0;
    const read = async (url) => {
      // The provider's default-branch helper gets this exact-route adapter;
      // pagination, changed hosts, redirects and incidental writes cannot use it.
      if (
        controller.signal.aborted ||
        typeof url !== 'string' ||
        url !== allowedUrl ||
        new URL(url).origin !== base.origin ||
        ++count > 2
      )
        throw failure();
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
        },
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        response?.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url)
      )
        throw failure();
      const value = await boundedJson(response, controller.signal);
      return { ok: true, status: 200, json: async () => value };
    };
    const resolve = async () => {
      const resolvedBranch =
        branch ?? (await adapter.getDefaultBranch({ token, fetchImpl: read }, identity.repository));
      if (!isNativeSourceBranch(resolvedBranch)) throw failure();
      allowedUrl = `${repoPath}/${provider === 'gitlab' ? 'repository/branches' : provider === 'bitbucket' ? 'refs/branches' : 'branches'}/${encodeURIComponent(resolvedBranch)}`;
      const body = await (await read(allowedUrl)).json();
      const commit =
        provider === 'github'
          ? body.commit?.sha
          : provider === 'gitlab'
            ? body.commit?.id
            : body.target?.hash;
      if (body.name !== resolvedBranch || !isNativeSourceCommit(commit)) throw failure();
      return { branch: resolvedBranch, commit };
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(failure());
      }, NATIVE_SOURCE_READ_TIMEOUT_MS);
    });
    return await Promise.race([resolve(), timeout]);
  } catch {
    // No raw provider errors, request URLs, bodies or credential material.
    throw failure();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};
