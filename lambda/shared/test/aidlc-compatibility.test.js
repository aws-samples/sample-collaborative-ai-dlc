import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  CompatibilityFixtureError,
  analyzeAidlcCompatibility,
  customProfile,
  fidelityGapsFromCatalog,
  filesFromCompatibilityFixture,
  isCustomProfile,
  normalizeAidlcFrontmatter,
  profileFor,
} from '../aidlc-compatibility.js';
import { parseFrontmatterStrict } from '../frontmatter.js';
import { AIDLC_CAPABILITIES, RUNTIME_HANDLERS, unhonouredValues } from '../aidlc-capabilities.js';
import { CORE_FILES } from './fixtures/repo-files.js';

const replaceFile = (files, path, transform) => {
  const copy = new Map(files);
  copy.set(path, transform(copy.get(path)));
  return copy;
};

const FIXTURE_IDS = ['current-stable', 'v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixtureFor = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );

describe('AI-DLC compatibility profiles', () => {
  it('uses exact immutable source SHAs as profile identities', () => {
    for (const profile of Object.values(AIDLC_COMPATIBILITY_PROFILES)) {
      expect(profile.upstreamRef).toMatch(/^[0-9a-f]{40}$/);
      expect(profileFor(profile.upstreamRef)).toBe(profile);
    }
  });

  it('does not infer a profile from an unknown tag or branch', () => {
    expect(profileFor('main')).toBeNull();
    expect(profileFor('v2.9')).toBeNull();
    expect(profileFor('toString')).toBeNull();
    expect(profileFor('__proto__')).toBeNull();
  });

  it('keeps the current baseline aligned with Terraform without claiming runtime certification', () => {
    const terraform = readFileSync(
      new URL('../../../terraform/variables.tf', import.meta.url),
      'utf8',
    );
    const pinned = /variable "aidlc_repo_ref"[\s\S]*?default\s*=\s*"([^"]+)"/.exec(terraform)?.[1];
    const current = AIDLC_COMPATIBILITY_PROFILES['current-stable'];

    expect(current.upstreamRef).toBe(pinned);
    expect(current.trustTier).toBe('T1');
    expect(current.compatibilityStatus).toBe('current-baseline');
  });
});

describe('offline exact-source fixtures', () => {
  it.each(FIXTURE_IDS)('%s replays without live GitHub access', (profileId) => {
    const fixture = fixtureFor(profileId);
    const profile = AIDLC_COMPATIBILITY_PROFILES[profileId];
    const files = filesFromCompatibilityFixture({ profileId, fixture });
    const report = analyzeAidlcCompatibility({ profileId, files });

    expect(fixture.source).toMatchObject({
      id: profileId,
      releaseId: profile.releaseId,
      repository: 'awslabs/aidlc-workflows',
      sha: profile.upstreamRef,
    });
    expect(profile.releaseId).toBe(`aidlc:${fixture.source.sha}`);
    expect(report).toMatchObject({
      importable: true,
      structurallyValid: true,
      dependencyClosureComplete: true,
      sensorCommandsCompatible: true,
      diagnostics: [],
    });
    expect(Object.values(report.scopePlans).every((plan) => plan.valid)).toBe(true);
    expect(report.scopes).toHaveLength(profileId === 'current-stable' ? 9 : 11);
    expect(report.normalizations).toHaveLength(
      profile.frontmatterDialect === 'invoke-template-v1' ? 6 : 0,
    );
    expect(report.currentPlatformBaseline).toBe(profileId === 'current-stable');
    // Certification reflects runtime fidelity, so a
    // release clears the bar only when no authored value is `unsupported`. With
    // the summary-confirmation checkpoint and the gate sensor plane native, every
    // pinned profile now clears it.
    expect(report.readyForCertification).toBe(true);
    expect(report.certificationGaps).toEqual([]);
  });

  it('computes mode certification gaps from the handlers registered in this build', () => {
    for (const profileId of FIXTURE_IDS) {
      const report = analyzeAidlcCompatibility({
        profileId,
        files: filesFromCompatibilityFixture({ profileId, fixture: fixtureFor(profileId) }),
      });
      const gaps = report.fidelity.gaps.map(({ blockType, field, value }) => ({
        blockType,
        field,
        value,
      }));
      expect(unhonouredValues({ fidelityGaps: gaps })).toEqual(gaps);
      const modeCapabilities = AIDLC_CAPABILITIES.find((entry) => entry.key === 'STAGE:mode');
      const modeGaps = report.certificationGaps.filter(
        (gap) => gap.blockType === 'STAGE' && gap.field === 'mode',
      );
      for (const mode of report.fidelity.fields.find((field) => field.field === 'mode')?.values ??
        []) {
        const handler = modeCapabilities.values[mode.value]?.handler;
        expect(modeGaps.some((gap) => gap.value === mode.value)).toBe(
          !handler || !RUNTIME_HANDLERS.has(handler),
        );
      }
      expect(report.readyForCertification).toBe(report.certificationGaps.length === 0);
    }
  });

  it('records runtime-file protocol capabilities and evaluates them against registered handlers', () => {
    const protocolEntries = AIDLC_CAPABILITIES.filter((entry) =>
      entry.capabilityPresentIf?.startsWith('runtimeFilePresent:'),
    );
    const runtimeFilePaths = protocolEntries.map((entry) =>
      entry.capabilityPresentIf.slice('runtimeFilePresent:'.length),
    );
    const fidelityGaps = fidelityGapsFromCatalog({
      catalog: { blocks: {} },
      bodies: [],
      runtimeFilePaths,
    });

    expect(fidelityGaps).toEqual(
      protocolEntries
        .map((entry) => ({
          blockType: entry.blockType,
          field: entry.field,
          value: 'present',
        }))
        .toSorted((left, right) =>
          `${left.blockType}:${left.field}`.localeCompare(`${right.blockType}:${right.field}`),
        ),
    );
    for (const gap of fidelityGaps) {
      const entry = protocolEntries.find(
        (candidate) => candidate.blockType === gap.blockType && candidate.field === gap.field,
      );
      const expected =
        entry.handling === 'unsupported' || !entry.handler || !RUNTIME_HANDLERS.has(entry.handler);
      expect(
        unhonouredValues({ fidelityGaps: [gap], handlers: new Set(RUNTIME_HANDLERS) }),
      ).toEqual(expected ? [gap] : []);
      if (entry.handler && RUNTIME_HANDLERS.has(entry.handler)) {
        const withoutHandler = new Set(RUNTIME_HANDLERS);
        withoutHandler.delete(entry.handler);
        expect(unhonouredValues({ fidelityGaps: [gap], handlers: withoutHandler })).toEqual([gap]);
      }
    }
  });

  it('classifies supported and unsupported stage modes per authored value', () => {
    const modeRow = (profileId) =>
      analyzeAidlcCompatibility({
        profileId,
        files: filesFromCompatibilityFixture({ profileId, fixture: fixtureFor(profileId) }),
      }).fidelity.fields.find((field) => `${field.blockType}:${field.field}` === 'STAGE:mode');

    // 2.3.3 authors only inline/subagent, so the row is fully native.
    expect(modeRow('current-stable')).toMatchObject({ handling: 'native' });
    expect(modeRow('current-stable').values.map((item) => item.value)).toEqual([
      'inline',
      'subagent',
    ]);

    // A release's classification is derived from the handlers available in this
    // build; handling can improve without changing the authored vocabulary. The
    // pipeline and mob modes run each persona in a separate session with a
    // role-scoped brief, but remain `approximated`: visibility is brief-enforced,
    // and contributions are graph artifacts rather than `.aidlc-engine/**` files.
    const row = modeRow('v2.9.0');
    expect(row.handling).toBe('approximated');
    expect(Object.fromEntries(row.values.map((item) => [item.value, item.handling]))).toEqual({
      inline: 'native',
      subagent: 'native',
      pipeline: 'approximated',
      mob: 'approximated',
    });
  });

  it('classifies the {{INVOKE}} dialect by the command families a release invokes', () => {
    const invoke = (profileId) =>
      analyzeAidlcCompatibility({
        profileId,
        files: filesFromCompatibilityFixture({ profileId, fixture: fixtureFor(profileId) }),
      }).fidelity.invokeCommands;

    // The 2.8.2/2.9.0 catalogs only ever invoke `engine sensor-<id>`, which binds
    // natively to our own sensor runner — so the dialect is not a gap for them.
    expect(invoke('v2.9.0')).toEqual([
      expect.objectContaining({ family: 'sensor-<id>', handling: 'native' }),
    ]);
    expect(invoke('current-stable')).toEqual([]);
  });

  it('treats a state-mutating engine command as unsupported', () => {
    const files = replaceFile(
      CORE_FILES,
      'core/aidlc-common/stages/ideation/intent-capture.md',
      (content) =>
        `${content}\n\nRun {{INVOKE}} engine state practices-promote before finishing.\n`,
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.fidelity.invokeCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'state', handling: 'unsupported' }),
      ]),
    );
    expect(report.certificationGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'engine-command', value: 'engine state' }),
      ]),
    );
    expect(report.readyForCertification).toBe(false);
  });

  it('defaults an unknown unmapped frontmatter key to execution-relevant', () => {
    const files = replaceFile(CORE_FILES, 'core/scopes/aidlc-feature.md', (content) =>
      content.replace('name: feature', 'name: feature\nsomething_new: yes'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.unmappedFields).toContainEqual({
      blockType: 'SCOPE',
      field: 'something_new',
      executionRelevant: true,
      paths: ['core/scopes/aidlc-feature.md'],
    });
    expect(report.certificationGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unmapped-field', field: 'something_new' }),
      ]),
    );
  });

  it('classifies every adapted field by fidelity instead of leaving it unmapped', () => {
    const reports = Object.fromEntries(
      FIXTURE_IDS.map((profileId) => {
        const fixture = fixtureFor(profileId);
        return [
          profileId,
          analyzeAidlcCompatibility({
            profileId,
            files: filesFromCompatibilityFixture({ profileId, fixture }),
          }),
        ];
      }),
    );
    const fields = (profileId) =>
      reports[profileId].unmappedFields.map(({ blockType, field }) => `${blockType}:${field}`);

    // `workspace_requires` stays on the unmapped list — no adapter reads it —
    // but it is the one key on the explicit informational allowlist, because the
    // precondition it asserts holds architecturally (every stage runs on a
    // restored checkout). It is separately classified in the fidelity table as
    // `approximated`, not `native`: holding architecturally is not the same as
    // the platform asserting the declaration per stage.
    expect(fields('current-stable')).toContain('STAGE:workspace_requires');
    for (const profileId of FIXTURE_IDS) {
      expect(reports[profileId].unmappedFields.some((field) => field.executionRelevant)).toBe(
        false,
      );
      expect(reports[profileId].fidelity.approximated).toContain('STAGE:workspace_requires');
      expect(reports[profileId].fidelity.native).not.toContain('STAGE:workspace_requires');
    }

    // `fire_on` is value-level: the write plane is still an approximation (no
    // per-write hook), the GATE plane is native (its own pass after the reviewer
    // loop, on final bytes), and 2.7.0+ author only `gate` — so the row is native.
    expect(reports['v2.7.0'].fidelity.native).toContain('SENSOR:fire_on');
    expect(reports['v2.7.0'].fidelity.unsupported).not.toContain('SENSOR:fire_on');
    expect(reports['v2.7.0'].fidelity.native).toContain('STAGE:review_artifact');
    // The scope switches are enforced by the platform now, not just explained in
    // the prompt: a fingerprint comparison for change control, and a real
    // skip of the skeleton ceremony.
    expect(reports['v2.8.2'].fidelity.approximated).toContain('SCOPE:change_control');
    expect(reports['v2.8.2'].fidelity.native).not.toContain('SCOPE:change_control');
    expect(reports['v2.9.0'].fidelity.native).toEqual(
      expect.arrayContaining(['STAGE:review_class']),
    );
    // `learnings` stays approximated by DESIGN: the ritual rides the approval gate
    // instead of taking a second mandatory human turn per stage. `change_control`
    // reproduces only the input-fingerprint half of upstream's mechanism, and
    // `skeleton` is only approximated for its `on` value — `off` is native
    // (`SCOPE.skeleton`).
    // 2.6.18+ author pipeline/mob alongside inline/subagent, so the STAGE:mode
    // row's worst-case rollup is `approximated` — it moved out
    // of the native array above into this one.
    expect(reports['v2.9.0'].fidelity.approximated).toEqual(
      expect.arrayContaining([
        'SCOPE:learnings',
        'SCOPE:change_control',
        'SCOPE:skeleton',
        'STAGE:mode',
      ]),
    );
    // SCOPE.summary_confirmation is `off` in 2.9.0: removing a requirement IS
    // something the platform can do natively, unlike imposing one.
    expect(reports['v2.9.0'].fidelity.native).toEqual(
      expect.arrayContaining(['SCOPE:sensors', 'SCOPE:summary_confirmation']),
    );
    expect(reports['v2.9.0'].fidelity.packagingOnly).toEqual(['SCOPE:runner']);
    expect(reports['v2.9.0'].fidelity.native).toEqual(
      expect.arrayContaining(['STAGE:summary_confirmation']),
    );
    expect(reports['v2.9.0'].fidelity.unsupported).toEqual([]);
    expect(reports['v2.9.0'].readyForCertification).toBe(true);
    // The 2.3.3-era baseline carries no release-policy field. It does carry
    // `mode` (native) and `workspace_requires` (approximated), so the report
    // names both rather than leaving them unclassified.
    expect(reports['current-stable'].fidelity).toMatchObject({
      native: ['STAGE:mode'],
      approximated: ['STAGE:workspace_requires'],
      unsupported: [],
      packagingOnly: [],
      gaps: [],
    });
    // An `approximated` value does not withhold certification — only `unsupported`
    // does — so the reclassification must NOT demote the baseline.
    expect(reports['current-stable'].readyForCertification).toBe(true);
  });

  it('rejects fixture source or hash metadata drift', () => {
    const sourceMismatch = fixtureFor('v2.9.0');
    sourceMismatch.source.sha = AIDLC_COMPATIBILITY_PROFILES['v2.8.2'].upstreamRef;
    expect(() =>
      filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture: sourceMismatch }),
    ).toThrowError(
      expect.objectContaining({
        name: 'CompatibilityFixtureError',
        code: 'compatibility_fixture_source_mismatch',
      }),
    );

    const hashMismatch = fixtureFor('v2.9.0');
    const [path] = Object.keys(hashMismatch.files);
    hashMismatch.files[path].originalSha256 = '0'.repeat(64);
    expect(() =>
      filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture: hashMismatch }),
    ).toThrow(CompatibilityFixtureError);
  });

  it('binds projected fixture content to the trusted profile digest', () => {
    const fixture = fixtureFor('v2.9.0');
    const path = Object.keys(fixture.files).find((item) =>
      item.startsWith('core/aidlc-common/stages/'),
    );
    fixture.files[path].content += '\nchanged locally\n';
    fixture.files[path].fixtureSha256 = sha256(fixture.files[path].content);

    expect(() => filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture })).toThrowError(
      expect.objectContaining({
        code: 'compatibility_fixture_digest_mismatch',
      }),
    );
  });

  it('rejects invalid runtime evidence metadata', () => {
    const fixture = fixtureFor('v2.9.0');
    fixture.runtimeFiles.push({ ...fixture.runtimeFiles[0] });

    expect(() => filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture })).toThrowError(
      expect.objectContaining({
        code: 'compatibility_fixture_runtime_file_invalid',
      }),
    );
  });

  it('rejects empty, non-canonical, or runtime-incomplete fixtures', () => {
    const empty = fixtureFor('v2.9.0');
    empty.files = {};
    expect(() =>
      filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture: empty }),
    ).toThrowError(expect.objectContaining({ code: 'compatibility_fixture_files_invalid' }));

    const nonCanonical = fixtureFor('v2.9.0');
    const sourcePath = Object.keys(nonCanonical.files)[0];
    nonCanonical.files['core/../shadow.md'] = { ...nonCanonical.files[sourcePath] };
    expect(() =>
      filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture: nonCanonical }),
    ).toThrowError(
      expect.objectContaining({
        code: 'compatibility_fixture_file_invalid',
        path: 'core/../shadow.md',
      }),
    );

    const runtimeIncomplete = fixtureFor('v2.9.0');
    const runtimePath = runtimeIncomplete.runtimeFiles[0].path;
    delete runtimeIncomplete.files[runtimePath];
    expect(() =>
      filesFromCompatibilityFixture({ profileId: 'v2.9.0', fixture: runtimeIncomplete }),
    ).toThrowError(
      expect.objectContaining({
        code: 'compatibility_fixture_runtime_file_invalid',
        path: runtimePath,
      }),
    );
  });
});

describe('normalizeAidlcFrontmatter', () => {
  const path = 'core/sensors/aidlc-linter.md';
  const source = `---
id: linter
kind: deterministic
command: {{INVOKE}} engine sensor-linter
default_severity: advisory
---
# Linter`;

  it('quotes the known 2.8+ invoke command before strict YAML parsing', () => {
    const result = normalizeAidlcFrontmatter({ profileId: 'v2.9.0', path, content: source });
    expect(result.error).toBeNull();
    expect(result.normalizations).toEqual([
      expect.objectContaining({ code: 'quote-invoke-command', path }),
    ]);
    expect(parseFrontmatterStrict(result.content, { path }).data.command).toBe(
      '{{INVOKE}} engine sensor-linter',
    );
  });

  it('does not apply the 2.8+ dialect to legacy profiles', () => {
    const result = normalizeAidlcFrontmatter({
      profileId: 'v2.7.0',
      path,
      content: source,
    });
    expect(result.normalizations).toEqual([]);
    expect(() => parseFrontmatterStrict(result.content, { path })).toThrowError(
      expect.objectContaining({ code: 'frontmatter_invalid_yaml' }),
    );
  });

  it('rejects unknown profiles instead of guessing', () => {
    expect(
      normalizeAidlcFrontmatter({ profileId: 'future', path, content: source }).error,
    ).toMatchObject({
      code: 'compatibility_profile_unknown',
      path,
    });
  });
});

describe('analyzeAidlcCompatibility', () => {
  it('produces deterministic evidence without changing the production importer', () => {
    const first = analyzeAidlcCompatibility({
      profileId: 'current-stable',
      files: CORE_FILES,
    });
    const second = analyzeAidlcCompatibility({
      profileId: AIDLC_COMPATIBILITY_PROFILES['current-stable'].upstreamRef,
      files: new Map([...CORE_FILES].toReversed()),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      importable: true,
      structurallyValid: false,
      dependencyClosureComplete: true,
      currentPlatformBaseline: true,
      readyForCertification: false,
      diagnostics: [],
      scopes: ['feature', 'mvp'],
    });
    expect(first.scopePlans.feature.errors).toMatchObject({
      dangling_consume: 2,
      no_unit_dag_producer: 1,
      unresolved_sensor: 1,
    });
    expect(first.scopePlans.mvp.valid).toBe(true);
    expect(first.sensors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'linter',
          scriptPresent: true,
          dependencyClosure: expect.objectContaining({ missing: [], cycles: [] }),
        }),
      ]),
    );
  });

  it('sorts failure evidence independently of Map insertion order', () => {
    const invalid = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('command: bun', 'command: [bun'),
    );
    invalid.set('core/sensors/aidlc-another.md', '---\nid: [bad\n---\nbody');
    const first = analyzeAidlcCompatibility({ profileId: 'current-stable', files: invalid });
    const second = analyzeAidlcCompatibility({
      profileId: 'current-stable',
      files: new Map([...invalid].toReversed()),
    });

    expect(first).toEqual(second);
  });

  it('reports malformed frontmatter at import time with path and position', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('command: bun', 'command: [bun'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.importable).toBe(false);
    expect(report.structurallyValid).toBe(false);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: 'frontmatter_invalid_yaml',
        severity: 'error',
        path: 'core/sensors/aidlc-linter.md',
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    ]);
  });

  it('rejects missing frontmatter and required fields before mapping', () => {
    const withoutFrontmatter = replaceFile(
      CORE_FILES,
      'core/sensors/aidlc-linter.md',
      () => '# Linter',
    );
    expect(
      analyzeAidlcCompatibility({ profileId: 'current-stable', files: withoutFrontmatter })
        .diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter_missing',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );

    const withoutCommand = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace(/^command:.*\n/m, ''),
    );
    expect(
      analyzeAidlcCompatibility({ profileId: 'current-stable', files: withoutCommand }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter_required_field_missing',
        field: 'command',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );
  });

  it('rejects non-string required identity and command fields with typed diagnostics', () => {
    const invalidId = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('id: linter', 'id: []'),
    );
    expect(
      analyzeAidlcCompatibility({ profileId: 'current-stable', files: invalidId }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter_required_field_invalid',
        field: 'id',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );

    const invalidCommand = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace(/^command:.*$/m, 'command: 1'),
    );
    expect(
      analyzeAidlcCompatibility({ profileId: 'current-stable', files: invalidCommand }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter_required_field_invalid',
        field: 'command',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );
  });

  it('rejects empty catalogs and duplicate block identities', () => {
    const empty = analyzeAidlcCompatibility({
      profileId: 'current-stable',
      files: new Map(),
    });
    expect(empty).toMatchObject({
      importable: false,
      structurallyValid: false,
      readyForCertification: false,
    });
    expect(empty.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'compatibility_files_invalid' }),
    );

    const duplicate = new Map(CORE_FILES);
    duplicate.set(
      'core/agents/duplicate-product-agent.md',
      CORE_FILES.get('core/agents/aidlc-product-agent.md'),
    );
    const duplicateReport = analyzeAidlcCompatibility({
      profileId: 'current-stable',
      files: duplicate,
    });
    expect(duplicateReport.importable).toBe(false);
    expect(duplicateReport.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_block_identity',
        field: 'AGENT:aidlc-product-agent',
      }),
    );
  });

  it('records security-relevant unmapped fields instead of certifying them silently', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('default_severity: advisory', 'default_severity: advisory\nceremony: full'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.importable).toBe(true);
    expect(report.scopePlans.mvp.valid).toBe(true);
    expect(report.readyForCertification).toBe(false);
    expect(report.unmappedFields).toContainEqual({
      blockType: 'SENSOR',
      field: 'ceremony',
      executionRelevant: true,
      paths: ['core/sensors/aidlc-linter.md'],
    });
  });

  it('adapts a known execution-relevant field instead of blocking on it', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('default_severity: advisory', 'default_severity: advisory\nfire_on: write'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.importable).toBe(true);
    expect(report.unmappedFields.map((field) => field.field)).not.toContain('fire_on');
    const entry = AIDLC_CAPABILITIES.find((candidate) => candidate.key === 'SENSOR:fire_on');
    const classification = entry.values.write;
    const handled = RUNTIME_HANDLERS.has(classification.handler);
    const field = report.fidelity.fields.find(
      (candidate) => candidate.blockType === 'SENSOR' && candidate.field === 'fire_on',
    );
    expect(field.values).toEqual([
      { value: 'write', handling: classification.handling, paths: expect.any(Array) },
    ]);
    expect(
      report.certificationGaps.some((gap) => gap.field === 'fire_on' && gap.value === 'write'),
    ).toBe(!handled);
    // The WRITE plane is a real approximation (post-agent sweep narrowed to the
    // attempt's changed files), so it is classified, not left unmapped.
    expect(report.fidelity.approximated).toContain('SENSOR:fire_on');
    expect(report.fidelity.unsupported).not.toContain('SENSOR:fire_on');
    expect(report.unmappedFields.some((unmappedField) => unmappedField.executionRelevant)).toBe(
      false,
    );
  });

  it('marks the fire_on GATE plane native, and withholds no certification for it', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('default_severity: advisory', 'default_severity: advisory\nfire_on: gate'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.importable).toBe(true);
    // The gate plane runs as its own pass after the reviewer loop resolves, once
    // per existing declared deliverable, on the bytes the human approves — so it
    // is reproduced, not merely approximated, and names a real runtime seam.
    expect(report.fidelity.native).toContain('SENSOR:fire_on');
    expect(report.fidelity.unsupported).not.toContain('SENSOR:fire_on');
    expect(report.certificationGaps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'fire_on', value: 'gate' })]),
    );
    const fireOn = report.fidelity.fields.find((field) => field.field === 'fire_on');
    expect(fireOn.values).toEqual([
      { value: 'gate', handling: 'native', paths: expect.any(Array) },
    ]);
  });

  it('fails closed on a stage mode outside the known set', () => {
    const files = replaceFile(
      CORE_FILES,
      'core/aidlc-common/stages/ideation/intent-capture.md',
      (content) => content.replace(/^mode:.*$/m, 'mode: swarm'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });

    expect(report.importable).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'frontmatter_enum_invalid', field: 'mode' }),
    );
  });

  it('fails closed on an authored field whose value is outside the adapter vocabulary', () => {
    const badSensor = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('default_severity: advisory', 'default_severity: advisory\nfire_on: always'),
    );
    const sensorReport = analyzeAidlcCompatibility({
      profileId: 'current-stable',
      files: badSensor,
    });
    expect(sensorReport.importable).toBe(false);
    expect(sensorReport.readyForCertification).toBe(false);
    expect(sensorReport.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'frontmatter_enum_invalid',
        field: 'fire_on',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );

    const badAgent = replaceFile(CORE_FILES, 'core/agents/aidlc-product-agent.md', (content) =>
      content.replace('name: aidlc-product-agent', 'name: aidlc-product-agent\nmaxTurns: 12.5'),
    );
    expect(
      analyzeAidlcCompatibility({ profileId: 'current-stable', files: badAgent }).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: 'frontmatter_enum_invalid', field: 'maxTurns' }),
    );
  });

  it('walks the transitive sensor dependency closure and reports missing files', () => {
    const files = replaceFile(
      CORE_FILES,
      'core/tools/aidlc-sensor-linter.ts',
      (content) => `import './missing-helper.ts';\n${content}`,
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });
    const linter = report.sensors.find((sensor) => sensor.id === 'linter');

    expect(report.scopePlans.mvp.valid).toBe(true);
    expect(report.dependencyClosureComplete).toBe(false);
    expect(report.readyForCertification).toBe(false);
    expect(linter.dependencyClosure.missing).toEqual(['core/tools/missing-helper.ts']);
  });

  it('normalizes 2.8+ manifests without treating candidates as the current baseline', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace(
        /command:.*aidlc-sensor-linter\.ts/,
        'command: {{INVOKE}} engine sensor-linter',
      ),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'v2.9.0', files });

    expect(report.importable).toBe(true);
    expect(report.scopePlans.mvp.valid).toBe(true);
    expect(report.normalizations).toContainEqual(
      expect.objectContaining({
        code: 'quote-invoke-command',
        path: 'core/sensors/aidlc-linter.md',
      }),
    );
    expect(report.currentPlatformBaseline).toBe(false);
    expect(report.readyForCertification).toBe(false);
  });

  it('rejects sensor commands that do not bind to the declared sensor id', () => {
    const files = replaceFile(CORE_FILES, 'core/sensors/aidlc-linter.md', (content) =>
      content.replace('aidlc-sensor-linter.ts', 'aidlc-sensor-other.ts'),
    );
    const report = analyzeAidlcCompatibility({ profileId: 'current-stable', files });
    const linter = report.sensors.find((sensor) => sensor.id === 'linter');

    expect(linter).toMatchObject({
      commandKind: 'unsupported',
      commandCompatible: false,
    });
    expect(report.sensorCommandsCompatible).toBe(false);
    expect(report.readyForCertification).toBe(false);
  });
});

// Custom fork profiles (issue #482 follow-up). The property under test: a fork
// can be analyzed, but the official allowlist stays closed, so nothing can
// resurface a fork profile by id — and a fork is always T0.
describe('custom fork profiles', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const customArgs = (over = {}) => ({
    repository: 'acme/aidlc-fork',
    sha: SHA,
    baseProfileId: 'v2.9.0',
    ...over,
  });

  it('synthesizes a frozen T0 import-only profile from an official dialect', () => {
    const profile = customProfile(customArgs());

    expect(profile).toEqual({
      id: `custom:acme/aidlc-fork@${SHA}`,
      releaseId: `aidlc-custom:acme/aidlc-fork@${SHA}`,
      upstreamRef: SHA,
      upstreamVersion: 'custom (2.9.0 dialect)',
      upstreamChannel: 'custom',
      baseProfileId: 'v2.9.0',
      frontmatterDialect: AIDLC_COMPATIBILITY_PROFILES['v2.9.0'].frontmatterDialect,
      trustTier: 'T0',
      currentPlatformBaseline: false,
      custom: true,
      sourceRepository: 'acme/aidlc-fork',
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(isCustomProfile(profile)).toBe(true);
    expect(isCustomProfile(AIDLC_COMPATIBILITY_PROFILES['v2.9.0'])).toBe(false);
  });

  it('lowercases the pinned SHA so one commit has one identity', () => {
    expect(customProfile(customArgs({ sha: SHA.toUpperCase() })).id).toBe(
      `custom:acme/aidlc-fork@${SHA}`,
    );
  });

  it('requires a full 40-hex commit SHA', () => {
    for (const sha of [SHA.slice(0, 7), 'main', `${SHA}0`, '', null, undefined]) {
      expect(() => customProfile(customArgs({ sha }))).toThrowError(/40-hex commit SHA/);
    }
  });

  it('refuses the official repository as a custom source', () => {
    expect(() => customProfile(customArgs({ repository: 'awslabs/aidlc-workflows' }))).toThrowError(
      /official repository/,
    );
  });

  it('refuses a repository that is not a validated owner/name pair', () => {
    for (const repository of ['acme', 'acme/fork/extra', 'acme/..', '../etc', '', null]) {
      expect(() => customProfile(customArgs({ repository }))).toThrow();
    }
  });

  it('requires an allowlisted official base profile for the parsing dialect', () => {
    expect(CUSTOM_BASE_PROFILE_IDS).toEqual(Object.keys(AIDLC_COMPATIBILITY_PROFILES));
    for (const baseProfileId of [
      'nope',
      'custom:acme/aidlc-fork@x',
      '__proto__',
      'toString',
      null,
      undefined,
    ]) {
      expect(() => customProfile(customArgs({ baseProfileId }))).toThrowError(
        /base dialect profile must be one of/,
      );
    }
    // A raw SHA is not a profile id: the allowlist is keyed by id only.
    expect(() =>
      customProfile(
        customArgs({ baseProfileId: AIDLC_COMPATIBILITY_PROFILES['v2.9.0'].upstreamRef }),
      ),
    ).toThrowError(/base dialect profile must be one of/);
  });

  it('keeps the official allowlist closed to custom profiles', () => {
    const profile = customProfile(customArgs());
    expect(profileFor(profile.id)).toBeNull();
    expect(profileFor(profile.releaseId)).toBeNull();
    expect(profileFor(profile.upstreamRef)).toBeNull();
    expect(Object.hasOwn(AIDLC_COMPATIBILITY_PROFILES, profile.id)).toBe(false);
  });

  it('analyzes a fork only when its profile is passed explicitly', () => {
    const profile = customProfile(customArgs({ baseProfileId: 'current-stable' }));
    // A fork's bytes are only ever as good as what it forked, so the baseline
    // fixture stands in for a fork that has not diverged structurally.
    const files = filesFromCompatibilityFixture({
      profileId: 'current-stable',
      fixture: fixtureFor('current-stable'),
    });

    expect(analyzeAidlcCompatibility({ profileId: profile.id, files })).toMatchObject({
      importable: false,
      structurallyValid: false,
      diagnostics: [expect.objectContaining({ code: 'compatibility_profile_unknown' })],
    });

    const report = analyzeAidlcCompatibility({ profileId: profile.id, profile, files });
    expect(report.profile).toBe(profile);
    expect(report.importable).toBe(true);
    expect(report.structurallyValid).toBe(true);
    expect(report.currentPlatformBaseline).toBe(false);
  });

  it('normalizes a fork with the base profile dialect', () => {
    const invokeProfile = customProfile(customArgs({ baseProfileId: 'v2.8.2' }));
    const legacyProfile = customProfile(customArgs({ baseProfileId: 'current-stable' }));
    const content = '---\ncommand: {{INVOKE}} engine sensor-linter\n---\nbody\n';

    expect(
      normalizeAidlcFrontmatter({
        profileId: invokeProfile.id,
        profile: invokeProfile,
        path: 'core/sensors/aidlc-linter.md',
        content,
      }).content,
    ).toContain('command: "{{INVOKE}} engine sensor-linter"');
    expect(
      normalizeAidlcFrontmatter({
        profileId: legacyProfile.id,
        profile: legacyProfile,
        path: 'core/sensors/aidlc-linter.md',
        content,
      }).content,
    ).toBe(content);
  });
});
