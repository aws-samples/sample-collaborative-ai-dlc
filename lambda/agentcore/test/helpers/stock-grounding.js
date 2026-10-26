// The REAL stock compose grounding of a published AI-DLC release.
//
// The compatibility fixtures under lambda/shared/test/fixtures/aidlc-compatibility
// carry the verbatim frontmatter of every core/ file of a release, so the
// workflow, the SCOPE vocabulary and the 33-stage catalog they compile to are
// the authentic ones. Running them through the SAME grounding builders the
// compose command uses (buildScopeGrounding + buildGroundingPack) is what lets a
// prompt-budget test assert on the grounding a real intent would receive rather
// than on a three-stage toy.

import { readFileSync } from 'node:fs';
import { filesFromCompatibilityFixture } from '../../../shared/aidlc-compatibility.js';
import { buildReleaseBundle } from '../../../shared/aidlc-release.js';
import { buildGroundingPack } from '../../../shared/compose-match.js';
import {
  effectiveAidlcSettingRows,
  scopeAidlcSettings,
} from '../../../shared/intent-aidlc-settings.js';
import { buildScopeGrounding } from '../../commands/compose-plan-start.js';

const keyById = (blocks = []) =>
  Object.fromEntries(blocks.map((block) => [block.id ?? block.blockId, block]));

const bundleFor = (profileId) =>
  buildReleaseBundle({
    profileId,
    files: filesFromCompatibilityFixture({
      profileId,
      fixture: JSON.parse(
        readFileSync(
          new URL(
            `../../../shared/test/fixtures/aidlc-compatibility/${profileId}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    }),
  });

// The grounding, the settings-awareness and the stage catalog of one release,
// assembled the way the compose command assembles them for a pinned intent.
export const stockGrounding = (profileId, { policyScope = 'bugfix' } = {}) => {
  const { workflow, blocks } = bundleFor(profileId).catalog;
  const library = {
    stagesById: keyById(blocks.STAGE),
    agentsById: keyById(blocks.AGENT),
    sensorsById: keyById(blocks.SENSOR),
    rulesById: keyById(blocks.RULE),
    artifactsById: keyById(blocks.ARTIFACT),
    knowledgeById: keyById(blocks.KNOWLEDGE),
  };
  const pack = buildScopeGrounding({ workflow, library, scopeBlocks: blocks.SCOPE });
  const settingsAware = pack.scopes.some(
    (scope) => Object.keys(scopeAidlcSettings(scope)).length > 0,
  );
  const settingsScopeBlock =
    pack.scopes.find((scope) => (scope.id ?? scope.blockId) === policyScope) ?? null;
  const grounding = buildGroundingPack({
    ...pack,
    settingsScopeId: settingsAware ? policyScope : null,
    effectiveSettings: settingsAware
      ? effectiveAidlcSettingRows(null, scopeAidlcSettings(settingsScopeBlock))
      : [],
  });
  return { grounding, settingsAware, stages: pack.stages, scopes: pack.scopes };
};

// Every row of the release's stage catalog, as the grounding renders it. A row
// the prompt drops, or keeps only the head of, is authoritative stage and
// dependency context the output contract still demands.
export const catalogRows = (grounding) =>
  grounding
    .slice(grounding.indexOf('## Stage catalog'))
    .split('\n')
    .filter((line) => line.startsWith('- '));
