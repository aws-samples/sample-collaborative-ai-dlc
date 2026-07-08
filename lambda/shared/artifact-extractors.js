'use strict';

const crypto = require('node:crypto');
const yaml = require('js-yaml');

const slugify = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

const sha256 = (value = '') =>
  crypto
    .createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex');

const splitSections = (content = '') => {
  const lines = String(content ?? '').split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, heading: m[2].trim(), line: index });
  });
  if (!headings.length) return [];
  return headings.map((h, i) => {
    const end = headings[i + 1]?.line ?? lines.length;
    const bodyLines = lines.slice(h.line + 1, end);
    return {
      slug: slugify(h.heading),
      heading: h.heading,
      level: h.level,
      order: i,
      startLine: h.line + 1,
      endLine: end,
      content: bodyLines.join('\n').trim(),
      contentHash: sha256(bodyLines.join('\n').trim()),
    };
  });
};

const extractCitations = (content = '') => {
  const found = new Set();
  const body = String(content ?? '');
  for (const m of body.matchAll(/\[\[([a-z0-9][a-z0-9-]*)\]\]/gi)) found.add(m[1].toLowerCase());
  return [...found].toSorted();
};

const fencedYaml = (content = '', key) => {
  const body = String(content ?? '');
  for (const m of body.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/gi)) {
    const parsed = yaml.load(m[1]);
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, key)) return parsed;
  }
  return null;
};

const asList = (value) => (Array.isArray(value) ? value : []);
const text = (value, fallback = '') => (value == null ? fallback : String(value));

const normalizeItems = (artifactType, parsed, spec) => {
  const rows = asList(parsed?.[spec.key]);
  return rows.map((row, index) => {
    const rawId = row.id ?? row.slug ?? row.name ?? row.title ?? `${artifactType}-${index + 1}`;
    const slug = slugify(rawId);
    return {
      slug,
      label: spec.label,
      artifactType,
      order: index,
      title: text(row.title ?? row.name ?? rawId),
      props: spec.props(row),
    };
  });
};

// The extraction registry — THE single source of truth for typed artifact
// structure. Each entry owns:
//   key    — the top-level key of the fenced YAML block in the artifact body
//   label  — the derived graph vertex label items are mirrored as
//   props  — the prop mapper (extraction side)
//   doc    — authoring metadata (instruction side): description + field specs
//            with examples. The structure-contract renderer generates the
//            per-stage prompt instructions AND their examples from this, so
//            what agents are told to write and what the parser reads can
//            never drift (a round-trip test enforces it).
const REGISTRY = Object.freeze({
  requirements: {
    key: 'requirements',
    label: 'Requirement',
    doc: {
      description: 'Each requirement the artifact defines, as one list entry.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'req-user-login',
        },
        {
          name: 'title',
          required: true,
          description: 'one-line requirement name',
          example: 'User can log in',
        },
        {
          name: 'category',
          required: false,
          description: 'functional | non-functional | constraint',
          example: 'functional',
        },
        {
          name: 'priority',
          required: false,
          description: 'must-have | should-have | could-have',
          example: 'must-have',
        },
        {
          name: 'description',
          required: false,
          description: 'short statement of the requirement',
          example: 'Registered users authenticate with email and password.',
        },
        {
          name: 'acceptance_criteria',
          required: false,
          description: 'list of verifiable criteria',
          example: ['Valid credentials open a session', 'Five failures lock the account'],
        },
      ],
    },
    props: (r) => ({
      category: text(r.category),
      priority: text(r.priority),
      description: text(r.description ?? r.statement),
      acceptance_criteria: JSON.stringify(asList(r.acceptance_criteria)),
    }),
  },
  stories: {
    key: 'stories',
    label: 'Story',
    doc: {
      description: 'Each user story, one list entry per story.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'story-user-login',
        },
        {
          name: 'title',
          required: true,
          description: 'one-line story name',
          example: 'User logs in with email',
        },
        {
          name: 'persona',
          required: false,
          description: 'persona id this story serves',
          example: 'registered-user',
        },
        {
          name: 'priority',
          required: false,
          description: 'must-have | should-have | could-have',
          example: 'must-have',
        },
        {
          name: 'covers',
          required: false,
          description: 'requirement ids this story covers',
          example: ['req-user-login'],
        },
        {
          name: 'depends_on',
          required: false,
          description: 'story ids this story depends on',
          example: [],
        },
        {
          name: 'acceptance_criteria',
          required: false,
          description: 'list of verifiable criteria',
          example: ['Login form accepts valid credentials'],
        },
      ],
    },
    props: (s) => ({
      persona: text(s.persona),
      priority: text(s.priority),
      acceptance_criteria: JSON.stringify(asList(s.acceptance_criteria)),
      depends_on: JSON.stringify(asList(s.depends_on)),
      covers: JSON.stringify(asList(s.covers)),
    }),
  },
  personas: {
    key: 'personas',
    label: 'Persona',
    doc: {
      description: 'Each persona, one list entry per persona.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'registered-user',
        },
        { name: 'name', required: true, description: 'display name', example: 'Registered User' },
        {
          name: 'role',
          required: false,
          description: 'role or job the persona holds',
          example: 'Customer with an account',
        },
        {
          name: 'goals',
          required: false,
          description: 'list of goals',
          example: ['Access the account quickly'],
        },
        {
          name: 'pain_points',
          required: false,
          description: 'list of pain points',
          example: ['Forgotten passwords'],
        },
      ],
    },
    props: (p) => ({
      role: text(p.role),
      goals: JSON.stringify(asList(p.goals)),
      pain_points: JSON.stringify(asList(p.pain_points)),
    }),
  },
  components: {
    key: 'components',
    label: 'Component',
    doc: {
      description: 'Each architectural component, one list entry per component.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'auth-service',
        },
        { name: 'name', required: true, description: 'component name', example: 'Auth Service' },
        {
          name: 'description',
          required: false,
          description: 'what the component does',
          example: 'Owns authentication and session issuance.',
        },
        {
          name: 'responsibilities',
          required: false,
          description: 'list of responsibilities',
          example: ['Verify credentials', 'Issue sessions'],
        },
        {
          name: 'depends_on',
          required: false,
          description: 'component ids this component depends on',
          example: ['user-store'],
        },
      ],
    },
    props: (c) => ({
      description: text(c.description),
      responsibilities: JSON.stringify(asList(c.responsibilities)),
      depends_on: JSON.stringify(asList(c.depends_on)),
    }),
  },
  decisions: {
    key: 'decisions',
    label: 'Decision',
    doc: {
      description: 'Each design/architecture decision, one list entry per decision.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'dec-session-tokens',
        },
        {
          name: 'title',
          required: true,
          description: 'one-line decision name',
          example: 'Use short-lived session tokens',
        },
        {
          name: 'status',
          required: false,
          description: 'proposed | accepted | superseded',
          example: 'accepted',
        },
        {
          name: 'context',
          required: false,
          description: 'why the decision was needed',
          example: 'Sessions must survive container restarts.',
        },
        {
          name: 'decision',
          required: false,
          description: 'what was decided',
          example: 'Signed tokens with 15-minute expiry and refresh.',
        },
        {
          name: 'consequences',
          required: false,
          description: 'trade-offs accepted',
          example: 'Clients must handle refresh.',
        },
      ],
    },
    props: (d) => ({
      status: text(d.status),
      context: text(d.context),
      decision: text(d.decision),
      consequences: text(d.consequences),
    }),
  },
  'unit-of-work-story-map': {
    key: 'mappings',
    label: 'StoryMapEntry',
    doc: {
      description: 'One entry per unit of work, mapping the stories it delivers.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id (map-<unit>)',
          example: 'map-auth',
        },
        { name: 'unit', required: true, description: 'unit-of-work slug', example: 'auth' },
        {
          name: 'stories',
          required: true,
          description: 'story ids delivered by this unit',
          example: ['story-user-login'],
        },
      ],
    },
    props: (m) => ({
      unit: text(m.unit),
      stories: JSON.stringify(asList(m.stories)),
    }),
  },
  'unit-of-work-dependency': {
    key: 'contracts',
    label: 'Contract',
    doc: {
      description:
        'Each interface contract between units (provider exposes, consumers consume), one list entry per contract.',
      fields: [
        {
          name: 'id',
          required: true,
          description: 'stable kebab-case id',
          example: 'contract-auth-api',
        },
        {
          name: 'title',
          required: true,
          description: 'one-line contract name',
          example: 'Auth session API',
        },
        {
          name: 'provider',
          required: true,
          description: 'unit slug that provides the interface',
          example: 'auth',
        },
        {
          name: 'consumers',
          required: true,
          description: 'unit slugs that consume it',
          example: ['billing'],
        },
        { name: 'kind', required: false, description: 'api | event | schema', example: 'api' },
        {
          name: 'description',
          required: false,
          description: 'what the contract covers',
          example: 'Session validation endpoint for downstream units.',
        },
      ],
    },
    props: (c) => ({
      provider: text(c.provider),
      consumers: JSON.stringify(asList(c.consumers)),
      kind: text(c.kind),
      description: text(c.description),
    }),
  },
});

const extractArtifactStructure = ({ artifactType, artifactId, content = '' } = {}) => {
  const type = text(artifactType);
  const sections = splitSections(content);
  const citations = extractCitations(content);
  const spec = REGISTRY[type];
  let items = [];
  let structured = null;
  let error = null;
  if (spec) {
    try {
      structured = fencedYaml(content, spec.key);
      if (structured) items = normalizeItems(type, structured, spec);
    } catch (e) {
      error = e.message;
    }
  }
  return {
    artifactId: text(artifactId),
    artifactType: type,
    contentHash: sha256(content),
    sections,
    citations,
    items,
    structuredKey: spec?.key ?? null,
    structuredPresent: Boolean(structured),
    error,
  };
};

module.exports = {
  REGISTRY,
  extractArtifactStructure,
  extractCitations,
  splitSections,
  slugify,
  sha256,
};
