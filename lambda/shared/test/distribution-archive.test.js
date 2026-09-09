import { describe, expect, it } from 'vitest';
import {
  buildDistributionArchive,
  extractDistributionArchive,
  safeDistributionPath,
} from '../distribution-archive.js';

describe('distribution archive', () => {
  it('round-trips binary and text files', async () => {
    const source = new Map([
      ['AGENTS.md', Buffer.from('# Harness\n')],
      ['assets/icon.bin', Buffer.from([0, 1, 2, 255])],
    ]);
    const archive = await buildDistributionArchive(source);
    const extracted = await extractDistributionArchive(archive);
    expect(extracted).toEqual(source);
  });

  it('rejects unsafe paths', () => {
    expect(() => safeDistributionPath('../secret')).toThrow(/unsafe path/);
    expect(() => safeDistributionPath('/absolute')).toThrow(/unsafe path/);
  });
});
