import { describe, it, expect } from 'vitest';
import {
  RESERVED_SERVER_NAME,
  MAX_SERVERS,
  validateMcpServers,
  validateMcpServersJson,
  toMcpServerMap,
  mergeMcpServers,
} from '../mcp-validator.js';

describe('validateMcpServers', () => {
  it('accepts an empty object', () => {
    expect(validateMcpServers({})).toEqual({ valid: true, issues: [] });
  });

  it('accepts a valid stdio server (minimal)', () => {
    const res = validateMcpServers({ 'my-tool': { command: 'npx' } });
    expect(res.valid).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('accepts a stdio server with args and env object', () => {
    const res = validateMcpServers({
      'my-tool': { command: 'npx', args: ['-y', 'my-mcp-server'], env: { TOKEN: 'abc' } },
    });
    expect(res.valid).toBe(true);
  });

  it('accepts http/sse servers with a headers object', () => {
    const res = validateMcpServers({
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Auth: 'x' } },
      stream: { type: 'sse', url: 'https://example.com/sse' },
    });
    expect(res.valid).toBe(true);
  });

  it('rejects a non-object root (array)', () => {
    const res = validateMcpServers([{ command: 'npx' }]);
    expect(res.valid).toBe(false);
    expect(res.issues[0].path).toBe('');
    expect(res.issues[0].message).toMatch(/Expected a JSON object/);
  });

  it('rejects the reserved name "aidlc"', () => {
    const res = validateMcpServers({ [RESERVED_SERVER_NAME]: { command: 'node' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({
        path: RESERVED_SERVER_NAME,
        message: expect.stringMatching(/reserved/),
      }),
    );
  });

  it('rejects the Claude-reserved name "workspace"', () => {
    const res = validateMcpServers({ workspace: { command: 'node' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({ path: 'workspace', message: expect.stringMatching(/reserved/) }),
    );
  });

  it('rejects a remote entry (url) with no explicit type', () => {
    const res = validateMcpServers({ r: { url: 'https://e.com/mcp' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({
        path: 'r.type',
        message: expect.stringMatching(/Remote servers require/),
      }),
    );
  });

  it('requires command for stdio servers', () => {
    const res = validateMcpServers({ x: {} });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(expect.objectContaining({ path: 'x.command' }));
  });

  it('accepts known bare commands (node/npx/bun/bunx/uv/uvx/python/python3)', () => {
    for (const command of ['node', 'npx', 'bun', 'bunx', 'uv', 'uvx', 'python', 'python3']) {
      const res = validateMcpServers({ [command]: { command } });
      expect(res.valid, command).toBe(true);
    }
  });

  it('rejects an unknown bare command (typo guard)', () => {
    const res = validateMcpServers({ typo: { command: 'uvxx' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({
        path: 'typo.command',
        message: expect.stringMatching(/Unknown executable "uvxx"/),
      }),
    );
  });

  it('allows any command containing a path separator (operator vouches)', () => {
    const res = validateMcpServers({ abs: { command: '/usr/local/bin/my-mcp' } });
    expect(res.valid).toBe(true);
  });

  it('rejects unknown keys on stdio servers (strict)', () => {
    const res = validateMcpServers({ x: { command: 'npx', foo: 1 } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({ path: 'x.foo', message: expect.stringMatching(/Unknown key/) }),
    );
  });

  it('rejects env as an array (old ACP shape) — must be an object', () => {
    const res = validateMcpServers({ x: { command: 'npx', env: [{ name: 'K', value: 'v' }] } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({ path: 'x.env', message: expect.stringMatching(/object/) }),
    );
  });

  it('rejects non-string args entries', () => {
    const res = validateMcpServers({ x: { command: 'npx', args: ['ok', 3] } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(expect.objectContaining({ path: 'x.args[1]' }));
  });

  it('rejects an unknown transport type', () => {
    const res = validateMcpServers({ x: { type: 'ftp', url: 'https://e.com' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(expect.objectContaining({ path: 'x.type' }));
  });

  it('rejects invalid url on http servers', () => {
    const res = validateMcpServers({ x: { type: 'http', url: 'not a url' } });
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({ path: 'x.url', message: expect.stringMatching(/Invalid URL/) }),
    );
  });

  it('rejects non-http(s) url schemes (file:, ftp:, etc.)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'ws://example.com']) {
      const res = validateMcpServers({ x: { type: 'http', url } });
      expect(res.valid, url).toBe(false);
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: 'x.url',
          message: expect.stringMatching(/must use http:\/\/ or https:\/\//),
        }),
      );
    }
  });

  it('accepts http and https urls', () => {
    expect(
      validateMcpServers({ a: { type: 'http', url: 'http://localhost:3000/mcp' } }).valid,
    ).toBe(true);
    expect(validateMcpServers({ b: { type: 'sse', url: 'https://example.com/sse' } }).valid).toBe(
      true,
    );
  });

  it('caps the number of servers', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SERVERS + 1 }, (_, i) => [`s${i}`, { command: 'node' }]),
    );
    const res = validateMcpServers(many);
    expect(res.valid).toBe(false);
    expect(res.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/Too many/) }),
    );
  });
});

describe('validateMcpServersJson', () => {
  it('reports invalid JSON at the root', () => {
    const res = validateMcpServersJson('{ not json');
    expect(res.valid).toBe(false);
    expect(res.issues[0].path).toBe('');
    expect(res.issues[0].message).toMatch(/Invalid JSON/);
  });

  it('validates parsed content', () => {
    expect(validateMcpServersJson('{"a":{"command":"npx"}}').valid).toBe(true);
  });
});

describe('toMcpServerMap', () => {
  it('keeps command/args/env for stdio', () => {
    const map = toMcpServerMap({ a: { command: 'npx', args: ['-y', 'p'], env: { K: 'v' } } });
    expect(map).toEqual({ a: { command: 'npx', args: ['-y', 'p'], env: { K: 'v' } } });
  });

  it('remote uses `type` (agent-config format for both CLIs)', () => {
    const map = toMcpServerMap({ r: { type: 'http', url: 'https://e.com', headers: { A: '1' } } });
    expect(map).toEqual({ r: { type: 'http', url: 'https://e.com', headers: { A: '1' } } });
  });

  it('remote sse keeps type: sse', () => {
    const map = toMcpServerMap({ r: { type: 'sse', url: 'https://e.com' } });
    expect(map).toEqual({ r: { type: 'sse', url: 'https://e.com' } });
  });

  it('stdio entries keep command/args', () => {
    expect(toMcpServerMap({ s: { command: 'uvx', args: ['x'] } })).toEqual({
      s: { command: 'uvx', args: ['x'] },
    });
  });

  it('skips the reserved name', () => {
    expect(toMcpServerMap({ [RESERVED_SERVER_NAME]: { command: 'x' } })).toEqual({});
  });
});

describe('mergeMcpServers', () => {
  it('merges by name with project winning over global', () => {
    const global = JSON.stringify({
      shared: { command: 'global' },
      onlyGlobal: { command: 'g' },
    });
    const project = JSON.stringify({
      shared: { command: 'project' },
      onlyProject: { command: 'p' },
    });
    expect(mergeMcpServers(global, project)).toEqual({
      shared: { command: 'project' },
      onlyGlobal: { command: 'g' },
      onlyProject: { command: 'p' },
    });
  });

  it('treats unparseable / empty inputs as empty', () => {
    expect(mergeMcpServers('', 'nope')).toEqual({});
    expect(mergeMcpServers(undefined, undefined)).toEqual({});
  });
});
