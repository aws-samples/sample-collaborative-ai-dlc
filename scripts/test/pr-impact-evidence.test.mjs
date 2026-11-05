import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceOf } from '../pr-impact/evidence.mjs';

function graphOf(edges = []) {
  const graph = { in: new Map(), out: new Map() };
  for (const [from, to] of edges) {
    graph.out.set(from, [...(graph.out.get(from) ?? []), to]);
    graph.in.set(to, [...(graph.in.get(to) ?? []), from]);
  }
  return graph;
}

function reachOf(graph, sources, maxHops) {
  const seen = new Set(sources);
  const rows = [];
  let frontier = sources;
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next = [];
    for (const via of frontier) {
      for (const path of graph.in.get(via) ?? []) {
        if (seen.has(path)) continue;
        seen.add(path);
        rows.push({ path, via, hop });
        next.push(path);
      }
    }
    frontier = next;
  }
  return rows;
}

const isTest = (path) => /(^|\/)test\/|\.(test|spec)\.js$/.test(path);
const changed = (path, extra = {}) => ({ path, added: 10, deleted: 5, ...extra });
const shape = (path, kind, touches = []) => ({ path, kind, touches, words: [], members: [] });
function input(changes, extra = {}) {
  const frame = {
    assign: (path) => ({
      section: { id: path.startsWith('other/') ? 'other' : 'main' },
      leaf: { id: path.startsWith('other/') ? 'other-leaf' : 'main-leaf' },
    }),
  };
  return {
    frame,
    facts: { lines: new Map(changes.map(({ path }) => [path, 100])) },
    changes,
    read: { shapes: new Map(), users: [], added: new Map(), coined: new Map() },
    weather: { cells: [] },
    graph: graphOf(),
    reachOf,
    isTest,
    anchors: new Map(
      changes.map(({ path }) => [
        path,
        { leafId: frame.assign(path).leaf.id, x: 0.4, y: 0.6, basis: 'baseline', version: 1 },
      ]),
    ),
    revision: 'pinned-revision',
    mapDigest: 'map-digest',
    ...extra,
  };
}

test('test fixtures and documentation never acquire production review scores', () => {
  const result = evidenceOf(
    input([changed('lambda/test/fixture.js', { added: 900 }), changed('README.md')]),
  );
  assert.deepEqual(
    result.changes.map((c) => c.role),
    ['test', 'documentation'],
  );
  for (const change of result.changes) {
    assert.equal('review' in change, false);
    assert.equal(change.analysisMode, 'not-applicable');
  }
  assert.equal(result.summary.productionChanges, 0);
  assert.equal(result.annotations[0].detail.includes('modified file'), true);
});

test('runtime prompts and infrastructure retain their role and static-reach limitation', () => {
  const result = evidenceOf(
    input([
      changed('lambda/agentcore/prompts/system.md'),
      changed('terraform/main.tf'),
      changed('.github/workflows/check.yml'),
    ]),
  );
  assert.deepEqual(
    result.changes.map((c) => c.role),
    ['runtime-input', 'infrastructure', 'infrastructure'],
  );
  for (const change of result.changes) {
    assert.equal(change.reachStatus, 'unavailable');
  }
});

test('comment and import edits do not propagate or claim production risk', () => {
  const changes = [changed('a.js'), changed('b.js')];
  const data = input(changes, {
    graph: graphOf([
      ['consumer.js', 'a.js'],
      ['consumer.js', 'b.js'],
    ]),
  });
  data.read.shapes.set('a.js', shape('a.js', 'comments'));
  data.read.shapes.set('b.js', shape('b.js', 'imports'));
  data.read.users.push({ of: 'a.js', path: 'consumer.js', via: 'a.js', hop: 1, uses: 3 });
  const result = evidenceOf(data);
  assert.deepEqual(result.reachByCause, []);
  for (const change of result.changes) {
    assert.equal('review' in change, false);
  }
});

test('shared targets retain every cause, changed targets, and their own chain predecessor', () => {
  const data = input([changed('a.js'), changed('b.js'), changed('shared.js')]);
  for (const path of ['a.js', 'b.js']) data.read.shapes.set(path, shape(path, 'body'));
  data.read.users.push(
    { of: 'a.js', path: 'barrel.js', via: 'a.js', hop: 1, uses: 0 },
    { of: 'a.js', path: 'shared.js', via: 'barrel.js', hop: 2, uses: 4 },
    { of: 'b.js', path: 'shared.js', via: 'b.js', hop: 1, uses: 2 },
  );
  data.weather.reach = [{ of: 'b.js', path: 'shared.js', via: 'b.js', hop: 1, uses: 2 }];
  const result = evidenceOf(data);
  const shared = result.reachByCause.filter(({ path }) => path === 'shared.js');
  assert.equal(shared.length, 2);
  assert.deepEqual(
    shared.map(({ of, via }) => [of, via]),
    [
      ['a.js', 'barrel.js'],
      ['b.js', 'b.js'],
    ],
  );
  assert.ok(shared.every(({ isChanged }) => isChanged));
});

test('null file-wide uses, zero transit imports, and positive name matches remain distinct', () => {
  const data = input([changed('a.js'), changed('new.js', { isNew: true })], {
    graph: graphOf([['whole.js', 'new.js']]),
  });
  data.read.shapes.set('a.js', shape('a.js', 'signature', [{ name: 'send', kind: 'signature' }]));
  data.read.users.push(
    { of: 'a.js', path: 'barrel.js', via: 'a.js', hop: 1, uses: 0 },
    { of: 'a.js', path: 'caller.js', via: 'barrel.js', hop: 2, uses: 7 },
  );
  const result = evidenceOf(data);
  assert.deepEqual(
    result.reachByCause.map(({ uses, evidence }) => [uses, evidence]),
    [
      [0, 'transit-import'],
      [7, 'name-match'],
      [null, 'import-fallback'],
    ],
  );
  assert.equal(result.summary.nameMatchTargets, 1);
  assert.equal(result.summary.transitTargets, 1);
  assert.equal(result.summary.importFallbackTargets, 1);
});

test('upstream declaration limits and new, deleted and failed reads are explicit', () => {
  const changes = Array.from({ length: 41 }, (_, i) => changed(`source${i}.js`));
  changes.push(
    changed('large.js'),
    changed('added.js', { isNew: true }),
    changed('deleted.js', { isDeleted: true }),
    changed('unsupported.go'),
  );
  const data = input(changes);
  data.facts.lines.set('large.js', 20_001);
  data.read.added.set('source0.js', ['module level']);
  const result = evidenceOf(data);
  const by = new Map(result.changes.map((c) => [c.path, c]));
  assert.equal(by.get('source0.js').fallbackReason, 'module-level-or-unparsed');
  assert.equal(by.get('source1.js').fallbackReason, 'declaration-read-unavailable');
  assert.equal(by.get('source40.js').fallbackReason, 'declaration-file-limit');
  assert.equal(by.get('large.js').fallbackReason, 'head-line-limit');
  assert.equal(by.get('added.js').fallbackReason, 'new-file');
  assert.equal(by.get('unsupported.go').fallbackReason, 'unsupported-language');
  assert.equal(by.get('deleted.js').fallbackReason, 'deleted-head-graph-unavailable');
  assert.equal(by.get('deleted.js').reachStatus, 'unavailable');
  assert.deepEqual(result.analysis.declarationSelection, {
    eligibleFiles: 41,
    selectedFiles: 40,
    omittedFiles: 1,
  });
  assert.equal(result.changes.length, changes.length);
});

test('deleted sources can use the base graph without treating absent HEAD imports as zero impact', () => {
  const result = evidenceOf(
    input([changed('deleted.js', { isDeleted: true })], {
      baseGraph: graphOf([['still-here.js', 'deleted.js']]),
    }),
  );
  assert.equal(result.changes[0].fallbackReason, 'deleted-file-base-import-fallback');
  assert.equal(result.changes[0].reachStatus, 'observed');
  assert.equal(result.reachByCause[0].path, 'still-here.js');
  assert.equal(result.reachByCause[0].of, 'deleted.js');
});

test('annotations are bounded, anchored to retained changes, and favor named production cues', () => {
  const data = input([
    changed('docs/a.md', { added: 3000 }),
    changed('source.js'),
    changed('other/second.js'),
  ]);
  data.read.shapes.set('source.js', shape('source.js', 'body'));
  data.read.users.push({ of: 'source.js', path: 'user.js', via: 'source.js', hop: 1, uses: 2 });
  const result = evidenceOf(data);
  assert.equal(result.annotations.length, 2);
  assert.equal(result.annotations[0].path, 'source.js');
  assert.equal(result.annotations[1].path, 'other/second.js');
  for (const annotation of result.annotations) {
    const change = result.changes.find(({ path }) => path === annotation.path);
    assert.equal(annotation.leafId, change.leafId);
    assert.ok(change.anchor);
  }
  assert.equal(result.annotations[0].detail.includes('1 static name-match target'), true);
  assert.equal(result.analysis.toolRevision, 'pinned-revision');
  assert.equal(result.analysis.mapDigest, 'map-digest');
  assert.equal(result.analysis.comparison, 'merge-base-to-head');
  assert.equal(JSON.stringify(result).includes('module level'), false);
  assert.doesNotMatch(JSON.stringify(result), /"review"|"score"|"band"|"contractChecks"/);
  assert.ok(result.analysis.limitations.some((text) => text.includes('deterministic fallback')));
});
