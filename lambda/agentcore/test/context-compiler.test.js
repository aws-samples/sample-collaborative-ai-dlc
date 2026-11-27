import { describe, it, expect, vi } from 'vitest';
import { compileContextPack, buildUnitPack, __test } from '../context-compiler.js';

// A getItems double that filters by label or artifact type and applies
// `limit` in traversal order, before any sort, as the graph writer does.
const labelItems = (rows) =>
  vi.fn(async ({ itemType = null, artifactType = null, limit = 100 } = {}) =>
    rows
      .filter((r) => !itemType || r.label === itemType)
      .filter((r) => !artifactType || r.artifact_type === artifactType)
      .slice(0, limit),
  );

describe('compileContextPack', () => {
  it('renders a bounded deterministic pack from graph artifacts and items', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async ({ artifactType }) => [
        { id: `${artifactType}-1`, artifact_type: artifactType, title: 'Title', contentLength: 42 },
      ]),
      getItems: labelItems([
        { id: 'decision:i:d1', label: 'Decision', slug: 'd1', title: 'Use tokens' },
        { id: 'story:i:s1', label: 'Story', slug: 's1', title: 'Login', artifact_type: 'stories' },
        { id: 'persona:i:p1', label: 'Persona', slug: 'p1', artifact_type: 'personas' },
      ]),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'stories' }] },
      budgetBytes: 10_000,
    });
    expect(pack.markdown).toContain('## Compiled graph context');
    expect(pack.markdown).toContain('requirements (requirements-1)');
    expect(pack.markdown).toContain('- d1 — Use tokens');
    expect(pack.markdown).toContain('### Derived items — stories');
    expect(pack.markdown).toContain('Story s1');
    // Items of artifacts the stage does not read stay behind get_items.
    expect(pack.markdown).not.toContain('p1');
    expect(pack.artifacts).toBe(2);
    expect(pack.items).toBe(2);
  });

  it('honors the byte budget', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => [
        { id: 'a', artifact_type: 'requirements', title: 'Long', contentLength: 999 },
      ]),
      getItems: vi.fn(async () => []),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }] },
      budgetBytes: 30,
    });
    expect(pack.truncated).toBe(true);
    expect(pack.bytes).toBeLessThanOrEqual(30);
  });

  it('surfaces the enrichment gist on artifact lines (enrichment pays into prompts)', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => [
        {
          id: 'req-1',
          artifact_type: 'requirements',
          title: 'Reqs',
          contentLength: 9000,
          summary_gist: 'Auth requirements: login, MFA, lockout.',
        },
      ]),
      getItems: vi.fn(async () => []),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }] },
    });
    expect(pack.markdown).toContain('gist: Auth requirements: login, MFA, lockout.');
  });

  it('renders decisions as a constraints section', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => []),
      getItems: vi.fn(async () => [
        {
          id: 'decision:i:d1',
          label: 'Decision',
          slug: 'dec-tokens',
          title: 'Short-lived tokens',
          status: 'accepted',
        },
      ]),
    };
    const pack = await compileContextPack({ graph, stage: { inputArtifacts: [] } });
    expect(pack.markdown).toContain('### Decisions (constraints on all work)');
    expect(pack.markdown).toContain('dec-tokens — Short-lived tokens [accepted]');
  });

  it('renders input-artifact TOCs after the drill-down hint (droppable navigation)', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => [
        { id: 'req-1', artifact_type: 'requirements', title: 'Reqs', contentLength: 10 },
      ]),
      getItems: vi.fn(async () => []),
      getArtifactToc: vi.fn(async () => [
        { slug: 'overview', heading: 'Overview' },
        { slug: 'scope', heading: 'Scope' },
      ]),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }] },
    });
    expect(pack.markdown).toContain('### Sections — requirements (req-1)');
    expect(pack.markdown).toContain('- overview — Overview');
    expect(pack.markdown.indexOf('drill-down tools')).toBeLessThan(
      pack.markdown.indexOf('### Sections'),
    );
  });

  it('includes the unit lane pack when a unit is in scope', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => []),
      getItems: labelItems([
        {
          id: 'i1',
          label: 'StoryMapEntry',
          slug: 'map-auth',
          unit: 'auth',
          stories: '["s-login"]',
        },
        { id: 'i2', label: 'Story', slug: 's-login', title: 'Login', priority: 'must-have' },
        { id: 'i3', label: 'Story', slug: 's-other', title: 'Other unit story' },
        {
          id: 'i4',
          label: 'Contract',
          slug: 'c-auth-api',
          title: 'Auth API',
          provider: 'auth',
          consumers: '["billing"]',
        },
        { id: 'i5', label: 'Contract', slug: 'c-unrelated', provider: 'x', consumers: '["y"]' },
      ]),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [] },
      unit: { slug: 'auth' },
    });
    expect(pack.markdown).toContain('### Unit pack — auth');
    expect(pack.markdown).toContain('- s-login — Login [must-have]');
    expect(pack.markdown).toContain('c-auth-api — Auth API (provides');
    // The unrelated contract stays out of the unit pack.
    const unitPackSection = pack.markdown.slice(
      pack.markdown.indexOf('### Unit pack'),
      pack.markdown.indexOf('Use MCP drill-down'),
    );
    expect(unitPackSection).not.toContain('c-unrelated');
    // Non-lane runs get no unit section.
    const noUnit = await compileContextPack({ graph, stage: { inputArtifacts: [] } });
    expect(noUnit.markdown).not.toContain('### Unit pack');
  });
});

describe('buildUnitPack', () => {
  it('joins mapped stories and touched contracts for one unit', () => {
    const { lines } = buildUnitPack({
      unitSlug: 'billing',
      items: [
        { label: 'StoryMapEntry', slug: 'map-billing', unit: 'billing', stories: '["s-pay"]' },
        { label: 'Story', slug: 's-pay', title: 'Pay invoice' },
        { label: 'Contract', slug: 'c-auth-api', provider: 'auth', consumers: '["billing"]' },
      ],
    });
    const md = lines.join('\n');
    expect(md).toContain('- s-pay — Pay invoice');
    expect(md).toContain('(consumes; provider: auth');
  });

  it('lists bare story ids when story items are not derived yet', () => {
    const { lines } = buildUnitPack({
      unitSlug: 'auth',
      items: [{ label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: '["s-a","s-b"]' }],
    });
    expect(lines.join('\n')).toContain('ids: s-a, s-b (story items not derived yet)');
  });

  it('caps the bare story ids and counts the rest', () => {
    const ids = Array.from({ length: 60 }, (_, k) => `s-${String(k).padStart(2, '0')}`);
    const pack = buildUnitPack({
      unitSlug: 'auth',
      items: [{ label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: JSON.stringify(ids) }],
    });
    expect(pack.lines.join('\n')).toContain('s-49 … 10 more (story items not derived yet)');
    expect(pack.lines.join('\n')).not.toContain('s-50');
    expect(pack.omitted).toBe(10);
  });

  it('returns null with no unit or nothing relevant', () => {
    expect(buildUnitPack({ unitSlug: null, items: [] })).toBeNull();
    expect(buildUnitPack({ unitSlug: 'auth', items: [{ label: 'Story', slug: 's' }] })).toBeNull();
  });

  it('lists the requirements the unit satisfies — one COVERS hop from its stories', () => {
    const { lines } = buildUnitPack({
      unitSlug: 'auth',
      items: [
        { label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: '["s-login","s-mfa"]' },
        { label: 'Story', slug: 's-login', title: 'Login', covers: '["req-auth"]' },
        { label: 'Story', slug: 's-mfa', title: 'MFA', covers: '["req-auth","req-mfa"]' },
        // Another lane's story must not pull its requirement in.
        { label: 'Story', slug: 's-other', covers: '["req-other"]' },
        { label: 'Requirement', slug: 'req-auth', title: 'Authentication', priority: 'must-have' },
        { label: 'Requirement', slug: 'req-mfa', title: 'MFA support' },
      ],
    });
    const md = lines.join('\n');
    expect(md).toContain('Requirements satisfied by this unit (via story COVERS):');
    expect(md).toContain('- req-auth — Authentication [must-have]');
    expect(md).toContain('- req-mfa — MFA support');
    expect(md).not.toContain('req-other');
  });

  it('renders a covered slug even when the Requirement item itself is not loaded', () => {
    const { lines } = buildUnitPack({
      unitSlug: 'auth',
      items: [
        { label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: '["s-login"]' },
        { label: 'Story', slug: 's-login', covers: '["req-elsewhere"]' },
      ],
    });
    expect(lines.join('\n')).toContain('- req-elsewhere');
  });
});

describe('traceSuffix (derived-item and unit-pack story traceability line)', () => {
  it('renders covers/persona/depends-on for stories and depends-on for components', () => {
    expect(
      __test.traceSuffix({
        label: 'Story',
        covers: '["req-a","req-b"]',
        persona: 'p-op',
        depends_on: '["s-x"]',
      }),
    ).toBe(' → covers: req-a, req-b; persona: p-op; depends on: s-x');
    expect(__test.traceSuffix({ label: 'Component', depends_on: '["c-db"]' })).toBe(
      ' → depends on: c-db',
    );
  });

  it('is empty for items without refs (line stays compact)', () => {
    expect(__test.traceSuffix({ label: 'Story' })).toBe('');
    expect(__test.traceSuffix({ label: 'Requirement', covers: '["x"]' })).toBe('');
    expect(__test.traceSuffix({ label: 'Persona' })).toBe('');
  });
});

describe('listProp (tolerant JSON-list props)', () => {
  it('parses arrays, JSON strings, and garbage safely', () => {
    expect(__test.listProp(['a'])).toEqual(['a']);
    expect(__test.listProp('["a","b"]')).toEqual(['a', 'b']);
    expect(__test.listProp('not json')).toEqual([]);
    expect(__test.listProp(undefined)).toEqual([]);
  });
});

describe('compileContextPack on large graphs', () => {
  const { SECTION_ITEM_LIMIT, ITEMS_PER_LABEL } = __test;
  const graphOf = (rows) => ({
    lookupArtifacts: vi.fn(async () => []),
    getItems: labelItems(rows),
  });
  const many = (n, label, extra = () => ({})) =>
    Array.from({ length: n }, (_, k) => ({
      id: `${label.toLowerCase()}:i:${String(k).padStart(3, '0')}`,
      label,
      slug: `${label.toLowerCase()}-${k}`,
      ...extra(k),
    }));
  const section = (md, heading) => {
    const start = md.indexOf(heading);
    if (start === -1) return '';
    const end = md.indexOf('\n\n', start + heading.length);
    return md.slice(start, end === -1 ? undefined : end);
  };
  const unitStories = (n, extra = () => ({})) => [
    {
      id: 'storymapentry:i:auth',
      label: 'StoryMapEntry',
      slug: 'map-auth',
      unit: 'auth',
      stories: JSON.stringify(Array.from({ length: n }, (_, k) => `story-${k}`)),
    },
    ...many(n, 'Story', extra),
  ];

  it('keeps the unit stories when their map entry comes after the first 50 items', async () => {
    const rows = [...many(99, 'Requirement'), ...unitStories(1), ...many(19, 'Persona')];
    const pack = await compileContextPack({
      graph: graphOf(rows),
      stage: { inputArtifacts: [] },
      unit: { slug: 'auth' },
    });
    expect(pack.markdown).toContain('### Unit pack — auth');
    expect(pack.markdown).toContain('- story-0');
    expect(pack).toMatchObject({ status: 'ok', omitted: 0 });
  });

  it('reads Decision on every run, the unit-pack labels on lane runs, and each input type', async () => {
    const plain = graphOf([]);
    await compileContextPack({ graph: plain, stage: {} });
    expect(plain.getItems.mock.calls.map(([a]) => a)).toEqual([
      { itemType: 'Decision', limit: ITEMS_PER_LABEL + 1 },
    ]);
    const reader = graphOf([]);
    await compileContextPack({
      graph: reader,
      stage: { inputArtifacts: [{ artifact: 'stories' }, { artifact: 'requirements' }] },
    });
    expect(reader.getItems.mock.calls.map(([a]) => a)).toEqual([
      { itemType: 'Decision', limit: ITEMS_PER_LABEL + 1 },
      { artifactType: 'requirements', limit: ITEMS_PER_LABEL + 1 },
      { artifactType: 'stories', limit: ITEMS_PER_LABEL + 1 },
    ]);
    const lane = graphOf([]);
    await compileContextPack({ graph: lane, stage: {}, unit: { slug: 'auth' } });
    expect(lane.getItems.mock.calls.map(([a]) => a.itemType)).toEqual([
      'Decision',
      'StoryMapEntry',
      'Story',
      'Requirement',
      'Contract',
    ]);
  });

  it('lists every decision up to the section cap and counts the rest', async () => {
    const exact = await compileContextPack({
      graph: graphOf([...many(60, 'Requirement'), ...many(SECTION_ITEM_LIMIT, 'Decision')]),
      stage: {},
    });
    const exactSection = section(exact.markdown, '### Decisions');
    expect(exactSection.match(/^- decision-/gm)).toHaveLength(SECTION_ITEM_LIMIT);
    expect(exactSection).not.toContain('more (get_items)');
    expect(exact).toMatchObject({ status: 'ok', omitted: 0 });

    const over = await compileContextPack({
      graph: graphOf(many(SECTION_ITEM_LIMIT + 10, 'Decision')),
      stage: {},
    });
    const overSection = section(over.markdown, '### Decisions');
    expect(overSection.match(/^- decision-/gm)).toHaveLength(SECTION_ITEM_LIMIT);
    expect(overSection).toContain('- … 10 more (get_items)');
    expect(over).toMatchObject({ status: 'truncated', omitted: 10 });
  });

  it('signposts the capped input-artifact index without marking the pack incomplete', async () => {
    const pack = await compileContextPack({
      graph: graphOf(
        many(SECTION_ITEM_LIMIT + 5, 'Requirement', () => ({ artifact_type: 'reqs' })),
      ),
      stage: { inputArtifacts: [{ artifact: 'reqs' }] },
    });
    const index = section(pack.markdown, '### Derived items — reqs');
    expect(index.match(/^- Requirement /gm)).toHaveLength(SECTION_ITEM_LIMIT);
    expect(index).toContain('- … 5 more (get_items)');
    expect(pack).toMatchObject({ status: 'ok', omitted: 0 });
  });

  it('caps the unit stories and counts the rest', async () => {
    const pack = await compileContextPack({
      graph: graphOf(unitStories(60)),
      stage: {},
      unit: { slug: 'auth' },
    });
    expect(pack.markdown.match(/^- story-/gm)).toHaveLength(SECTION_ITEM_LIMIT);
    expect(pack.markdown).toContain('- … 10 more (get_items)');
    expect(pack).toMatchObject({ status: 'truncated', omitted: 10 });
  });

  it('renders the same pack for the same items in any traversal order', async () => {
    const rows = [...many(55, 'Decision'), ...unitStories(70), ...many(70, 'Requirement')];
    const run = (graphRows) =>
      compileContextPack({ graph: graphOf(graphRows), stage: {}, unit: { slug: 'auth' } });
    const forward = await run(rows);
    const reversed = await run(rows.toReversed());
    expect(reversed.markdown).toBe(forward.markdown);
  });

  it('flags a label only when it has more items than one read carries', async () => {
    const atLimit = await compileContextPack({
      graph: graphOf(many(ITEMS_PER_LABEL, 'Decision')),
      stage: {},
    });
    expect(atLimit.markdown).not.toContain('More than');
    const over = await compileContextPack({
      graph: graphOf(many(ITEMS_PER_LABEL + 1, 'Decision')),
      stage: {},
    });
    expect(over.markdown).toContain(`More than ${ITEMS_PER_LABEL} Decision items`);
    expect(over.status).toBe('truncated');
  });

  it('reports a failed item read as unavailable', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => []),
      getItems: vi.fn(async () => {
        throw new Error('graph down');
      }),
    };
    const pack = await compileContextPack({ graph, stage: {} });
    expect(pack.markdown).toContain('Could not read Decision items');
    expect(pack.status).toBe('unavailable');
  });

  it('reports a failed artifact lookup as unavailable', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => {
        throw new Error('graph down');
      }),
      getItems: labelItems([]),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }] },
    });
    expect(pack.markdown).toContain('Could not read the requirements input artifacts');
    expect(pack.status).toBe('unavailable');
  });

  it('reports a failed TOC read as truncated', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async () => [
        { id: 'req-1', artifact_type: 'requirements', contentLength: 10 },
      ]),
      getItems: labelItems([]),
      getArtifactToc: vi.fn(async () => {
        throw new Error('graph down');
      }),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }] },
    });
    expect(pack.status).toBe('truncated');
  });

  it('reports an empty graph as a complete pack', async () => {
    const pack = await compileContextPack({ graph: graphOf([]), stage: {}, unit: { slug: 'a' } });
    expect(pack).toMatchObject({ status: 'ok', omitted: 0, items: 0, truncated: false });
    expect(pack.markdown).not.toContain('### Decisions');
    expect(pack.markdown).not.toContain('### Unit pack');
  });

  it('ends a budget-cut pack with a visible marker', async () => {
    const pack = await compileContextPack({
      graph: graphOf(many(40, 'Decision')),
      stage: {},
      budgetBytes: 400,
    });
    expect(pack.truncated).toBe(true);
    expect(pack.status).toBe('truncated');
    expect(pack.bytes).toBeLessThanOrEqual(400);
    expect(pack.markdown.endsWith('- … context truncated (get_items)')).toBe(true);
  });

  it('keeps every decision under the default budget and counts the unit items it cuts', async () => {
    const long = 'x'.repeat(180);
    const rows = [
      ...many(50, 'Decision', () => ({ title: 'Short decision' })),
      ...unitStories(50, (k) => ({ title: long, covers: `["requirement-${k}"]` })),
      ...many(50, 'Requirement', () => ({ title: long })),
      ...many(50, 'Contract', () => ({ title: long, provider: 'auth' })),
    ];
    const pack = await compileContextPack({
      graph: graphOf(rows),
      stage: {},
      unit: { slug: 'auth' },
    });
    expect(pack.truncated).toBe(true);
    expect(pack.markdown.match(/^- decision-/gm)).toHaveLength(50);
    const unitLines = pack.markdown.match(/^- (story|requirement|contract)-/gm) ?? [];
    expect(unitLines.length).toBeLessThan(150);
    expect(pack.omitted).toBe(150 - unitLines.length);
    expect(pack.status).toBe('truncated');
  });
});
