import { createHash } from 'node:crypto';

export const ANCHOR_VERSION = 1;
export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Existing files use coordinates frozen from the authored baseline. New paths
// receive reproducible positions independent of file counts, LOC, or neighbours.
export function loadAnchors(source, frame) {
  if (source?.version !== ANCHOR_VERSION || !/^[a-f0-9]{40}$/.test(source.baselineSha)) {
    throw new Error('Invalid fixed file-anchor baseline');
  }
  if (!source.files || typeof source.files !== 'object' || Array.isArray(source.files)) {
    throw new Error('Invalid fixed file anchors');
  }
  for (const [path, point] of Object.entries(source.files)) {
    if (
      !point ||
      point.leafId !== frame.assign(path).leaf.id ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    ) {
      throw new Error(`Invalid fixed file anchor: ${path}`);
    }
  }
  const get = (path) => {
    const prior = source.files[path];
    if (prior) return { ...prior, basis: 'baseline', version: ANCHOR_VERSION };
    const leafId = frame.assign(path).leaf.id;
    const hash = createHash('sha256').update(`isobar-anchor-v1:${leafId}:${path}`).digest();
    return {
      leafId,
      x: 0.07 + 0.86 * (hash.readUInt32BE(0) / 0xffffffff),
      y: 0.07 + 0.86 * (hash.readUInt32BE(4) / 0xffffffff),
      basis: 'new-path',
      version: ANCHOR_VERSION,
    };
  };
  return { get, baselineSha: source.baselineSha, version: ANCHOR_VERSION };
}

// Place a point within its own geographic rectangle. No state/weights derived
// from the PR participate; the same file appears in the same place each time.
export function pixelAnchor(point, rect) {
  return { x: rect.x + point.x * rect.w, y: rect.y + point.y * rect.h };
}
