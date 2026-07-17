import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildToolHandlers,
  handlersForRole,
  registerTools,
  READ_TOOLS,
  REVIEWER_TOOLS,
  AUTHOR_TOOLS,
  ok,
} from '../mcp/server.js';
import { GraphWriteError } from '../mcp/graph-writer.js';

// A stub writer/bridge that records calls — the handler layer is pure of Neptune
// and DynamoDB, so we assert it routes args through and envelopes results.
const stubWriter = () => ({
  calls: [],
  getArtifact({ id, mode }) {
    this.calls.push(['getArtifact', { id, mode }]);
    return { id, artifact_type: 't' };
  },
  lookupArtifacts({ artifactType }) {
    this.calls.push(['lookupArtifacts', artifactType]);
    return [{ id: 'a', artifact_type: artifactType }];
  },
  getIntentGraph() {
    this.calls.push(['getIntentGraph']);
    return [];
  },
  getNeighbors(args) {
    this.calls.push(['getNeighbors', args]);
    return [];
  },
  getArtifactToc(args) {
    this.calls.push(['getArtifactToc', args]);
    return [{ id: 'section:a:intro', heading: 'Intro' }];
  },
  getSection(args) {
    this.calls.push(['getSection', args]);
    return { id: 'section:a:intro', content: 'body' };
  },
  getItems(args) {
    this.calls.push(['getItems', args]);
    return [{ id: 'story:intent:s1' }];
  },
  searchGraph(args) {
    this.calls.push(['searchGraph', args]);
    return [];
  },
  getCoverage(args) {
    this.calls.push(['getCoverage', args]);
    return { counts: { requirements: 1 }, uncoveredMustHave: [] };
  },
  createArtifact(args) {
    this.calls.push(['createArtifact', args]);
    return { id: args.id };
  },
  updateArtifact(args) {
    this.calls.push(['updateArtifact', args]);
    return { id: args.id, updated: Object.keys(args.props) };
  },
  linkArtifacts(args) {
    this.calls.push(['linkArtifacts', args]);
    return args;
  },
  getTeamKnowledge(args) {
    this.calls.push(['getTeamKnowledge', args]);
    return [{ id: 'k1', title: 'Naming', agent_ref: 'shared' }];
  },
  recordTeamKnowledge(args) {
    this.calls.push(['recordTeamKnowledge', args]);
    return { id: args.id, agentRef: args.agentRef };
  },
  getLearningRules() {
    this.calls.push(['getLearningRules']);
    return [{ id: 'no-secrets', layer: 'project-learnings' }];
  },
  recordLearningRule(args) {
    this.calls.push(['recordLearningRule', args]);
    return { id: args.id, layer: args.layer };
  },
});

const stubBridge = () => ({
  calls: [],
  askQuestion(args) {
    this.calls.push(['askQuestion', args]);
    return { status: 'answered', answer: { ok: true } };
  },
  sendOutput(args) {
    this.calls.push(['sendOutput', args]);
    return { seq: 1, kind: args.kind };
  },
  collectMetric(args) {
    this.calls.push(['collectMetric', args]);
    return { metricId: 'm1' };
  },
  emitStageNote(args) {
    this.calls.push(['emitStageNote', args]);
    return { eventId: 'e1' };
  },
  recordGraphRead(args) {
    this.calls.push(['recordGraphRead', args]);
    return { readId: 'read-1' };
  },
});

const parse = (env) => JSON.parse(env.content[0].text);

describe('buildToolHandlers — routing + envelopes', () => {
  let writer, bridge, h;
  beforeEach(() => {
    writer = stubWriter();
    bridge = stubBridge();
    h = buildToolHandlers({ writer, bridge });
  });

  it('routes create_artifact through the writer and wraps the result', async () => {
    const env = await h.create_artifact({ artifactType: 'design', id: 'd1', title: 'T' });
    expect(parse(env)).toEqual({ id: 'd1' });
    expect(writer.calls[0][0]).toBe('createArtifact');
    expect(writer.calls[0][1]).toMatchObject({ artifactType: 'design', id: 'd1', links: [] });
  });

  it('create_artifact emits a v2.artifact.created note so the UI updates live', async () => {
    await h.create_artifact({ artifactType: 'design', id: 'd1', title: 'Auth design' });
    expect(bridge.calls).toContainEqual([
      'emitStageNote',
      { summary: 'Artifact created: Auth design', type: 'v2.artifact.created' },
    ]);
  });

  it('update_artifact emits a v2.artifact.updated note (falls back to the id)', async () => {
    await h.update_artifact({ id: 'd1', props: { status: 'done' } });
    expect(bridge.calls).toContainEqual([
      'emitStageNote',
      { summary: 'Artifact updated: d1', type: 'v2.artifact.updated' },
    ]);
  });

  it('a failed artifact note never fails the tool call (the write succeeded)', async () => {
    bridge.emitStageNote = () => {
      throw new Error('ws down');
    };
    const env = await h.create_artifact({ artifactType: 'design', id: 'd1' });
    expect(env.isError).toBeUndefined();
    expect(parse(env)).toEqual({ id: 'd1' });
  });

  it('a failed artifact WRITE emits no note (nothing was created)', async () => {
    writer.createArtifact = () => {
      throw new GraphWriteError('duplicate id');
    };
    const env = await h.create_artifact({ artifactType: 'design', id: 'd1' });
    expect(env.isError).toBe(true);
    expect(bridge.calls).toEqual([]);
  });

  it('routes ask_question through the bridge (blocking handled there)', async () => {
    const env = await h.ask_question({ questions: [{ text: '?', type: 'single', options: [] }] });
    expect(parse(env)).toEqual({ status: 'answered', answer: { ok: true } });
    expect(bridge.calls[0][0]).toBe('askQuestion');
  });

  it('routes send_output and defaults kind to text', async () => {
    await h.send_output({ content: 'hi' });
    expect(bridge.calls[0][1]).toEqual({ content: 'hi', kind: 'text' });
  });

  it('uses graph manager for graph tools but not process-only tools', async () => {
    const graph = { withWriter: vi.fn(async (fn) => fn(writer)) };
    const handlers = buildToolHandlers({ graph, bridge });

    await handlers.create_artifact({ artifactType: 'design', id: 'd1' });
    expect(graph.withWriter).toHaveBeenCalledTimes(1);

    await handlers.send_output({ content: 'hi' });
    await handlers.collect_metric({ metrics: { tokens: 1 } });
    await handlers.emit_stage_note({ summary: 'note' });
    expect(graph.withWriter).toHaveBeenCalledTimes(1);
  });

  it('routes record_team_knowledge through the writer (defaulting agentRef to shared)', async () => {
    const env = await h.record_team_knowledge({ id: 'naming-conv', content: 'use kebab' });
    expect(parse(env)).toEqual({ id: 'naming-conv', agentRef: 'shared' });
    expect(writer.calls[0]).toEqual([
      'recordTeamKnowledge',
      {
        id: 'naming-conv',
        title: undefined,
        content: 'use kebab',
        agentRef: 'shared',
        props: undefined,
      },
    ]);
  });

  it('routes get_team_knowledge through the writer (agentRef defaults to null)', async () => {
    const env = await h.get_team_knowledge({});
    expect(parse(env)).toEqual([{ id: 'k1', title: 'Naming', agent_ref: 'shared' }]);
    expect(writer.calls[0]).toEqual(['getTeamKnowledge', { agentRef: null }]);
  });

  it('routes record_learning_rule through the writer (defaulting layer + pairing)', async () => {
    const env = await h.record_learning_rule({ id: 'no-secrets', content: 'NEVER plaintext' });
    expect(parse(env)).toEqual({ id: 'no-secrets', layer: 'project-learnings' });
    expect(writer.calls[0]).toEqual([
      'recordLearningRule',
      {
        id: 'no-secrets',
        title: undefined,
        content: 'NEVER plaintext',
        layer: 'project-learnings',
        pairing: 'feedforward-only',
      },
    ]);
  });

  it('routes get_learning_rules through the writer', async () => {
    const env = await h.get_learning_rules({});
    expect(parse(env)).toEqual([{ id: 'no-secrets', layer: 'project-learnings' }]);
    expect(writer.calls[0]).toEqual(['getLearningRules']);
  });

  it('records graph read ledger samples for read tools', async () => {
    await h.lookup_artifacts({ artifactType: 'stories' });
    const read = bridge.calls.find((c) => c[0] === 'recordGraphRead');
    expect(read[1]).toMatchObject({
      tool: 'lookup_artifacts',
      args: { artifactType: 'stories' },
      resultCount: 1,
    });
    expect(read[1].bytes).toBeGreaterThan(0);
  });

  it('routes get_coverage through the writer with read-ledger sampling', async () => {
    const env = await h.get_coverage({ unitSlug: 'auth' });
    expect(parse(env)).toMatchObject({ counts: { requirements: 1 } });
    expect(writer.calls[0]).toEqual(['getCoverage', { unitSlug: 'auth' }]);
    const read = bridge.calls.find((c) => c[0] === 'recordGraphRead');
    expect(read[1]).toMatchObject({ tool: 'get_coverage', args: { unitSlug: 'auth' } });
    // unitSlug defaults to null for the intent-wide report.
    await h.get_coverage({});
    expect(writer.calls[1]).toEqual(['getCoverage', { unitSlug: null }]);
  });

  it('routes compact derived graph reads through the writer', async () => {
    expect(parse(await h.get_artifact({ id: 'a1', mode: 'toc' }))).toEqual({
      id: 'a1',
      artifact_type: 't',
    });
    expect(parse(await h.get_artifact_toc({ id: 'a1' }))).toEqual([
      { id: 'section:a:intro', heading: 'Intro' },
    ]);
    expect(parse(await h.get_section({ artifactId: 'a1', slug: 'intro' }))).toEqual({
      id: 'section:a:intro',
      content: 'body',
    });
    expect(parse(await h.get_items({ itemType: 'Story', artifactType: 'stories' }))).toEqual([
      { id: 'story:intent:s1' },
    ]);
    expect(writer.calls.slice(-4)).toEqual([
      ['getArtifact', { id: 'a1', mode: 'toc' }],
      ['getArtifactToc', { id: 'a1' }],
      ['getSection', { artifactId: 'a1', heading: null, slug: 'intro' }],
      ['getItems', { itemType: 'Story', artifactType: 'stories', limit: 100 }],
    ]);
  });

  it('turns a GraphWriteError into a clean isError envelope', async () => {
    writer.createArtifact = () => {
      throw new GraphWriteError('bad edge');
    };
    const env = await buildToolHandlers({ writer, bridge }).create_artifact({
      artifactType: 't',
      id: 'x',
    });
    expect(env.isError).toBe(true);
    expect(env.content[0].text).toContain('graph write rejected: bad edge');
  });

  it('surfaces a generic error message as isError', async () => {
    bridge.collectMetric = () => {
      throw new Error('ddb down');
    };
    const env = await buildToolHandlers({ writer, bridge }).collect_metric({ metrics: {} });
    expect(env.isError).toBe(true);
    expect(env.content[0].text).toBe('ddb down');
  });
});

describe('role gating', () => {
  it('reader gets read-only graph and knowledge tools only', () => {
    const h = buildToolHandlers({ writer: stubWriter(), bridge: stubBridge() });
    const reader = handlersForRole(h, 'reader');
    expect(Object.keys(reader).toSorted()).toEqual([...READ_TOOLS].toSorted());
    expect(reader.create_artifact).toBeUndefined();
    expect(reader.collect_metric).toBeUndefined();
    expect(reader.submit_review).toBeUndefined();
  });

  it('reviewer gets the clean-room subset only — reads, metrics, and verdict submit', () => {
    const h = buildToolHandlers({ writer: stubWriter(), bridge: stubBridge() });
    const reviewer = handlersForRole(h, 'reviewer');
    expect(Object.keys(reviewer).toSorted()).toEqual([...REVIEWER_TOOLS].toSorted());
    expect(reviewer.create_artifact).toBeUndefined();
    expect(reviewer.ask_question).toBeUndefined();
    // A reviewer may READ team knowledge but never WRITE it.
    expect(reviewer.get_team_knowledge).toBeDefined();
    expect(reviewer.record_team_knowledge).toBeUndefined();
    // Same for learning rules: read-only for a reviewer.
    expect(reviewer.get_learning_rules).toBeDefined();
    expect(reviewer.record_learning_rule).toBeUndefined();
    expect(reviewer.collect_metric).toBeDefined();
    expect(reviewer.submit_review).toBeDefined();
  });

  it('author gets the full surface', () => {
    const h = buildToolHandlers({ writer: stubWriter(), bridge: stubBridge() });
    const author = handlersForRole(h, 'author');
    expect(Object.keys(author).toSorted()).toEqual([...AUTHOR_TOOLS].toSorted());
  });
});

describe('registerTools', () => {
  // A fake MCP server + a minimal zod stand-in (registerTools only needs the
  // schema-shape values to exist; it never invokes zod here).
  const fakeZod = {
    string: () => ({ optional: () => ({}) }),
    number: () => ({
      optional: () => ({}),
      int: () => ({ min: () => ({ max: () => ({ optional: () => ({}) }) }) }),
    }),
    enum: () => ({ optional: () => ({}) }),
    object: () => ({ optional: () => ({}) }),
    array: () => ({ optional: () => ({}) }),
    record: () => ({ optional: () => ({}) }),
  };

  it('registers exactly the read tools for a reader', () => {
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    const names = registerTools({ server, handlers: {}, role: 'reader', z: fakeZod });
    expect(registered.toSorted()).toEqual([...READ_TOOLS].toSorted());
    expect(names).toEqual(READ_TOOLS);
  });

  it('registers exactly the reviewer tools for a reviewer', () => {
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    const names = registerTools({ server, handlers: {}, role: 'reviewer', z: fakeZod });
    expect(registered.toSorted()).toEqual([...REVIEWER_TOOLS].toSorted());
    expect(names).toEqual(REVIEWER_TOOLS);
  });

  it('registers the full surface for an author', () => {
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    registerTools({ server, handlers: {}, role: 'author', z: fakeZod });
    expect(registered.toSorted()).toEqual([...AUTHOR_TOOLS].toSorted());
  });

  it('traces each call with the result-envelope byte size, and passes the envelope through', async () => {
    const captured = [];
    const bound = {};
    const server = { tool: (name, _d, _s, fn) => (bound[name] = fn) };
    const handlers = { get_learning_rules: async () => ok({ hello: 'world' }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m) => captured.push(m));
    try {
      registerTools({ server, handlers, role: 'reviewer', z: fakeZod, env: {} });
      const env = await bound.get_learning_rules({});
      // Envelope is returned unchanged (tracing is transparent).
      expect(JSON.parse(env.content[0].text)).toEqual({ hello: 'world' });
      const line = captured.find((l) => l.startsWith('[mcp-trace] get_learning_rules'));
      expect(line).toBeDefined();
      expect(line).toContain(`bytes=${Buffer.byteLength(env.content[0].text, 'utf8')}`);
      expect(line).toContain('ok=true');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('V2_MCP_TRACE=off silences the trace (no stderr line)', async () => {
    const captured = [];
    const bound = {};
    const server = { tool: (name, _d, _s, fn) => (bound[name] = fn) };
    const handlers = { get_learning_rules: async () => ok({ ok: true }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m) => captured.push(m));
    try {
      registerTools({
        server,
        handlers,
        role: 'reviewer',
        z: fakeZod,
        env: { V2_MCP_TRACE: 'off' },
      });
      await bound.get_learning_rules({});
      expect(captured.some((l) => String(l).startsWith('[mcp-trace]'))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
