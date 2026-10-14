// One verified file at a time, bounded disk output, no workspace filesystem input.
import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeCredentialPath, nativeFileExclusion } from '../shared/native-project-files.js';
import { nativePublicationPath } from '../shared/native-publication.js';
import { resultFailure, RESULT_MAX_BYTES } from './result-store.js';

export const RESULT_ARCHIVE_BYTES = RESULT_MAX_BYTES;
export const resultEligibleFiles = (manifest, request) => {
  const files = request.fileId
    ? manifest.files.filter((f) => f.id === request.fileId && f.sha256 === request.sha256)
    : manifest.files;
  if (request.fileId && files.length !== 1) throw resultFailure('INVALID');
  if (files.some((f) => nativeFileExclusion(f.path) || nativeCredentialPath(f.path)))
    throw resultFailure('FILE_POLICY');
  return files;
};
export const assertArchivePaths = (files) => {
  const names = new Set();
  for (const file of files) {
    nativePublicationPath(file.path);
    const parts = file.path.split('/');
    if (
      parts.some(
        (p) =>
          /[<>:"|?*]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      )
    )
      throw resultFailure('ARCHIVE_PATH');
    const name = file.path.normalize('NFC').toLowerCase();
    if (names.has(name)) throw resultFailure('ARCHIVE_PATH');
    names.add(name);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join('/'))) throw resultFailure('ARCHIVE_PATH');
  }
};
export const buildNativeResultArchive = async ({
  destination,
  files,
  provenance,
  readFile,
  signal,
}) => {
  assertArchivePaths(files);
  const archive = archiver('zip', { store: true });
  const digest = createHash('sha256');
  let count = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > RESULT_ARCHIVE_BYTES) return callback(resultFailure('LIMIT'));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  archive.on('warning', (error) => archive.destroy(error));
  const completed = pipeline(
    archive,
    meter,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  // Attach immediately so an output error during an input read cannot become
  // an unhandled rejection. The original promise is still awaited below.
  void completed.catch(() => {});
  const append = async (content, name) => {
    signal?.throwIfAborted();
    if (archive.destroyed) throw resultFailure();
    const entered = once(archive, 'entry', { signal });
    archive.append(content, { name, date: new Date('1980-01-01T00:00:00Z'), mode: 0o644 });
    await entered;
  };
  try {
    for (const file of files) await append(await readFile(file), `files/${file.path}`);
    await append(Buffer.from(JSON.stringify(provenance, null, 2) + '\n'), 'result-manifest.json');
    await archive.finalize();
    await completed;
    return { bytes: count, sha256: digest.digest('hex') };
  } catch (error) {
    archive.destroy(error);
    await completed.catch(() => {});
    throw error;
  }
};
