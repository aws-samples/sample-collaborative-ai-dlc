import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildToolHandlers,
  handlersForRole,
  registerTools,
  READ_TOOLS,
  AUTHOR_TOOLS,
} from '../mcp/server.js';
import { GraphWriteError } from '../mcp/graph-writer.js';

// A stub writer/bridge that records calls — the handler layer is pure of Neptune
// and DynamoDB, so we assert it routes args through and envelopes results.
const stubWriter = () => ({
  calls: [],
  getArtifact({ id }) {
    this.calls.push(['getArtifact', id]);
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
  searchGraph(args) {
    this.calls.push(['searchGraph', args]);
    return [];
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

  it('routes ask_question through the bridge (blocking handled there)', async () => {
    const env = await h.ask_question({ questions: [{ text: '?', type: 'single', options: [] }] });
    expect(parse(env)).toEqual({ status: 'answered', answer: { ok: true } });
    expect(bridge.calls[0][0]).toBe('askQuestion');
  });

  it('routes send_output and defaults kind to text', async () => {
    await h.send_output({ content: 'hi' });
    expect(bridge.calls[0][1]).toEqual({ content: 'hi', kind: 'text' });
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
  it('reviewer gets the read-only subset only — no writes, no questions', () => {
    const h = buildToolHandlers({ writer: stubWriter(), bridge: stubBridge() });
    const reviewer = handlersForRole(h, 'reviewer');
    expect(Object.keys(reviewer).toSorted()).toEqual([...READ_TOOLS].toSorted());
    expect(reviewer.create_artifact).toBeUndefined();
    expect(reviewer.ask_question).toBeUndefined();
    // A reviewer may READ team knowledge but never WRITE it.
    expect(reviewer.get_team_knowledge).toBeDefined();
    expect(reviewer.record_team_knowledge).toBeUndefined();
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
    number: () => ({ int: () => ({ min: () => ({ max: () => ({ optional: () => ({}) }) }) }) }),
    enum: () => ({ optional: () => ({}) }),
    object: () => ({ optional: () => ({}) }),
    array: () => ({ optional: () => ({}) }),
    record: () => ({ optional: () => ({}) }),
  };

  it('registers exactly the read tools for a reviewer', () => {
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    const names = registerTools({ server, handlers: {}, role: 'reviewer', z: fakeZod });
    expect(registered.toSorted()).toEqual([...READ_TOOLS].toSorted());
    expect(names).toEqual(READ_TOOLS);
  });

  it('registers the full surface for an author', () => {
    const registered = [];
    const server = { tool: (name) => registered.push(name) };
    registerTools({ server, handlers: {}, role: 'author', z: fakeZod });
    expect(registered.toSorted()).toEqual([...AUTHOR_TOOLS].toSorted());
  });
});
