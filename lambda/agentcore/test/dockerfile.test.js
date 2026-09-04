import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(path.join(here, '..', 'Dockerfile'), 'utf8');

describe('AgentCore image ownership', () => {
  it('prepares writable runtime state before dropping privileges', () => {
    const createDirs = dockerfile.indexOf('install -d -o node -g node');
    const dropPrivileges = dockerfile.indexOf('USER node');
    expect(createDirs).toBeGreaterThan(-1);
    expect(createDirs).toBeLessThan(dropPrivileges);
    expect(dockerfile).toContain('/mnt/workspace');
    expect(dockerfile).toContain('/home/node/.codex-state');
    expect(dockerfile).toContain('/home/node/.codex-runs');
  });

  it('includes every archive extractor supported by managed tools', () => {
    expect(dockerfile).toContain('unzip xz-utils');
  });
});
