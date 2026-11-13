import { getProvider } from './git-providers.js';
import { workflowSourceIdentity } from './workflow-source-bindings.js';
import { isNativeSourceCommit } from './native-application-source.js';
import {
  NATIVE_ENGINE_SETTINGS_PATHS,
  encodeNativeEngineFiles,
  nativeEngineFileDigest,
  engineFailure,
} from './native-workflow-protocol.js';

// The existing source owner reads policy from the admitted application commit.
// Runtime-submitted policy files cannot alter requirements before the first
// engine command. Provider credentials never leave that source owner.
export const readNativeWorkflowSettings = async ({
  provider,
  repository,
  commit,
  token,
  fetchImpl = fetch,
}) => {
  workflowSourceIdentity(provider, repository);
  if (!isNativeSourceCommit(commit) || typeof token !== 'string' || !token.trim())
    throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
  const adapter = getProvider(provider);
  const root =
    provider === 'gitlab'
      ? `${adapter.apiBase}/projects/${encodeURIComponent(repository)}`
      : `${adapter.apiBase}/${provider === 'github' ? 'repos' : 'repositories'}/${repository}`;
  const commitUrl = `${root}/${
    provider === 'github' ? 'git/commits' : provider === 'gitlab' ? 'repository/commits' : 'commit'
  }/${commit}`;
  const fetchAt =
    (expected, optional = false) =>
    async (url) => {
      if (url !== expected || new URL(url).origin !== new URL(adapter.apiBase).origin)
        throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      });
      if (optional && response.status === 404) throw engineFailure('NATIVE_ENGINE_SETTINGS_ABSENT');
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url))
        throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 256 * 1024) throw engineFailure('NATIVE_ENGINE_SETTINGS_LIMIT');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return {
        ok: true,
        status: 200,
        text: async () => text,
        json: async () => {
          const value = JSON.parse(text);
          if (optional && provider !== 'bitbucket') {
            if (value.encoding !== 'base64' || typeof value.content !== 'string')
              throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
            const content = Buffer.from(value.content, 'base64');
            new TextDecoder('utf-8', { fatal: true }).decode(content);
            if (content.length !== value.size)
              throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
          }
          return value;
        },
      };
    };
  const assertCommit = async () => {
    if (
      (await adapter.getCommitIdentity(
        { token, fetchImpl: fetchAt(commitUrl) },
        repository,
        commit,
      )) !== commit
    )
      throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
  };
  await assertCommit();
  const results = await Promise.allSettled(
    NATIVE_ENGINE_SETTINGS_PATHS.map(async (path) => {
      const url =
        provider === 'github'
          ? `${root}/contents/${path}?ref=${commit}`
          : provider === 'gitlab'
            ? `${root}/repository/files/${encodeURIComponent(path)}?ref=${commit}`
            : `${root}/src/${commit}/${path}`;
      try {
        const file = await adapter.getFileContents(
          { token, fetchImpl: fetchAt(url, true) },
          repository,
          path,
          commit,
        );
        if (
          file.path !== path ||
          typeof file.content !== 'string' ||
          Buffer.byteLength(file.content) > 64 * 1024
        )
          throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
        return { path, content: Buffer.from(file.content) };
      } catch (error) {
        if (error.code === 'NATIVE_ENGINE_SETTINGS_ABSENT') return null;
        throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
      }
    }),
  );
  if (results.some((result) => result.status !== 'fulfilled'))
    throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
  await assertCommit();
  const files = encodeNativeEngineFiles(results.map((result) => result.value).filter(Boolean));
  return { schemaVersion: 1, commit, files, filesSha256: nativeEngineFileDigest(files) };
};
