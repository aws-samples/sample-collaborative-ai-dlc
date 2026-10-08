import { createHash } from 'node:crypto';
import {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  resolveCapabilities,
} from './aidlc-capabilities.js';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  OFFICIAL_AIDLC_REPOSITORY,
  customProfile,
  isCustomProfile,
  profileFor,
} from './aidlc-compatibility-profiles.js';
import { buildFromFiles } from './block-mappers.js';
import { parseFrontmatterStrict, splitFrontmatter } from './frontmatter.js';
import { buildExecutionPlan } from './v2-execution-plan.js';
import { canonicalJson } from './workflow-checkpoint.js';

const COMPATIBILITY_REPORT_SCHEMA_VERSION = 1;
const COMPATIBILITY_FIXTURE_SCHEMA_VERSION = 1;
const MAX_COMPATIBILITY_FILES = 5_000;
const MAX_COMPATIBILITY_FILE_BYTES = 5 * 1024 * 1024;
const MAX_COMPATIBILITY_TOTAL_BYTES = 50 * 1024 * 1024;

const FRONTMATTER_PATHS = Object.freeze([
  ['STAGE', 'core/aidlc-common/stages/', (path) => path.endsWith('.md')],
  ['AGENT', 'core/agents/', (path) => path.endsWith('.md')],
  ['SCOPE', 'core/scopes/', (path) => path.endsWith('.md')],
  ['SENSOR', 'core/sensors/', (path) => path.endsWith('.md')],
  ['SKILL', 'core/skills/', (path) => path.endsWith('/SKILL.md')],
  ['TEMPLATE', 'core/templates/', (path) => path.endsWith('.md')],
]);

// Fields the current mapper consumes. Everything else is evidence requiring an
// explicit adapter decision; this analyzer never silently calls it compatible.
const MAPPED_FRONTMATTER_FIELDS = Object.freeze({
  STAGE: Object.freeze([
    'slug',
    'name',
    'phase',
    'condition',
    'lead_agent',
    'support_agents',
    'mode',
    'execution',
    'for_each',
    'produces',
    'optional_produces',
    'produces_kinds',
    'consumes',
    'requires_stage',
    'blocks_on',
    'inputs',
    'outputs',
    'sensors',
    'reviewer',
    'reviewer_max_iterations',
    'review_class',
    'review_artifact',
    'summary_confirmation',
    'number',
    'bundle',
    'when',
    'required_sections',
    'scopes',
  ]),
  AGENT: Object.freeze([
    'name',
    'display_name',
    'description',
    'tier',
    'modelOverride',
    'model',
    'disallowedTools',
    'examples',
    'maxTurns',
    'tools',
  ]),
  SCOPE: Object.freeze([
    'name',
    'depth',
    'testStrategy',
    'keywords',
    'description',
    'sensors',
    'review_cap',
    'summary_confirmation',
    'change_control',
    'learnings',
    'skeleton',
    'runner',
  ]),
  SENSOR: Object.freeze([
    'id',
    'kind',
    'command',
    'default_severity',
    'description',
    'category',
    'matches',
    'timeout_seconds',
    'fire_on',
    'input_schema',
    'output_schema',
  ]),
  SKILL: Object.freeze([
    'name',
    'description',
    'argument-hint',
    'user-invocable',
    'classification',
  ]),
  TEMPLATE: Object.freeze(['description']),
});

const REQUIRED_FRONTMATTER_FIELDS = Object.freeze({
  STAGE: Object.freeze(['slug', 'phase', 'execution']),
  AGENT: Object.freeze(['name']),
  SCOPE: Object.freeze(['name']),
  SENSOR: Object.freeze(['id', 'kind', 'command']),
  SKILL: Object.freeze(['name']),
  TEMPLATE: Object.freeze([]),
});

// Unmapped frontmatter keys default to EXECUTION-RELEVANT: an unrecognized key
// in a methodology catalog is evidence of a semantic this platform does not
// reproduce, and defaulting it to "harmless" is how a release gets certified
// while quietly dropping behaviour. Only keys on this explicit allowlist are
// treated as informational, each with the reason it is safe to ignore.
//
// `workspace_requires` (present since 2.3.3 on `code-generation`) asserts that
// the stage needs the code workspace. This runtime materializes and self-heals
// the repo checkout before EVERY stage (`run-stage.js` ensureWorkspaceSource), so
// the precondition is satisfied architecturally rather than by a per-field
// adapter — see the `STAGE:workspace_requires` fidelity entry for the residual.
const INFORMATIONAL_UNMAPPED_FIELDS = new Map([
  ['workspace_requires', 'satisfied architecturally: every stage runs on a restored checkout'],
]);

// The adapter vocabulary (FRONTMATTER_ENUMS) and the per-value fidelity
// classification (FIELD_FIDELITY) both come from the capability registry in
// `aidlc-capabilities.js`, which is also what `v2-execution-plan.js` derives its
// policy vocabulary from — one table, so the analyzer and the plan resolver can
// never disagree about which values exist or how faithfully each is honoured.

// `{{INVOKE}} engine <family>` command families, classified by what this runtime
// can actually do with them. Unsupported families have no platform equivalent;
// for the `annexed` ones the annex (agentcore/prompts/invoke-dialect-annex.md)
// still tells the agent what to do instead (for a state-mutating command, record
// a recommendation for the human), which is a different outcome from upstream,
// not a reproduction of it. Approximated families have a platform equivalent the
// annex names; the per-sensor commands are native (our own sensor runner).
//
// Each pattern matches exactly the subcommands the annex answers by name. The
// engine CLI has others (`orchestrate next`, `state approve`, `worktree remove`,
// `graph compile`, `gen runners`, …); each of those stays its own unsupported
// family, so the promotion guard keeps refusing a release that invokes one.
// `annexed` marks the entries the annex answers by name; only a gap carrying it
// can be honoured, so a command no pattern matches can never pass under the name
// it happens to share.
const INVOKE_FAMILY_FIDELITY = Object.freeze([
  Object.freeze({ pattern: /^sensor-[a-z0-9-]+$/, family: 'sensor-<id>', handling: 'native' }),
  Object.freeze({
    pattern: /^gen (?:scope-table|stage-table)$/,
    family: 'gen',
    handling: 'approximated',
    note: 'Read-only reporting; the scope, stage list, inputs and outputs are already in the prompt.',
  }),
  Object.freeze({
    pattern: /^workspace (?:detect|codekb|codekb-scope-diff)$/,
    family: 'workspace',
    handling: 'approximated',
    note: 'Read-only reporting; the compose prompt carries the workspace signals the platform detected, and code knowledge reaches a stage through the compiled context and the checked-out working tree. No scope-diff identifier is minted.',
  }),
  Object.freeze({
    pattern: /^worktree(?: (?:create|merge|info))?$/,
    family: 'worktree',
    handling: 'approximated',
    note: 'The platform performs the worktree lifecycle itself. A per-unit lane runs on a unit branch the platform creates from the intent branch and checks out before the stage starts (agentcore/commands/lane.js init-lane); any other stage runs on the intent branch. The platform merges each unit branch back into the intent branch with a --no-ff merge after the unit (merge-lane), and the intent branch reaches main through its pull request; that stands in for upstream merging the Bolt branch into main. The agent never creates, merges or inspects a worktree.',
  }),
  Object.freeze({
    pattern: /^graph validate-grid$/,
    family: 'graph validate-grid',
    handling: 'approximated',
    note: 'The platform validates every compose proposal with its plan resolver (strict for an in-flight proposal) before anything is applied, and rejects an invalid grid. Not reproduced: the validator summary the agent would copy, the nearest_stock ranking, and the keyword collision check.',
  }),
  Object.freeze({
    pattern: /^graph ars$/,
    family: 'graph ars',
    handling: 'unsupported',
    annexed: true,
    note: "Upstream's Autonomy Risk Score is an advisory composite of five component scores shown to the human at the compose gate. The platform computes no composite and shows none; the annex tells the agent to justify each EXECUTE/SKIP with evidence in the proposal rationale and never to present a composite score or band. Nothing routes on the score upstream either.",
  }),
  Object.freeze({
    pattern: /^orchestrate report$/,
    family: 'orchestrate',
    handling: 'unsupported',
    annexed: true,
  }),
  Object.freeze({
    pattern: /^recompose --add$/,
    family: 'recompose',
    handling: 'unsupported',
    annexed: true,
  }),
  Object.freeze({
    pattern: /^state (?:set-construction-iteration|practices-event|practices-promote)$/,
    family: 'state',
    handling: 'unsupported',
    annexed: true,
  }),
]);

const sha256 = (value = '') => {
  const encoded =
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value ?? ''));
  return createHash('sha256').update(encoded).digest('hex');
};

const isCanonicalRepoPath = (path) => {
  if (
    typeof path !== 'string' ||
    !path.startsWith('core/') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /\p{Cc}/u.test(path)
  ) {
    return false;
  }
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
};

const sortDiagnostics = (items) =>
  items.toSorted(
    (left, right) =>
      String(left.path ?? '').localeCompare(String(right.path ?? '')) ||
      String(left.code ?? '').localeCompare(String(right.code ?? '')) ||
      String(left.field ?? '').localeCompare(String(right.field ?? '')),
  );

const sortNormalizations = (items) =>
  items.toSorted(
    (left, right) =>
      String(left.path ?? '').localeCompare(String(right.path ?? '')) ||
      String(left.code ?? '').localeCompare(String(right.code ?? '')),
  );

const inputDigest = (files) =>
  sha256(
    [...files]
      .toSorted(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([path, content]) => [String(path), sha256(content)]),
  );

class CompatibilityFixtureError extends Error {
  constructor(code, message, { path = null } = {}) {
    super(message);
    this.name = 'CompatibilityFixtureError';
    this.code = code;
    this.path = path;
  }
}

const filesFromCompatibilityFixture = ({ profileId, fixture }) => {
  const profile = profileFor(profileId);
  if (!profile) {
    throw new CompatibilityFixtureError(
      'compatibility_profile_unknown',
      `Unknown AI-DLC compatibility profile "${profileId}"`,
    );
  }
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_invalid',
      'Compatibility fixture must be an object',
    );
  }
  if (fixture.schemaVersion !== COMPATIBILITY_FIXTURE_SCHEMA_VERSION) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_schema_unsupported',
      `Compatibility fixture schema ${fixture.schemaVersion ?? '<missing>'} is unsupported`,
    );
  }
  if (fixture.source?.repository !== OFFICIAL_AIDLC_REPOSITORY) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_repository_mismatch',
      `Compatibility fixture repository must be ${OFFICIAL_AIDLC_REPOSITORY}`,
    );
  }
  if (
    fixture.source?.id !== profile.id ||
    fixture.source?.releaseId !== profile.releaseId ||
    fixture.source?.sha !== profile.upstreamRef
  ) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_source_mismatch',
      `Compatibility fixture source does not match profile ${profile.id}`,
    );
  }
  if (!fixture.files || typeof fixture.files !== 'object' || Array.isArray(fixture.files)) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_files_invalid',
      'Compatibility fixture files must be an object',
    );
  }
  const fixtureEntries = Object.entries(fixture.files);
  if (fixtureEntries.length === 0 || fixtureEntries.length > MAX_COMPATIBILITY_FILES) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_files_invalid',
      `Compatibility fixture must contain 1-${MAX_COMPATIBILITY_FILES} files`,
    );
  }
  if (
    !fixture.originalFileHashes ||
    typeof fixture.originalFileHashes !== 'object' ||
    Array.isArray(fixture.originalFileHashes)
  ) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_hashes_invalid',
      'Compatibility fixture originalFileHashes must be an object',
    );
  }
  if (!Array.isArray(fixture.runtimeFiles) || fixture.runtimeFiles.length === 0) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_runtime_invalid',
      'Compatibility fixture runtimeFiles must be a non-empty array',
    );
  }

  const files = new Map();
  let totalBytes = 0;
  for (const [path, record] of fixtureEntries.toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      !isCanonicalRepoPath(path) ||
      !record ||
      typeof record !== 'object' ||
      typeof record.content !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.fixtureSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(record.originalSha256 ?? '') ||
      sha256(record.content) !== record.fixtureSha256
    ) {
      throw new CompatibilityFixtureError(
        'compatibility_fixture_file_invalid',
        `Compatibility fixture file ${path} is invalid`,
        { path },
      );
    }
    const bytes = Buffer.byteLength(record.content);
    totalBytes += bytes;
    if (bytes > MAX_COMPATIBILITY_FILE_BYTES || totalBytes > MAX_COMPATIBILITY_TOTAL_BYTES) {
      throw new CompatibilityFixtureError(
        'compatibility_fixture_size_exceeded',
        `Compatibility fixture content exceeds the configured size limit at ${path}`,
        { path },
      );
    }
    if (fixture.originalFileHashes?.[path] !== record.originalSha256) {
      throw new CompatibilityFixtureError(
        'compatibility_fixture_hash_mismatch',
        `Compatibility fixture hash metadata disagrees for ${path}`,
        { path },
      );
    }
    files.set(path, record.content);
  }
  const runtimePaths = new Set();
  for (const runtimeFile of fixture.runtimeFiles) {
    const path = runtimeFile?.path;
    const record = files.has(path) ? fixture.files[path] : null;
    if (
      !isCanonicalRepoPath(path) ||
      !record ||
      !/^[0-9a-f]{64}$/.test(runtimeFile?.fixtureSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(runtimeFile?.originalSha256 ?? '') ||
      runtimeFile.fixtureSha256 !== record.fixtureSha256 ||
      runtimeFile.originalSha256 !== record.originalSha256 ||
      fixture.originalFileHashes[path] !== runtimeFile.originalSha256 ||
      runtimePaths.has(path)
    ) {
      throw new CompatibilityFixtureError(
        'compatibility_fixture_runtime_file_invalid',
        `Compatibility fixture runtime file ${path ?? '<missing>'} is invalid`,
        { path: path ?? null },
      );
    }
    runtimePaths.add(path);
  }
  for (const [path, hash] of Object.entries(fixture.originalFileHashes)) {
    if (!isCanonicalRepoPath(path) || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new CompatibilityFixtureError(
        'compatibility_fixture_hash_invalid',
        `Compatibility fixture original hash entry ${path} is invalid`,
        { path },
      );
    }
  }
  if (
    !/^[0-9a-f]{64}$/.test(profile.fixtureDigest ?? '') ||
    sha256(canonicalJson(fixture)) !== profile.fixtureDigest
  ) {
    throw new CompatibilityFixtureError(
      'compatibility_fixture_digest_mismatch',
      `Compatibility fixture digest does not match profile ${profile.id}`,
    );
  }
  return files;
};

const blockTypeForPath = (path) => {
  for (const [type, prefix, matches] of FRONTMATTER_PATHS) {
    if (path.startsWith(prefix) && matches(path)) return type;
  }
  return null;
};

const quoteInvokeCommand = (source) =>
  source.replace(
    /^(command:\s*)(\{\{INVOKE\}\}[^\r\n]*)$/m,
    (_match, prefix, command) => `${prefix}${JSON.stringify(command.trim())}`,
  );

const normalizeAidlcFrontmatter = ({
  profileId,
  profile: explicitProfile = null,
  path,
  content,
}) => {
  const profile = explicitProfile ?? profileFor(profileId);
  if (!profile) {
    return {
      content,
      normalizations: [],
      error: {
        code: 'compatibility_profile_unknown',
        path,
        message: `Unknown AI-DLC compatibility profile "${profileId}"`,
      },
    };
  }
  if (
    profile.frontmatterDialect !== 'invoke-template-v1' ||
    !path.startsWith('core/sensors/') ||
    !path.endsWith('.md')
  ) {
    return { content, normalizations: [], error: null };
  }

  const split = splitFrontmatter(content);
  if (!split.hasFrontmatter) return { content, normalizations: [], error: null };
  const normalizedSource = quoteInvokeCommand(split.source);
  if (normalizedSource === split.source) return { content, normalizations: [], error: null };
  return {
    content: `---\n${normalizedSource}\n---\n${split.body}`,
    normalizations: [
      {
        code: 'quote-invoke-command',
        path,
        detail: 'Quoted the 2.8+ {{INVOKE}} sensor command before YAML parsing',
      },
    ],
    error: null,
  };
};

const errorHistogram = (items = []) => {
  const counts = new Map();
  for (const item of items) {
    const code = item?.code ?? 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].toSorted(([left], [right]) => left.localeCompare(right)));
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sensorCommandContract = (sensor) => {
  const id = sensor.id;
  const command = typeof sensor.command === 'string' ? sensor.command.trim() : '';
  if (command === `{{INVOKE}} engine sensor-${id}`) {
    return { commandKind: 'native-engine', commandCompatible: true };
  }
  const legacy = new RegExp(
    `^(?:bun|node)\\s+\\{\\{HARNESS_DIR\\}\\}/tools/aidlc-sensor-${escapeRegExp(id)}\\.ts$`,
  );
  if (legacy.test(command)) {
    return { commandKind: 'legacy-script', commandCompatible: true };
  }
  return { commandKind: 'unsupported', commandCompatible: false };
};

const keyById = (items, profile) =>
  Object.fromEntries(
    items
      .filter((item) => item.id)
      .map((item) => [
        item.id,
        {
          ...item,
          version: 1,
          tenantId: 'SYSTEM',
          sourceRef: profile.upstreamRef,
        },
      ]),
  );

const importSpecifiers = (content = '') =>
  [...String(content).matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .toSorted();

const relativeImportCandidate = (path, relativePath) => {
  const parts = path.split('/');
  parts.pop();
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};

const resolveRelativeImport = (files, path, relativePath) => {
  const candidate = relativeImportCandidate(path, relativePath);
  const candidates = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    `${candidate}/index.ts`,
    `${candidate}/index.js`,
    `${candidate}/index.mjs`,
    `${candidate}/index.cjs`,
  ];
  return candidates.find((item) => files.has(item)) ?? candidate;
};

const dependencyClosure = (files, entryPath) => {
  const visited = new Set();
  const visiting = [];
  const missing = new Set();
  const external = new Set();
  const cycles = new Set();

  const walk = (path) => {
    if (visited.has(path)) return;
    const cycleIndex = visiting.indexOf(path);
    if (cycleIndex !== -1) {
      cycles.add([...visiting.slice(cycleIndex), path].join(' -> '));
      return;
    }
    const content = files.get(path);
    if (content == null) {
      missing.add(path);
      return;
    }
    visiting.push(path);
    for (const specifier of importSpecifiers(content)) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      const resolved = resolveRelativeImport(files, path, specifier);
      if (!files.has(resolved)) missing.add(resolved);
      else walk(resolved);
    }
    visiting.pop();
    visited.add(path);
  };

  walk(entryPath);
  return {
    files: [...visited].toSorted(),
    missing: [...missing].toSorted(),
    external: [...external].toSorted(),
    cycles: [...cycles].toSorted(),
  };
};

const FIDELITY_BY_KEY = new Map(
  FIELD_FIDELITY.map((entry) => [`${entry.blockType}:${entry.field}`, entry]),
);

// Worst-first severity order: a field row reports the WORST handling among the
// values the catalog actually authors, so a row can never read `native` while
// carrying an unsupported value.
const FIDELITY_RANK = Object.freeze(['native', 'packaging-only', 'approximated', 'unsupported']);
const worstHandling = (handlings) =>
  handlings.reduce(
    (worst, handling) =>
      FIDELITY_RANK.indexOf(handling) > FIDELITY_RANK.indexOf(worst) ? handling : worst,
    FIDELITY_RANK[0],
  );

const valueHandling = (entry, value) =>
  (typeof value === 'string' ? entry.values?.[value] : null) ?? entry.handling;

const invokeFamilyHandling = (command) => {
  const match = INVOKE_FAMILY_FIDELITY.find((entry) => entry.pattern.test(command));
  return match ?? { family: command, handling: 'unsupported' };
};

// Collect every `{{INVOKE}} engine <command>` a catalog carries, keyed by the
// command family, so the report can classify the engine dialect by what the
// release actually invokes instead of by the token's mere presence.
// The second word may be a `--flag`, so `recompose --add` and `recompose --remove`
// stay distinct commands.
const INVOKE_COMMAND_RE =
  /\{\{INVOKE\}\}\s+engine\s+([a-z][a-z0-9-]*(?:\s+(?:--)?[a-z][a-z0-9-]*)?)/g;

/**
 * Accumulates the same evidence one file at a time, so a caller that reads very
 * large bodies out of object storage can fold each body in and then drop it
 * instead of holding the whole closure in the heap (see `readReleaseFidelityGaps`).
 *
 * The result is independent of the order the bodies are folded in: every family,
 * command and path list is sorted on the way out, and a family's `handling` is a
 * property of the family rather than of the body it was first seen in.
 *
 * `annexReaches: false` says the prompt this body is rendered into does not carry
 * the engine-command annex, so a command found there is not answered even when
 * the annex names it.
 */
const invokeCommandCollector = () => {
  const byFamily = new Map();
  return {
    add: (path, content, { annexReaches = true } = {}) => {
      if (typeof content !== 'string') return;
      for (const match of content.matchAll(INVOKE_COMMAND_RE)) {
        const { family, handling, note = null, annexed = false } = invokeFamilyHandling(match[1]);
        const entry = byFamily.get(family) ?? {
          family,
          handling,
          note,
          annexed,
          commands: new Set(),
          paths: new Set(),
        };
        // A family is answered only if every command filed under it is, and only
        // where the annex reaches the prompt.
        entry.annexed &&= annexed && annexReaches;
        entry.commands.add(match[1]);
        entry.paths.add(path);
        byFamily.set(family, entry);
      }
    },
    commands: () =>
      [...byFamily.values()]
        .map((entry) => ({
          family: entry.family,
          handling: entry.handling,
          ...(entry.note ? { note: entry.note } : {}),
          ...(entry.annexed ? { annexed: true } : {}),
          commands: [...entry.commands].toSorted(),
          paths: [...entry.paths].toSorted(),
        }))
        .toSorted((left, right) => left.family.localeCompare(right.family)),
  };
};

const collectInvokeCommands = (files) => {
  const collector = invokeCommandCollector();
  for (const [path, content] of files) collector.add(path, content);
  return collector.commands();
};

// Build the per-profile fidelity report. `adapterFieldValues` maps
// `TYPE:field` → Map<authored value, paths[]>, so each row reports the exact
// values this catalog carries and the handling each of them gets.
const fidelityReport = (adapterFieldValues, invokeCommands) => {
  const fields = [...adapterFieldValues]
    .map(([key, byValue]) => {
      const entry = FIDELITY_BY_KEY.get(key);
      const values = [...byValue]
        .map(([value, paths]) => ({
          value,
          handling: valueHandling(entry, value),
          paths: paths.toSorted(),
        }))
        .toSorted((left, right) => String(left.value).localeCompare(String(right.value)));
      return {
        blockType: entry.blockType,
        field: entry.field,
        handling: worstHandling(values.map((item) => item.handling)),
        note: entry.note,
        values,
        paths: [...new Set(values.flatMap((item) => item.paths))].toSorted(),
      };
    })
    .toSorted(
      (left, right) =>
        left.blockType.localeCompare(right.blockType) || left.field.localeCompare(right.field),
    );
  const by = (handling) =>
    fields
      .filter((entry) => entry.handling === handling)
      .map((entry) => `${entry.blockType}:${entry.field}`);
  const gaps = [
    ...fields.flatMap((field) =>
      field.values
        .filter((item) => item.handling === 'unsupported')
        .map((item) => ({
          kind: 'frontmatter-value',
          blockType: field.blockType,
          field: field.field,
          value: item.value,
          paths: item.paths,
          note: field.note,
        })),
    ),
    ...invokeCommands
      .filter((entry) => entry.handling === 'unsupported')
      .map((entry) => ({
        kind: 'engine-command',
        blockType: 'BODY',
        field: '{{INVOKE}}',
        value: `engine ${entry.family}`,
        ...(entry.annexed ? { annexed: true } : {}),
        paths: entry.paths,
        note:
          entry.note ??
          (entry.annexed
            ? 'State-mutating engine commands have no equivalent seam; the agent records a recommendation for the human instead of performing the action.'
            : 'The annex does not answer this command: the agent is told it is unavailable, so the authored step is not performed.'),
      })),
  ].toSorted((left, right) =>
    `${left.blockType}:${left.field}:${left.value}`.localeCompare(
      `${right.blockType}:${right.field}:${right.value}`,
    ),
  );
  return {
    fields,
    native: by('native'),
    approximated: by('approximated'),
    unsupported: by('unsupported'),
    packagingOnly: by('packaging-only'),
    invokeCommands,
    gaps,
  };
};

// Re-evaluates analyzer fidelity evidence from an immutable mapped catalog and
// its content-addressed bodies. The manifest predates this projection, so these
// values stay out of its bytes and closure digest. A caller that cannot afford to
// hold every body at once folds them through `invokeCommandCollector` instead and
// hands the collected `invokeCommands` in; the gaps are identical either way.
const fidelityGapsFromCatalog = ({
  catalog,
  bodies = [],
  invokeCommands = null,
  runtimeFilePaths = [],
}) => {
  const adapterFieldValues = new Map();
  for (const capability of AIDLC_CAPABILITIES) {
    const fidelity = FIDELITY_BY_KEY.get(`${capability.blockType}:${capability.field}`);
    if (!fidelity) continue;
    const catalogField =
      capability.planKey ??
      capability.field.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    for (const block of catalog?.blocks?.[capability.blockType] ?? []) {
      const authoredValue = block[catalogField];
      if (authoredValue == null) continue;
      const value = typeof authoredValue === 'string' ? authoredValue : String(authoredValue);
      const key = `${fidelity.blockType}:${fidelity.field}`;
      const byValue = adapterFieldValues.get(key) ?? new Map();
      byValue.set(value, [...(byValue.get(value) ?? []), `closure/${block.blockId ?? block.id}`]);
      adapterFieldValues.set(key, byValue);
    }
  }
  const bodyFiles = new Map(bodies.map((body, index) => [`closure/body-${index}.md`, body]));
  const fieldGaps = fidelityReport(
    adapterFieldValues,
    invokeCommands ?? collectInvokeCommands(bodyFiles),
  ).gaps.map(({ blockType, field, value, annexed }) => ({
    blockType,
    field,
    value,
    ...(annexed ? { annexed } : {}),
  }));
  const presentCapabilities = resolveCapabilities({ runtimeFilePaths });
  const protocolGaps = AIDLC_CAPABILITIES.filter(
    (capability) =>
      capability.blockType === 'PROTOCOL' && presentCapabilities[capability.key] === true,
  ).map(({ blockType, field }) => ({ blockType, field, value: 'present' }));
  return [...fieldGaps, ...protocolGaps].toSorted((left, right) =>
    `${left.blockType}:${left.field}:${left.value}`.localeCompare(
      `${right.blockType}:${right.field}:${right.value}`,
    ),
  );
};

const protocolCertificationGaps = (runtimeFilePaths = []) => {
  const present = resolveCapabilities({ runtimeFilePaths });
  return AIDLC_CAPABILITIES.filter(
    (capability) =>
      capability.blockType === 'PROTOCOL' &&
      capability.handling === 'unsupported' &&
      present[capability.key] === true,
  ).map((capability) => ({
    kind: 'protocol',
    blockType: capability.blockType,
    field: capability.field,
    value: 'present',
    paths: [String(capability.capabilityPresentIf).replace(/^runtimeFilePresent:/, '')],
    note: capability.note,
  }));
};

// An explicit `profile` object is the custom-fork path: `profileFor` answers
// only from the closed official allowlist, so a fork must hand its synthesized
// profile in rather than be looked up by id.
const analyzeAidlcCompatibility = ({ profileId, profile: explicitProfile = null, files }) => {
  const profile = explicitProfile ?? profileFor(profileId);
  if (!profile) {
    return {
      schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
      profile: null,
      importable: false,
      structurallyValid: false,
      readyForCertification: false,
      currentPlatformBaseline: false,
      diagnostics: [
        {
          code: 'compatibility_profile_unknown',
          severity: 'error',
          message: `Unknown AI-DLC compatibility profile "${profileId}"`,
        },
      ],
    };
  }
  if (!(files instanceof Map)) {
    throw new TypeError('files must be a Map<repo-relative-path, content>');
  }

  const diagnostics = [];
  const normalizations = [];
  const unmapped = new Map();
  const adapterFieldValues = new Map();
  const sortedFiles = [...files].toSorted(([left], [right]) =>
    String(left).localeCompare(String(right)),
  );
  let totalBytes = 0;
  if (files.size === 0 || files.size > MAX_COMPATIBILITY_FILES) {
    diagnostics.push({
      code: 'compatibility_files_invalid',
      severity: 'error',
      message: `Compatibility analysis requires 1-${MAX_COMPATIBILITY_FILES} files`,
    });
  }
  for (const [path, content] of sortedFiles) {
    if (!isCanonicalRepoPath(path) || typeof content !== 'string') {
      diagnostics.push({
        code: 'compatibility_file_invalid',
        severity: 'error',
        path: typeof path === 'string' ? path : null,
        message: `Compatibility input path or content is invalid: ${String(path)}`,
      });
      continue;
    }
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (bytes > MAX_COMPATIBILITY_FILE_BYTES || totalBytes > MAX_COMPATIBILITY_TOTAL_BYTES) {
      diagnostics.push({
        code: 'compatibility_input_size_exceeded',
        severity: 'error',
        path,
        message: `Compatibility input exceeds the configured size limit at ${path}`,
      });
    }
  }
  if (diagnostics.length > 0) {
    return {
      schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
      profile,
      inputDigest: inputDigest(files),
      fileCount: files.size,
      importable: false,
      structurallyValid: false,
      readyForCertification: false,
      currentPlatformBaseline: profile.currentPlatformBaseline,
      diagnostics: sortDiagnostics(diagnostics),
      normalizations: [],
      unmappedFields: [],
    };
  }

  const normalizedFiles = new Map(sortedFiles);
  for (const [path, content] of sortedFiles) {
    const type = blockTypeForPath(path);
    if (!type) continue;
    const normalized = normalizeAidlcFrontmatter({ profileId: profile.id, profile, path, content });
    if (normalized.error) {
      diagnostics.push(normalized.error);
      continue;
    }
    normalizedFiles.set(path, normalized.content);
    normalizations.push(...normalized.normalizations);
    try {
      const split = splitFrontmatter(normalized.content);
      if (!split.hasFrontmatter && type !== 'TEMPLATE') {
        diagnostics.push({
          code: 'frontmatter_missing',
          severity: 'error',
          path,
          line: 1,
          column: 1,
          message: `${type} file ${path} has no frontmatter`,
        });
        continue;
      }
      const { data } = parseFrontmatterStrict(normalized.content, { path });
      for (const field of REQUIRED_FRONTMATTER_FIELDS[type] ?? []) {
        if (data[field] == null || data[field] === '') {
          diagnostics.push({
            code: 'frontmatter_required_field_missing',
            severity: 'error',
            path,
            field,
            line: null,
            column: null,
            message: `${type} file ${path} is missing required frontmatter field "${field}"`,
          });
        } else if (typeof data[field] !== 'string' || data[field].trim() === '') {
          diagnostics.push({
            code: 'frontmatter_required_field_invalid',
            severity: 'error',
            path,
            field,
            line: null,
            column: null,
            message: `${type} file ${path} requires frontmatter field "${field}" to be a non-empty string`,
          });
        }
      }
      const mapped = new Set(MAPPED_FRONTMATTER_FIELDS[type] ?? []);
      const enums = FRONTMATTER_ENUMS[type] ?? {};
      for (const [field, allowed] of Object.entries(enums)) {
        const value = data[field];
        if (value == null) continue;
        if (typeof value !== 'string' || !allowed.includes(value)) {
          diagnostics.push({
            code: 'frontmatter_enum_invalid',
            severity: 'error',
            path,
            field,
            line: null,
            column: null,
            message: `${type} file ${path} declares ${field} "${String(value)}"; allowed: ${allowed.join(' | ')}`,
          });
        }
      }
      if (type === 'AGENT' && data.maxTurns != null) {
        const turns = typeof data.maxTurns === 'string' ? Number(data.maxTurns) : data.maxTurns;
        if (!Number.isInteger(turns) || turns < 1) {
          diagnostics.push({
            code: 'frontmatter_enum_invalid',
            severity: 'error',
            path,
            field: 'maxTurns',
            line: null,
            column: null,
            message: `AGENT file ${path} requires maxTurns to be a positive decimal integer`,
          });
        }
      }
      if (type === 'STAGE' && data.review_artifact != null) {
        const produces = Array.isArray(data.produces) ? data.produces : [];
        if (typeof data.review_artifact !== 'string' || !produces.includes(data.review_artifact)) {
          diagnostics.push({
            code: 'frontmatter_enum_invalid',
            severity: 'error',
            path,
            field: 'review_artifact',
            line: null,
            column: null,
            message: `STAGE file ${path} names review_artifact "${String(data.review_artifact)}", which is not one of its required produces`,
          });
        }
      }
      for (const field of Object.keys(data)) {
        if (FIDELITY_BY_KEY.has(`${type}:${field}`)) {
          const key = `${type}:${field}`;
          const byValue = adapterFieldValues.get(key) ?? new Map();
          const value = typeof data[field] === 'string' ? data[field] : String(data[field]);
          byValue.set(value, [...(byValue.get(value) ?? []), path]);
          adapterFieldValues.set(key, byValue);
        }
        if (mapped.has(field)) continue;
        const key = `${type}:${field}`;
        const entry = unmapped.get(key) ?? {
          blockType: type,
          field,
          // Fail closed: only the explicit informational allowlist is exempt.
          executionRelevant: !INFORMATIONAL_UNMAPPED_FIELDS.has(field),
          paths: [],
        };
        entry.paths.push(path);
        unmapped.set(key, entry);
      }
    } catch (error) {
      diagnostics.push({
        code: error.code ?? 'frontmatter_parse_failed',
        severity: 'error',
        path,
        line: error.line ?? null,
        column: error.column ?? null,
        message: error.message,
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
      profile,
      inputDigest: inputDigest(files),
      fileCount: files.size,
      importable: false,
      structurallyValid: false,
      readyForCertification: false,
      currentPlatformBaseline: profile.currentPlatformBaseline,
      diagnostics: sortDiagnostics(diagnostics),
      normalizations: sortNormalizations(normalizations),
      unmappedFields: [...unmapped.values()]
        .map((entry) => ({ ...entry, paths: entry.paths.toSorted() }))
        .toSorted(
          (left, right) =>
            left.blockType.localeCompare(right.blockType) || left.field.localeCompare(right.field),
        ),
    };
  }

  let built;
  try {
    built = buildFromFiles(normalizedFiles);
  } catch (error) {
    return {
      schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
      profile,
      inputDigest: inputDigest(files),
      fileCount: files.size,
      importable: false,
      structurallyValid: false,
      readyForCertification: false,
      currentPlatformBaseline: profile.currentPlatformBaseline,
      diagnostics: [
        {
          code: 'compatibility_mapping_failed',
          severity: 'error',
          message: error.message,
        },
      ],
      normalizations: sortNormalizations(normalizations),
      unmappedFields: [...unmapped.values()]
        .map((entry) => ({ ...entry, paths: entry.paths.toSorted() }))
        .toSorted(
          (left, right) =>
            left.blockType.localeCompare(right.blockType) || left.field.localeCompare(right.field),
        ),
    };
  }
  const { blocks, workflow, sensorScripts, runtimeFiles } = built;
  const byType = new Map();
  const blockIdentities = new Map();
  for (const block of blocks) {
    const items = byType.get(block.type) ?? [];
    items.push(block);
    byType.set(block.type, items);
    const identity = `${block.type}:${block.id ?? '<missing>'}`;
    if (block.id == null) {
      diagnostics.push({
        code: 'block_identity_missing',
        severity: 'error',
        message: `${block.type} block has no identity`,
      });
    } else if (blockIdentities.has(identity)) {
      diagnostics.push({
        code: 'duplicate_block_identity',
        severity: 'error',
        field: identity,
        message: `Duplicate compatibility block identity ${identity}`,
      });
    } else {
      blockIdentities.set(identity, block);
    }
  }
  const library = {
    stagesById: keyById(byType.get('STAGE') ?? [], profile),
    agentsById: keyById(byType.get('AGENT') ?? [], profile),
    sensorsById: keyById(byType.get('SENSOR') ?? [], profile),
    rulesById: keyById(byType.get('RULE') ?? [], profile),
    artifactsById: keyById(byType.get('ARTIFACT') ?? [], profile),
    scopesById: keyById(byType.get('SCOPE') ?? [], profile),
    // A capability whose presence test is a runtime engine file (Plan Approval)
    // is answered from this list, so the analyzer classifies the same
    // capabilities a pinned run of this catalog would resolve.
    runtimeFilePaths: [...runtimeFiles.keys()].toSorted(),
  };
  const scopes = [
    ...new Set(
      (workflow.placements ?? []).flatMap((placement) =>
        Object.keys(placement.scopeMembership ?? {}),
      ),
    ),
  ].toSorted();
  const scopePlans = Object.fromEntries(
    scopes.map((scope) => {
      let result;
      try {
        result = buildExecutionPlan({
          workflow: { ...workflow, version: 1 },
          scope,
          library,
          // The analyzer's input IS a release catalog, so authored scope
          // policy is in force here — analysing it on the legacy path would
          // report a plan the runtime never builds for a pinned intent.
          releaseMode: true,
        });
      } catch (error) {
        diagnostics.push({
          code: 'execution_plan_analysis_failed',
          severity: 'error',
          field: scope,
          message: `Execution-plan analysis failed for scope "${scope}": ${error.message}`,
        });
        return [
          scope,
          {
            valid: false,
            errors: { execution_plan_analysis_failed: 1 },
            warnings: {},
          },
        ];
      }
      return [
        scope,
        {
          valid: result.valid,
          errors: errorHistogram(result.errors),
          warnings: errorHistogram(result.warnings),
        },
      ];
    }),
  );

  const sensors = (byType.get('SENSOR') ?? [])
    .map((sensor) => {
      const script = sensorScripts.get(sensor.id);
      const closure = script
        ? dependencyClosure(normalizedFiles, script.path)
        : { files: [], missing: [], external: [], cycles: [] };
      return {
        id: sensor.id,
        command: sensor.command,
        ...sensorCommandContract(sensor),
        runtime: sensor.runtime,
        scriptPath: script?.path ?? null,
        scriptPresent: Boolean(script),
        dependencyClosure: closure,
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));

  if ((workflow.placements ?? []).length === 0) {
    diagnostics.push({
      code: 'workflow_empty',
      severity: 'error',
      message: 'Compatibility workflow has no stage placements',
    });
  }
  if (scopes.length === 0) {
    diagnostics.push({
      code: 'workflow_scopes_missing',
      severity: 'error',
      message: 'Compatibility workflow offers no scopes',
    });
  }
  if (sensors.length === 0) {
    diagnostics.push({
      code: 'workflow_sensors_missing',
      severity: 'error',
      message: 'Compatibility catalog contains no sensors',
    });
  }
  const structurallyValid =
    diagnostics.length === 0 &&
    Object.values(scopePlans).length > 0 &&
    Object.values(scopePlans).every((plan) => plan.valid);
  const dependencyClosureComplete = sensors.every(
    (sensor) => sensor.scriptPresent && sensor.dependencyClosure.missing.length === 0,
  );
  const sensorCommandsCompatible = sensors.every((sensor) => sensor.commandCompatible);
  const unmappedFields = [...unmapped.values()]
    .map((entry) => ({ ...entry, paths: entry.paths.toSorted() }))
    .toSorted(
      (left, right) =>
        left.blockType.localeCompare(right.blockType) || left.field.localeCompare(right.field),
    );
  const fidelity = fidelityReport(adapterFieldValues, collectInvokeCommands(normalizedFiles));
  // An execution-relevant field this platform does not model at all, and an
  // authored VALUE it models as `unsupported`, are the same failure from a
  // reviewer's point of view: the release would run with semantics silently
  // missing. Both withhold certification, and `certificationGaps` names every
  // one so the answer is never just "false".
  const certificationGaps = [
    ...unmappedFields
      .filter((field) => field.executionRelevant)
      .map((field) => ({
        kind: 'unmapped-field',
        blockType: field.blockType,
        field: field.field,
        value: null,
        paths: field.paths,
        note: 'No adapter consumes this field; its semantics are unknown to this platform.',
      })),
    ...fidelity.gaps,
    // A protocol the release ships but this platform does not reproduce is the
    // same failure as an unsupported field value; promotion refuses it from the
    // release's runtime files, so the analyzer names it too.
    ...protocolCertificationGaps(library.runtimeFilePaths),
  ];

  return {
    schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
    profile,
    inputDigest: inputDigest(files),
    fileCount: files.size,
    readyForCertification:
      structurallyValid &&
      dependencyClosureComplete &&
      sensorCommandsCompatible &&
      certificationGaps.length === 0,
    importable: diagnostics.length === 0,
    structurallyValid,
    dependencyClosureComplete,
    sensorCommandsCompatible,
    currentPlatformBaseline: profile.currentPlatformBaseline,
    diagnostics: sortDiagnostics(diagnostics),
    normalizations: sortNormalizations(normalizations),
    unmappedFields,
    certificationGaps,
    blockCounts: Object.fromEntries(
      [...byType]
        .map(([type, items]) => [type, items.length])
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    runtimeFileCount: runtimeFiles.size,
    fidelity,
    scopes,
    scopePlans,
    sensors,
  };
};

export {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  COMPATIBILITY_FIXTURE_SCHEMA_VERSION,
  COMPATIBILITY_REPORT_SCHEMA_VERSION,
  CompatibilityFixtureError,
  FIELD_FIDELITY,
  INFORMATIONAL_UNMAPPED_FIELDS,
  INVOKE_FAMILY_FIDELITY,
  FRONTMATTER_ENUMS,
  MAPPED_FRONTMATTER_FIELDS,
  OFFICIAL_AIDLC_REPOSITORY,
  REQUIRED_FRONTMATTER_FIELDS,
  analyzeAidlcCompatibility,
  fidelityGapsFromCatalog,
  invokeCommandCollector,
  blockTypeForPath,
  customProfile,
  filesFromCompatibilityFixture,
  isCustomProfile,
  normalizeAidlcFrontmatter,
  profileFor,
};

export default {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  COMPATIBILITY_FIXTURE_SCHEMA_VERSION,
  COMPATIBILITY_REPORT_SCHEMA_VERSION,
  CompatibilityFixtureError,
  FIELD_FIDELITY,
  INFORMATIONAL_UNMAPPED_FIELDS,
  INVOKE_FAMILY_FIDELITY,
  FRONTMATTER_ENUMS,
  MAPPED_FRONTMATTER_FIELDS,
  OFFICIAL_AIDLC_REPOSITORY,
  REQUIRED_FRONTMATTER_FIELDS,
  analyzeAidlcCompatibility,
  fidelityGapsFromCatalog,
  invokeCommandCollector,
  blockTypeForPath,
  customProfile,
  filesFromCompatibilityFixture,
  isCustomProfile,
  normalizeAidlcFrontmatter,
  profileFor,
};
