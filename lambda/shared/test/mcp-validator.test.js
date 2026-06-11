import { describe, it, expect } from 'vitest';
import { validateMcpServers, validateMcpServersJson } from '../mcp-validator.js';

describe('validateMcpServers', () => {
  describe('top-level', () => {
    it('accepts an empty array', () => {
      expect(validateMcpServers([])).toEqual({ valid: true, issues: [] });
    });

    it('rejects non-array input', () => {
      const r = validateMcpServers({ name: 'foo' });
      expect(r.valid).toBe(false);
      expect(r.issues).toEqual([
        { path: '', message: expect.stringContaining('Expected a JSON array') },
      ]);
    });

    it('rejects null', () => {
      const r = validateMcpServers(null);
      expect(r.valid).toBe(false);
      expect(r.issues[0].path).toBe('');
    });

    it('reports duplicate server names', () => {
      const r = validateMcpServers([
        { name: 'dup', command: 'a', args: [] },
        { name: 'dup', command: 'b', args: [] },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toEqual([
        { path: '[1].name', message: expect.stringContaining('Duplicate server name "dup"') },
      ]);
    });
  });

  describe('stdio servers', () => {
    it('accepts a minimal stdio server', () => {
      expect(validateMcpServers([{ name: 'fs', command: '/usr/bin/mcp-fs', args: [] }])).toEqual({
        valid: true,
        issues: [],
      });
    });

    it('accepts explicit type=stdio', () => {
      expect(
        validateMcpServers([
          { type: 'stdio', name: 'fs', command: '/usr/bin/mcp-fs', args: ['--root', '/'] },
        ]),
      ).toEqual({ valid: true, issues: [] });
    });

    it('accepts env entries as array of {name, value}', () => {
      const r = validateMcpServers([
        {
          name: 'fs',
          command: '/usr/bin/mcp-fs',
          args: [],
          env: [{ name: 'API_KEY', value: 'secret' }],
        },
      ]);
      expect(r).toEqual({ valid: true, issues: [] });
    });

    it('rejects missing command', () => {
      const r = validateMcpServers([{ name: 'fs', args: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].command',
        message: expect.stringContaining('Required non-empty string'),
      });
    });

    it('rejects empty command', () => {
      const r = validateMcpServers([{ name: 'fs', command: '', args: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].command',
        message: expect.any(String),
      });
    });

    it('rejects missing args', () => {
      const r = validateMcpServers([{ name: 'fs', command: '/x' }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].args',
        message: expect.stringContaining('Required array of strings'),
      });
    });

    it('rejects non-array args', () => {
      const r = validateMcpServers([{ name: 'fs', command: '/x', args: '--stdio' }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].args',
        message: expect.stringContaining('got string'),
      });
    });

    it('rejects non-string arg entries', () => {
      const r = validateMcpServers([{ name: 'fs', command: '/x', args: ['ok', 42, null] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].args[1]',
        message: expect.stringContaining('got number'),
      });
      expect(r.issues).toContainEqual({
        path: '[0].args[2]',
        message: expect.stringContaining('got null'),
      });
    });

    it('rejects env as object instead of array (common kiro/claude config mistake)', () => {
      const r = validateMcpServers([
        { name: 'fs', command: '/x', args: [], env: { API_KEY: 'secret' } },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].env',
        message: expect.stringContaining('Expected array of {name, value}'),
      });
    });

    it('rejects env entry missing name', () => {
      const r = validateMcpServers([
        { name: 'fs', command: '/x', args: [], env: [{ value: 'v' }] },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].env[0].name',
        message: expect.stringContaining('Required non-empty string'),
      });
    });

    it('rejects unknown keys (strict mode)', () => {
      const r = validateMcpServers([
        {
          name: 'aws-mcp',
          command: 'uvx',
          args: ['mcp-proxy@latest'],
          transport: 'stdio',
          timeout: 100000,
          autoApprove: ['x'],
        },
      ]);
      expect(r.valid).toBe(false);
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain('[0].transport');
      expect(paths).toContain('[0].timeout');
      expect(paths).toContain('[0].autoApprove');
    });
  });

  describe('http servers', () => {
    it('accepts a minimal http server', () => {
      const r = validateMcpServers([
        {
          type: 'http',
          name: 'api',
          url: 'https://example.com/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer x' }],
        },
      ]);
      expect(r).toEqual({ valid: true, issues: [] });
    });

    it('rejects missing url', () => {
      const r = validateMcpServers([{ type: 'http', name: 'api', headers: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].url',
        message: expect.stringContaining('Required non-empty string'),
      });
    });

    it('rejects malformed url', () => {
      const r = validateMcpServers([{ type: 'http', name: 'api', url: 'not a url', headers: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].url',
        message: expect.stringContaining('Invalid URL'),
      });
    });

    it('rejects headers as object instead of array (common config mistake)', () => {
      const r = validateMcpServers([
        {
          type: 'http',
          name: 'api',
          url: 'https://x.test',
          headers: { Authorization: 'Bearer x' },
        },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].headers',
        message: expect.stringContaining('array of {name, value}'),
      });
    });

    it('rejects header entry missing value', () => {
      const r = validateMcpServers([
        {
          type: 'http',
          name: 'api',
          url: 'https://x.test',
          headers: [{ name: 'X' }],
        },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].headers[0].value',
        message: expect.stringContaining('Required string'),
      });
    });

    it('rejects unknown keys on http server', () => {
      const r = validateMcpServers([
        {
          type: 'http',
          name: 'api',
          url: 'https://x.test',
          headers: [],
          command: '/x',
        },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].command',
        message: expect.stringContaining('Unknown key'),
      });
    });
  });

  describe('sse servers', () => {
    it('accepts a minimal sse server', () => {
      const r = validateMcpServers([
        { type: 'sse', name: 'events', url: 'https://x.test/sse', headers: [] },
      ]);
      expect(r).toEqual({ valid: true, issues: [] });
    });
  });

  describe('type field', () => {
    it('rejects unknown transport type', () => {
      const r = validateMcpServers([
        { type: 'remote', name: 'context7', url: 'https://x.test', headers: [] },
      ]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].type',
        message: expect.stringContaining('Expected one of "stdio", "http", "sse"'),
      });
    });

    it('rejects non-string type', () => {
      const r = validateMcpServers([{ type: 1, name: 'x', command: '/x', args: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].type',
        message: expect.any(String),
      });
    });
  });

  describe('server item shape', () => {
    it('rejects non-object items', () => {
      const r = validateMcpServers(['not an object']);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0]',
        message: expect.stringContaining('Expected an object'),
      });
    });

    it('rejects missing name', () => {
      const r = validateMcpServers([{ command: '/x', args: [] }]);
      expect(r.valid).toBe(false);
      expect(r.issues).toContainEqual({
        path: '[0].name',
        message: expect.stringContaining('Required non-empty string'),
      });
    });
  });

  describe('aggregation', () => {
    it('reports issues from multiple servers and fields', () => {
      const r = validateMcpServers([
        { name: 'ok', command: '/x', args: [] },
        { name: 'bad', command: '', args: 'not-array' },
        { type: 'http', name: 'api', url: 'no', headers: {} },
      ]);
      expect(r.valid).toBe(false);
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain('[1].command');
      expect(paths).toContain('[1].args');
      expect(paths).toContain('[2].url');
      expect(paths).toContain('[2].headers');
    });
  });
});

describe('validateMcpServersJson', () => {
  it('accepts a valid JSON string', () => {
    const r = validateMcpServersJson('[]');
    expect(r).toEqual({ valid: true, issues: [] });
  });

  it('returns a single root issue on invalid JSON', () => {
    const r = validateMcpServersJson('{not json');
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([{ path: '', message: expect.stringContaining('Invalid JSON') }]);
  });

  it('forwards schema issues from the parsed payload', () => {
    const r = validateMcpServersJson(JSON.stringify([{ name: 'x' }]));
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === '[0].command')).toBe(true);
  });
});
