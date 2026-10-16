// Public, attested fixture assets only. The real pinned installer performs its
// signature/issuer/repository/ref checks; this helper supplies offline roots.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export async function prepareQualificationPackage(root, assets) {
  assert.ok(assets, 'The installed tier requires attested release assets');
  const pins = {
    'aidlc-linux-arm64': '18e6fefcd3591aefd66d8a485fba5deaa870c6bbc6fd3e389d4b0b2032ce9f35',
    'aidlc-runtime-2.11.0.tar.gz':
      '68906435223b47d6dfda59d79def78974d7b37e38b5649a56402a0007a41fad4',
    'version.json': '5711b7af08fc8c293576fdde9252b6b9fe13a7041f7db5f0dd33f6b56223c1e9',
    'checksums.txt': 'c49098da9ce425afbc5c5beeaae395aa8480c6f887107b0b455cc1143cac2ac9',
  };
  const directory = `${root}/packages/2.11.0`;
  const tools = `${root}/tools`;
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  await fs.mkdir(tools);
  for (const [name, hash] of Object.entries(pins)) {
    const bytes = await fs.readFile(`${assets}/${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
    await fs.writeFile(`${directory}/${name}`, bytes);
  }
  await fs.copyFile(
    `${assets}/aidlc-release.intoto.jsonl`,
    `${directory}/aidlc-release.intoto.jsonl`,
  );
  const binaryPath = `${directory}/aidlc-linux-arm64`;
  await fs.chmod(binaryPath, 0o700);
  const gh = ['/usr/bin/gh', '/usr/local/bin/gh'].find(existsSync);
  assert.ok(gh, 'The immutable image must contain the installer verifier');
  // Both paths are fixed container paths, never user-supplied shell fragments.
  assert.equal(assets, '/assets');
  await fs.writeFile(
    `${tools}/gh`,
    `#!/bin/sh\nexec ${gh} "$@" --custom-trusted-root /assets/trusted-root.jsonl\n`,
    { mode: 0o700 },
  );
  return { directory, binaryPath, tools, version: '2.11.0' };
}
