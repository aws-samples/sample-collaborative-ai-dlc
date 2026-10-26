// The 2.11.0 scope settings at the MAPPER seam: `guard_policy`, `plan_approval`,
// `collaborators` and `existing_code` must survive import, and no existing pin's
// catalog may change because they did.
//
// The scope frontmatter is the verbatim upstream 2.11.0 bytes
// (fixtures/aidlc-211-scopes.json), not a paraphrase: the read order for
// `changeControl` is the whole compatibility argument, and it can only be
// checked against what upstream actually authors.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAPPED_FRONTMATTER_FIELDS,
  filesFromCompatibilityFixture,
} from '../aidlc-compatibility.js';
import { buildReleaseBundle } from '../aidlc-release.js';
import { buildFromFiles } from '../block-mappers.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/aidlc-211-scopes.json', import.meta.url), 'utf8'),
);

const scopeBlocks = (frontmatterByPath) =>
  Object.fromEntries(
    buildFromFiles(
      new Map(
        Object.entries(frontmatterByPath).map(([path, frontmatter]) => [
          path,
          `---\n${frontmatter}\n---\n[BODY OMITTED]\n`,
        ]),
      ),
    )
      .blocks.filter((block) => block.type === 'SCOPE')
      .map((block) => [block.id, block]),
  );

const releaseScopes = scopeBlocks(
  Object.fromEntries(
    Object.entries(FIXTURE.scopes).map(([path, entry]) => [path, entry.frontmatter]),
  ),
);

describe('the 2.11.0 scope settings reach the catalog', () => {
  it('maps the guard policy, plan approval, collaborators and project type', () => {
    expect(releaseScopes.enterprise).toMatchObject({
      guardPolicy: 'strict',
      planApproval: 'on',
      collaborators: 'on',
    });
    expect(releaseScopes.express).toMatchObject({
      guardPolicy: 'off',
      planApproval: 'off',
      collaborators: 'off',
    });
    expect(releaseScopes.bugfix).toMatchObject({ guardPolicy: 'off', existingCode: true });
    expect(releaseScopes.classic.existingCode).toBeUndefined();
  });

  // `guard_policy` is upstream's rename of `change_control`. Reading the new name
  // FIRST and the old one second is what lets one resolver serve both: a 2.11
  // scope resolves from `guard_policy`, and a 2.8.2/2.9.0 scope maps to the exact
  // bytes it maps to today.
  it('resolves change control from the guard policy, then the legacy field', () => {
    expect(releaseScopes.enterprise.changeControl).toBe('strict');
    expect(releaseScopes.classic.changeControl).toBe('off');
    expect(
      scopeBlocks({ 'core/scopes/legacy.md': 'name: legacy\nchange_control: relaxed' }).legacy,
    ).toMatchObject({ changeControl: 'relaxed' });
    expect(
      scopeBlocks({ 'core/scopes/legacy.md': 'name: legacy\nchange_control: relaxed' }).legacy
        .guardPolicy,
    ).toBeUndefined();
    const absent = scopeBlocks({ 'core/scopes/bare.md': 'name: bare' }).bare;
    expect(absent.changeControl).toBeUndefined();
    expect(absent.guardPolicy).toBeUndefined();
  });

  it('names the four fields as mapped, so the analyzer stops reporting them', () => {
    expect(MAPPED_FRONTMATTER_FIELDS.SCOPE).toEqual(
      expect.arrayContaining(['guard_policy', 'plan_approval', 'collaborators', 'existing_code']),
    );
  });

  // Every setting the 2.11 scopes author is either mapped above or already
  // mapped; a new one appearing here is a field the platform would drop.
  it('leaves no 2.11 scope field unmapped', () => {
    const authored = new Set(
      Object.values(FIXTURE.scopes).flatMap((entry) =>
        entry.frontmatter
          .split('\n')
          .filter((line) => /^[a-zA-Z_]+:/.test(line))
          .map((line) => line.slice(0, line.indexOf(':'))),
      ),
    );

    expect(
      [...authored].filter((field) => !MAPPED_FRONTMATTER_FIELDS.SCOPE.includes(field)),
    ).toEqual([]);
  });
});

// Import is the boundary that decides whether a settings value exists at all,
// and `existing_code` is the one authored as a YAML BOOLEAN. These go through
// the real `buildReleaseBundle` — the entry point an admin's import calls —
// because the mapper and the plan resolver are both downstream of a check that
// rejected the real upstream bytes.
describe('the project-type boolean at the import boundary', () => {
  const PROFILE = 'v2.9.0';
  const SCOPE_PATH = 'core/scopes/aidlc-classic.md';

  const importWithProjectType = (authored) => {
    const files = filesFromCompatibilityFixture({
      profileId: PROFILE,
      fixture: JSON.parse(
        readFileSync(
          new URL(`./fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
          'utf8',
        ),
      ),
    });
    expect(files.has(SCOPE_PATH), SCOPE_PATH).toBe(true);
    files.set(
      SCOPE_PATH,
      files.get(SCOPE_PATH).replace('---\n', `---\nexisting_code: ${authored}\n`),
    );
    return buildReleaseBundle({ profileId: PROFILE, files });
  };

  const classicOf = (bundle) =>
    bundle.catalog.blocks.SCOPE.find((scope) => scope.blockId === 'classic');

  it.each([
    ['true', true],
    ['false', false],
  ])('imports the real YAML boolean %s and keeps its type', (authored, expected) => {
    const bundle = importWithProjectType(authored);

    expect(classicOf(bundle).existingCode).toBe(expected);
  });

  // A quoted boolean is NOT the same authored value: the mapper keeps the
  // caller's type, so a consumer comparing with `true` would silently drop it.
  // Refusing it at import is what keeps that from reaching a run.
  it.each(['"true"', 'maybe', '1'])('refuses the illegal project type %s', (authored) => {
    let thrown = null;
    try {
      importWithProjectType(authored);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'release_import_rejected' });
    expect(thrown.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'frontmatter_enum_invalid', field: 'existing_code' }),
      ]),
    );
  });

  it('imports every real 2.11.0 scope, including the three that author it', () => {
    const files = filesFromCompatibilityFixture({
      profileId: PROFILE,
      fixture: JSON.parse(
        readFileSync(
          new URL(`./fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
          'utf8',
        ),
      ),
    });
    for (const path of files.keys()) {
      if (path.startsWith('core/scopes/')) files.delete(path);
    }
    for (const [path, entry] of Object.entries(FIXTURE.scopes)) {
      files.set(path, `---\n${entry.frontmatter}\n---\n[BODY OMITTED]\n`);
    }

    const bundle = buildReleaseBundle({ profileId: PROFILE, files });

    const byId = Object.fromEntries(
      bundle.catalog.blocks.SCOPE.map((scope) => [scope.blockId, scope]),
    );
    expect(Object.keys(byId).toSorted()).toEqual(
      Object.values(FIXTURE.scopes)
        .map((entry) => /^name: (.+)$/m.exec(entry.frontmatter)[1])
        .toSorted(),
    );
    expect(
      Object.entries(byId)
        .filter(([, scope]) => scope.existingCode === true)
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(['bugfix', 'refactor', 'security-patch']);
  });
});
