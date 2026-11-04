import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAnchors, pixelAnchor } from '../pr-impact/anchors.mjs';

const frame = { assign: () => ({ leaf: { id: 'shared-execution' } }) };
const raw = {
  version: 1,
  baselineSha: 'a'.repeat(40),
  files: { 'src/store.js': { leafId: 'shared-execution', x: 0.42, y: 0.61 } },
};

test('baseline points remain stable when unrelated files or PR weights change', () => {
  const first = loadAnchors(raw, frame);
  const added = loadAnchors(
    {
      ...raw,
      files: { ...raw.files, 'src/other.js': { leafId: 'shared-execution', x: 0.1, y: 0.2 } },
    },
    frame,
  );
  assert.deepEqual(first.get('src/store.js'), added.get('src/store.js'));
  assert.deepEqual(pixelAnchor(first.get('src/store.js'), { x: 100, y: 50, w: 200, h: 300 }), {
    x: 184,
    y: 233,
  });
});

test('new-path anchor is deterministic, scoped and explicitly a fallback', () => {
  const anchors = loadAnchors(raw, frame);
  const point = anchors.get('src/new.js');
  assert.equal(point.basis, 'new-path');
  assert.equal(point.leafId, 'shared-execution');
  assert.ok(point.x >= 0.07 && point.x <= 0.93 && point.y >= 0.07 && point.y <= 0.93);
  assert.deepEqual(point, anchors.get('src/new.js'));
});

test('mismatched ownership, malformed baseline and out-of-box points fail', () => {
  assert.throws(() => loadAnchors({ ...raw, version: 2 }, frame));
  assert.throws(() =>
    loadAnchors({ ...raw, files: { a: { leafId: 'elsewhere', x: 0.5, y: 0.5 } } }, frame),
  );
  assert.throws(() =>
    loadAnchors({ ...raw, files: { a: { leafId: 'shared-execution', x: 1.2, y: 0.5 } } }, frame),
  );
});
