import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('mcp-server-graph image packaging', () => {
  it('copies every local module required (transitively) by index.js into the ECS image', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const moduleDir = new URL('../mcp-server-graph/', import.meta.url);
    const localRequiresOf = (source) =>
      [...source.matchAll(/require\('(?<path>\.\/[\w-]+)'\)/g)].map(
        (match) => `${match.groups.path.slice('./'.length)}.js`,
      );

    const seen = new Set();
    const queue = ['index.js'];
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...localRequiresOf(readFileSync(new URL(file, moduleDir), 'utf8')));
    }
    seen.delete('index.js');

    expect([...seen]).toContain('create-repo-prs.js');
    expect([...seen]).toContain('merge-task-branches.js');
    expect([...seen]).toContain('git-providers.js');

    const mcpCopyLine = dockerfile
      .split('\n')
      .find((line) => line.startsWith('COPY ') && line.includes('/opt/mcp-server-graph/'));

    for (const file of seen) {
      expect(mcpCopyLine).toContain(`mcp-server-graph/${file}`);
    }

    // The ./git-providers shim resolves ./shared/git-providers in the image, so
    // the canonical shared module + its impl dir must be copied alongside it.
    expect(dockerfile).toContain(
      'COPY shared/git-providers.js /opt/mcp-server-graph/shared/git-providers.js',
    );
    expect(dockerfile).toContain(
      'COPY shared/git-providers/ /opt/mcp-server-graph/shared/git-providers/',
    );
  });
});
