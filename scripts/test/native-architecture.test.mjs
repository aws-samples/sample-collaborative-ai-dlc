import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeArchitectureSource, checkArchitecture } from '../lib/native-architecture.mjs';
import { nativeDependencyInventory, assertNativeRemoval } from '../lib/native-dependencies.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../../architecture/native-owners.json', import.meta.url)),
);
test('nearest-function structural complexity is deterministic and rejects a new hotspot', () => {
  const source = 'function outer(x) { if (x) return function inner(y) { if(y && x) return 1; }; }';
  const parsed = analyzeArchitectureSource('lambda/native-runtime-control/example.js', source);
  assert.deepEqual(
    parsed.functions.map((fn) => fn.score),
    [2, 2],
  );
  const hotspot = analyzeArchitectureSource(
    'lambda/native-runtime-control/example.js',
    `function hotspot(x) { ${'if(x) x++;'.repeat(20)} }`,
  );
  assert.match(
    checkArchitecture([hotspot], manifest, { functions: {} }).join('\n'),
    /Complexity 21 > 20/,
  );
  assert.equal(
    checkArchitecture([hotspot], manifest, {
      functions: { [hotspot.functions[0].key]: 21 },
    }).length,
    0,
  );
  hotspot.functions[0].score++;
  assert.equal(
    checkArchitecture([hotspot], manifest, {
      functions: { [hotspot.functions[0].key]: 21 },
    }).length,
    1,
  );
});
test('forbidden writers and mutator imports fail even when package dependencies are legal', () => {
  const parsed = analyzeArchitectureSource(
    'lambda/native-runtime-control/index.js',
    "import { createNativeExecutionStore } from './execution-store.js'; import { PutCommand } from '@aws-sdk/lib-dynamodb'; new PutCommand({});",
  );
  assert.deepEqual(checkArchitecture([parsed], manifest, { functions: {} }).length, 2);
});
test('prepared, accepted, cold-recovery and unknown references block removal without leaking answers', () => {
  const records = [
    {
      pk: 'a',
      sk: 'RUNTIME',
      status: 'READY',
      imageDigest: 'old-image',
      request: { prompt: 'private-prompt' },
    },
    {
      pk: 'b',
      sk: 'EXECUTION',
      schemaVersion: 1,
      status: 'RECOVERY_REQUIRED',
      configuration: { image: { digest: 'old-image' }, harness: 'codex' },
      response: { commandId: 'accepted-once', deliveryStatus: 'pending', text: 'private-answer' },
      recoveryCheckpoint: { id: 'cold-checkpoint' },
      recovery: { canRecover: true },
    },
    { pk: 'c', sk: 'META', status: 'FAILED' }, // v2 failure cannot imply no dependents
  ];
  const inventory = nativeDependencyInventory(records);
  assert.equal(inventory.executableReferences, 3);
  assert.doesNotMatch(JSON.stringify(inventory), /private-prompt|private-answer/);
  assert.throws(
    () => assertNativeRemoval(inventory, { admissionClosed: true, dependencies: ['old-image'] }),
    /protected dependencies/,
  );
  assert.throws(
    () =>
      assertNativeRemoval(nativeDependencyInventory([]), {
        admissionClosed: false,
        entireService: true,
        dependencies: [],
      }),
    /Close native admission/,
  );
  assert.equal(
    assertNativeRemoval(nativeDependencyInventory([]), {
      admissionClosed: true,
      entireService: true,
      dependencies: [],
    }),
    true,
  );
});
test('readable history prevents service teardown independently of executable support', () => {
  const inventory = nativeDependencyInventory([
    { pk: 'a', sk: 'PUBLICATION#1' },
    { pk: 'a', sk: 'PROMPT#request', request: { prompt: 'Private saved prompt' } },
    { pk: 'a', sk: 'EVENT#0000000000000001' },
    { pk: 'a', sk: 'ANSWER#interaction#delivered' },
  ]);
  assert.equal(inventory.executableReferences, 0);
  assert.equal(inventory.references.filter((reference) => reference.kind === 'history').length, 4);
  assert.doesNotMatch(JSON.stringify(inventory), /Private saved prompt/);
  assert.throws(
    () =>
      assertNativeRemoval(inventory, {
        admissionClosed: true,
        entireService: true,
        dependencies: [],
      }),
    /readable history/,
  );
});

test('aliases and namespace constructors cannot bypass direct-write checks', () => {
  for (const source of [
    "import { PutCommand as Hidden } from '@aws-sdk/lib-dynamodb'; new Hidden({});",
    "import * as sdk from '@aws-sdk/lib-dynamodb'; new sdk.PutCommand({});",
    "import { PutItemCommand as Hidden } from '@aws-sdk/client-dynamodb'; new Hidden({});",
  ])
    assert.equal(
      checkArchitecture(
        [analyzeArchitectureSource('lambda/native-runtime-control/index.js', source)],
        manifest,
        { functions: {} },
      ).length,
      1,
    );
  const quorum = analyzeArchitectureSource(
    'lambda/agentcore/commands/discussion-assist-start.js',
    "g.V().property('content', 'bypass');",
  );
  assert.match(
    checkArchitecture([quorum], manifest, { functions: {} }).join(''),
    /discussion owner/,
  );
  for (const source of [
    "import * as store from '../native-runtime-control/execution-store.js';",
    "export * from '../native-runtime-control/execution-store.js';",
    "const store = await import('../native-runtime-control/execution-store.js');",
  ])
    assert.equal(
      checkArchitecture([analyzeArchitectureSource('lambda/shared/bypass.js', source)], manifest, {
        functions: {},
      }).length,
      1,
    );
});
