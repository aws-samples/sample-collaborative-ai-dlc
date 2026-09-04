import { describe, it, expect } from 'vitest';
import { fetchCustomRules } from '../custom-rules.js';

// A fake S3 client. send() handles HeadObjectCommand (returns ContentLength)
// and GetObjectCommand (returns the body). Sizes default to the body's byte
// length; override per key via `sizes` to simulate an oversized object.
const fakeS3 = (byKey, { failKeys = [], sizes = {} } = {}) => ({
  send: async (cmd) => {
    const key = cmd.input.Key;
    if (failKeys.includes(key)) throw new Error(`boom ${key}`);
    const body = byKey[key] ?? '';
    if (cmd.constructor.name === 'HeadObjectCommand') {
      return { ContentLength: sizes[key] ?? Buffer.byteLength(body) };
    }
    return { Body: { transformToString: async () => body } };
  },
});

const env = { ARTIFACTS_BUCKET: 'bucket' };

describe('fetchCustomRules', () => {
  it('returns empty when no bucket or no docs', async () => {
    expect(await fetchCustomRules({ customRules: [], env })).toEqual([]);
    expect(
      await fetchCustomRules({ customRules: [{ s3Key: 'custom-rules/p/a.md' }], env: {} }),
    ).toEqual([]);
  });

  it('fetches each doc and returns { filename, body }', async () => {
    const s3 = fakeS3({
      'custom-rules/p/standards.md': 'Use tabs.',
      'custom-rules/p/api.md': 'REST only.',
    });
    const docs = await fetchCustomRules({
      customRules: [
        { filename: 'standards.md', s3Key: 'custom-rules/p/standards.md' },
        { filename: 'api.md', s3Key: 'custom-rules/p/api.md' },
      ],
      env,
      s3,
    });
    expect(docs).toEqual([
      { filename: 'standards.md', body: 'Use tabs.' },
      { filename: 'api.md', body: 'REST only.' },
    ]);
  });

  it('skips docs with unsafe keys (wrong prefix, traversal, non-.md)', async () => {
    const s3 = fakeS3({ 'custom-rules/p/ok.md': 'OK' });
    const docs = await fetchCustomRules({
      customRules: [
        { filename: 'evil', s3Key: 'other/p/evil.md' },
        { filename: 'x.txt', s3Key: 'custom-rules/p/x.txt' },
        { filename: 'ok.md', s3Key: 'custom-rules/p/ok.md' },
      ],
      env,
      s3,
    });
    expect(docs).toEqual([{ filename: 'ok.md', body: 'OK' }]);
  });

  it('best-effort: a failed fetch is skipped, others still return', async () => {
    const s3 = fakeS3({ 'custom-rules/p/ok.md': 'OK' }, { failKeys: ['custom-rules/p/bad.md'] });
    const docs = await fetchCustomRules({
      customRules: [
        { filename: 'bad.md', s3Key: 'custom-rules/p/bad.md' },
        { filename: 'ok.md', s3Key: 'custom-rules/p/ok.md' },
      ],
      env,
      s3,
      log: () => {},
    });
    expect(docs).toEqual([{ filename: 'ok.md', body: 'OK' }]);
  });

  it('skips an object that exceeds the 100 KB size cap (runtime guard)', async () => {
    const s3 = fakeS3(
      { 'custom-rules/p/big.md': 'HUGE', 'custom-rules/p/ok.md': 'OK' },
      { sizes: { 'custom-rules/p/big.md': 200 * 1024 } },
    );
    const docs = await fetchCustomRules({
      customRules: [
        { filename: 'big.md', s3Key: 'custom-rules/p/big.md' },
        { filename: 'ok.md', s3Key: 'custom-rules/p/ok.md' },
      ],
      env,
      s3,
      log: () => {},
    });
    expect(docs).toEqual([{ filename: 'ok.md', body: 'OK' }]);
  });

  it('keeps an object exactly at the cap', async () => {
    const s3 = fakeS3(
      { 'custom-rules/p/edge.md': 'EDGE' },
      { sizes: { 'custom-rules/p/edge.md': 100 * 1024 } },
    );
    const docs = await fetchCustomRules({
      customRules: [{ filename: 'edge.md', s3Key: 'custom-rules/p/edge.md' }],
      env,
      s3,
    });
    expect(docs).toEqual([{ filename: 'edge.md', body: 'EDGE' }]);
  });
});
