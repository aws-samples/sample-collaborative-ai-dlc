import { describe, it, expect, vi } from 'vitest';
import { compileContextPack, buildUnitPack, __test } from '../context-compiler.js';

describe('compileContextPack', () => {
  it('renders a bounded deterministic pack from graph artifacts and items', async () => {
    const graph = {
      lookupArtifacts: vi.fn(async ({ artifactType }) => [
        { id: `${artifactType}-1`, artifact_type: artifactType, title: 'Title', contentLength: 42 },
      ]),
      getItems: vi.fn(async () => [
        { id: 'story:i:s1', label: 'Story', slug: 's1', title: 'Login' },
      ]),
    };
    const pack = await compileContextPack({
      graph,
      stage: { inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'stories' }] },
      budgetBytes: 10_000,
    });
    expect(pack.markdown).toContain('## Compiled graph context');
    expect(pack.markdown).toContain('requirements (requirements-1)');
    expect(pack.markdown).toContain('Story s1');
    expect(pack.artifacts).toBe(2);
    expect(pack.items).toBe(1);
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
      getItems: vi.fn(async () => [
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
    // The unrelated contract stays out of the UNIT PACK (it still shows in the
    // full derived-items index below it).
    const unitPackSection = pack.markdown.slice(
      pack.markdown.indexOf('### Unit pack'),
      pack.markdown.indexOf('### Derived items'),
    );
    expect(unitPackSection).not.toContain('c-unrelated');
    // Non-lane runs get no unit section.
    const noUnit = await compileContextPack({ graph, stage: { inputArtifacts: [] } });
    expect(noUnit.markdown).not.toContain('### Unit pack');
  });
});

describe('buildUnitPack', () => {
  it('joins mapped stories and touched contracts for one unit', () => {
    const lines = buildUnitPack({
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
    const lines = buildUnitPack({
      unitSlug: 'auth',
      items: [{ label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: '["s-a","s-b"]' }],
    });
    expect(lines.join('\n')).toContain('ids: s-a, s-b (story items not derived yet)');
  });

  it('returns null with no unit or nothing relevant', () => {
    expect(buildUnitPack({ unitSlug: null, items: [] })).toBeNull();
    expect(buildUnitPack({ unitSlug: 'auth', items: [{ label: 'Story', slug: 's' }] })).toBeNull();
  });

  it('lists the requirements the unit satisfies — one COVERS hop from its stories', () => {
    const lines = buildUnitPack({
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
    const lines = buildUnitPack({
      unitSlug: 'auth',
      items: [
        { label: 'StoryMapEntry', slug: 'm', unit: 'auth', stories: '["s-login"]' },
        { label: 'Story', slug: 's-login', covers: '["req-elsewhere"]' },
      ],
    });
    expect(lines.join('\n')).toContain('- req-elsewhere');
  });
});

describe('traceSuffix (derived-item index traceability line)', () => {
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

  it('is empty for items without refs (index stays compact)', () => {
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
