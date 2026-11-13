// How the protected engine's loader presents a pinned file to Bun. The pinned
// engine imports its sensor manifests as text (`with { type: "text" }`); Bun
// does not accept a text loader from a plugin, so text is returned as a module
// whose default export is the exact file content. Any other kind of file is
// refused instead of being interpreted.
import { extname } from 'node:path';

const LOADERS = {
  '.ts': 'ts',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.toml': 'toml',
};
const TEXT = new Set(['.md']);

export const nativeEngineModuleSource = (path, bytes) => {
  const extension = extname(path);
  const contents = bytes.toString('utf8');
  if (Object.hasOwn(LOADERS, extension)) return { contents, loader: LOADERS[extension] };
  if (TEXT.has(extension))
    return { contents: `export default ${JSON.stringify(contents)};\n`, loader: 'js' };
  throw new Error('NATIVE_ENGINE_MODULE_DENIED');
};
