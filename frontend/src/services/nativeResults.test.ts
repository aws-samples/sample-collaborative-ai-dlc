import { expect, it } from 'vitest';
import { decodeNativeResult } from './nativeResults';
const request = {
  requestId: '10000000-0000-4000-8000-000000000001',
  publicationId: 'a'.repeat(64),
  publicationSequence: 2,
};
const valid = () => ({
  projectId: 'project',
  executionId: 'run',
  ...request,
  status: 'ready',
  download: {
    filename: 'result.zip',
    bytes: 10,
    sha256: 'c'.repeat(64),
    downloadUrl: `https://results.s3.us-east-1.amazonaws.com/native-results/v1/${'b'.repeat(64)}/${'c'.repeat(64)}?signature=example`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
});
it('accepts an exact scope-bound result without caching its bearer URL', () => {
  expect(decodeNativeResult(valid(), 'project', 'run', request).status).toBe('ready');
});
it.each([
  { projectId: 'other' },
  { executionId: 'other' },
  { publicationId: 'd'.repeat(64) },
  { publicationSequence: 3 },
  { requestId: 'another' },
])('rejects stale or foreign result identity %j', (patch) => {
  expect(() => decodeNativeResult({ ...valid(), ...patch }, 'project', 'run', request)).toThrow();
});
it.each([
  { sha256: 'wrong' },
  { bytes: 261 * 1024 * 1024 },
  { expiresAt: 'invalid' },
  { expiresAt: '2020-01-01T00:00:00Z' },
  { expiresAt: '2100-01-01T00:00:00Z' },
  { downloadUrl: 'javascript:alert(1)' },
  { downloadUrl: 'https://foreign.example/file' },
  { filename: '../escape' },
])('rejects an invalid, expired or redirected download %j', (patch) => {
  const value = valid();
  Object.assign(value.download, patch);
  expect(() => decodeNativeResult(value, 'project', 'run', request)).toThrow();
});
it('binds a binary download checksum and length to the selected file', () => {
  expect(() =>
    decodeNativeResult(valid(), 'project', 'run', request, {
      id: 'nf-' + 'd'.repeat(64),
      path: 'file.bin',
      bytes: 5,
      sha256: 'e'.repeat(64),
      role: 'code',
      mediaType: 'application/octet-stream',
    }),
  ).toThrow();
});
