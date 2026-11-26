// Image-build-only fixture. It is never selected by an invocation or used as
// authorization for a project's workflow source. No package code executes here.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeCommand } from './command-runner.js';
import { verifyNativeReleaseDirectory } from '../../shared/native-runtime-package.js';

if (process.env.ENABLE_NATIVE_INTERACTION_PROBE === 'true') {
  const fixture = JSON.parse(await readFile(new URL('./probe-package.json', import.meta.url)));
  const destination = '/opt/aidlc-native-probe-package';
  await mkdir(destination, { mode: 0o755 });
  for (const file of fixture.files) {
    const response = await fetch(
      `https://github.com/${fixture.source.repository}/releases/download/${fixture.source.release}/${file.name}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok || !response.body) throw new Error('Fixture download failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > file.bytes) throw new Error('Fixture asset exceeds its pinned size');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('Fixture asset does not match the verified import');
    }
    await writeFile(join(destination, file.name), bytes, {
      flag: 'wx',
      mode: file.name === 'aidlc-linux-arm64' ? 0o555 : 0o444,
    });
  }
  const report = await verifyNativeReleaseDirectory({
    directory: destination,
    source: fixture.source,
    target: 'linux-arm64',
  });
  if (report.packageId !== fixture.packageId) throw new Error('Fixture package identity differs');
  const verification = await runNativeCommand({
    command: '/usr/local/bin/gh',
    args: [
      'attestation',
      'verify',
      join(destination, 'checksums.txt'),
      '--bundle',
      join(destination, 'aidlc-release.intoto.jsonl'),
      '--repo',
      fixture.source.repository,
      '--signer-workflow',
      `${fixture.source.repository}/.github/workflows/release.yml`,
      '--source-ref',
      `refs/tags/${fixture.source.release}`,
      '--source-digest',
      fixture.source.commit,
      '--format=json',
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
      '--cert-oidc-issuer',
      'https://token.actions.githubusercontent.com',
    ],
    cwd: destination,
    env: { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', GH_PROMPT_DISABLED: '1' },
  });
  if (
    verification.exitCode !== 0 ||
    verification.timedOut ||
    verification.outputLimitExceeded ||
    !verification.cleanupComplete
  )
    throw new Error('Fixture signature verification failed');
  const result = JSON.parse(verification.stdout);
  if (!Array.isArray(result) || result.length === 0) throw new Error('Missing signature evidence');
  await writeFile(
    join(destination, 'build-verification.json'),
    JSON.stringify({
      packageId: fixture.packageId,
      materializationId: fixture.materializationId,
      signature: 'verified',
      signer: `${fixture.source.repository}/.github/workflows/release.yml`,
    }),
    { flag: 'wx', mode: 0o444 },
  );
  console.log(`Verified fixed native interaction fixture ${fixture.version}`);
}
