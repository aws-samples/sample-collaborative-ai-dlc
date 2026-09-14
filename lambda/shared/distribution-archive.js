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

const buildDistributionArchive = async (files) => {
  const entries = [...files].map(([path, body]) => [
    safeDistributionPath(path),
    Buffer.isBuffer(body) ? body : Buffer.from(body),
  ]);
  if (entries.length > MAX_DISTRIBUTION_FILES) {
    throw new Error(`distribution-archive: exceeds ${MAX_DISTRIBUTION_FILES} files`);
  }
  const totalBytes = entries.reduce((sum, [, body]) => sum + body.length, 0);
  if (totalBytes > MAX_DISTRIBUTION_BYTES) {
    throw new Error(`distribution-archive: exceeds ${MAX_DISTRIBUTION_BYTES} bytes`);
  }

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
      pack.entry({ name: path, size: body.length, mode: 0o644 }, body, (error) => {
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
  extractDistributionArchive,
  safeDistributionPath,
};

export default { buildDistributionArchive, extractDistributionArchive };
