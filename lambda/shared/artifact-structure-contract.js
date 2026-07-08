'use strict';

// Artifact structure contracts — the authoring half of the typed graph.
//
// The extraction REGISTRY (artifact-extractors.js) parses fenced YAML blocks
// out of artifact markdown into typed graph items. This module renders the
// matching INSTRUCTIONS the stage prompt injects for each output artifact
// type, generated from the same registry `doc` metadata — so what agents are
// told to write and what the parser reads cannot drift. A round-trip test
// (artifact-structure-contract.test.js) feeds every rendered example back
// through extractArtifactStructure and fails on any mismatch.
//
// Upstream AI-DLC methodology files are NOT modified: these contracts are a
// runtime prompt overlay, layered on top of whatever stage prose upstream
// ships. The `units:` DAG block for `unit-of-work-dependency` is included
// here too — it is scheduling-critical (parseBoltDag + a blocking sensor +
// promote-units all depend on it), so its format spec must live in-repo, not
// only in un-vendored upstream prose.

const yaml = require('js-yaml');
const { REGISTRY } = require('./artifact-extractors.js');

// Build the canonical minimal example object for a registry entry from its
// field examples. Kept as data (not a string) so the renderer and the
// round-trip test share one source.
const exampleItem = (doc) => {
  const item = {};
  for (const field of doc.fields) {
    if (field.example === undefined) continue;
    item[field.name] = field.example;
  }
  return item;
};

const exampleBlock = (key, doc) =>
  yaml.dump({ [key]: [exampleItem(doc)] }, { lineWidth: 100, noRefs: true }).trimEnd();

const fieldLine = (f) => `- \`${f.name}\`${f.required ? ' (required)' : ''} — ${f.description}`;

// The units: DAG block — hand-authored spec matching parseBoltDag
// (v2-sensor-contract.js): top-level `units:` list of { name, depends_on }.
// Enforced by the BLOCKING required-sections sensor on this artifact type:
// absent/malformed/cyclic fails the stage.
const UNITS_DAG_CONTRACT = [
  '### Structured block: `units:` (REQUIRED — the stage fails without it)',
  '',
  'Include exactly one fenced YAML block with a top-level `units:` list defining the unit-of-work DAG. It is machine-parsed to schedule the parallel construction lanes.',
  '- `name` (required) — unique kebab-case unit slug',
  '- `depends_on` — list of unit slugs this unit builds on (omit or `[]` for none; no self or unknown references, no cycles)',
  '',
  '```yaml',
  'units:',
  '  - name: auth',
  '    depends_on: []',
  '  - name: billing',
  '    depends_on: [auth]',
  '```',
].join('\n');

// Render the structure contract for one artifact type, or null when the type
// has no registered structure. Returned markdown is bounded and example-led.
const renderStructureContract = (artifactType) => {
  const spec = REGISTRY[artifactType];
  const parts = [];
  if (artifactType === 'unit-of-work-dependency') parts.push(UNITS_DAG_CONTRACT);
  if (spec?.doc) {
    parts.push(
      [
        `### Structured block: \`${spec.key}:\``,
        '',
        `${spec.doc.description} Include exactly one fenced YAML block with a top-level \`${spec.key}:\` list — it is machine-parsed into typed graph items (${spec.label}) that downstream agents query instead of re-reading the whole document.`,
        ...spec.doc.fields.map(fieldLine),
        '',
        '```yaml',
        exampleBlock(spec.key, spec.doc),
        '```',
      ].join('\n'),
    );
  }
  return parts.length ? parts.join('\n\n') : null;
};

// Render the full "Artifact structure contracts" prompt section for a stage's
// output artifact types. Null when no output has a registered structure —
// the prompt slot stays empty rather than injecting boilerplate.
const renderStructureContracts = (artifactTypes = []) => {
  const seen = new Set();
  const sections = [];
  for (const t of artifactTypes) {
    const type = String(t ?? '');
    if (!type || seen.has(type)) continue;
    seen.add(type);
    const contract = renderStructureContract(type);
    if (contract) sections.push(`## Structure contract — ${type}\n\n${contract}`);
  }
  if (!sections.length) return null;
  return [
    '# Artifact structure contracts',
    '',
    'Every artifact must use markdown with at least two `##` section headings, and cite each consumed upstream artifact by its exact slug (inline or as a `[[artifact-slug]]` wikilink).',
    'The fenced YAML blocks specified below are machine-parsed into the business graph. Place each block once, verbatim in shape; keep ids stable across revisions of the same artifact.',
    '',
    ...sections,
  ].join('\n');
};

module.exports = {
  renderStructureContract,
  renderStructureContracts,
  exampleItem,
  UNITS_DAG_CONTRACT,
};
