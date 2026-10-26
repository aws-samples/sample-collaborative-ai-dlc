// A pinned sensor script's sibling imports.
//
// The release publishes a sensor script and the modules it imports as separate
// objects; the runtime wrote only the script. These tests pin that the closure
// is resolved by the analyzer's own walk, that every dependency is read through
// the digest-checked release path, and that an unpublished dependency is a named
// release integrity failure rather than a partial write.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  createReleaseScriptClosureReader,
  releaseOwnedSensorPredicate,
  resolveScriptClosure,
} from '../release-script-closure.js';
import { isReleaseDependencyError } from '../sensor-runner.js';

const ENTRY = 'core/tools/aidlc-sensor-linter.ts';

describe('resolveScriptClosure', () => {
  const publishedFiles = new Map([
    ['core/tools/aidlc-runtime-budget.ts', 'export const budget = 1;'],
    ['core/tools/aidlc-lib.ts', 'import { budget } from "./aidlc-runtime-budget.ts";'],
    ['core/shared/deep.ts', 'export const deep = 1;'],
  ]);
  const published = {
    publishes: (repoPath) => publishedFiles.has(repoPath),
    read: async (repoPath) => publishedFiles.get(repoPath),
  };

  it('resolves a transitive closure as paths relative to the script', async () => {
    expect(
      await resolveScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { lib } from "./aidlc-lib.ts";\nimport "node:fs";',
        ...published,
      }),
    ).toEqual([
      { relativePath: 'aidlc-lib.ts', content: publishedFiles.get('core/tools/aidlc-lib.ts') },
      {
        relativePath: 'aidlc-runtime-budget.ts',
        content: publishedFiles.get('core/tools/aidlc-runtime-budget.ts'),
      },
    ]);
  });

  it('keeps a dependency outside the script directory at its relative path', async () => {
    expect(
      await resolveScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { deep } from "../shared/deep.ts";',
        ...published,
      }),
    ).toEqual([{ relativePath: '../shared/deep.ts', content: 'export const deep = 1;' }]);
  });

  it('resolves nothing for a self-contained script', async () => {
    expect(
      await resolveScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { spawnSync } from "node:child_process";',
        ...published,
      }),
    ).toEqual([]);
  });

  it('fails closed, naming the dependency the release does not publish', async () => {
    const read = [];
    await expect(
      resolveScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { gone } from "./aidlc-gone.ts";',
        publishes: (repoPath) => publishedFiles.has(repoPath),
        read: async (repoPath) => {
          read.push(repoPath);
          return publishedFiles.get(repoPath);
        },
      }),
    ).rejects.toMatchObject({
      name: 'ReleaseResolverError',
      code: 'release_script_dependency_missing',
      message: expect.stringContaining('core/tools/aidlc-gone.ts'),
    });
    expect(read).toEqual([]);
  });

  it('reports the failure as a release dependency error the runner holds on', async () => {
    const error = await resolveScriptClosure({
      entryPath: ENTRY,
      entryContent: 'import "./aidlc-gone.ts";',
      ...published,
    }).catch((caught) => caught);
    expect(isReleaseDependencyError(error)).toBe(true);
  });
});

describe('createReleaseScriptClosureReader', () => {
  const closure = {
    releaseId: 'aidlc:abc',
    runtimeFiles: new Map([['core/tools/aidlc-lib.ts', { sha256: 'd', key: 'k' }]]),
  };

  it('reads nothing in legacy mode, where a script is one self-contained object', () => {
    expect(createReleaseScriptClosureReader({ methodologyRelease: null })).toBeNull();
  });

  it('reads each dependency through the digest-checked release path', async () => {
    const asked = [];
    const loaderArgs = [];
    const methodologyRelease = { releaseId: 'aidlc:abc' };
    const reader = createReleaseScriptClosureReader({
      methodologyRelease,
      releaseOwnsSensor: () => true,
      s3: 'the-client',
      bucket: () => 'the-bucket',
      loadReleaseClosure: async (args) => {
        loaderArgs.push(args);
        return closure;
      },
      resolveRuntimeFile: async ({ s3, bucket, closure: given, repoPath }) => {
        asked.push({ s3, bucket, releaseId: given.releaseId, repoPath });
        return { content: 'export const lib = 1;' };
      },
    });
    expect(await reader('linter', 'import { lib } from "./aidlc-lib.ts";')).toEqual([
      { relativePath: 'aidlc-lib.ts', content: 'export const lib = 1;' },
    ]);
    // The closure loader takes an envelope, not the pin alone: handing it the
    // pin rejects every well-formed release before storage is read.
    expect(loaderArgs).toEqual([{ s3: 'the-client', bucket: 'the-bucket', methodologyRelease }]);
    expect(asked).toEqual([
      {
        s3: 'the-client',
        bucket: 'the-bucket',
        releaseId: 'aidlc:abc',
        repoPath: 'core/tools/aidlc-lib.ts',
      },
    ]);
  });

  // A user-tenant SENSOR overlay is not part of the methodology release. Its
  // script may legitimately import the project's checked-out code, and asking
  // the release for that import reports the project as release corruption.
  it('reads no closure for a sensor the release does not own', async () => {
    const reader = createReleaseScriptClosureReader({
      methodologyRelease: { releaseId: 'aidlc:abc' },
      releaseOwnsSensor: (sensorId) => sensorId !== 'type-check',
      loadReleaseClosure: async () => {
        throw new Error('must not read the closure');
      },
      resolveRuntimeFile: async () => {
        throw new Error('must not read an object');
      },
    });
    expect(await reader('type-check', 'import { ok } from "../../src/helper.ts";')).toEqual([]);
  });

  it('refuses to build a reader that cannot tell a release sensor from an overlay', () => {
    expect(() =>
      createReleaseScriptClosureReader({ methodologyRelease: { releaseId: 'aidlc:abc' } }),
    ).toThrow(/releaseOwnsSensor is required/);
  });
});

// The provenance the reader is bound to, read off the resolved library the plan
// was built from — the release catalog as the base, user-tenant pins as the only
// overlay.
describe('releaseOwnedSensorPredicate', () => {
  it('owns a release catalog sensor and disowns a user-tenant overlay', () => {
    const owns = releaseOwnedSensorPredicate({
      linter: { id: 'linter', tenantId: 'SYSTEM' },
      'type-check': { id: 'type-check', tenantId: 'default' },
      legacy: { id: 'legacy' },
    });
    expect(owns('linter')).toBe(true);
    expect(owns('legacy')).toBe(true);
    expect(owns('type-check')).toBe(false);
  });

  it('owns a sensor the library does not carry, which cannot be an overlay', () => {
    expect(releaseOwnedSensorPredicate(undefined)('linter')).toBe(true);
  });
});

describe('createReleaseScriptClosureReader — a self-contained script', () => {
  it('reads no release object at all', async () => {
    const reader = createReleaseScriptClosureReader({
      methodologyRelease: { releaseId: 'aidlc:abc' },
      releaseOwnsSensor: () => true,
      loadReleaseClosure: async () => {
        throw new Error('must not read the closure');
      },
      resolveRuntimeFile: async () => {
        throw new Error('must not read an object');
      },
    });
    expect(await reader('linter', 'import { spawnSync } from "node:child_process";')).toEqual([]);
  });
});

// The real published bodies, and exactly which of them declare a sibling
// import. 2.9.0's document sensors and the 2.3.3 baseline's type-check all
// import `./aidlc-lib.ts`, which every release publishes as a runtime object and
// the runtime never wrote — the startup failure this change fixes. The linter
// imports nothing relative in either, so it is unaffected.
describe('the sibling imports a published release actually declares', () => {
  const fixtureFor = (profileId) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../shared/test/fixtures/aidlc-compatibility/${profileId}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );

  const scriptClosureOf = async (profileId, sensorId) => {
    const fixture = fixtureFor(profileId);
    const runtimePaths = new Set(fixture.runtimeFiles.map((file) => file.path));
    const reader = createReleaseScriptClosureReader({
      methodologyRelease: { releaseId: profileId },
      releaseOwnsSensor: () => true,
      bucket: () => 'bucket',
      loadReleaseClosure: async () => ({ releaseId: profileId, runtimeFiles: runtimePaths }),
      resolveRuntimeFile: async ({ repoPath }) => ({ content: `// ${repoPath}` }),
    });
    const script = fixture.files[`core/tools/aidlc-sensor-${sensorId}.ts`];
    expect(script, `${profileId} publishes no ${sensorId} script`).toBeTruthy();
    return reader(sensorId, script.content);
  };

  const AIDLC_LIB = [{ relativePath: 'aidlc-lib.ts', content: '// core/tools/aidlc-lib.ts' }];

  it('resolves aidlc-lib.ts for every script sensor that imports it', async () => {
    for (const [profileId, sensorId] of [
      ['v2.9.0', 'traceability'],
      ['v2.9.0', 'claim-sources'],
      ['v2.9.0', 'type-check'],
      ['current-stable', 'type-check'],
    ]) {
      expect(await scriptClosureOf(profileId, sensorId), `${profileId}/${sensorId}`).toEqual(
        AIDLC_LIB,
      );
    }
  });

  it('resolves nothing for a script sensor that imports no sibling', async () => {
    for (const profileId of ['current-stable', 'v2.9.0']) {
      expect(await scriptClosureOf(profileId, 'linter'), profileId).toEqual([]);
    }
  });
});

// A release failure the runner must hold the stage on, whatever the sensor's
// severity: the pinned check could not be run at all. `runtime_file_missing`
// is the resolver's code for a manifest-listed object that is absent from
// storage, and it carries no `release_` prefix — an incompletely published
// closure used to be classified as a best-effort loader error, which let an
// advisory sensor continue on a release that cannot be run.
describe('isReleaseDependencyError', () => {
  const resolverError = (code) => ({ name: 'ReleaseResolverError', code });

  it('holds on an unreadable, mismatched, or incompletely published closure', () => {
    for (const code of [
      'release_closure_mismatch',
      'release_object_unreadable',
      'release_script_dependency_missing',
      'runtime_file_missing',
      'unpinned_user_block',
      'user_block_missing',
    ]) {
      expect(isReleaseDependencyError(resolverError(code)), code).toBe(true);
    }
  });

  it('leaves an ordinary loader failure best-effort', () => {
    expect(isReleaseDependencyError(new Error('NoSuchKey'))).toBe(false);
    expect(isReleaseDependencyError({ name: 'Error', code: 'runtime_file_missing' })).toBe(false);
    expect(isReleaseDependencyError(null)).toBe(false);
  });
});
