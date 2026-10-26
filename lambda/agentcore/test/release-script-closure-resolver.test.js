// The sensor closure reader against the PRODUCTION release resolver.
//
// The unit tests above it inject a loader and an object reader, so they cannot
// see whether the reader calls the real resolver correctly. These publish a real
// release bundle (built from a real compatibility fixture, with real sensor and
// helper bodies) into an in-memory object store and drive the reader's DEFAULT
// `loadReleaseClosure` / `resolveRuntimeFile`. What they pin:
//
//   - a well-formed pin resolves its closure instead of being rejected before
//     storage is read;
//   - a manifest-listed object that is absent from storage is a RELEASE
//     INTEGRITY failure, not a best-effort advisory — an incompletely published
//     closure must not let a stage continue;
//   - a user-tenant SENSOR overlay, resolved through the production library
//     resolver and plan builder, is not asked for a methodology closure at all.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle } from '../../shared/aidlc-release.js';
import { blockPk, buildScriptRef, versionSk } from '../../shared/blocks.js';
import {
  __test,
  loadReleaseClosure,
  methodologyReleasePinFromManifest,
  resolveMethodologyLibrary,
} from '../../shared/release-resolver.js';
import { buildExecutionPlan } from '../../shared/v2-execution-plan.js';
import {
  createReleaseScriptClosureReader,
  releaseOwnedSensorPredicate,
} from '../release-script-closure.js';
import { createSensorRunner, isReleaseDependencyError } from '../sensor-runner.js';

const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const PROFILE = 'current-stable';
const AIDLC_LIB = 'core/tools/aidlc-lib.ts';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const store = new Map();
const getFailures = new Map();

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

// The storage failures that are NOT a missing key. The resolver converts only
// `NoSuchKey` into a typed release error; these reject with whatever the SDK or
// the body stream raised, which is what used to escape the closure reader.
const accessDenied = () => {
  const error = new Error('Access Denied');
  error.name = 'AccessDenied';
  error.$metadata = { httpStatusCode: 403 };
  return error;
};

const timeoutError = () => {
  const error = new Error('socket timed out');
  error.name = 'TimeoutError';
  return error;
};

const bodyReadFailure = () => {
  const error = new Error('aborted mid-stream');
  error.name = 'Error';
  return error;
};

// The three ways a published object the reader needs can fail to come back:
// refused, never arrived, and arrived but died while being read. Each is applied
// to a specific key through `getFailures`.
const READ_FAILURES = [
  [
    'a permissions failure',
    () => {
      throw accessDenied();
    },
  ],
  [
    'a transport failure',
    () => {
      throw timeoutError();
    },
  ],
  [
    'a body read failure',
    () => ({
      Body: {
        transformToString: async () => {
          throw bodyReadFailure();
        },
      },
    }),
  ],
];

const fixture = JSON.parse(
  readFileSync(
    new URL(`../../shared/test/fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
    'utf8',
  ),
);
const bundle = buildReleaseBundle({
  profileId: PROFILE,
  files: filesFromCompatibilityFixture({ profileId: PROFILE, fixture }),
});
const pin = methodologyReleasePinFromManifest(bundle.manifest);

// The release's own `type-check` script and the helper it imports, as published.
const typeCheckScript = fixture.files['core/tools/aidlc-sensor-type-check.ts'].content;
const aidlcLib = fixture.files[AIDLC_LIB].content;

// The real transitive closure of 2.3.3's `type-check`: the helper it imports,
// plus everything that helper imports in turn (including its type-only
// specifiers, which the walk treats as imports because the spawned interpreter
// resolves them). None of these was ever written next to the script.
const TYPE_CHECK_SIBLINGS = [
  'aidlc-audit.ts',
  'aidlc-graph.ts',
  'aidlc-lib.ts',
  'aidlc-rule-schema.ts',
  'aidlc-sensor-schema.ts',
  'aidlc-stage-schema.ts',
];

// A user-tenant SENSOR overlay whose script imports the project's checked-out
// code, which the methodology release never published and never will.
const OVERLAY_SCRIPT = 'import { ok } from "../../src/helper.ts";\nconsole.log(ok);\n';
const overlayRow = {
  pk: blockPk('default', 'SENSOR', 'type-check'),
  sk: versionSk(7),
  type: 'SENSOR',
  blockId: 'type-check',
  id: 'type-check',
  tenantId: 'default',
  version: 7,
  command: 'bun <runtime-managed>/tools/aidlc-sensor-type-check.ts',
  runtime: 'bun',
  severity: 'advisory',
  matches: '**/*.ts',
  scriptRef: buildScriptRef(OVERLAY_SCRIPT),
};

const readerFor = (sensorsById, { resolveRuntimeFile } = {}) =>
  createReleaseScriptClosureReader({
    methodologyRelease: pin,
    releaseOwnsSensor: releaseOwnedSensorPredicate(sensorsById),
    s3,
    bucket: () => BUCKET,
    ...(resolveRuntimeFile ? { resolveRuntimeFile } : {}),
  });

const TYPE_CHECK_SENSOR = Object.freeze({
  sensorId: 'type-check',
  severity: 'advisory',
  runtime: 'bun',
  command: 'bun aidlc-sensor-type-check.ts',
  matches: '**/*.ts',
  timeoutSeconds: 5,
});

let workspace = null;

const recordingSpawn = (launches) => (file, args) => {
  launches.push({ file, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('{"pass":true}'));
    child.emit('close', 0);
  }, 0);
  return child;
};

// The production sensor runner driving the production closure reader: the
// verdict is what a stage actually records, and `launches` collects every
// interpreter the runner would have started.
const runAdvisoryTypeCheck = async (launches) => {
  const runner = createSensorRunner({
    graph: null,
    loadBlockScript: async () => typeCheckScript,
    workspaceDir: workspace,
    spawnFn: recordingSpawn(launches),
    loadScriptClosure: readerFor({ 'type-check': { tenantId: 'SYSTEM' } }),
  });
  return runner.runStageSensors({ sensors: [TYPE_CHECK_SENSOR], stageId: 'code-generation' });
};

beforeEach(async () => {
  s3Mock.reset();
  ddbMock.reset();
  store.clear();
  getFailures.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    store.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (getFailures.has(input.Key)) return getFailures.get(input.Key)();
    if (!store.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => store.get(input.Key) } };
  });
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item:
      `${input.Key.pk}|${input.Key.sk}` === `${overlayRow.pk}|${overlayRow.sk}` ? overlayRow : null,
  }));
  ddbMock.on(QueryCommand).callsFake(() => ({ Items: [] }));
  // The closure cache is never invalidated in production (a closure is
  // immutable), so every test here starts from cold.
  __test.releaseClosureCache.clear();
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
  workspace = await mkdtemp(path.join(tmpdir(), 'release-closure-'));
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'export const x = 1;');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('the reader against the production resolver', () => {
  it('resolves the real helper a release sensor imports, out of the published closure', async () => {
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const closureFiles = await reader('type-check', typeCheckScript);

    expect(closureFiles.map((file) => file.relativePath).toSorted()).toEqual(TYPE_CHECK_SIBLINGS);
    expect(closureFiles.find((file) => file.relativePath === 'aidlc-lib.ts').content).toBe(
      aidlcLib,
    );
  });

  it('holds the stage when the manifest lists a dependency storage no longer has', async () => {
    const manifestEntry = bundle.manifest.runtimeFiles.find((file) => file.path === AIDLC_LIB);
    store.delete(manifestEntry.key);
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const error = await reader('type-check', typeCheckScript).catch((caught) => caught);
    expect(error).toMatchObject({ name: 'ReleaseResolverError', code: 'runtime_file_missing' });
    expect(isReleaseDependencyError(error)).toBe(true);
  });

  it('holds the stage when a published dependency no longer matches its digest', async () => {
    const manifestEntry = bundle.manifest.runtimeFiles.find((file) => file.path === AIDLC_LIB);
    store.set(manifestEntry.key, `${aidlcLib}\n// tampered\n`);
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const error = await reader('type-check', typeCheckScript).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'release_closure_mismatch' });
    expect(isReleaseDependencyError(error)).toBe(true);
  });
});

// A pinned import whose object exists but cannot be READ. The resolver only
// converts a missing key into a typed release error, so a permissions failure, a
// transport failure or a body stream that dies mid-read used to escape the
// reader raw. The sensor runner recognizes only release-dependency errors as
// fatal, so an advisory sensor whose pinned import could not be read was
// recorded BLOCKED without holding the stage — the stage continued on a check
// that never ran, while the same sensor with a MISSING import correctly held it.
describe('a pinned import the release publishes but storage cannot read', () => {
  const manifestEntryForLib = () =>
    bundle.manifest.runtimeFiles.find((file) => file.path === AIDLC_LIB);

  describe.each(READ_FAILURES)('%s', (_label, onGet) => {
    it('is a release dependency error naming the unreadable import', async () => {
      getFailures.set(manifestEntryForLib().key, onGet);
      const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

      const error = await reader('type-check', typeCheckScript).catch((caught) => caught);

      expect(error).toMatchObject({
        name: 'ReleaseResolverError',
        code: 'release_object_unreadable',
        details: { repoPath: AIDLC_LIB },
      });
      expect(error.message).toContain(AIDLC_LIB);
      expect(isReleaseDependencyError(error)).toBe(true);
    });

    // The entry script loads fine, so the sensor reaches materialization: the
    // defect is that the failure is in a dependency, not in the script itself.
    it('launches no script and holds the stage even for an advisory sensor', async () => {
      getFailures.set(manifestEntryForLib().key, onGet);
      const launches = [];

      const verdicts = await runAdvisoryTypeCheck(launches);

      expect(launches).toEqual([]);
      expect(verdicts[0]).toMatchObject({
        severity: 'advisory',
        result: 'BLOCKED',
        held: true,
        detail: {
          code: 'release_object_unreadable',
          releaseIntegrityFailure: true,
          details: { repoPath: AIDLC_LIB },
        },
      });
      await expect(readdir(path.join(workspace, '.aidlc', 'sensors'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('keeps an import storage never published on its own code', async () => {
    store.delete(manifestEntryForLib().key);
    const launches = [];

    const verdicts = await runAdvisoryTypeCheck(launches);

    expect(launches).toEqual([]);
    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: true,
      detail: { code: 'runtime_file_missing', releaseIntegrityFailure: true },
    });
  });
});

// The other half of the same defect: the closure the reader needs BEFORE it can
// resolve a single import. `loadReleaseClosure` rethrows raw storage errors and
// JSON parse failures, so an unreadable manifest escaped the reader exactly like
// an unreadable import did.
describe('a release closure storage cannot read', () => {
  describe.each(READ_FAILURES)('%s', (_label, onGet) => {
    it('is a release dependency error naming the sensor entry', async () => {
      getFailures.set(pin.manifestKey, onGet);
      const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

      const error = await reader('type-check', typeCheckScript).catch((caught) => caught);

      expect(error).toMatchObject({
        name: 'ReleaseResolverError',
        code: 'release_object_unreadable',
      });
      expect(error.details.repoPath).toBeUndefined();
      expect(isReleaseDependencyError(error)).toBe(true);
    });

    it('launches no script and holds the stage even for an advisory sensor', async () => {
      getFailures.set(pin.manifestKey, onGet);
      const launches = [];

      const verdicts = await runAdvisoryTypeCheck(launches);

      expect(launches).toEqual([]);
      expect(verdicts[0]).toMatchObject({
        severity: 'advisory',
        result: 'BLOCKED',
        held: true,
        detail: { code: 'release_object_unreadable', releaseIntegrityFailure: true },
      });
      await expect(readdir(path.join(workspace, '.aidlc', 'sensors'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });
});

// The overlay half of the provenance rule, through the real library resolver and
// the real plan builder rather than a hand-built sensor bag.
describe('a user SENSOR overlay in a pinned intent', () => {
  const resolvedLibrary = async () => {
    const closure = await loadReleaseClosure({
      s3,
      bucket: BUCKET,
      methodologyRelease: pin,
      cache: new Map(),
    });
    return resolveMethodologyLibrary({
      closure,
      ddb,
      tableName: TABLE,
      workflowId: closure.catalog.workflow.id,
      workflowVersion: 1,
      methodologyPins: { SENSOR: { 'type-check': { tenantId: 'default', version: 7 } } },
    });
  };

  const sensorEntries = ({ workflow, library }, sensorId) => {
    const scopes = [
      ...new Set(
        (workflow.placements ?? []).flatMap((placement) =>
          Object.keys(placement.scopeMembership ?? {}),
        ),
      ),
    ].toSorted();
    return scopes.flatMap((scope) =>
      (buildExecutionPlan({ workflow, scope, library }).plan?.stages ?? []).flatMap((stage) =>
        (stage.sensors ?? []).filter((sensor) => sensor.sensorId === sensorId),
      ),
    );
  };

  it('replaces the release sensor and still reaches the plan', async () => {
    const resolved = await resolvedLibrary();

    expect(resolved.library.sensorsById['type-check']).toMatchObject({ tenantId: 'default' });
    expect(sensorEntries(resolved, 'type-check').length).toBeGreaterThan(0);
  });

  it('is never asked for a methodology closure, so its project import is not corruption', async () => {
    const resolved = await resolvedLibrary();
    const read = [];
    const reader = readerFor(resolved.library.sensorsById, {
      resolveRuntimeFile: async ({ repoPath }) => {
        read.push(repoPath);
        return { content: '' };
      },
    });

    expect(await reader('type-check', OVERLAY_SCRIPT)).toEqual([]);
    expect(read).toEqual([]);
  });
});
