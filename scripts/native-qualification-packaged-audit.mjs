import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const bytes = await fs.readFile('/fixture/packaged-source.json');
const manifest = JSON.parse(bytes);
for (const file of manifest) {
  assert.match(file.path, /^\/opt\/(?:agentcore|shared)\//);
  assert.equal(await fs.realpath(file.path), file.path, 'Packaged source must be an image file');
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(file.path))
      .digest('hex'),
    file.sha256,
    `Production image/source mismatch: ${file.path}`,
  );
}
const executor = await fs.realpath('/fixture/lambda/agentcore/native/executor.js');
assert.equal(executor, '/opt/agentcore/native/executor.js');
console.log(
  JSON.stringify({
    probe: 'packaged-production-source',
    files: manifest.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executor,
    controller: 'separate candidate Lambda adapter',
    controllerSha256: createHash('sha256')
      .update(await fs.readFile('/fixture/controller-qualification.mjs'))
      .digest('hex'),
  }),
);
