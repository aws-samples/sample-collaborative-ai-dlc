// Offline object-I/O probe. Synthetic delay is not an estimate of AWS latency.
// Uses the production publication owner and verifies the resulting exact bytes.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativePublications } from '../lambda/shared/native-publication.js';

const samples = 5;
const identity = {
  projectId: 'benchmark',
  executionId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  epoch: 1,
};
const range = (values) => ({
  meanMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  minMs: Math.round(Math.min(...values)),
  maxMs: Math.round(Math.max(...values)),
});
for (const files of [16, 128, 512]) {
  for (const delayMs of [0, 5]) {
    const writes = [],
      reads = [];
    let peak = 0,
      gets = 0,
      puts = 0;
    for (let sample = 0; sample < samples; sample++) {
      const objects = new Map();
      let active = 0,
        version = 0;
      const store = createNativePublications({
        bucket: 'native-benchmark',
        accountId: '123456789012',
        s3: {
          async send(command) {
            active++;
            peak = Math.max(peak, active);
            try {
              if (delayMs) await delay(delayMs);
              const p = command.input;
              if (command.constructor.name === 'PutObjectCommand') {
                puts++;
                const id = `v${++version}`;
                objects.set(`${p.Key}:${id}`, Buffer.from(p.Body));
                return { VersionId: id };
              }
              gets++;
              const content = objects.get(`${p.Key}:${p.VersionId}`);
              assert.ok(content);
              return {
                VersionId: p.VersionId,
                ContentLength: content.length,
                Body: Readable.from([content]),
              };
            } finally {
              active--;
            }
          },
        },
      });
      const start = performance.now();
      const receipt = await store.write({
        identity,
        sequence: 1,
        packageId: `sha256:${'a'.repeat(64)}`,
        nativeSessionId: 'benchmark-session',
        outcome: 'STOPPED',
        repository: { branch: 'fixture', commit: 'b'.repeat(40) },
        files: Array.from({ length: files }, (_, index) => ({
          path: `src/file-${index}.txt`,
          role: 'code',
          content: Buffer.alloc(4096, index % 256),
        })),
      });
      const uploaded = performance.now();
      const manifest = await store.read(identity, receipt, { verifyFiles: true });
      assert.equal(manifest.files.length, files);
      writes.push(uploaded - start);
      reads.push(performance.now() - uploaded);
    }
    assert.equal(gets, samples * (files + 1));
    assert.equal(puts, samples * (files + 1));
    console.log(
      JSON.stringify({
        fixture: 'public-file-upload-and-exact-verification',
        files,
        fileBytes: 4096,
        samples,
        injectedObjectDelayMs: delayMs,
        getsPerSample: gets / samples,
        putsPerSample: puts / samples,
        peakRequests: peak,
        upload: range(writes),
        verify: range(reads),
      }),
    );
  }
}
