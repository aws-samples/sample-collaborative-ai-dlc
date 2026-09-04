import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createGraphWriter, GraphWriteError, flattenValueMap } from '../mcp/graph-writer.js';
import { extractArtifactStructure } from '../../shared/artifact-extractors.js';
import { archiveArtifactsForStages } from '../../shared/artifact-versioning.js';

const PARTITION = 'agentcore-graph-writer';

// Gremlin anonymous-traversal statics for edge-existence assertions.
const anon = gremlin.process.statics;

const SCOPE = {
  projectId: 'proj-1',
  intentId: 'intent-1',
  executionId: 'exec-1',
  stageInstanceId: 'si-req',
};

let conn;
let g;
let writer;

// Seed the Intent anchor the writer hangs artifacts off (init-ws creates it in
// production; the writer requires it to exist).
const seedIntent = (id = SCOPE.intentId) =>
  g.addV('Intent').property('id', id).property('project_id', SCOPE.projectId).next();

beforeAll(async () => {
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
  let t = 0;
  writer = createGraphWriter({ g, scope: SCOPE, clock: () => `2026-01-01T00:00:0${t++}.000Z` });
});

// The Neptune entry-order regression (field incident): valueMap(true) returns
// the T.id token in DIFFERENT positions per provider. gremlin-server yields it
// FIRST (business `id` property overwrote it — masking the bug in every
// container test); Neptune can yield it LAST, where the old flatten clobbered
// the business id with the internal vertex UUID: every derive failed with
// "artifact not found" and the UI dropped all artifact↔artifact edges.
describe('flattenValueMap — token vs property precedence (Neptune order)', () => {
  const T_ID = { elementName: 'id' };
  const T_LABEL = { elementName: 'label' };

  it('business id survives regardless of token position', () => {
    // Neptune order: token AFTER the property.
    const neptune = new Map([
      ['id', ['stories-art']],
      ['title', ['Stories']],
      [T_ID, '4acf899d-d580-9c18-f791-df4ecf8a11a6'],
      [T_LABEL, 'Artifact'],
    ]);
    expect(flattenValueMap(neptune)).toMatchObject({ id: 'stories-art', label: 'Artifact' });
    // gremlin-server order: token BEFORE the property.
    const gserver = new Map([
      [T_ID, '4acf899d-d580-9c18-f791-df4ecf8a11a6'],
      [T_LABEL, 'Artifact'],
      ['id', ['stories-art']],
      ['title', ['Stories']],
    ]);
    expect(flattenValueMap(gserver)).toMatchObject({ id: 'stories-art', label: 'Artifact' });
  });

  it('tokens still fill gaps when no property claims the name (derived-item label)', () => {
    const row = new Map([
      ['slug', ['s-login']],
      [T_ID, 'internal-uuid'],
      [T_LABEL, 'Story'],
    ]);
    // No `id`/`label` property on the vertex → token values surface.
    expect(flattenValueMap(row)).toMatchObject({
      id: 'internal-uuid',
      label: 'Story',
      slug: 's-login',
    });
  });
});

describe('createGraphWriter — guards', () => {
  it('requires an intentId in scope', () => {
    expect(() => createGraphWriter({ g, scope: {} })).toThrow(/intentId/);
  });
});

describe('createArtifact', () => {
  it('fails when the Intent anchor does not exist', async () => {
    await expect(
      writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a1' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('creates an Artifact typed by name, stamped with provenance, anchored to the Intent', async () => {
    await seedIntent();
    const created = await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'a1',
      title: 'Requirements',
      content: '# reqs',
      props: { status: 'draft' },
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'a1',
      artifactType: 'requirements-analysis',
      created_at: expect.any(String),
      links: 0,
    });
    expect(created.content).toBeUndefined();

    const fetched = await writer.getArtifact({ id: 'a1' });
    expect(fetched).toMatchObject({
      id: 'a1',
      artifact_type: 'requirements-analysis',
      title: 'Requirements',
      status: 'draft',
      project_id: 'proj-1',
      created_by_stage_instance_id: 'si-req',
    });

    // Anchored Intent --CONTAINS--> Artifact.
    const anchored = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('CONTAINS')
      .has('Artifact', 'id', 'a1')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('drops caller-supplied reserved/provenance props (spoof-proof)', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'design',
      id: 'a2',
      props: { project_id: 'EVIL', created_by_execution_id: 'EVIL', legit: 'ok' },
    });
    const fetched = await writer.getArtifact({ id: 'a2' });
    expect(fetched.project_id).toBe('proj-1');
    expect(fetched.created_by_execution_id).toBe('exec-1');
    expect(fetched.legit).toBe('ok');
  });

  it('is idempotent on re-create (upsert by id), not duplicated', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'a3', title: 'v1' });
    await writer.createArtifact({ artifactType: 'design', id: 'a3', title: 'v2' });
    const count = await g.V().has('Artifact', 'id', 'a3').count().next();
    expect(count.value).toBe(1);
    expect((await writer.getArtifact({ id: 'a3' })).title).toBe('v2');
    const edges = await g.V().has('Intent', 'id', 'intent-1').outE('CONTAINS').count().next();
    expect(edges.value).toBe(1);
  });

  it('rejects a malformed structured YAML block and persists nothing', async () => {
    await seedIntent();
    // A value starting with an unquoted `"` breaks the block.
    const content = [
      '## Functional Requirements',
      '',
      '```yaml',
      'requirements:',
      '  - id: req-x',
      '    acceptance_criteria:',
      '      - "Retry" button is shown',
      '```',
    ].join('\n');
    await expect(
      writer.createArtifact({ artifactType: 'requirements', id: 'bad', content }),
    ).rejects.toThrow(/malformed `requirements` structured YAML block/);
    // Nothing was written.
    const exists = await g.V().has('Artifact', 'id', 'bad').hasNext();
    expect(exists).toBe(false);
  });

  it('accepts a well-formed structured block (quoted value)', async () => {
    await seedIntent();
    const content = [
      '## Functional Requirements',
      '',
      '```yaml',
      'requirements:',
      '  - id: req-x',
      '    title: Retry works',
      '    acceptance_criteria:',
      '      - \'"Retry" button is shown\'',
      '```',
    ].join('\n');
    const created = await writer.createArtifact({
      artifactType: 'requirements',
      id: 'ok',
      content,
    });
    expect(created.id).toBe('ok');
    expect(await g.V().has('Artifact', 'id', 'ok').hasNext()).toBe(true);
  });

  it('does not gate unregistered artifact types on YAML (no structured block)', async () => {
    await seedIntent();
    // `design` is not in the extraction registry — a stray broken fence must not block it.
    const content = '```yaml\nnot: [valid';
    const created = await writer.createArtifact({ artifactType: 'design', id: 'free', content });
    expect(created.id).toBe('free');
  });

  it('wires links to existing artifacts in the same call', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'req' });
    await writer.createArtifact({
      artifactType: 'user-stories',
      id: 'us',
      links: [{ toId: 'req', edge: 'DERIVED_FROM' }],
    });
    const neighbors = await writer.getNeighbors({
      id: 'us',
      edge: 'DERIVED_FROM',
      direction: 'out',
    });
    expect(neighbors.map((n) => n.id)).toEqual(['req']);
  });
});

describe('recordPullRequest', () => {
  it('fails when the Intent anchor does not exist', async () => {
    await expect(writer.recordPullRequest({ repoId: 'owner/repo' })).rejects.toBeInstanceOf(
      GraphWriteError,
    );
  });

  it('creates a PullRequest anchored Intent --HAS_PR--> PullRequest, stamped', async () => {
    await seedIntent();
    const res = await writer.recordPullRequest({
      repoId: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/7',
      prNumber: 7,
      branch: 'aidlc/intent-1',
      baseBranch: 'main',
    });
    expect(res).toEqual({
      id: 'pr:intent-1:owner/repo',
      repoId: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/7',
      prNumber: '7',
    });

    const anchored = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('HAS_PR')
      .has('PullRequest', 'id', 'pr:intent-1:owner/repo')
      .valueMap(true)
      .next();
    const vm = flattenValueMap(anchored.value);
    expect(vm).toMatchObject({
      id: 'pr:intent-1:owner/repo',
      repository: 'owner/repo',
      pr_url: 'https://github.com/owner/repo/pull/7',
      pr_number: '7',
      branch: 'aidlc/intent-1',
      base_branch: 'main',
      intent_id: 'intent-1',
      project_id: 'proj-1',
    });
  });

  it('stores an empty base_branch when the base was not resolved', async () => {
    await seedIntent();
    await writer.recordPullRequest({
      repoId: 'owner/repo',
      prUrl: 'https://example/pr/1',
      prNumber: 1,
      branch: 'b',
      baseBranch: null,
    });
    const vm = flattenValueMap(
      (await g.V().has('PullRequest', 'id', 'pr:intent-1:owner/repo').valueMap(true).next()).value,
    );
    expect(vm.base_branch).toBe('');
  });

  it('is idempotent per (intent, repo): re-record upserts, no duplicate', async () => {
    await seedIntent();
    await writer.recordPullRequest({ repoId: 'owner/repo', prUrl: 'u1', prNumber: 1, branch: 'b' });
    await writer.recordPullRequest({ repoId: 'owner/repo', prUrl: 'u2', prNumber: 2, branch: 'b' });
    const count = await g.V().hasLabel('PullRequest').count().next();
    expect(count.value).toBe(1);
    const vm = flattenValueMap(
      (await g.V().has('PullRequest', 'id', 'pr:intent-1:owner/repo').valueMap(true).next()).value,
    );
    expect(vm.pr_url).toBe('u2');
    expect(vm.pr_number).toBe('2');
  });

  it('records one PullRequest per repo (multi-repo)', async () => {
    await seedIntent();
    await writer.recordPullRequest({ repoId: 'owner/api', prUrl: 'ua', prNumber: 1, branch: 'b' });
    await writer.recordPullRequest({ repoId: 'owner/web', prUrl: 'uw', prNumber: 1, branch: 'b' });
    const ids = (
      await g.V().has('Intent', 'id', 'intent-1').out('HAS_PR').values('id').toList()
    ).toSorted();
    expect(ids).toEqual(['pr:intent-1:owner/api', 'pr:intent-1:owner/web']);
  });
});

describe('recordUnitPullRequest', () => {
  it('uses a distinct section/unit/repository/provider/number identity and edge', async () => {
    await seedIntent();
    const result = await writer.recordUnitPullRequest({
      sectionIndex: 2,
      unitSlug: 'auth',
      repoId: 'owner/api',
      provider: 'github',
      prUrl: 'https://github.com/owner/api/pull/7',
      prNumber: 7,
      sourceBranch: 'aidlc/intent-1--s2-unit-auth',
      targetBranch: 'aidlc/intent-1',
      headSha: 'abc123',
      state: 'DRAFT',
    });
    const id = 'unit-pr:intent-1:s2:auth:owner/api:github:7';
    expect(result.id).toBe(id);
    const vertex = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('HAS_UNIT_PR')
      .has('UnitPullRequest', 'id', id)
      .valueMap(true)
      .next();
    expect(flattenValueMap(vertex.value)).toMatchObject({
      id,
      section_index: '2',
      unit_slug: 'auth',
      repository: 'owner/api',
      provider: 'github',
      pr_number: '7',
      source_branch: 'aidlc/intent-1--s2-unit-auth',
      target_branch: 'aidlc/intent-1',
      head_sha: 'abc123',
      state: 'DRAFT',
    });
  });
});

describe('linkArtifacts', () => {
  beforeEach(async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'a', id: 'x' });
    await writer.createArtifact({ artifactType: 'b', id: 'y' });
  });

  it('rejects a non-allowlisted edge', async () => {
    await expect(
      writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'HACKS' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('creates an allowlisted edge and is idempotent', async () => {
    await writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'PRODUCES' });
    await writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'PRODUCES' });
    const count = await g.V().has('Artifact', 'id', 'x').outE('PRODUCES').count().next();
    expect(count.value).toBe(1);
  });

  it('rejects a link to a missing artifact', async () => {
    await expect(
      writer.linkArtifacts({ fromId: 'x', toId: 'ghost', edge: 'PRODUCES' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'r1',
      title: 'Auth requirements',
      content: 'login',
    });
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'r2',
      title: 'Billing',
    });
    await writer.createArtifact({ artifactType: 'design', id: 'd1', title: 'Auth design' });
  });

  it('lookupArtifacts filters by type within the intent', async () => {
    const reqs = await writer.lookupArtifacts({ artifactType: 'requirements-analysis' });
    expect(reqs.map((a) => a.id).toSorted()).toEqual(['r1', 'r2']);
    expect(reqs.find((a) => a.id === 'r1').content).toBeUndefined();
    expect(reqs.find((a) => a.id === 'r1').contentLength).toBe(5);

    const withContent = await writer.lookupArtifacts({
      artifactType: 'requirements-analysis',
      includeContent: true,
    });
    expect(withContent.find((a) => a.id === 'r1').content).toBe('login');
  });

  it('getIntentGraph returns every contained artifact', async () => {
    const all = await writer.getIntentGraph();
    expect(all.map((a) => a.id).toSorted()).toEqual(['d1', 'r1', 'r2']);
    expect(all.every((a) => a.content === undefined)).toBe(true);
  });

  it('searchGraph matches title/content substrings, optionally by type', async () => {
    const hits = await writer.searchGraph({ query: 'auth' });
    expect(hits.map((a) => a.id).toSorted()).toEqual(['d1', 'r1']);
    expect(hits.every((a) => a.content === undefined && typeof a.snippet === 'string')).toBe(true);
    const typed = await writer.searchGraph({ query: 'auth', artifactType: 'design' });
    expect(typed.map((a) => a.id)).toEqual(['d1']);
  });

  it('searchGraph matches enrichment summaries (gist/claims wording)', async () => {
    await writer.applyArtifactEnrichment({
      artifactId: 'r2',
      gist: 'Invoicing and payment reconciliation requirements.',
      claims: ['Monthly statements are mandatory'],
      model: 'm',
      sourceHash: 'h',
    });
    // 'reconciliation' appears ONLY in the gist, 'statements' only in a claim.
    expect((await writer.searchGraph({ query: 'reconciliation' })).map((a) => a.id)).toEqual([
      'r2',
    ]);
    expect((await writer.searchGraph({ query: 'statements' })).map((a) => a.id)).toEqual(['r2']);
  });

  it('getArtifact supports full, summary, and toc modes', async () => {
    const full = await writer.getArtifact({ id: 'r1' });
    expect(full.content).toBe('login');
    const summary = await writer.getArtifact({ id: 'r1', mode: 'summary' });
    expect(summary.content).toBeUndefined();
    expect(summary.contentLength).toBe(5);
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'r3',
      content: '# Title\n\n## A\nBody\n### A.1\nMore',
    });
    const toc = await writer.getArtifact({ id: 'r3', mode: 'toc' });
    expect(toc.content).toBeUndefined();
    expect(toc.headings.map((h) => h.heading)).toEqual(['Title', 'A', 'A.1']);
  });

  it('mirrors derived sections, typed items, and citation edges from artifact content', async () => {
    await writer.createArtifact({ artifactType: 'requirements', id: 'req-art', title: 'Reqs' });
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'stories-art',
      title: 'Stories',
      content: [
        '## Stories',
        'References [[requirements]].',
        '',
        '```yaml',
        'stories:',
        '  - id: story-login',
        '    title: Login',
        '    persona: Admin',
        '    priority: Must Have',
        '    covers: [req-auth]',
        '```',
      ].join('\n'),
    });
    const artifact = await writer.getArtifact({ id: 'stories-art' });
    const extraction = extractArtifactStructure({
      artifactType: artifact.artifact_type,
      artifactId: artifact.id,
      content: artifact.content,
    });
    const mirrored = await writer.mirrorArtifactDerivations({ artifact, extraction });
    expect(mirrored).toMatchObject({
      artifactId: 'stories-art',
      sections: 1,
      items: 1,
      citations: 1,
    });

    const toc = await writer.getArtifactToc({ id: 'stories-art' });
    expect(toc).toHaveLength(1);
    expect(toc[0]).toMatchObject({ heading: 'Stories', slug: 'stories' });
    expect(toc[0].content).toBeUndefined();

    const section = await writer.getSection({ artifactId: 'stories-art', slug: 'stories' });
    expect(section.content).toContain('References [[requirements]]');
    const items = await writer.getItems({ itemType: 'Story' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ slug: 'story-login', title: 'Login', persona: 'Admin' });
    expect(items[0].content).toBeUndefined();

    const cites = await g
      .V()
      .has('Artifact', 'id', 'stories-art')
      .out('CITES')
      .has('Artifact', 'id', 'req-art')
      .hasNext();
    expect(cites).toBe(true);
  });

  it('updateArtifact patches props and errors on a missing artifact', async () => {
    await writer.updateArtifact({ id: 'r1', props: { status: 'final' } });
    expect((await writer.getArtifact({ id: 'r1' })).status).toBe('final');
    await expect(writer.updateArtifact({ id: 'nope', props: {} })).rejects.toBeInstanceOf(
      GraphWriteError,
    );
  });

  it('applyArtifactEnrichment writes summary props only — visible in compact reads', async () => {
    await writer.applyArtifactEnrichment({
      artifactId: 'r1',
      gist: 'Login requirements for the auth flow.',
      claims: ['Users must log in', 'MFA is required'],
      model: 'us.anthropic.claude-haiku-4-5',
      sourceHash: 'hash-1',
    });
    // Compact reads carry the gist for orientation; content stays behind full reads.
    const compact = await writer.getArtifact({ id: 'r1', mode: 'summary' });
    expect(compact.summary_gist).toBe('Login requirements for the auth flow.');
    expect(JSON.parse(compact.summary_claims)).toEqual(['Users must log in', 'MFA is required']);
    expect(compact.enrichment_source_hash).toBe('hash-1');
    expect(compact.enrichment_model).toBe('us.anthropic.claude-haiku-4-5');
    expect(compact.enriched_at).toBeTruthy();
    expect(compact.content).toBeUndefined();
    // Full content is untouched.
    expect((await writer.getArtifact({ id: 'r1' })).content).toBe('login');
    // Missing artifact errors (the derive command treats it fail-open).
    await expect(
      writer.applyArtifactEnrichment({ artifactId: 'nope', gist: 'x' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('getCoverage joins requirements/stories/mappings/contracts with integrity findings', async () => {
    const mirror = async (artifactType, id, content) => {
      await writer.createArtifact({ artifactType, id, content });
      const artifact = await writer.getArtifact({ id });
      await writer.mirrorArtifactDerivations({
        artifact,
        extraction: extractArtifactStructure({ artifactType, artifactId: id, content }),
      });
    };
    await mirror(
      'requirements',
      'req-art',
      [
        '## Reqs',
        '```yaml',
        'requirements:',
        '  - id: req-login',
        '    title: Login',
        '    priority: must-have',
        '  - id: req-report',
        '    title: Reporting',
        '    priority: must-have',
        '  - id: req-theme',
        '    title: Theming',
        '    priority: could-have',
        '```',
      ].join('\n'),
    );
    await mirror(
      'stories',
      'story-art',
      [
        '## Stories',
        '```yaml',
        'stories:',
        '  - id: s-login',
        '    title: Login story',
        '    covers: [req-login, req-ghost]',
        '  - id: s-float',
        '    title: Unmapped story',
        '```',
      ].join('\n'),
    );
    await mirror(
      'unit-of-work-story-map',
      'map-art',
      [
        '## Map',
        '```yaml',
        'mappings:',
        '  - id: map-auth',
        '    unit: auth',
        '    stories: [s-login, s-missing]',
        '```',
      ].join('\n'),
    );
    await mirror(
      'unit-of-work-dependency',
      'dep-art',
      [
        '## Contracts',
        '```yaml',
        'contracts:',
        '  - id: c-auth-api',
        '    title: Auth API',
        '    provider: auth',
        '    consumers: [billing]',
        '```',
      ].join('\n'),
    );

    const cov = await writer.getCoverage();
    expect(cov.counts).toMatchObject({ requirements: 3, stories: 2, mappings: 1, contracts: 1 });
    // req-login covered; req-report (must-have) + req-theme (could-have) uncovered.
    expect(cov.uncoveredRequirements.map((r) => r.slug).toSorted()).toEqual([
      'req-report',
      'req-theme',
    ]);
    expect(cov.uncoveredMustHave.map((r) => r.slug)).toEqual(['req-report']);
    // s-float is not in any mapping.
    expect(cov.unmappedStories.map((s) => s.slug)).toEqual(['s-float']);
    // Integrity: a covers→unknown requirement and a mapping→unknown story.
    expect(cov.unknownReferences).toEqual(
      expect.arrayContaining([
        { kind: 'story-covers-unknown-requirement', from: 's-login', ref: 'req-ghost' },
        { kind: 'mapping-references-unknown-story', from: 'map-auth', ref: 's-missing' },
      ]),
    );

    // Lane view: auth's stories + contracts.
    const lane = await writer.getCoverage({ unitSlug: 'auth' });
    expect(lane.unit.stories.map((s) => s.slug)).toEqual(['s-login']);
    expect(lane.unit.storyIds).toEqual(['s-login', 's-missing']);
    expect(lane.unit.contracts).toEqual([
      {
        slug: 'c-auth-api',
        title: 'Auth API',
        role: 'provides',
        provider: 'auth',
        consumers: ['billing'],
      },
    ]);
    const consumerLane = await writer.getCoverage({ unitSlug: 'billing' });
    expect(consumerLane.unit.contracts[0].role).toBe('consumes');
  });
});

describe('team knowledge (project-scoped, cross-intent)', () => {
  it('records a TeamKnowledge vertex anchored to the Project, stamped with provenance', async () => {
    const created = await writer.recordTeamKnowledge({
      id: 'naming-conv',
      title: 'Naming convention',
      content: 'kebab-case ids',
      agentRef: 'aidlc-product-agent',
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'naming-conv',
      agentRef: 'aidlc-product-agent',
      created_at: expect.any(String),
    });
    expect(created.content).toBeUndefined();
    // The full provenance is persisted (read it back to verify).
    const persisted = (await writer.getTeamKnowledge()).find((r) => r.id === 'naming-conv');
    expect(persisted).toMatchObject({
      tier: 'team',
      agent_ref: 'aidlc-product-agent',
      project_id: 'proj-1',
      created_by_intent_id: 'intent-1',
      created_by_stage_instance_id: 'si-req',
    });
    // Anchored Project --HAS_KNOWLEDGE--> TeamKnowledge.
    const anchored = await g
      .V()
      .has('Project', 'id', 'proj-1')
      .out('HAS_KNOWLEDGE')
      .has('TeamKnowledge', 'id', 'naming-conv')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('upserts by id (a later run updates, not duplicates) and keeps one anchor edge', async () => {
    await writer.recordTeamKnowledge({ id: 'k', content: 'v1' });
    await writer.recordTeamKnowledge({ id: 'k', content: 'v2' });
    const count = await g.V().has('TeamKnowledge', 'id', 'k').count().next();
    expect(count.value).toBe(1);
    const edges = await g.V().has('Project', 'id', 'proj-1').outE('HAS_KNOWLEDGE').count().next();
    expect(edges.value).toBe(1);
    const rows = await writer.getTeamKnowledge();
    expect(rows.find((r) => r.id === 'k').content).toBe('v2');
  });

  it('drops caller-supplied provenance props (spoof-proof)', async () => {
    await writer.recordTeamKnowledge({
      id: 'k2',
      content: 'x',
      props: { project_id: 'EVIL', created_by_intent_id: 'EVIL', legit: 'ok' },
    });
    const persisted = (await writer.getTeamKnowledge()).find((r) => r.id === 'k2');
    expect(persisted.project_id).toBe('proj-1');
    expect(persisted.created_by_intent_id).toBe('intent-1');
    expect(persisted.legit).toBe('ok');
  });

  it('getTeamKnowledge filters to one agent plus the shared corpus', async () => {
    await writer.recordTeamKnowledge({ id: 'shared-1', content: 'a', agentRef: 'shared' });
    await writer.recordTeamKnowledge({
      id: 'prod-1',
      content: 'b',
      agentRef: 'aidlc-product-agent',
    });
    await writer.recordTeamKnowledge({ id: 'arch-1', content: 'c', agentRef: 'aidlc-arch-agent' });
    const forProduct = await writer.getTeamKnowledge({ agentRef: 'aidlc-product-agent' });
    expect(forProduct.map((r) => r.id).toSorted()).toEqual(['prod-1', 'shared-1']);
  });

  it('returns [] when the Project has no knowledge yet', async () => {
    expect(await writer.getTeamKnowledge()).toEqual([]);
  });
});

describe('learning rules (project-scoped guardrails)', () => {
  it('records a LearningRule vertex anchored to the Project, stamped + layered', async () => {
    const created = await writer.recordLearningRule({
      id: 'no-secrets',
      title: 'No plaintext secrets',
      content: 'NEVER store secrets in plaintext config',
      layer: 'project-learnings',
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'no-secrets',
      layer: 'project-learnings',
      created_at: expect.any(String),
    });
    expect(created.content).toBeUndefined();
    const persisted = (await writer.getLearningRules()).find((r) => r.id === 'no-secrets');
    expect(persisted).toMatchObject({
      pairing: 'feedforward-only',
      project_id: 'proj-1',
      created_by_intent_id: 'intent-1',
    });
    const anchored = await g
      .V()
      .has('Project', 'id', 'proj-1')
      .out('HAS_LEARNING')
      .has('LearningRule', 'id', 'no-secrets')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('rejects a layer outside the two learnings tiers', async () => {
    await expect(
      writer.recordLearningRule({ id: 'x', content: 'c', layer: 'org' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('upserts by id and keeps one anchor edge', async () => {
    await writer.recordLearningRule({ id: 'r', content: 'v1', layer: 'team-learnings' });
    await writer.recordLearningRule({ id: 'r', content: 'v2', layer: 'project-learnings' });
    const count = await g.V().has('LearningRule', 'id', 'r').count().next();
    expect(count.value).toBe(1);
    const edges = await g.V().has('Project', 'id', 'proj-1').outE('HAS_LEARNING').count().next();
    expect(edges.value).toBe(1);
    const rows = await writer.getLearningRules();
    const r = rows.find((x) => x.id === 'r');
    expect(r.content).toBe('v2');
    expect(r.layer).toBe('project-learnings');
  });

  it('getLearningRules returns [] when the Project has none', async () => {
    expect(await writer.getLearningRules()).toEqual([]);
  });
});

describe('recordQuestion', () => {
  it('creates a Question vertex anchored to the Intent', async () => {
    await seedIntent();
    await writer.recordQuestion({ questionId: 'q1', questionsJson: '[{"text":"?"}]' });
    const anchored = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('CONTAINS')
      .has('Question', 'id', 'q1')
      .hasNext();
    expect(anchored).toBe(true);
    const question = await g.V().has('Question', 'id', 'q1').valueMap().next();
    expect(question.value.get('stage_instance_id')[0]).toBe('si-req');
  });

  it('links answered same-stage questions to created and updated artifacts', async () => {
    await seedIntent();
    await writer.recordQuestion({ questionId: 'q1', questionsJson: '[{"text":"?"}]' });
    await g.V().has('Question', 'id', 'q1').property('answered_at', '2026-01-01T00:00:00Z').next();

    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a1' });
    expect(
      await g.V().has('Question', 'id', 'q1').out('INFLUENCES').has('id', 'a1').hasNext(),
    ).toBe(true);

    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a2' });
    await writer.updateArtifact({ id: 'a2', props: { status: 'revised' } });
    expect(
      await g.V().has('Question', 'id', 'q1').out('INFLUENCES').has('id', 'a2').hasNext(),
    ).toBe(true);
  });
});

// ── Steering (docs/v2-steering.md) ──

describe('rewind supersede lifecycle', () => {
  const markSuperseded = (id) =>
    g
      .V()
      .has('Artifact', 'id', id)
      .property('superseded_at', '2026-01-01T00:00:00.000Z')
      .property('superseded_by', 'st-1')
      .next();

  it('update_artifact rehabilitates a superseded artifact (marker cleared)', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'a1', title: 'Design' });
    await markSuperseded('a1');
    await writer.updateArtifact({ id: 'a1', props: { note: 'redone' } });
    const fetched = await writer.getArtifact({ id: 'a1' });
    expect(fetched.superseded_at).toBeUndefined();
    expect(fetched.superseded_by).toBeUndefined();
    expect(fetched.note).toBe('redone');
  });

  it('re-creating a superseded artifact rehabilitates it too', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'a1' });
    await markSuperseded('a1');
    await writer.createArtifact({ artifactType: 'design', id: 'a1', content: 'v2' });
    const fetched = await writer.getArtifact({ id: 'a1' });
    expect(fetched.superseded_at).toBeUndefined();
    expect(fetched.content).toBe('v2');
  });

  it('agents cannot spoof the supersede marker via props', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'design',
      id: 'a1',
      props: { superseded_at: 'EVIL', superseded_by: 'EVIL' },
    });
    const fetched = await writer.getArtifact({ id: 'a1' });
    expect(fetched.superseded_at).toBeUndefined();
    expect(fetched.superseded_by).toBeUndefined();
  });

  it('superseded artifacts vanish from list/search/neighbor reads (explicit-id read still works)', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'design',
      id: 'a1',
      title: 'Old auth',
      content: 'auth v1',
    });
    await writer.createArtifact({
      artifactType: 'design',
      id: 'a2',
      title: 'New auth',
      content: 'auth v2',
    });
    await writer.linkArtifacts({ fromId: 'a2', toId: 'a1', edge: 'DERIVED_FROM' });
    await markSuperseded('a1');

    expect((await writer.lookupArtifacts({ artifactType: 'design' })).map((a) => a.id)).toEqual([
      'a2',
    ]);
    expect((await writer.getIntentGraph()).map((a) => a.id)).toEqual(['a2']);
    expect((await writer.searchGraph({ query: 'auth' })).map((a) => a.id)).toEqual(['a2']);
    expect((await writer.getNeighbors({ id: 'a2' })).map((a) => a.id)).toEqual([]);
    // Opt-in for audit/derive consumers.
    expect(
      (await writer.getIntentGraph({ includeSuperseded: true })).map((a) => a.id).toSorted(),
    ).toEqual(['a1', 'a2']);
    // Explicit-id needle read may still target history.
    expect((await writer.getArtifact({ id: 'a1' })).superseded_at).toBeTruthy();
  });

  it('re-derive supersedes removed sections/items and reads hide them', async () => {
    await seedIntent();
    const content = (bodies) =>
      [
        ...bodies.map((b) => `## ${b}\ntext`),
        '',
        '```yaml',
        'stories:',
        ...bodies.map((b) => `  - id: s-${b.toLowerCase()}\n    title: ${b}`),
        '```',
      ].join('\n');
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'st-art',
      content: content(['One', 'Two']),
    });
    const mirror = async () => {
      const artifact = await writer.getArtifact({ id: 'st-art' });
      const extraction = extractArtifactStructure({
        artifactType: 'stories',
        artifactId: 'st-art',
        content: artifact.content,
      });
      return writer.mirrorArtifactDerivations({ artifact, extraction });
    };
    await mirror();
    expect((await writer.getArtifactToc({ id: 'st-art' })).map((s) => s.slug).toSorted()).toEqual([
      'one',
      'two',
    ]);
    expect((await writer.getItems({ itemType: 'Story' })).map((i) => i.slug).toSorted()).toEqual([
      's-one',
      's-two',
    ]);

    // Section/story "Two" removed in v2 → re-derive marks its rows superseded.
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'st-art',
      content: content(['One']),
    });
    const second = await mirror();
    expect(second.superseded).toBe(2);
    expect((await writer.getArtifactToc({ id: 'st-art' })).map((s) => s.slug)).toEqual(['one']);
    expect(await writer.getSection({ artifactId: 'st-art', slug: 'two' })).toBeNull();
    expect((await writer.getItems({ itemType: 'Story' })).map((i) => i.slug)).toEqual(['s-one']);
  });

  it('supersedeDerivationsForArtifacts sweeps orphaned derivations; getItems drops superseded parents', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'old-art',
      content: ['## S', '```yaml', 'stories:', '  - id: s-old', '    title: Old', '```'].join('\n'),
    });
    const artifact = await writer.getArtifact({ id: 'old-art' });
    await writer.mirrorArtifactDerivations({
      artifact,
      extraction: extractArtifactStructure({
        artifactType: 'stories',
        artifactId: 'old-art',
        content: artifact.content,
      }),
    });
    await markSuperseded('old-art');
    // Rewind superseded the ARTIFACT but no re-derive ran: the item row itself
    // is still current — getItems must already hide it via the parent filter.
    expect(await writer.getItems({ itemType: 'Story' })).toEqual([]);
    // The sweep then marks the derived rows themselves.
    const swept = await writer.supersedeDerivationsForArtifacts({ artifactIds: ['old-art'] });
    expect(swept.superseded).toBe(2); // 1 section + 1 item
    // Idempotent: nothing left to sweep.
    expect(
      (await writer.supersedeDerivationsForArtifacts({ artifactIds: ['old-art'] })).superseded,
    ).toBe(0);
    expect(await writer.getArtifactToc({ id: 'old-art' })).toEqual([]);
  });
});

describe('restart artifact versions', () => {
  const archiveStage = (reason = 'Retry from requirements') =>
    archiveArtifactsForStages({
      g,
      intentId: SCOPE.intentId,
      stageInstanceIds: [SCOPE.stageInstanceId],
      restartId: 'restart-1',
      reason,
      actor: 'Ada',
      clock: () => '2026-01-02T00:00:00.000Z',
    });

  it('same-id rerun keeps one head, archives immutable content, and increments once', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'design',
      id: 'design-head',
      title: 'Design v1',
      content: 'old content',
    });

    await archiveStage();
    await archiveStage(); // replay-safe: deterministic version id + edge
    const rerun = createGraphWriter({
      g,
      scope: { ...SCOPE, stageAttempt: 1 },
      clock: () => '2026-01-03T00:00:00.000Z',
    });
    await rerun.createArtifact({
      artifactType: 'design',
      id: 'design-head',
      title: 'Design v2',
      content: 'new content',
    });
    await rerun.createArtifact({
      artifactType: 'design',
      id: 'design-head',
      title: 'Design v2 final',
      content: 'new content final',
    });

    expect((await g.V().hasLabel('Artifact').has('id', 'design-head').count().next()).value).toBe(
      1,
    );
    expect(await rerun.getArtifact({ id: 'design-head' })).toMatchObject({
      content: 'new content final',
      generation: 2,
      stage_attempt: 1,
    });
    const versions = await g
      .V()
      .has('Artifact', 'id', 'design-head')
      .out('HAS_VERSION')
      .valueMap(true)
      .toList();
    expect(versions).toHaveLength(1);
    expect(flattenValueMap(versions[0])).toMatchObject({
      id: 'design-head:v1',
      artifact_id: 'design-head',
      generation: 1,
      content: 'old content',
      restart_id: 'restart-1',
      restart_reason: 'Retry from requirements',
      archived_by: 'Ada',
    });
  });

  it('different-id rerun returns the canonical id, records an alias, and keeps relationship history', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'requirements',
      id: 'reqs',
      content: 'requirements',
    });
    await writer.createArtifact({
      artifactType: 'design',
      id: 'design-head',
      content: 'old design',
      links: [{ toId: 'reqs', edge: 'DERIVED_FROM' }],
    });

    await archiveStage('Rewind to design');
    const rerun = createGraphWriter({
      g,
      scope: { ...SCOPE, stageAttempt: 1 },
      clock: () => '2026-01-03T00:00:00.000Z',
    });
    const result = await rerun.createArtifact({
      artifactType: 'design',
      id: 'agent-new-id',
      content: 'new design',
    });

    expect(result.id).toBe('design-head');
    expect(await rerun.getArtifact({ id: 'agent-new-id' })).toMatchObject({
      id: 'design-head',
      content: 'new design',
      generation: 2,
    });
    const head = await rerun.getArtifact({ id: 'design-head' });
    expect(JSON.parse(head.artifact_aliases)).toEqual(['agent-new-id']);
    expect(await g.V().has('Artifact', 'id', 'design-head').outE('DERIVED_FROM').hasNext()).toBe(
      false,
    );
    const version = flattenValueMap(
      (await g.V().has('Artifact', 'id', 'design-head').out('HAS_VERSION').valueMap(true).next())
        .value,
    );
    expect(JSON.parse(version.relationships)).toContainEqual({
      direction: 'out',
      edge: 'DERIVED_FROM',
      artifactId: 'reqs',
    });
  });

  it('archives every derived projection and keeps prior edit metadata only on the version', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'stories',
      id: 'stories-head',
      content: [
        '## First',
        '```yaml',
        'stories:',
        '  - id: first',
        '    title: First',
        '```',
        '## Second',
        '```yaml',
        'stories:',
        '  - id: second',
        '    title: Second',
        '```',
      ].join('\n'),
    });
    const artifact = await writer.getArtifact({ id: 'stories-head' });
    await writer.mirrorArtifactDerivations({
      artifact,
      extraction: extractArtifactStructure({
        artifactType: 'stories',
        artifactId: 'stories-head',
        content: artifact.content,
      }),
    });
    await g
      .V()
      .has('Artifact', 'id', 'stories-head')
      .property('edited_by', 'u-1')
      .property('edited_by_name', 'Ada')
      .property('edited_at', '2026-01-01T12:00:00.000Z')
      .property('edit_origin', 'human')
      .property('verified_by', 'u-2')
      .property('verified_at', '2026-01-01T13:00:00.000Z')
      .next();

    await archiveStage();
    const projections = await g
      .V()
      .has('Artifact', 'id', 'stories-head')
      .out('HAS_SECTION', 'HAS_ITEM')
      .valueMap(true)
      .toList();
    expect(projections.length).toBeGreaterThan(1);
    expect(projections.map(flattenValueMap).every((row) => row.superseded_at)).toBe(true);

    const rerun = createGraphWriter({
      g,
      scope: { ...SCOPE, stageAttempt: 1 },
      clock: () => '2026-01-03T00:00:00.000Z',
    });
    await rerun.createArtifact({
      artifactType: 'stories',
      id: 'stories-head',
      content: '## Replacement',
    });

    expect(await rerun.getArtifact({ id: 'stories-head' })).not.toMatchObject({
      edited_by: expect.anything(),
      verified_by: expect.anything(),
    });
    const version = flattenValueMap(
      (await g.V().has('Artifact', 'id', 'stories-head').out('HAS_VERSION').valueMap(true).next())
        .value,
    );
    expect(version).toMatchObject({
      edited_by: 'u-1',
      edited_by_name: 'Ada',
      edit_origin: 'human',
      verified_by: 'u-2',
    });
  });

  it('rejects a rerun alias already owned by another logical artifact', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'design-head', content: 'v1' });
    await writer.createArtifact({ artifactType: 'requirements', id: 'taken', content: 'reqs' });
    await archiveStage();
    const rerun = createGraphWriter({
      g,
      scope: { ...SCOPE, stageAttempt: 1 },
      clock: () => '2026-01-03T00:00:00.000Z',
    });

    await expect(
      rerun.createArtifact({ artifactType: 'design', id: 'taken', content: 'v2' }),
    ).rejects.toThrow(/alias "taken" already belongs/);
  });

  it('isolates identical ids and types in separate unit lanes', async () => {
    await seedIntent();
    const auth = createGraphWriter({
      g,
      scope: {
        ...SCOPE,
        stageInstanceId: 'si-code-auth',
        sectionIndex: 1,
        unitSlug: 'auth',
      },
    });
    const billing = createGraphWriter({
      g,
      scope: {
        ...SCOPE,
        stageInstanceId: 'si-code-billing',
        sectionIndex: 1,
        unitSlug: 'billing',
      },
    });
    await auth.createArtifact({ artifactType: 'code-design', id: 'design', content: 'auth' });
    await billing.createArtifact({ artifactType: 'code-design', id: 'design', content: 'billing' });

    expect((await g.V().has('Artifact', 'id', 'design').count().next()).value).toBe(2);
    expect((await auth.getArtifact({ id: 'design' })).content).toBe('auth');
    expect((await billing.getArtifact({ id: 'design' })).content).toBe('billing');
  });

  it('lazily exposes only the newest legacy head in context, lookup, and search', async () => {
    await seedIntent();
    const seedLegacy = async (id, createdAt, content) => {
      await g
        .addV('Artifact')
        .property('id', id)
        .property('intent_id', SCOPE.intentId)
        .property('artifact_type', 'design')
        .property('created_by_stage_instance_id', SCOPE.stageInstanceId)
        .property('created_at', createdAt)
        .property('content', content)
        .as('a')
        .V()
        .has('Intent', 'id', SCOPE.intentId)
        .addE('CONTAINS')
        .to('a')
        .next();
    };
    await seedLegacy('legacy-old', '2026-01-01T00:00:00.000Z', 'old searchable content');
    await seedLegacy('legacy-new', '2026-01-02T00:00:00.000Z', 'new searchable content');

    expect((await writer.lookupArtifacts({ artifactType: 'design' })).map((row) => row.id)).toEqual(
      ['legacy-new'],
    );
    expect((await writer.getIntentGraph()).map((row) => row.id)).toEqual(['legacy-new']);
    expect((await writer.searchGraph({ query: 'searchable' })).map((row) => row.id)).toEqual([
      'legacy-new',
    ]);
    expect(await writer.getArtifact({ id: 'legacy-old' })).toMatchObject({
      id: 'legacy-new',
      content: 'new searchable content',
    });
  });

  it('rehabilitates the canonical legacy head when a rerun supplies an older sibling id', async () => {
    await seedIntent();
    const seedLegacy = async (id, createdAt, content) => {
      await g
        .addV('Artifact')
        .property('id', id)
        .property('intent_id', SCOPE.intentId)
        .property('artifact_type', 'design')
        .property('created_by_stage_instance_id', SCOPE.stageInstanceId)
        .property('created_at', createdAt)
        .property('content', content)
        .as('a')
        .V()
        .has('Intent', 'id', SCOPE.intentId)
        .addE('CONTAINS')
        .to('a')
        .next();
    };
    await seedLegacy('legacy-old', '2026-01-01T00:00:00.000Z', 'old');
    await seedLegacy('legacy-new', '2026-01-02T00:00:00.000Z', 'new');
    await archiveStage();

    const rerun = createGraphWriter({
      g,
      scope: { ...SCOPE, stageAttempt: 1 },
      clock: () => '2026-01-03T00:00:00.000Z',
    });
    const result = await rerun.createArtifact({
      artifactType: 'design',
      id: 'legacy-old',
      content: 'replacement',
    });

    expect(result.id).toBe('legacy-new');
    expect(await rerun.getArtifact({ id: 'legacy-old' })).toMatchObject({
      id: 'legacy-new',
      content: 'replacement',
      generation: 2,
    });
    expect(
      (
        await g
          .V()
          .hasLabel('Artifact')
          .has('intent_id', SCOPE.intentId)
          .hasNot('superseded_at')
          .count()
          .next()
      ).value,
    ).toBe(1);
  });

  it('preserves compatibility slots when a stage rewrites multiple artifacts of one type', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'design-a', content: 'a1' });
    await writer.createArtifact({ artifactType: 'design', id: 'design-b', content: 'b1' });
    await writer.createArtifact({ artifactType: 'design', id: 'design-b', content: 'b2' });

    const rows = await writer.lookupArtifacts({ artifactType: 'design', includeContent: true });
    expect(rows.map((row) => [row.id, row.content]).toSorted()).toEqual([
      ['design-a', 'a1'],
      ['design-b', 'b2'],
    ]);
    expect(new Set(rows.map((row) => row.artifact_logical_key)).size).toBe(2);
  });
});

describe('linkSteeringInfluences', () => {
  const seedSteering = (id = 'st-1') =>
    g
      .addV('Steering')
      .property('id', id)
      .property('intent_id', SCOPE.intentId)
      .property('kind', 'rewind')
      .property('message', 'redo it')
      .next();

  it("links consumed steering to the stage's artifacts (idempotent)", async () => {
    await seedIntent();
    await seedSteering();
    await writer.createArtifact({ artifactType: 'design', id: 'a1' });
    const first = await writer.linkSteeringInfluences({
      steerIds: ['st-1'],
      stageInstanceId: SCOPE.stageInstanceId,
    });
    expect(first.linked).toBe(1);
    // Idempotent re-link: the edge exists, no duplicate.
    await writer.linkSteeringInfluences({
      steerIds: ['st-1'],
      stageInstanceId: SCOPE.stageInstanceId,
    });
    const edges = await g.V().has('Steering', 'id', 'st-1').outE('INFLUENCES').toList();
    expect(edges).toHaveLength(1);
  });

  it("skips unknown steer ids and other stages' artifacts", async () => {
    await seedIntent();
    await seedSteering();
    // Artifact created by a DIFFERENT stage instance.
    const otherWriter = createGraphWriter({
      g,
      scope: { ...SCOPE, stageInstanceId: 'si-other' },
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    await otherWriter.createArtifact({ artifactType: 'design', id: 'a-other' });
    const res = await writer.linkSteeringInfluences({
      steerIds: ['st-1', 'st-missing'],
      stageInstanceId: SCOPE.stageInstanceId,
    });
    expect(res.linked).toBe(0);
  });

  it('is a no-op without steer ids or a stage instance', async () => {
    await seedIntent();
    expect(
      await writer.linkSteeringInfluences({ steerIds: [], stageInstanceId: 'si-req' }),
    ).toEqual({ linked: 0 });
    expect(
      await writer.linkSteeringInfluences({ steerIds: ['st-1'], stageInstanceId: null }),
    ).toEqual({ linked: 0 });
  });
});

// ── WP3: unit DAG mirror (docs/v2-parallel.md) ──

describe('mirrorUnitDag (traceability mirror of the promoted unit DAG)', () => {
  const UNITS = [
    { slug: 'auth', dependsOn: [] },
    { slug: 'catalog', dependsOn: [] },
    { slug: 'checkout', dependsOn: ['auth', 'catalog'] },
  ];

  it('fails when the Intent anchor does not exist', async () => {
    await expect(writer.mirrorUnitDag({ units: UNITS })).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('creates UnitOfWork vertices anchored to the Intent with DEPENDS_ON edges', async () => {
    await seedIntent();
    const res = await writer.mirrorUnitDag({ units: UNITS });
    expect(res).toEqual({ mirrored: 3, superseded: 0 });

    // Anchored under the intent.
    const ids = await g
      .V()
      .has('Intent', 'id', SCOPE.intentId)
      .out('CONTAINS')
      .hasLabel('UnitOfWork')
      .values('id')
      .toList();
    expect(ids.toSorted()).toEqual([
      'unit:intent-1:auth',
      'unit:intent-1:catalog',
      'unit:intent-1:checkout',
    ]);

    // Dependency edges: checkout DEPENDS_ON auth + catalog.
    const deps = await g
      .V()
      .has('UnitOfWork', 'id', 'unit:intent-1:checkout')
      .out('DEPENDS_ON')
      .values('id')
      .toList();
    expect(deps.toSorted()).toEqual(['unit:intent-1:auth', 'unit:intent-1:catalog']);

    // Provenance stamped from trusted scope.
    const auth = await g.V().has('UnitOfWork', 'id', 'unit:intent-1:auth').valueMap().next();
    expect(auth.value.get('intent_id')[0]).toBe(SCOPE.intentId);
    expect(auth.value.get('slug')[0]).toBe('auth');
  });

  it('wires DERIVED_FROM to the source artifact when present', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'unit-of-work-dependency',
      id: 'art-dag',
      content: 'body',
    });
    await writer.mirrorUnitDag({ units: UNITS, sourceArtifactId: 'art-dag' });
    const derived = await g
      .V()
      .has('UnitOfWork', 'id', 'unit:intent-1:auth')
      .out('DERIVED_FROM')
      .values('id')
      .toList();
    expect(derived).toEqual(['art-dag']);
  });

  it('is idempotent — re-mirroring never duplicates vertices or edges', async () => {
    await seedIntent();
    await writer.mirrorUnitDag({ units: UNITS });
    await writer.mirrorUnitDag({ units: UNITS });
    const count = await g.V().hasLabel('UnitOfWork').count().next();
    expect(count.value).toBe(3);
    const edgeCount = await g
      .V()
      .has('UnitOfWork', 'id', 'unit:intent-1:checkout')
      .outE('DEPENDS_ON')
      .count()
      .next();
    expect(edgeCount.value).toBe(2);
  });

  it('a re-promotion with a changed DAG supersedes dropped units (audit kept) and revives re-added ones', async () => {
    await seedIntent();
    await writer.mirrorUnitDag({ units: UNITS });
    // catalog is gone in the new DAG.
    const res = await writer.mirrorUnitDag({
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'checkout', dependsOn: ['auth'] },
      ],
    });
    expect(res).toEqual({ mirrored: 2, superseded: 1 });
    const catalog = await g
      .V()
      .has('UnitOfWork', 'id', 'unit:intent-1:catalog')
      .values('superseded_at')
      .next();
    expect(catalog.value).toBeTruthy(); // marked, not deleted

    // Re-adding catalog revives it (superseded_at cleared).
    await writer.mirrorUnitDag({ units: UNITS });
    const revived = await g
      .V()
      .has('UnitOfWork', 'id', 'unit:intent-1:catalog')
      .values('superseded_at')
      .next();
    expect(revived.value).toBe('');
  });
});

describe('resolveDerivedItemEdges (item↔item traceability sweep)', () => {
  // Mirror an artifact through the real extractor — the same path derive uses.
  const mirror = async (artifactType, id, content) => {
    await writer.createArtifact({ artifactType, id, content });
    const artifact = await writer.getArtifact({ id });
    await writer.mirrorArtifactDerivations({
      artifact,
      extraction: extractArtifactStructure({ artifactType, artifactId: id, content }),
    });
  };
  const yamlArtifact = (heading, lines) => ['## ' + heading, '```yaml', ...lines, '```'].join('\n');

  const seedInceptionItems = async () => {
    await seedIntent();
    await mirror(
      'personas',
      'art-personas',
      yamlArtifact('Personas', ['personas:', '  - id: p-operator', '    title: Operator']),
    );
    await mirror(
      'requirements',
      'art-reqs',
      yamlArtifact('Reqs', [
        'requirements:',
        '  - id: req-auth',
        '    title: Auth',
        '    priority: must-have',
        '  - id: req-report',
        '    title: Reporting',
        '    priority: should-have',
      ]),
    );
    await mirror(
      'stories',
      'art-stories',
      yamlArtifact('Stories', [
        'stories:',
        '  - id: s-login',
        '    title: Login',
        '    persona: p-operator',
        '    covers: [req-auth]',
        '  - id: s-report',
        '    title: Reports',
        '    persona: p-operator',
        '    covers: [req-auth, req-report]',
        '    depends_on: [s-login]',
      ]),
    );
  };

  const edgeExists = (fromLabel, fromId, edge, toId) =>
    g.V().has(fromLabel, 'id', fromId).outE(edge).where(anon.inV().has('id', toId)).hasNext();

  it('materializes COVERS/FOR_PERSONA/DEPENDS_ON from the structured-block refs', async () => {
    await seedInceptionItems();
    const res = await writer.resolveDerivedItemEdges();
    // s-login: covers 1 + persona 1; s-report: covers 2 + persona 1 + depends 1.
    expect(res.edges).toBe(6);
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-login',
        'COVERS',
        'requirement:intent-1:req-auth',
      ),
    ).toBe(true);
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-login',
        'FOR_PERSONA',
        'persona:intent-1:p-operator',
      ),
    ).toBe(true);
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-report',
        'COVERS',
        'requirement:intent-1:req-report',
      ),
    ).toBe(true);
    expect(
      await edgeExists('Story', 'story:intent-1:s-report', 'DEPENDS_ON', 'story:intent-1:s-login'),
    ).toBe(true);
  });

  it('skips dangling refs silently and never links a vertex to itself', async () => {
    await seedIntent();
    await mirror(
      'stories',
      'art-stories',
      yamlArtifact('Stories', [
        'stories:',
        '  - id: s-solo',
        '    title: Solo',
        '    persona: p-ghost',
        '    covers: [req-ghost]',
        '    depends_on: [s-solo]',
      ]),
    );
    const res = await writer.resolveDerivedItemEdges();
    expect(res.edges).toBe(0);
    const out = await g
      .V()
      .has('Story', 'id', 'story:intent-1:s-solo')
      .outE('COVERS', 'FOR_PERSONA', 'DEPENDS_ON')
      .count()
      .next();
    expect(out.value).toBe(0);
  });

  it('re-derive that drops a ref also drops its edge (sweep is drop-then-recreate)', async () => {
    await seedInceptionItems();
    await writer.resolveDerivedItemEdges();
    // s-report no longer covers req-report after the re-derive.
    await mirror(
      'stories',
      'art-stories',
      yamlArtifact('Stories', [
        'stories:',
        '  - id: s-login',
        '    title: Login',
        '    persona: p-operator',
        '    covers: [req-auth]',
        '  - id: s-report',
        '    title: Reports',
        '    persona: p-operator',
        '    covers: [req-auth]',
        '    depends_on: [s-login]',
      ]),
    );
    await writer.resolveDerivedItemEdges();
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-report',
        'COVERS',
        'requirement:intent-1:req-report',
      ),
    ).toBe(false);
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-report',
        'COVERS',
        'requirement:intent-1:req-auth',
      ),
    ).toBe(true);
    // Idempotent: re-running does not duplicate.
    await writer.resolveDerivedItemEdges();
    const covers = await g
      .V()
      .has('Story', 'id', 'story:intent-1:s-report')
      .outE('COVERS')
      .count()
      .next();
    expect(covers.value).toBe(1);
  });

  it('wires StoryMapEntry→Story/UnitOfWork and unit EXPOSES/CONSUMES_CONTRACT — units resolving late', async () => {
    await seedInceptionItems();
    await mirror(
      'unit-of-work-story-map',
      'art-map',
      yamlArtifact('Map', [
        'mappings:',
        '  - id: m-auth',
        '    unit: u-auth',
        '    stories: [s-login]',
      ]),
    );
    await mirror(
      'unit-of-work-dependency',
      'art-contracts',
      yamlArtifact('Contracts', [
        'contracts:',
        '  - id: c-auth-api',
        '    title: Auth API',
        '    provider: u-auth',
        '    consumers: [u-report]',
        '    kind: api',
      ]),
    );
    // First sweep runs BEFORE promote-units created the UnitOfWork vertices:
    // story wiring lands, unit wiring cannot yet.
    await writer.resolveDerivedItemEdges();
    expect(
      await edgeExists(
        'StoryMapEntry',
        'storymapentry:intent-1:m-auth',
        'IMPLEMENTS',
        'story:intent-1:s-login',
      ),
    ).toBe(true);
    expect(
      await edgeExists(
        'StoryMapEntry',
        'storymapentry:intent-1:m-auth',
        'IMPLEMENTS',
        'unit:intent-1:u-auth',
      ),
    ).toBe(false);

    // promote-units mirrors the DAG, then re-sweeps (the hook under test).
    await writer.mirrorUnitDag({
      units: [
        { slug: 'u-auth', dependsOn: [] },
        { slug: 'u-report', dependsOn: ['u-auth'] },
      ],
      sourceArtifactId: 'art-contracts',
    });
    await writer.resolveDerivedItemEdges();
    expect(
      await edgeExists(
        'StoryMapEntry',
        'storymapentry:intent-1:m-auth',
        'IMPLEMENTS',
        'unit:intent-1:u-auth',
      ),
    ).toBe(true);
    expect(
      await edgeExists(
        'UnitOfWork',
        'unit:intent-1:u-auth',
        'EXPOSES',
        'contract:intent-1:c-auth-api',
      ),
    ).toBe(true);
    expect(
      await edgeExists(
        'UnitOfWork',
        'unit:intent-1:u-report',
        'CONSUMES_CONTRACT',
        'contract:intent-1:c-auth-api',
      ),
    ).toBe(true);
    // The sweep must NOT touch the DAG edges mirrorUnitDag owns.
    expect(
      await edgeExists(
        'UnitOfWork',
        'unit:intent-1:u-report',
        'DEPENDS_ON',
        'unit:intent-1:u-auth',
      ),
    ).toBe(true);
  });

  it('never wires edges from or to superseded items', async () => {
    await seedInceptionItems();
    // Re-derive the requirements artifact WITHOUT req-report → its item is
    // superseded; a story still claiming to cover it must get no edge.
    await mirror(
      'requirements',
      'art-reqs',
      yamlArtifact('Reqs', [
        'requirements:',
        '  - id: req-auth',
        '    title: Auth',
        '    priority: must-have',
      ]),
    );
    await writer.resolveDerivedItemEdges();
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-report',
        'COVERS',
        'requirement:intent-1:req-report',
      ),
    ).toBe(false);
    expect(
      await edgeExists(
        'Story',
        'story:intent-1:s-report',
        'COVERS',
        'requirement:intent-1:req-auth',
      ),
    ).toBe(true);
  });
});

describe('intent-scoped artifact identity (cross-intent isolation)', () => {
  // The field incident: two intents' agents chose the SAME artifact id, so
  // they shared one Neptune vertex — one intent's write (or delete) corrupted
  // the other. Every artifact/section lookup now matches intent_id too. These
  // tests drive two writers over the SAME partition with the SAME artifact id.
  const SCOPE_A = { ...SCOPE, intentId: 'intent-A', executionId: 'exec-A' };
  const SCOPE_B = { ...SCOPE, intentId: 'intent-B', executionId: 'exec-B' };
  let writerA;
  let writerB;

  beforeEach(async () => {
    let t = 0;
    const clock = () => `2026-02-01T00:00:0${t++}.000Z`;
    writerA = createGraphWriter({ g, scope: SCOPE_A, clock });
    writerB = createGraphWriter({ g, scope: SCOPE_B, clock });
    await g.addV('Intent').property('id', 'intent-A').property('project_id', 'proj-1').next();
    await g.addV('Intent').property('id', 'intent-B').property('project_id', 'proj-1').next();
  });

  it('same artifact id in two intents = two distinct vertices, no overwrite', async () => {
    await writerA.createArtifact({
      artifactType: 'requirements',
      id: 'requirements',
      title: 'A reqs',
      content: 'A body',
    });
    await writerB.createArtifact({
      artifactType: 'requirements',
      id: 'requirements',
      title: 'B reqs',
      content: 'B body',
    });

    // Two vertices, not one adopted vertex.
    const count = await g.V().has('Artifact', 'id', 'requirements').count().next();
    expect(count.value).toBe(2);

    // Each intent reads ITS OWN content — no cross-contamination.
    expect((await writerA.getArtifact({ id: 'requirements' })).title).toBe('A reqs');
    expect((await writerB.getArtifact({ id: 'requirements' })).title).toBe('B reqs');

    // B's update never touches A's vertex.
    await writerB.updateArtifact({ id: 'requirements', props: { status: 'final' } });
    expect((await writerA.getArtifact({ id: 'requirements' })).status).toBeUndefined();
    expect((await writerB.getArtifact({ id: 'requirements' })).status).toBe('final');

    // Each intent's CONTAINS points only at its own vertex.
    expect((await writerA.getIntentGraph()).map((a) => a.title)).toEqual(['A reqs']);
    expect((await writerB.getIntentGraph()).map((a) => a.title)).toEqual(['B reqs']);
  });

  it('enrichment and links are isolated per intent', async () => {
    await writerA.createArtifact({ artifactType: 'requirements', id: 'requirements', title: 'A' });
    await writerB.createArtifact({ artifactType: 'requirements', id: 'requirements', title: 'B' });
    await writerA.createArtifact({ artifactType: 'stories', id: 'stories', title: 'A stories' });
    await writerB.createArtifact({ artifactType: 'stories', id: 'stories', title: 'B stories' });

    await writerA.applyArtifactEnrichment({
      artifactId: 'requirements',
      gist: 'A gist',
      sourceHash: 'ha',
    });
    expect((await writerA.getArtifact({ id: 'requirements' })).summary_gist).toBe('A gist');
    expect((await writerB.getArtifact({ id: 'requirements' })).summary_gist).toBeUndefined();

    // linkArtifacts stays within the intent — A's edge does not appear on B.
    await writerA.linkArtifacts({ fromId: 'requirements', toId: 'stories', edge: 'RELATES_TO' });
    const aRelates = await writerA.getNeighbors({
      id: 'requirements',
      edge: 'RELATES_TO',
      direction: 'out',
    });
    expect(aRelates.map((n) => n.title)).toEqual(['A stories']);
    const bRelates = await writerB.getNeighbors({
      id: 'requirements',
      edge: 'RELATES_TO',
      direction: 'out',
    });
    expect(bRelates).toEqual([]);
  });

  it('derived sections/items with identical slugs stay isolated per intent', async () => {
    const body = [
      '## Stories',
      '```yaml',
      'stories:',
      '  - id: s-login',
      '    title: Login',
      '```',
    ].join('\n');
    for (const w of [writerA, writerB]) {
      await w.createArtifact({ artifactType: 'stories', id: 'stories', title: 'S', content: body });
      const artifact = await w.getArtifact({ id: 'stories' });
      await w.mirrorArtifactDerivations({
        artifact,
        extraction: extractArtifactStructure({
          artifactType: 'stories',
          artifactId: 'stories',
          content: body,
        }),
      });
    }
    // Section ids embed the artifact id (section:stories:stories) — collide
    // across intents unless intent-scoped. Each intent sees exactly one.
    const tocA = await writerA.getArtifactToc({ id: 'stories' });
    const tocB = await writerB.getArtifactToc({ id: 'stories' });
    expect(tocA).toHaveLength(1);
    expect(tocB).toHaveLength(1);
    // The two Section vertices are distinct rows keyed by intent.
    const sectionCount = await g.V().has('Section', 'id', 'section:stories:stories').count().next();
    expect(sectionCount.value).toBe(2);
    // Items ARE intent-scoped by id already, but assert per-intent visibility.
    expect((await writerA.getItems({ itemType: 'Story' })).map((i) => i.slug)).toEqual(['s-login']);
    expect((await writerB.getItems({ itemType: 'Story' })).map((i) => i.slug)).toEqual(['s-login']);
  });

  it('re-derive supersede in one intent never supersedes the other intent rows', async () => {
    const withStory = (slug) =>
      ['## S', '```yaml', 'stories:', `  - id: ${slug}`, `    title: ${slug}`, '```'].join('\n');
    const derive = async (w, content) => {
      await w.createArtifact({ artifactType: 'stories', id: 'stories', title: 'S', content });
      const artifact = await w.getArtifact({ id: 'stories' });
      await w.mirrorArtifactDerivations({
        artifact,
        extraction: extractArtifactStructure({
          artifactType: 'stories',
          artifactId: 'stories',
          content,
        }),
      });
    };
    await derive(writerA, withStory('s-old'));
    await derive(writerB, withStory('s-old'));
    // A re-derives with a different story → A's s-old supersedes; B's must not.
    await derive(writerA, withStory('s-new'));
    expect((await writerA.getItems({ itemType: 'Story' })).map((i) => i.slug)).toEqual(['s-new']);
    expect((await writerB.getItems({ itemType: 'Story' })).map((i) => i.slug)).toEqual(['s-old']);
  });
});
