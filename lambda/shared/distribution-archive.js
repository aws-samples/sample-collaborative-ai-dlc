import zlib from 'node:zlib';
import tar from 'tar-stream';

const MAX_DISTRIBUTION_FILES = 1_000;
const MAX_DISTRIBUTION_BYTES = 20 * 1024 * 1024;

const safeDistributionPath = (value) => {
  const path = String(value ?? '').replaceAll('\\', '/');
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`distribution-archive: unsafe path ${value}`);
  }
  return path;
};

// Fixed tar header fields, so the same files always build the same bytes: an
// archive's checksum is recorded in its manifest, and two builds of one release
// (an overlapping re-import) must agree with it. gzip's own header carries no
// timestamp from zlib.
const ENTRY_HEADER = Object.freeze({
  mode: 0o644,
  mtime: new Date(0),
  uid: 0,
  gid: 0,
  uname: '',
  gname: '',
});
// The reason a set of files cannot be archived (an unsafe path, or more files or
// bytes than an archive holds), or null when it can. Lets a caller decide before
// it builds or publishes anything.
const distributionLimitError = (files) => {
  let count = 0;
  let totalBytes = 0;
  for (const [path, body] of files) {
    try {
      safeDistributionPath(path);
    } catch (error) {
      return error.message;
    }
    count += 1;
    totalBytes += body.length;
  }
  if (count > MAX_DISTRIBUTION_FILES) {
    return `distribution-archive: exceeds ${MAX_DISTRIBUTION_FILES} files`;
  }
  if (totalBytes > MAX_DISTRIBUTION_BYTES) {
    return `distribution-archive: exceeds ${MAX_DISTRIBUTION_BYTES} bytes`;
  }
  return null;
};
const buildDistributionArchive = async (files) => {
  const entries = [...files]
    .map(([path, body]) => [
      safeDistributionPath(path),
      Buffer.isBuffer(body) ? body : Buffer.from(body),
    ])
    // Paths are unique map keys, so a code-unit comparison is a total order.
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  const limitError = distributionLimitError(entries);
  if (limitError) throw new Error(limitError);

  const pack = tar.pack();
  const gzip = zlib.createGzip({ level: 9 });
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    gzip.on('data', (chunk) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    pack.on('error', reject);
  });
  pack.pipe(gzip);
  for (const [path, body] of entries) {
    await new Promise((resolve, reject) => {
      pack.entry({ ...ENTRY_HEADER, name: path, size: body.length }, body, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  pack.finalize();
  return completed;
};

const extractDistributionArchive = async (archive) =>
  new Promise((resolve, reject) => {
    const files = new Map();
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      if (header.type !== 'file') {
        stream.on('end', next);
        stream.resume();
        return;
      }
      let path;
      try {
        path = safeDistributionPath(header.name);
        if (files.has(path)) throw new Error(`distribution-archive: duplicate path ${path}`);
        if (files.size >= MAX_DISTRIBUTION_FILES) {
          throw new Error(`distribution-archive: exceeds ${MAX_DISTRIBUTION_FILES} files`);
        }
      } catch (error) {
        stream.on('end', next);
        stream.resume();
        fail(error);
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_DISTRIBUTION_BYTES) {
          fail(new Error(`distribution-archive: exceeds ${MAX_DISTRIBUTION_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (!settled) files.set(path, Buffer.concat(chunks));
        next();
      });
      stream.on('error', fail);
    });
    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    extract.on('error', fail);

    const gunzip = zlib.createGunzip();
    gunzip.on('error', fail);
    gunzip.pipe(extract);
    gunzip.end(archive);
  });

export {
  MAX_DISTRIBUTION_BYTES,
  MAX_DISTRIBUTION_FILES,
  buildDistributionArchive,
  distributionLimitError,
  extractDistributionArchive,
  safeDistributionPath,
};

export default { buildDistributionArchive, extractDistributionArchive };
