import { describe, it, expect, vi } from 'vitest';
import { discoverInstalledClis } from '../cli/discover.js';

describe('CLI discovery', () => {
  it('probes Claude, Kiro, and OpenCode and returns installed binaries in stable order', async () => {
    const execFileFn = vi.fn(async (command) => {
      if (command === 'kiro-cli') throw new Error('ENOENT');
      return { stdout: 'version' };
    });
    expect(await discoverInstalledClis({ execFileFn })).toEqual(['claude', 'opencode']);
    expect(execFileFn.mock.calls.map((call) => call[0])).toEqual([
      'claude',
      'kiro-cli',
      'opencode',
    ]);
    for (const call of execFileFn.mock.calls) {
      expect(call[1]).toEqual(['--version']);
    }
  });
});
