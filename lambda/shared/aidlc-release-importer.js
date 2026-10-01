// Importer identity for immutable AI-DLC release closures (issue #482).
//
// A closure's catalog.json is produced by the block mappers AT IMPORT TIME and
// is immutable afterwards. When a mapper learns a new field, every closure that
// was imported before the change keeps its old catalog forever — correctly,
// because existing intents are pinned to those exact bytes — but the SAME source
// SHA can only get a corrected closure under a NEW importer revision.
//
// Two things therefore identify the importer that produced a closure:
//
//   - AIDLC_RELEASE_IMPORTER_REVISION, the integer that ADDRESSES the closure
//     (`aidlc-releases/v1/<sha>/i<revision>/`). It is what lets a corrected
//     closure coexist with the one existing intents already pin.
//   - a behavioural MAPPER FINGERPRINT, recorded in the manifest from revision
//     2 on: sha256 over the catalog the mappers produce for a fixed probe corpus
//     that authors every frontmatter field the capability registry knows.
//
// Why a behavioural fingerprint rather than a hand-bumped MAPPER_REVISION
// constant alone: a constant only works if whoever edits a mapper remembers to
// bump it; a stale revision could publish a closure without the mapped policy
// fields handled by the running compatibility registry.
// Why not a hash of the catalog's field vocabulary:
// that is a property of ONE release (2.3.3 authors no `reviewClass`, so its
// vocabulary says nothing about the mapper), and it misses a mapper that maps an
// existing field to a different value. Running the real mappers over a probe
// that authors every known field catches both — a new key, a dropped key, and a
// changed value all change the digest.
//
// The fingerprint for each revision is PINNED below. The importer refuses to
// publish when the running mappers do not reproduce the pin for the revision it
// is about to write (fail closed: a mapper change without a revision bump can
// never land under an existing revision's prefix), and a reader refuses a
// manifest whose recorded fingerprint disagrees with the pin for its revision.
// The unit suite additionally pins the catalog digest of every vendored
// compatibility fixture per revision, which covers fields the probe cannot
// know about yet (a mapper for an upstream field not in the registry).
//
// Bumping procedure (also in the operator runbook): increment
// AIDLC_RELEASE_IMPORTER_REVISION, add the new revision's fingerprint to
// AIDLC_RELEASE_MAPPER_FINGERPRINTS (the failing test prints it), and update the
// per-fixture catalog goldens for the new revision. Never edit an existing
// revision's entry: published closures carry it.

import { buildFromFiles } from './block-mappers.js';
import { sha256 } from './blocks.js';
import { buildMethodologyCatalog } from './methodology-catalog.js';
import { canonicalJson } from './workflow-checkpoint.js';

// Bump whenever importer/adapter semantics change, so a re-import of the same
// SHA lands under a new prefix instead of colliding with older bytes.
//
// 1: closures carry no mapper fingerprint.
// 2: the mapper handles review_class, review_artifact, summary_confirmation,
//    fire_on, maxTurns, and per-scope execution policy, with a recorded fingerprint.
const AIDLC_RELEASE_IMPORTER_REVISION = 2;

// The first revision whose manifests MUST record a mapper fingerprint. Revision
// 1 manifests predate the field and MUST NOT carry one — their closure digests
// were computed without it.
const FIRST_FINGERPRINTED_IMPORTER_REVISION = 2;

// Pinned per importer revision. Never edit an existing entry.
const AIDLC_RELEASE_MAPPER_FINGERPRINTS = Object.freeze({
  2: '2f286898897690966ec322ca6a02d96362e765d64e661abe583a9f9acc7bb83e',
});

// Fixed and never a real upstream commit: the probe catalog's `ref`.
const MAPPER_PROBE_REF = '0000000000000000000000000000000000000000';

// A synthetic core/** tree that sends one file through every mapper branch of
// `buildFromFiles` and authors every STAGE/AGENT/SCOPE/SENSOR field the
// capability registry (aidlc-capabilities.js) classifies. The unit suite
// asserts that coverage, so a registry entry added without extending the probe
// fails CI instead of silently escaping the fingerprint.
const MAPPER_PROBE_FILES = Object.freeze([
  [
    'core/aidlc-common/stages/probe-design.md',
    [
      '---',
      'slug: probe-design',
      'name: Probe Design',
      'number: 1',
      'phase: inception',
      'condition: always',
      'lead_agent: probe-agent',
      'support_agents: [probe-reviewer]',
      'mode: pipeline',
      'execution: ALWAYS',
      'for_each: unit',
      'produces: [probe-design]',
      'optional_produces: [probe-notes]',
      'produces_kinds:',
      '  probe-design: [service]',
      'consumes:',
      '  - artifact: probe-intent',
      '    required: true',
      '    conditional_on: probe-flag',
      'requires_stage: [probe-intake]',
      'blocks_on: [probe-intake]',
      'inputs: intent',
      'outputs: design',
      'sensors: [probe-lint]',
      'reviewer: probe-reviewer',
      'reviewer_max_iterations: 2',
      'review_class: advisory',
      'review_artifact: probe-design',
      'summary_confirmation: if-present',
      'workspace_requires: true',
      'bundle: probe-bundle',
      'when:',
      '  scope: [probe-scope]',
      'required_sections: [Overview]',
      'scopes: [probe-scope]',
      '---',
      'Probe stage body.',
      '',
    ].join('\n'),
  ],
  [
    'core/aidlc-common/stages/probe-intake.md',
    [
      '---',
      'slug: probe-intake',
      'phase: initialization',
      'execution: ALWAYS',
      'produces: [probe-intent]',
      'scopes: [probe-scope]',
      '---',
      'Probe intake body.',
      '',
    ].join('\n'),
  ],
  [
    'core/agents/probe-agent.md',
    [
      '---',
      'name: probe-agent',
      'display_name: Probe Agent',
      'description: Probe lead.',
      'tier: judgment',
      'model: probe-model',
      'disallowedTools: [probe-tool]',
      'examples: [probe example]',
      'maxTurns: 7',
      'tools: [Read]',
      '---',
      'Probe agent body.',
      '',
    ].join('\n'),
  ],
  [
    'core/scopes/aidlc-probe-scope.md',
    [
      '---',
      'name: probe-scope',
      'depth: standard',
      'testStrategy: minimal',
      'keywords: [probe]',
      'description: Probe scope.',
      'sensors: off',
      'review_cap: advisory',
      'summary_confirmation: on',
      'change_control: relaxed',
      'learnings: off',
      'skeleton: on',
      'runner: probe-runner',
      '---',
      'Probe scope body.',
      '',
    ].join('\n'),
  ],
  [
    'core/sensors/aidlc-probe-lint.md',
    [
      '---',
      'id: probe-lint',
      'description: Probe sensor.',
      'kind: deterministic',
      'default_severity: blocking',
      'command: bun core/tools/aidlc-sensor-probe-lint.ts',
      'category: lint',
      'matches: ["**/*.md"]',
      'timeout_seconds: 30',
      'fire_on: gate',
      'input_schema: { type: object }',
      'output_schema: { type: object }',
      '---',
      'Probe sensor body.',
      '',
    ].join('\n'),
  ],
  ['core/tools/aidlc-sensor-probe-lint.ts', 'export const probe = true;\n'],
  ['core/rules/aidlc-org.md', 'Probe org rule.\n'],
  ['core/memory/phases/inception.md', 'Probe phase memory.\n'],
  ['core/knowledge/aidlc-shared/probe-doc.md', 'Probe knowledge.\n'],
  [
    'core/skills/aidlc-probe/SKILL.md',
    [
      '---',
      'name: aidlc-probe',
      'description: Probe skill.',
      'argument-hint: <probe>',
      'user-invocable: true',
      'classification: probe',
      '---',
      'Probe skill body.',
      '',
    ].join('\n'),
  ],
  [
    'core/templates/probe-template.md',
    ['---', 'description: Probe template.', '---', 'Probe template body.', ''].join('\n'),
  ],
]);

/**
 * The catalog the RUNNING mappers produce for the probe corpus. Deterministic:
 * no timestamps, no environment, fixed input order.
 */
const buildMapperProbeCatalog = () => {
  const { blocks, workflow, sensorScripts } = buildFromFiles(new Map(MAPPER_PROBE_FILES));
  return buildMethodologyCatalog({ ref: MAPPER_PROBE_REF, blocks, workflow, sensorScripts });
};

const computeMapperFingerprint = () => sha256(canonicalJson(buildMapperProbeCatalog()));

// Computed once per cold start; the mappers cannot change within a process.
let cachedFingerprint = null;
const currentMapperFingerprint = () => {
  cachedFingerprint ??= computeMapperFingerprint();
  return cachedFingerprint;
};

const pinnedMapperFingerprint = (importerRevision) =>
  AIDLC_RELEASE_MAPPER_FINGERPRINTS[importerRevision] ?? null;

export {
  AIDLC_RELEASE_IMPORTER_REVISION,
  AIDLC_RELEASE_MAPPER_FINGERPRINTS,
  FIRST_FINGERPRINTED_IMPORTER_REVISION,
  MAPPER_PROBE_FILES,
  MAPPER_PROBE_REF,
  buildMapperProbeCatalog,
  computeMapperFingerprint,
  currentMapperFingerprint,
  pinnedMapperFingerprint,
};

export default {
  AIDLC_RELEASE_IMPORTER_REVISION,
  AIDLC_RELEASE_MAPPER_FINGERPRINTS,
  FIRST_FINGERPRINTED_IMPORTER_REVISION,
  MAPPER_PROBE_FILES,
  MAPPER_PROBE_REF,
  buildMapperProbeCatalog,
  computeMapperFingerprint,
  currentMapperFingerprint,
  pinnedMapperFingerprint,
};
