// The relative-import walk the release compatibility analyzer uses to claim a
// sensor script's dependency closure is complete, and the one the sensor
// runtime uses to materialize it, are the same function. These tests pin the
// walk; `release-script-closure.test.js` pins that the runtime calls it.

import { describe, it, expect } from 'vitest';
import {
  dependencyClosure,
  importSpecifiers,
  relativeImportCandidate,
  resolveRelativeImport,
} from '../script-closure.js';

describe('importSpecifiers', () => {
  it('reads static, named and dynamic import specifiers', () => {
    expect(
      importSpecifiers(
        [
          'import { a } from "./aidlc-lib.ts";',
          "import './side-effect.ts';",
          'const m = await import("node:fs");',
        ].join('\n'),
      ),
    ).toEqual(['./aidlc-lib.ts', './side-effect.ts', 'node:fs']);
  });
  it('reads nothing out of a body with no imports', () => {
    expect(importSpecifiers('export const x = 1;')).toEqual([]);
    expect(importSpecifiers()).toEqual([]);
  });
});

describe('relativeImportCandidate', () => {
  it('resolves a specifier against the importing file directory', () => {
    expect(relativeImportCandidate('core/tools/a.ts', './lib.ts')).toBe('core/tools/lib.ts');
    expect(relativeImportCandidate('core/tools/a.ts', '../hooks/h.ts')).toBe('core/hooks/h.ts');
  });
});

describe('resolveRelativeImport', () => {
  it('takes an extensionless specifier to the file that exists', () => {
    const files = new Map([['core/tools/lib.ts', '']]);
    expect(resolveRelativeImport(files, 'core/tools/a.ts', './lib')).toBe('core/tools/lib.ts');
  });
  it('returns the bare candidate when nothing exists, so the caller can report it', () => {
    expect(resolveRelativeImport(new Map(), 'core/tools/a.ts', './lib')).toBe('core/tools/lib');
  });
});

describe('dependencyClosure', () => {
  const files = new Map([
    ['core/tools/entry.ts', 'import { b } from "./budget.ts";\nimport "node:fs";'],
    ['core/tools/budget.ts', 'import { c } from "./shared/c.ts";'],
    ['core/tools/shared/c.ts', 'export const c = 1;'],
  ]);

  it('walks every transitive relative import', () => {
    expect(dependencyClosure(files, 'core/tools/entry.ts')).toEqual({
      files: ['core/tools/budget.ts', 'core/tools/entry.ts', 'core/tools/shared/c.ts'],
      missing: [],
      external: ['node:fs'],
      cycles: [],
    });
  });

  it('reports an import no file satisfies', () => {
    const closure = dependencyClosure(
      new Map([['core/tools/entry.ts', 'import "./gone.ts";']]),
      'core/tools/entry.ts',
    );
    expect(closure.missing).toEqual(['core/tools/gone.ts']);
  });

  it('reports a cycle instead of looping', () => {
    const closure = dependencyClosure(
      new Map([
        ['a.ts', 'import "./b.ts";'],
        ['b.ts', 'import "./a.ts";'],
      ]),
      'a.ts',
    );
    expect(closure.cycles).toEqual(['a.ts -> b.ts -> a.ts']);
  });
});
