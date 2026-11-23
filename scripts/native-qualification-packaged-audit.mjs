import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const bytes = await fs.readFile('/fixture/packaged-source.json');
const manifest = JSON.parse(bytes);
for (const file of manifest) {
  assert.match(file.path, /^\/opt\/(?:agentcore|shared|native-runtime-control)\//);
  assert.equal(await fs.realpath(file.path), file.path, 'Packaged source must be an image file');
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(file.path))
      .digest('hex'),
    file.sha256,
    `Production image/source mismatch: ${file.path}`,
  );
}
const loadedFrom = {};
for (const [role, path] of Object.entries({
  executor: 'agentcore/native/executor.js',
  activityHistory: 'native-runtime-control/activity-store.js',
  publicHandler: 'native-runtime-control/index.js',
  protectedEngine: 'native-runtime-control/workflow-engine/service.js',
  journal: 'native-runtime-control/workflow-engine/store.js',
  proofReader: 'native-runtime-control/workflow-engine/proof-reader.js',
})) {
  loadedFrom[role] = await fs.realpath(`/fixture/lambda/${path}`);
  assert.equal(loadedFrom[role], `/opt/${path}`);
}
console.log(
  JSON.stringify({
    probe: 'packaged-production-source',
    files: manifest.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...loadedFrom,
    controller: 'separate candidate Lambda adapter (authority, router and supervisor)',
    controllerSha256: createHash('sha256')
      .update(await fs.readFile('/fixture/controller-qualification.mjs'))
      .digest('hex'),
  }),
);
