import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const mcpServer = readFileSync(new URL('../mcp-server-graph/index.js', import.meta.url), 'utf8');

// mcp-server-graph/index.js starts an MCP server at import time (it is the
// container-side tool process), so these invariants are pinned at source
// level, matching the conventions of this workspace's tests.
describe('mcp-server-graph discussions integration (plan §5)', () => {
  it('registers Discussion/DiscussionMessage labels and the discussion edges', () => {
    expect(mcpServer).toContain("'Discussion',");
    expect(mcpServer).toContain("'DiscussionMessage',");
    expect(mcpServer).toContain("'HAS_DISCUSSION',");
    expect(mcpServer).toContain("'DISCUSSES',");
    expect(mcpServer).toContain("'HAS_MESSAGE',");
  });

  it('documents both vertex types and the discussion edges in DATA_MODEL', () => {
    expect(mcpServer).toMatch(/- Discussion: id, title \(nullable\), entity_type/);
    expect(mcpServer).toMatch(/- DiscussionMessage: id, content \(markdown\)/);
    expect(mcpServer).toMatch(/Sprint --HAS_DISCUSSION--> Discussion/);
    expect(mcpServer).toMatch(/Discussion --DISCUSSES--> /);
    expect(mcpServer).toMatch(/Discussion --HAS_MESSAGE--> DiscussionMessage/);
  });

  it('scopes list_nodes for Discussion/DiscussionMessage via HAS_DISCUSSION (not CONTAINS)', () => {
    expect(mcpServer).toMatch(/label === 'Discussion'[\s\S]{0,200}out\('HAS_DISCUSSION'\)/);
    expect(mcpServer).toMatch(
      /label === 'DiscussionMessage'[\s\S]{0,200}out\('HAS_DISCUSSION'\)\.out\('HAS_MESSAGE'\)/,
    );
  });

  it('registers the get_discussions tool (sprint-scoped, entityId filter, per-thread limit)', () => {
    expect(mcpServer).toContain("'get_discussions'");
    const toolSrc = mcpServer.slice(
      mcpServer.indexOf("'get_discussions'"),
      mcpServer.indexOf("'get_neighbors'"),
    );
    expect(toolSrc).toContain("out('HAS_DISCUSSION')");
    expect(toolSrc).toContain("has('entity_id', entityId)");
    expect(toolSrc).toContain('resolutionSummary');
    expect(toolSrc).toContain('messageCount');
  });

  it('includes Discussion in get_sprint_graph and filters the structural edge', () => {
    const sprintGraphSrc = mcpServer.slice(
      mcpServer.indexOf("'get_sprint_graph'"),
      mcpServer.indexOf("'find_nodes'"),
    );
    expect(sprintGraphSrc).toContain("__.out('HAS_DISCUSSION')");
    expect(sprintGraphSrc).toMatch(/'HAS_PR_GROUP', 'HAS_DISCUSSION'/);
  });
});

describe('post_discussion_message tool (plan §8)', () => {
  it("is registered and scoped to the assist run's discussion", () => {
    expect(mcpServer).toContain("'post_discussion_message'");
    const toolSrc = mcpServer.slice(
      mcpServer.indexOf("'post_discussion_message'"),
      mcpServer.indexOf('// ─── TRAVERSE ───'),
    );
    expect(toolSrc).toContain('process.env.DISCUSSION_ID');
    expect(toolSrc).toContain('discussionId !== jobDiscussionId');
    expect(toolSrc).toContain("author_type', 'agent'");
    expect(toolSrc).toContain("'last_message_at', now");
  });

  it('writes the fallback-guard marker file and broadcasts to the sprint channel', () => {
    const toolSrc = mcpServer.slice(
      mcpServer.indexOf("'post_discussion_message'"),
      mcpServer.indexOf('// ─── TRAVERSE ───'),
    );
    expect(toolSrc).toMatch(/discussion-posted-\$\{process\.env\.EXECUTION_ID/);
    expect(toolSrc).toContain('broadcastToSprintChannel({');
  });

  it('documents the DISCUSSION AgentRun phase in DATA_MODEL', () => {
    expect(mcpServer).toContain('phase (INCEPTION|CONSTRUCTION|REVIEW|DISCUSSION)');
  });
});
