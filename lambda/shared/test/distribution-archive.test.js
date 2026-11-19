import { describe, expect, it } from 'vitest';
import {
  MAX_DISTRIBUTION_BYTES,
  MAX_DISTRIBUTION_FILES,
  buildDistributionArchive,
  distributionLimitError,
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

  it('archives string bodies as UTF-8', async () => {
    const extracted = await extractDistributionArchive(
      await buildDistributionArchive(new Map([['notes.md', 'café\n']])),
    );
    expect(extracted.get('notes.md').toString('utf8')).toBe('café\n');
  });
  it('builds byte-identical archives from the same files in any order', async () => {
    const files = [
      ['b/second.md', Buffer.from('two')],
      ['a/first.md', Buffer.from('one')],
    ];
    const first = await buildDistributionArchive(new Map(files));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await buildDistributionArchive(new Map(files.toReversed()));
    expect(second.equals(first)).toBe(true);
  });
  it('reports why files cannot be archived, before building', async () => {
    expect(distributionLimitError(new Map([['ok.md', Buffer.from('x')]]))).toBeNull();
    expect(distributionLimitError(new Map([['../x', Buffer.from('x')]]))).toMatch(/unsafe path/);
    const tooMany = new Map(
      Array.from({ length: MAX_DISTRIBUTION_FILES + 1 }, (_, i) => [`f${i}`, Buffer.from('')]),
    );
    expect(distributionLimitError(tooMany)).toMatch(/exceeds 1000 files/);
    await expect(buildDistributionArchive(tooMany)).rejects.toThrow(/exceeds 1000 files/);
    const tooBig = new Map([['big.bin', Buffer.alloc(MAX_DISTRIBUTION_BYTES + 1)]]);
    expect(distributionLimitError(tooBig)).toMatch(/bytes/);
  });
  it('rejects unsafe paths', () => {
    expect(() => safeDistributionPath('../secret')).toThrow(/unsafe path/);
    expect(() => safeDistributionPath('/absolute')).toThrow(/unsafe path/);
  });
});
