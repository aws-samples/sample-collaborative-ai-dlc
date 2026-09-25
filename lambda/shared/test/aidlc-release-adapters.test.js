// The release mapper vocabulary is frozen here. The 2.3.3 block and plan
// digests prove that adding newer authored fields does not change legacy plans.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import { buildFromFiles, mapAgent, mapScope, mapSensor, mapStage } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const LEGACY_BLOCKS_DIGEST = '7b8efd306c01d59a033ef10cc2d0f6586ea6bbd56c99c37816f1b0538555b4c4';
const LEGACY_PLAN_DIGESTS = Object.freeze({
  bugfix: '9db9c5796db93e77f5304b8a768ec8a776748e7bc5f52b1fcb2c9b61bd295288',
  enterprise: 'edc690e0e42fc9f954e3b28db69c6116df9a24ccf31d1471cdca523a11e22e4f',
  feature: '171302b22cf8159fe785b8255a461f039c3fcfd0812bc51737f4b1b72b6e191e',
  infra: '015c582c48f0b1fbed59811b96c24f190d86a7f537dc3cdbdfe82d8c28c4abd2',
  mvp: '6e16bb353666ff31c19b1b5e78832188b871c2414422196cac7cc64e0a735da5',
  poc: '0ecd69c9eb42c52558a71812871d2e7936f2b9b8f5767e232aeb7c6502d8bd90',
  refactor: '33ce3a3b72c42893823468339e8e87c8d468ea53038c7cdf3cc5574d2c1d3213',
  'security-patch': '9e0201f3b5051ea669a0012672c196b0f1766dfe06d8ee3a76868e7fbe7344d5',
  workshop: '3e0ceaab383f51e4b8c0ee6d5013b317321cd818ef7ad3adf2138ab6b1d653e6',
});

const fixtureFiles = (profileId) =>
  filesFromCompatibilityFixture({
    profileId,
    fixture: JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });

const keyById = (items) =>
  Object.fromEntries(
    items.filter((item) => item.id).map((item) => [item.id, { ...item, version: 1 }]),
  );

const STAGE_FM = Object.freeze({
  slug: 'demo',
  phase: 'inception',
  execution: 'ALWAYS',
  produces: ['design'],
  reviewer: 'reviewer-agent',
  reviewer_max_iterations: 3,
});

describe('legacy release byte identity', () => {
  it('keeps the 2.3.3-era blocks and plans byte-identical', () => {
    const { blocks, workflow } = buildFromFiles(fixtureFiles('current-stable'));
    expect(sha256(canonicalJson(blocks))).toBe(LEGACY_BLOCKS_DIGEST);

    const library = {
      stagesById: keyById(blocks.filter((block) => block.type === 'STAGE')),
      agentsById: keyById(blocks.filter((block) => block.type === 'AGENT')),
      sensorsById: keyById(blocks.filter((block) => block.type === 'SENSOR')),
      rulesById: keyById(blocks.filter((block) => block.type === 'RULE')),
      artifactsById: keyById(blocks.filter((block) => block.type === 'ARTIFACT')),
      scopesById: keyById(blocks.filter((block) => block.type === 'SCOPE')),
    };
    for (const [scope, expectedDigest] of Object.entries(LEGACY_PLAN_DIGESTS)) {
      for (const releaseMode of [false, true]) {
        const result = buildExecutionPlan({
          workflow: { ...workflow, version: 1 },
          scope,
          library,
          releaseMode,
        });
        expect(result.valid).toBe(true);
        expect(sha256(canonicalJson(result.plan))).toBe(expectedDigest);
        for (const stage of result.plan.stages) expect(stage.policy).toBeUndefined();
      }
    }
  });
});

describe('release mapper vocabulary', () => {
  it('maps all release-authored stage, sensor, agent, and scope fields', () => {
    expect(
      mapStage(
        {
          ...STAGE_FM,
          mode: 'pipeline',
          review_class: 'advisory',
          review_artifact: 'design',
          summary_confirmation: 'required',
        },
        '',
      ),
    ).toMatchObject({
      mode: 'pipeline',
      reviewClass: 'advisory',
      reviewArtifact: 'design',
      summaryConfirmation: 'required',
    });
    expect(mapSensor({ id: 'linter', fire_on: 'gate' }, '', 'linter').fireOn).toBe('gate');
    expect(mapAgent({ name: 'reviewer', maxTurns: '60' }, '', 'reviewer').maxTurns).toBe(60);
    expect(
      mapScope(
        {
          name: 'classic',
          depth: 'deep',
          sensors: 'off',
          review_cap: 'advisory',
          summary_confirmation: 'off',
          change_control: 'relaxed',
          learnings: 'off',
          skeleton: 'on',
          runner: false,
        },
        '',
        'classic',
      ),
    ).toMatchObject({
      sensorsPolicy: 'off',
      reviewCap: 'advisory',
      summaryConfirmation: 'off',
      changeControl: 'relaxed',
      learnings: 'off',
      skeleton: 'on',
      runner: false,
    });
  });

  it('omits every mapped addition when source frontmatter omits the field', () => {
    const stage = mapStage(STAGE_FM, '');
    for (const key of ['reviewClass', 'reviewArtifact', 'summaryConfirmation']) {
      expect(Object.hasOwn(stage, key)).toBe(false);
    }
    expect(Object.hasOwn(mapAgent({ name: 'agent' }, '', 'agent'), 'maxTurns')).toBe(false);
    expect(Object.hasOwn(mapSensor({ id: 'sensor' }, '', 'sensor'), 'fireOn')).toBe(false);
    const scope = mapScope({ name: 'feature', depth: 'standard' }, '', 'feature');
    for (const key of [
      'sensorsPolicy',
      'reviewCap',
      'summaryConfirmation',
      'changeControl',
      'learnings',
      'skeleton',
      'runner',
    ]) {
      expect(Object.hasOwn(scope, key)).toBe(false);
    }
  });
});
