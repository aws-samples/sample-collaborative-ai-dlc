import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analysisMap, frameLayout, loadFrame, nestedPicture } from '../pr-impact/frame.mjs';
import { loadAnchors } from '../pr-impact/anchors.mjs';

const raw = JSON.parse(readFileSync(new URL('../../.isobar/map.json', import.meta.url), 'utf8'));
const frame = loadFrame(raw);

test('the authored hierarchy retains all 15 parents and 42 scoped children', () => {
  assert.equal(frame.sections.length, 15);
  assert.equal(frame.leaves.length, 42);
  assert.equal(new Set(frame.leaves.map(({ id }) => id)).size, 42);
  assert.equal(frame.legend.flatMap(({ children }) => children).length, 42);
});

test('static ownership separates archived reads, live discussions, and live agent administration', () => {
  for (const path of [
    'lambda/questions/index.js',
    'lambda/reviews/index.js',
    'lambda/general-info/index.js',
  ]) {
    assert.equal(frame.assign(path).section.id, 'history');
  }
  assert.equal(frame.assign('lambda/discussions/index.js').leaf.id, 'realtime-discussions');
  assert.equal(frame.assign('lambda/agents/index.js').leaf.id, 'identity-agent-settings');
  assert.equal(frame.assign('config/platform-roles.json').leaf.id, 'identity-projects-users');
  assert.equal(frame.assign('lambda/.dockerignore').leaf.id, 'infrastructure-app');
  assert.equal(frame.assign('lambda/engine-data/store-gateway.js').leaf.id, 'shared-execution');
  assert.equal(
    frame.assign('lambda/engine-data/test/store-gateway.test.js').leaf.id,
    'shared-helpers',
  );
  assert.equal(frame.assign('lambda/mcp-tools/tool-gateway.js').leaf.id, 'agentcore-mcp');
});

test('change markers have fixed strength; anchors survive neighbours', async () => {
  const paths = ['lambda/shared/v2-process-store.js', 'lambda/shared/v2-process-keys.js'];
  const anchors = loadAnchors({ version: 1, baselineSha: 'a'.repeat(40), files: {} }, frame);
  const owner = frame.assign(paths[0]).leaf.id;
  const changes = paths.map((path) => ({
    path,
    leafId: owner,
    anchor: anchors.get(path),
    role: 'source',
    status: 'modified',
  }));
  const seen = [];
  const strengths = [];
  const picture = await nestedPicture({
    frame,
    facts: { lines: new Map() },
    anchors,
    evidence: { changes, reachByCause: [], annotations: [{ key: 'A', path: paths[0] }] },
    weather: { cells: paths.map((path) => ({ path, region: owner, risk: 0.99 })) },
    map: analysisMap(frame, paths),
    inks: { paper: 0, radar: [], rain: [] },
    layoutOf: () => ({ cols: 2, rows: 1 }),
    fieldOf: (local, weather) => {
      seen.push(new Map(local.points));
      strengths.push(weather.cells[0].risk);
      return { level: [16, 8, 0, 1] };
    },
  });
  const leaf = picture.panels.flatMap((p) => p.children).find((l) => l.id === owner);
  assert.equal(Math.max(...leaf.heat.level), 11);
  assert.equal(leaf.markers.length, 2);
  assert.deepEqual(seen[0].get(paths[0]), seen[1].get(paths[0]));
  assert.deepEqual(strengths, [0.5, 0.5]);
  assert.equal(leaf.markers[0].key, 'A');
  assert.ok(leaf.markers.every((marker) => !('band' in marker)));
});

test('documentation markers use the fixed lighter pilot treatment', async () => {
  const path = 'docs/development/testing.md';
  const anchors = loadAnchors({ version: 1, baselineSha: 'a'.repeat(40), files: {} }, frame);
  const leafId = frame.assign(path).leaf.id;
  let strength;
  const picture = await nestedPicture({
    frame,
    facts: { lines: new Map() },
    anchors,
    evidence: {
      changes: [
        { path, leafId, anchor: anchors.get(path), role: 'documentation', status: 'modified' },
      ],
      reachByCause: [],
      annotations: [],
    },
    weather: { cells: [{ path, region: leafId, risk: 1 }] },
    map: analysisMap(frame, [path]),
    inks: { paper: 0, radar: [], rain: [] },
    layoutOf: () => ({ cols: 2, rows: 1 }),
    fieldOf: (_local, weather) => {
      strength = weather.cells[0].risk;
      return { level: [16, 8, 0, 1] };
    },
  });
  const leaf = picture.panels.flatMap((panel) => panel.children).find((item) => item.id === leafId);
  assert.equal(strength, 0.15);
  assert.equal(Math.max(...leaf.heat.level), 4);
});

test('longest authored parent and child selectors win; unknown paths get an honest static fallback', () => {
  assert.equal(frame.assign('lambda/shared/git-providers/github.js').section.id, 'integrations');
  assert.equal(frame.assign('lambda/shared/git-providers.js').section.id, 'integrations');
  assert.equal(frame.assign('lambda/shared/v2-process-store.js').leaf.id, 'shared-execution');
  assert.equal(
    frame.assign('lambda/shared/agent-auth-bindings.js').leaf.id,
    'shared-authentication',
  );
  assert.equal(frame.assign('frontend/src/services/api.ts').leaf.id, 'client-state-api');
  assert.equal(frame.assign('frontend/src/new-view/widget.tsx').leaf.id, 'ui-shared');
  assert.equal(frame.assign('unknown-service/new.ts').leaf.id, 'repository-other');
});

test('expanded analysis map does not lose leaves or retarget them as a PR changes', () => {
  const before = frameLayout(frame);
  const sourceBefore = JSON.stringify(frame.source);
  const files = [
    'lambda/agentcore/commands/run-stage.js',
    'lambda/agentcore/test/run-stage.test.js',
  ];
  const first = analysisMap(frame, files);
  const next = analysisMap(frame, [...files, 'lambda/shared/v2-process-store.js']);
  assert.equal(first.regions.length, 42);
  assert.equal(next.regions.length, 42);
  assert.deepEqual(first.regions.find(({ id }) => id === 'agentcore-commands').paths, [files[0]]);
  assert.deepEqual(next.regions.find(({ id }) => id === 'agentcore-commands').paths, [files[0]]);
  assert.deepEqual(frameLayout(frame), before);
  assert.equal(JSON.stringify(frame.source), sourceBefore);
});

test('every child rectangle stays within its parent and has room for labels and heat', () => {
  for (const panel of frameLayout(frame).panels) {
    for (const leaf of panel.children) {
      const r = leaf.rect;
      assert.ok(r.x >= panel.rect.x && r.y >= panel.rect.y);
      assert.ok(r.x + r.w <= panel.rect.x + panel.rect.w);
      assert.ok(r.y + r.h <= panel.rect.y + panel.rect.h);
      assert.ok(r.w >= 240 && r.h >= 100, `${leaf.id}: ${r.w} × ${r.h}`);
    }
  }
});

test('leaf ownership exactly tiles the atlas without gutters, title rows or overlaps', () => {
  const layout = frameLayout(frame);
  const area = (r) => r.w * r.h;
  const fields = [];
  for (const parent of layout.panels) {
    assert.equal(
      parent.children.reduce((sum, child) => sum + area(child.rect), 0),
      area(parent.rect),
    );
    fields.push(...parent.children.map(({ rect }) => rect));
  }
  assert.equal(
    fields.reduce((sum, r) => sum + area(r), 0),
    area(layout.mapRect),
  );
  for (const [index, a] of fields.entries()) {
    for (const b of fields.slice(index + 1)) {
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(overlapW <= 0 || overlapH <= 0, 'ownership fields overlap');
    }
  }
});

test('invalid, ambiguous and oversized hierarchy fails before rendering', () => {
  for (const mutate of [
    (map) => {
      map.regions[0].children[1].id = map.regions[0].children[0].id;
    },
    (map) => {
      map.regions[0].children[0].fallback = true;
    },
    (map) => {
      map.regions[0].children[0].paths = ['/private/path'];
    },
    (map) => {
      map.regions[0].name = 'x'.repeat(25);
    },
    (map) => {
      map.layers[0].height = 100;
    },
    (map) => {
      map.fallbackSection = 'missing';
    },
  ]) {
    const bad = structuredClone(raw);
    mutate(bad);
    assert.throws(() => loadFrame(bad), /Invalid fixed map/);
  }
});
