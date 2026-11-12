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
import { readReleaseScriptClosure } from '../../shared/release-script-closure.js';
import { sensorScriptPath } from '../../shared/block-mappers.js';

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

describe('readReleaseScriptClosure', () => {
  const closure = {
    releaseId: 'aidlc:abc',
    runtimeFiles: new Map([['core/tools/aidlc-lib.ts', { sha256: 'd', key: 'k' }]]),
  };

  it('reads each dependency through the digest-checked release path', async () => {
    const asked = [];
    expect(
      await readReleaseScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { lib } from "./aidlc-lib.ts";',
        loadClosure: async () => closure,
        readRuntimeFile: async (given, repoPath) => {
          asked.push({ releaseId: given.releaseId, repoPath });
          return 'export const lib = 1;';
        },
      }),
    ).toEqual([{ relativePath: 'aidlc-lib.ts', content: 'export const lib = 1;' }]);
    expect(asked).toEqual([{ releaseId: 'aidlc:abc', repoPath: 'core/tools/aidlc-lib.ts' }]);
  });

  it('names an unreadable import and keeps a typed resolver error as itself', async () => {
    const raw = await readReleaseScriptClosure({
      entryPath: ENTRY,
      entryContent: 'import { lib } from "./aidlc-lib.ts";',
      loadClosure: async () => closure,
      readRuntimeFile: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      },
    }).catch((caught) => caught);
    expect(raw).toMatchObject({
      name: 'ReleaseResolverError',
      code: 'release_object_unreadable',
      details: { entryPath: ENTRY, repoPath: 'core/tools/aidlc-lib.ts', reason: 'AccessDenied' },
    });
    const typed = Object.assign(new Error('gone'), {
      name: 'ReleaseResolverError',
      code: 'runtime_file_missing',
    });
    await expect(
      readReleaseScriptClosure({
        entryPath: ENTRY,
        entryContent: 'import { lib } from "./aidlc-lib.ts";',
        loadClosure: async () => {
          throw typed;
        },
        readRuntimeFile: async () => '',
      }),
    ).rejects.toBe(typed);
  });
});

describe('createReleaseScriptClosureReader', () => {
  const methodologyRelease = { releaseId: 'aidlc:abc' };

  it('reads nothing in legacy mode, where a script is one self-contained object', () => {
    expect(createReleaseScriptClosureReader({ methodologyRelease: null })).toBeNull();
  });

  it('asks the catalog for the release sensor\u2019s closure', async () => {
    const asked = [];
    const files = [{ relativePath: 'aidlc-lib.ts', content: 'export const lib = 1;' }];
    const reader = createReleaseScriptClosureReader({
      methodologyRelease,
      releaseOwnsSensor: () => true,
      loadScriptClosure: async (input) => {
        asked.push(input);
        return files;
      },
    });
    const entryContent = 'import { lib } from "./aidlc-lib.ts";';
    expect(await reader('linter', entryContent)).toBe(files);
    expect(asked).toEqual([{ sensorId: 'linter', entryContent, methodologyRelease }]);
  });

  // In remote mode the catalog call can fail in transport or be denied; neither
  // produced a closure, so both hold the stage like an unreadable object.
  it('holds on a catalog failure that is not a release error', async () => {
    const reader = createReleaseScriptClosureReader({
      methodologyRelease,
      releaseOwnsSensor: () => true,
      loadScriptClosure: async () => {
        throw Object.assign(new Error('denied'), {
          name: 'EngineDataAccessDenied',
          code: 'catalog_key_not_allowed',
        });
      },
    });
    const error = await reader('linter', 'import "./aidlc-lib.ts";').catch((caught) => caught);
    expect(error).toMatchObject({
      name: 'ReleaseResolverError',
      code: 'release_object_unreadable',
      details: { entryPath: sensorScriptPath('linter'), reason: 'EngineDataAccessDenied' },
    });
    expect(isReleaseDependencyError(error)).toBe(true);
  });

  // A user-tenant SENSOR overlay is not part of the methodology release. Its
  // script may legitimately import the project's checked-out code, and asking
  // the release for that import reports the project as release corruption.
  it('reads no closure for a sensor the release does not own', async () => {
    const reader = createReleaseScriptClosureReader({
      methodologyRelease: { releaseId: 'aidlc:abc' },
      releaseOwnsSensor: (sensorId) => sensorId !== 'type-check',
      loadScriptClosure: async () => {
        throw new Error('must not read the closure');
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
      loadScriptClosure: async () => {
        throw new Error('must not read the closure');
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
      loadScriptClosure: ({ sensorId: id, entryContent }) =>
        readReleaseScriptClosure({
          entryPath: sensorScriptPath(id),
          entryContent,
          loadClosure: async () => ({ releaseId: profileId, runtimeFiles: runtimePaths }),
          readRuntimeFile: async (_closure, repoPath) => `// ${repoPath}`,
        }),
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
