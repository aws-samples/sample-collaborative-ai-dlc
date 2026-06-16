'use strict';

// The shipped baseline block library + default workflow, owned by the SYSTEM
// tenant and read-only to everyone else. Ported from the AI-DLC V2 source
// (awslabs/aidlc-workflows, v2-unified branch): 32 stages, 11 agents, 9 scopes,
// 4 sensors, 7 rules, composed into the default `aidlc-v2` workflow.
//
// This file is the data seam — the seed lambda just writes what's here. Grow or
// retune the baseline by editing the data tables below; no code change needed.
//
// Modeling notes:
//   - A STAGE is the atomic unit (V2's "stage"); its DAG edges are produces /
//     consumes / requires (c1), its checks are sensors (c2).
//   - Phases are NOT library blocks — they are defined inline on the workflow's
//     phase tree (V2 treats a phase as a label, not a standalone object).
//   - A stage's V2 `scopes:` list (which scopes include it) is transposed onto
//     the workflow placement's scopeMembership (listed → EXECUTE).

const titleCase = (slug) =>
  slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

// ─── Agents (11) ───
const AGENTS = [
  [
    'aidlc-architect-agent',
    'Architect Agent',
    'opus',
    'Solutions architect: application design, domain modelling, NFR patterns, component design.',
  ],
  [
    'aidlc-aws-platform-agent',
    'AWS Platform Agent',
    'opus',
    'AWS solutions architect: infrastructure design, environment provisioning, cloud-native patterns.',
  ],
  [
    'aidlc-compliance-agent',
    'Compliance Agent',
    'opus',
    'GRC analyst: compliance mapping, data classification, risk assessment.',
  ],
  [
    'aidlc-delivery-agent',
    'Delivery Agent',
    'sonnet',
    'Engineering manager: team formation, Bolt sequencing, phase handoffs.',
  ],
  [
    'aidlc-design-agent',
    'Design Agent',
    'opus',
    'UX/UI designer: wireframing, interaction design, accessibility, design systems.',
  ],
  [
    'aidlc-developer-agent',
    'Developer Agent',
    'opus',
    'Senior developer: code generation, reverse engineering, data modelling.',
  ],
  [
    'aidlc-devsecops-agent',
    'DevSecOps Agent',
    'opus',
    'Security engineer: threat modelling, security requirements, scanning.',
  ],
  [
    'aidlc-operations-agent',
    'Operations Agent',
    'sonnet',
    'SRE: observability, incident response, operational optimization.',
  ],
  [
    'aidlc-pipeline-deploy-agent',
    'Pipeline & Deploy Agent',
    'sonnet',
    'CI/CD engineer: pipeline configuration, deployment strategy, releases.',
  ],
  [
    'aidlc-product-agent',
    'Product Agent',
    'opus',
    'Product manager / business analyst: requirements, user stories, market research.',
  ],
  [
    'aidlc-quality-agent',
    'Quality Agent',
    'opus',
    'QA lead: test strategy, test case design, quality gates, performance validation.',
  ],
];

const agentBlock = ([id, displayName, modelOverride, description]) => ({
  type: 'AGENT',
  id,
  name: displayName,
  displayName,
  description,
  modelOverride,
  disallowedTools: 'Task',
});

// ─── Scopes (9) ───
// [id, depth, keywords, description, testStrategy?]. testStrategy is an
// optional override of the test depth (V2 defaults it to `depth`); only
// workshop declares its own (Standard depth, but Minimal tests).
const SCOPES = [
  ['bugfix', 'Minimal', ['fix', 'bug', 'broken'], 'Fix a specific bug'],
  ['enterprise', 'Comprehensive', [], 'Regulated enterprise feature, full audit trail'],
  ['feature', 'Standard', [], 'Default for new features, practical depth'],
  ['infra', 'Standard', ['infrastructure', 'deploy', 'infra'], 'Infrastructure changes'],
  ['mvp', 'Standard', ['mvp', 'minimum viable'], 'Skip operations, ship the core'],
  ['poc', 'Minimal', ['proof of concept', 'prototype', 'poc', 'spike'], 'Prove feasibility fast'],
  ['refactor', 'Minimal', ['refactor', 'clean up', 'simplify'], 'Clean up existing code'],
  ['security-patch', 'Minimal', ['security', 'CVE', 'vulnerability', 'patch'], 'CVE response'],
  [
    'workshop',
    'Standard',
    ['workshop', 'lab', 'training'],
    'Facilitated group session with mandatory gates',
    'Minimal',
  ],
];

const scopeBlock = ([id, depth, keywords, description, testStrategy]) => ({
  type: 'SCOPE',
  id,
  name: titleCase(id),
  depth,
  // Defaults to depth when the scope declares no override (V2 semantics).
  testStrategy: testStrategy ?? depth,
  keywords,
  description,
});

// ─── Sensors (4) ── all deterministic, advisory (V2 ships only these) ───
const SENSORS = [
  [
    'linter',
    'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
    'code-quality',
    '**/*.{ts,js}',
    30,
    "Wraps the project's configured linter; fires on TS/JS code outputs.",
  ],
  [
    'required-sections',
    'bun {{HARNESS_DIR}}/tools/aidlc-sensor-required-sections.ts',
    'document-shape',
    '**/aidlc-docs/**',
    5,
    'Checks stage output contains the required H2 headings.',
  ],
  [
    'type-check',
    'bun {{HARNESS_DIR}}/tools/aidlc-sensor-type-check.ts',
    'code-quality',
    '**/*.{ts,tsx}',
    60,
    "Wraps the project's configured type-checker; fires on TS/TSX code outputs.",
  ],
  [
    'upstream-coverage',
    'bun {{HARNESS_DIR}}/tools/aidlc-sensor-upstream-coverage.ts',
    'document-shape',
    '**/aidlc-docs/**',
    5,
    'Checks the output references the upstream artifacts the stage consumes.',
  ],
];

const sensorBlock = ([id, command, category, matches, timeoutSeconds, description]) => ({
  type: 'SENSOR',
  id,
  name: titleCase(id),
  description,
  mode: 'deterministic',
  severity: 'advisory',
  command,
  runtime: 'bun',
  category,
  matches,
  timeoutSeconds,
});

// ─── Rules (7) ── layered guardrails on V2's five-layer chain
// (org → team → project → phase → stage). org/team/project are universal
// defaults that apply to every stage; a phase rule attaches to a stage when its
// `phase` matches the stage's phase (V2's pull-authoring: the rule binds via
// the stage's existing `phase:` declaration, no glob scoping). Tuple:
// [id, layer, phase|null, summary].
const RULES = [
  [
    'aidlc-org',
    'org',
    null,
    'Framework defaults: trunk-based development, walking skeleton, testing posture.',
  ],
  ['aidlc-team', 'team', null, "Team's affirmed practices and corrections. Overrides org."],
  [
    'aidlc-project',
    'project',
    null,
    'Project-specific overrides and corrections. Overrides team and org.',
  ],
  [
    'aidlc-phase-ideation',
    'phase',
    'ideation',
    'Ideation rules: evidence standards, scope discipline, output quality.',
  ],
  [
    'aidlc-phase-inception',
    'phase',
    'inception',
    'Inception rules: requirements quality, architecture standards, traceability.',
  ],
  [
    'aidlc-phase-construction',
    'phase',
    'construction',
    'Construction rules: code completeness, error handling, testing, security.',
  ],
  [
    'aidlc-phase-operation',
    'phase',
    'operation',
    'Operation rules: infra safety, deployment procedures, observability, incident response.',
  ],
];

const ruleBlock = ([id, layer, phase, summary]) => ({
  type: 'RULE',
  id,
  name: titleCase(id.replace(/^aidlc-/, '')),
  layer,
  // The phase a phase-layer rule attaches to (null for the universal layers).
  phase,
  description: summary,
});

// ─── Stages (32) ───
// Compact tuples: [id, phase, execution, leadAgent, mode, produces, consumes,
// requires, sensors, scopes, forEach?]. consumes entries are [artifact, required].
const r = true; // required
const o = false; // optional
const ALL_SCOPES = [
  'enterprise',
  'feature',
  'mvp',
  'poc',
  'bugfix',
  'refactor',
  'infra',
  'security-patch',
  'workshop',
];

const STAGES = [
  // initialization (3) — orchestrator-run, no artifacts/sensors
  {
    id: 'workspace-scaffold',
    phase: 'initialization',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-delivery-agent',
    mode: 'inline',
    produces: [],
    consumes: [],
    requires: [],
    sensors: [],
    scopes: ALL_SCOPES,
  },
  {
    id: 'workspace-detection',
    phase: 'initialization',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-delivery-agent',
    mode: 'inline',
    produces: [],
    consumes: [],
    requires: ['workspace-scaffold'],
    sensors: [],
    scopes: ALL_SCOPES,
  },
  {
    id: 'state-init',
    phase: 'initialization',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-delivery-agent',
    mode: 'inline',
    produces: [],
    consumes: [],
    requires: ['workspace-detection'],
    sensors: [],
    scopes: ALL_SCOPES,
  },

  // ideation (7)
  {
    id: 'intent-capture',
    phase: 'ideation',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-product-agent',
    support: ['aidlc-architect-agent'],
    mode: 'inline',
    produces: ['intent-statement', 'stakeholder-map', 'intent-capture-questions'],
    consumes: [],
    requires: [],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'poc'],
  },
  {
    id: 'market-research',
    phase: 'ideation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-product-agent',
    mode: 'inline',
    produces: [
      'competitive-analysis',
      'market-trends',
      'build-vs-buy',
      'market-research-questions',
    ],
    consumes: [['intent-statement', r]],
    requires: ['intent-capture'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature'],
  },
  {
    id: 'feasibility',
    phase: 'ideation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-aws-platform-agent', 'aidlc-compliance-agent'],
    mode: 'inline',
    produces: [
      'feasibility-assessment',
      'constraint-register',
      'raid-log',
      'feasibility-questions',
    ],
    consumes: [
      ['intent-statement', r],
      ['competitive-analysis', o],
      ['market-trends', o],
      ['build-vs-buy', o],
    ],
    requires: ['intent-capture', 'market-research'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp'],
  },
  {
    id: 'scope-definition',
    phase: 'ideation',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-product-agent',
    support: ['aidlc-delivery-agent'],
    mode: 'inline',
    produces: ['scope-document', 'intent-backlog', 'scope-definition-questions'],
    consumes: [
      ['intent-statement', r],
      ['feasibility-assessment', o],
      ['constraint-register', o],
    ],
    requires: ['intent-capture', 'feasibility'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp'],
  },
  {
    id: 'team-formation',
    phase: 'ideation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-delivery-agent',
    mode: 'inline',
    produces: ['team-assessment', 'skill-matrix', 'mob-composition', 'team-formation-questions'],
    consumes: [
      ['scope-document', r],
      ['intent-backlog', r],
      ['feasibility-assessment', o],
    ],
    requires: ['scope-definition'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature'],
  },
  {
    id: 'rough-mockups',
    phase: 'ideation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-design-agent',
    support: ['aidlc-product-agent'],
    mode: 'inline',
    produces: ['wireframes', 'user-flow', 'rough-mockups-questions'],
    consumes: [
      ['intent-statement', r],
      ['scope-document', r],
      ['intent-backlog', r],
    ],
    requires: ['scope-definition', 'team-formation'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp'],
  },
  {
    id: 'approval-handoff',
    phase: 'ideation',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-delivery-agent',
    support: ['aidlc-product-agent'],
    mode: 'inline',
    produces: ['initiative-brief', 'decision-log', 'approval-handoff-questions'],
    consumes: [
      ['intent-statement', r],
      ['scope-document', r],
      ['intent-backlog', r],
      ['competitive-analysis', o],
      ['feasibility-assessment', o],
      ['constraint-register', o],
      ['team-assessment', o],
      ['wireframes', o],
    ],
    requires: [
      'intent-capture',
      'feasibility',
      'scope-definition',
      'team-formation',
      'rough-mockups',
    ],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature'],
  },

  // inception (8)
  {
    id: 'reverse-engineering',
    phase: 'inception',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-developer-agent',
    support: ['aidlc-architect-agent'],
    mode: 'subagent',
    produces: [
      'business-overview',
      'architecture',
      'code-structure',
      'api-documentation',
      'component-inventory',
      'technology-stack',
      'dependencies',
      'code-quality-assessment',
      'reverse-engineering-timestamp',
    ],
    consumes: [],
    requires: ['state-init'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: [
      'enterprise',
      'feature',
      'mvp',
      'poc',
      'bugfix',
      'refactor',
      'security-patch',
      'workshop',
    ],
  },
  {
    id: 'practices-discovery',
    phase: 'inception',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-pipeline-deploy-agent',
    support: ['aidlc-quality-agent', 'aidlc-developer-agent', 'aidlc-devsecops-agent'],
    mode: 'inline',
    produces: ['team-practices', 'discovered-rules', 'evidence', 'practices-discovery-timestamp'],
    consumes: [
      ['code-structure', o],
      ['technology-stack', o],
      ['dependencies', o],
      ['code-quality-assessment', o],
      ['architecture', o],
      ['business-overview', o],
    ],
    requires: ['state-init', 'reverse-engineering'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'infra', 'workshop'],
  },
  {
    id: 'requirements-analysis',
    phase: 'inception',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-product-agent',
    mode: 'inline',
    produces: ['requirements', 'requirements-analysis-questions'],
    consumes: [
      ['intent-statement', o],
      ['scope-document', o],
      ['business-overview', o],
      ['architecture', o],
      ['code-structure', o],
      ['team-practices', o],
    ],
    requires: ['approval-handoff', 'reverse-engineering'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'poc', 'bugfix', 'refactor', 'infra', 'workshop'],
  },
  {
    id: 'user-stories',
    phase: 'inception',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-product-agent',
    support: ['aidlc-design-agent'],
    mode: 'inline',
    produces: ['stories', 'personas', 'user-stories-assessment'],
    consumes: [
      ['requirements', r],
      ['business-overview', o],
      ['component-inventory', o],
      ['team-practices', o],
    ],
    requires: ['requirements-analysis'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'workshop'],
  },
  {
    id: 'refined-mockups',
    phase: 'inception',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-design-agent',
    support: ['aidlc-product-agent'],
    mode: 'inline',
    produces: [
      'mockups',
      'interaction-spec',
      'design-system-mapping',
      'accessibility-checklist',
      'refined-mockups-questions',
    ],
    consumes: [
      ['wireframes', r],
      ['user-flow', r],
      ['stories', o],
      ['requirements', r],
      ['team-practices', o],
    ],
    requires: ['user-stories'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'workshop'],
  },
  {
    id: 'application-design',
    phase: 'inception',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-aws-platform-agent', 'aidlc-design-agent'],
    mode: 'inline',
    produces: ['components', 'component-methods', 'services', 'component-dependency', 'decisions'],
    consumes: [
      ['requirements', r],
      ['stories', o],
      ['architecture', o],
      ['component-inventory', o],
      ['team-practices', o],
    ],
    requires: ['requirements-analysis', 'refined-mockups'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'workshop'],
  },
  {
    id: 'units-generation',
    phase: 'inception',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-delivery-agent'],
    mode: 'inline',
    produces: ['unit-of-work', 'unit-of-work-dependency', 'unit-of-work-story-map'],
    consumes: [
      ['components', r],
      ['component-methods', r],
      ['services', r],
      ['component-dependency', r],
      ['decisions', r],
      ['requirements', r],
      ['stories', o],
    ],
    requires: ['application-design'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'workshop'],
  },
  {
    id: 'delivery-planning',
    phase: 'inception',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-delivery-agent',
    support: ['aidlc-architect-agent'],
    mode: 'inline',
    produces: [
      'bolt-plan',
      'team-allocation',
      'risk-and-sequencing-rationale',
      'external-dependency-map',
      'delivery-planning-questions',
    ],
    consumes: [
      ['requirements', r],
      ['stories', o],
      ['mockups', o],
      ['components', r],
      ['unit-of-work', r],
      ['unit-of-work-dependency', r],
      ['unit-of-work-story-map', o],
      ['team-practices', o],
    ],
    requires: ['units-generation'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'mvp', 'workshop'],
  },

  // construction (7) — most run once per unit-of-work
  {
    id: 'functional-design',
    phase: 'construction',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-developer-agent'],
    mode: 'inline',
    forEach: 'unit-of-work',
    produces: ['business-logic-model', 'business-rules', 'domain-entities', 'frontend-components'],
    consumes: [
      ['unit-of-work', r],
      ['unit-of-work-story-map', o],
      ['requirements', r],
      ['components', r],
      ['component-methods', r],
      ['services', r],
    ],
    requires: ['units-generation'],
    sensors: ['required-sections', 'upstream-coverage', 'linter', 'type-check'],
    scopes: ['enterprise', 'feature', 'mvp', 'refactor', 'workshop'],
  },
  {
    id: 'nfr-requirements',
    phase: 'construction',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-devsecops-agent', 'aidlc-compliance-agent', 'aidlc-quality-agent'],
    mode: 'inline',
    forEach: 'unit-of-work',
    produces: [
      'performance-requirements',
      'security-requirements',
      'scalability-requirements',
      'reliability-requirements',
      'tech-stack-decisions',
    ],
    consumes: [
      ['business-logic-model', r],
      ['business-rules', r],
      ['requirements', r],
      ['technology-stack', o],
    ],
    requires: ['units-generation', 'functional-design'],
    sensors: ['required-sections', 'upstream-coverage', 'linter', 'type-check'],
    scopes: ['enterprise', 'feature', 'mvp', 'infra', 'security-patch', 'workshop'],
  },
  {
    id: 'nfr-design',
    phase: 'construction',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-architect-agent',
    support: ['aidlc-aws-platform-agent'],
    mode: 'inline',
    forEach: 'unit-of-work',
    produces: [
      'performance-design',
      'security-design',
      'scalability-design',
      'reliability-design',
      'logical-components',
    ],
    consumes: [
      ['performance-requirements', r],
      ['security-requirements', r],
      ['scalability-requirements', r],
      ['reliability-requirements', r],
      ['tech-stack-decisions', r],
      ['business-logic-model', r],
    ],
    requires: ['units-generation', 'nfr-requirements'],
    sensors: ['required-sections', 'upstream-coverage', 'linter', 'type-check'],
    scopes: ['enterprise', 'feature', 'mvp', 'infra', 'workshop'],
  },
  {
    id: 'infrastructure-design',
    phase: 'construction',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-aws-platform-agent',
    support: ['aidlc-devsecops-agent', 'aidlc-compliance-agent'],
    mode: 'inline',
    forEach: 'unit-of-work',
    produces: [
      'deployment-architecture',
      'infrastructure-services',
      'monitoring-design',
      'cicd-pipeline',
      'shared-infrastructure',
    ],
    consumes: [
      ['performance-design', r],
      ['security-design', r],
      ['scalability-design', r],
      ['reliability-design', r],
      ['logical-components', r],
      ['components', r],
      ['services', r],
      ['business-logic-model', r],
    ],
    requires: ['units-generation', 'nfr-design'],
    sensors: ['required-sections', 'upstream-coverage', 'linter', 'type-check'],
    scopes: ['enterprise', 'feature', 'mvp', 'infra', 'workshop'],
  },
  {
    id: 'code-generation',
    phase: 'construction',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-developer-agent',
    mode: 'subagent',
    forEach: 'unit-of-work',
    produces: ['code-generation-plan', 'code-summary'],
    consumes: [
      ['business-logic-model', o],
      ['business-rules', o],
      ['domain-entities', o],
      ['performance-design', o],
      ['security-design', o],
      ['deployment-architecture', o],
      ['unit-of-work', r],
      ['requirements', r],
    ],
    requires: [
      'units-generation',
      'functional-design',
      'nfr-requirements',
      'nfr-design',
      'infrastructure-design',
    ],
    sensors: ['linter', 'type-check'],
    scopes: [
      'enterprise',
      'feature',
      'mvp',
      'poc',
      'bugfix',
      'refactor',
      'security-patch',
      'workshop',
    ],
  },
  {
    id: 'build-and-test',
    phase: 'construction',
    execution: 'ALWAYS',
    leadAgent: 'aidlc-quality-agent',
    support: ['aidlc-devsecops-agent'],
    mode: 'inline',
    produces: [
      'build-instructions',
      'unit-test-instructions',
      'integration-test-instructions',
      'performance-test-instructions',
      'security-test-instructions',
      'build-and-test-summary',
      'build-test-results',
    ],
    consumes: [
      ['code-generation-plan', r],
      ['code-summary', r],
    ],
    requires: ['code-generation'],
    sensors: ['required-sections', 'upstream-coverage', 'type-check'],
    scopes: [
      'enterprise',
      'feature',
      'mvp',
      'poc',
      'bugfix',
      'refactor',
      'security-patch',
      'workshop',
    ],
  },
  {
    id: 'ci-pipeline',
    phase: 'construction',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-pipeline-deploy-agent',
    mode: 'inline',
    produces: ['ci-config', 'quality-gates', 'ci-pipeline-questions'],
    consumes: [
      ['code-summary', r],
      ['build-and-test-summary', r],
      ['build-test-results', r],
    ],
    requires: ['build-and-test'],
    sensors: ['required-sections', 'upstream-coverage', 'linter', 'type-check'],
    scopes: ['enterprise', 'feature', 'mvp', 'infra', 'workshop'],
  },

  // operation (7)
  {
    id: 'deployment-pipeline',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-pipeline-deploy-agent',
    mode: 'inline',
    produces: [
      'cd-config',
      'deployment-strategy',
      'rollback-runbook',
      'deployment-pipeline-questions',
    ],
    consumes: [
      ['ci-config', r],
      ['quality-gates', r],
      ['deployment-architecture', r],
      ['cicd-pipeline', r],
    ],
    requires: ['ci-pipeline', 'infrastructure-design'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'infra', 'security-patch', 'workshop'],
  },
  {
    id: 'environment-provisioning',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-aws-platform-agent',
    support: ['aidlc-devsecops-agent', 'aidlc-compliance-agent'],
    mode: 'inline',
    produces: ['environment-inventory', 'validation-report', 'environment-provisioning-questions'],
    consumes: [
      ['deployment-architecture', r],
      ['infrastructure-services', r],
      ['cd-config', r],
    ],
    requires: ['infrastructure-design', 'deployment-pipeline'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'infra', 'workshop'],
  },
  {
    id: 'deployment-execution',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-pipeline-deploy-agent',
    support: ['aidlc-developer-agent'],
    mode: 'inline',
    produces: [
      'deployment-log',
      'smoke-test-results',
      'health-check-report',
      'deployment-execution-questions',
    ],
    consumes: [
      ['cd-config', r],
      ['deployment-strategy', r],
      ['environment-inventory', r],
      ['build-test-results', r],
    ],
    requires: ['deployment-pipeline', 'environment-provisioning'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'infra', 'security-patch', 'workshop'],
  },
  {
    id: 'observability-setup',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-operations-agent',
    mode: 'inline',
    produces: [
      'dashboards',
      'alarms',
      'slo-config',
      'log-queries',
      'tracing-config',
      'anomaly-config',
      'observability-setup-questions',
    ],
    consumes: [
      ['performance-design', r],
      ['security-design', r],
      ['reliability-design', r],
      ['monitoring-design', r],
      ['infrastructure-services', r],
    ],
    requires: ['nfr-design', 'infrastructure-design', 'deployment-execution'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'infra', 'workshop'],
  },
  {
    id: 'incident-response',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-operations-agent',
    mode: 'inline',
    produces: ['runbooks', 'incident-plan', 'escalation-matrix', 'incident-response-questions'],
    consumes: [
      ['dashboards', r],
      ['alarms', r],
      ['reliability-design', r],
      ['security-design', r],
      ['deployment-architecture', r],
    ],
    requires: ['observability-setup'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'workshop'],
  },
  {
    id: 'performance-validation',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-quality-agent',
    mode: 'inline',
    produces: [
      'load-test-plan',
      'load-test-results',
      'nfr-validation-matrix',
      'performance-validation-questions',
    ],
    consumes: [
      ['performance-requirements', r],
      ['scalability-requirements', r],
      ['performance-design', r],
      ['scalability-design', r],
      ['dashboards', r],
    ],
    requires: ['nfr-requirements', 'nfr-design', 'observability-setup'],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'workshop'],
  },
  {
    id: 'feedback-optimization',
    phase: 'operation',
    execution: 'CONDITIONAL',
    leadAgent: 'aidlc-operations-agent',
    support: ['aidlc-aws-platform-agent'],
    mode: 'inline',
    produces: [
      'slo-report',
      'cost-analysis',
      'drift-report',
      'feedback-loop',
      'feedback-optimization-questions',
    ],
    consumes: [
      ['dashboards', r],
      ['alarms', r],
      ['slo-config', r],
      ['deployment-log', r],
      ['load-test-results', o],
      ['incident-plan', o],
    ],
    requires: [
      'observability-setup',
      'deployment-execution',
      'incident-response',
      'performance-validation',
    ],
    sensors: ['required-sections', 'upstream-coverage'],
    scopes: ['enterprise', 'feature', 'workshop'],
  },
];

// V2 stage prose (condition + the human Inputs/Outputs lines), keyed by stage
// id. Ported verbatim from the v2-unified stage frontmatter so a stage
// round-trips losslessly. Kept as a side table rather than inlined into the
// compact STAGES tuples to keep those readable.
const STAGE_PROSE = {
  'application-design': {
    condition:
      'Execute when new components or services are needed, or service layer design is required. Skip when changes are modifications to existing components only.',
    inputs:
      'aidlc-docs/inception/requirements-analysis/requirements.md, aidlc-docs/inception/user-stories/stories.md (if produced), RE artifacts (if brownfield)',
    outputs:
      'aidlc-docs/inception/application-design/components.md, aidlc-docs/inception/application-design/component-methods.md, aidlc-docs/inception/application-design/services.md, aidlc-docs/inception/application-design/component-dependency.md, aidlc-docs/inception/application-design/decisions.md',
  },
  'approval-handoff': {
    condition:
      'Always executes — compiles all Ideation artifacts into initiative brief for approval',
    inputs:
      'All Ideation phase artifacts (intent, market research, feasibility, scope, team, mockups)',
    outputs:
      'aidlc-docs/ideation/approval-handoff/initiative-brief.md, aidlc-docs/ideation/approval-handoff/decision-log.md, aidlc-docs/ideation/approval-handoff/approval-handoff-questions.md',
  },
  'build-and-test': {
    condition: 'Always executes once after all per-unit stages are finished.',
    inputs: 'ALL code generation outputs across all units',
    outputs:
      'aidlc-docs/construction/build-and-test/ (build-instructions.md, unit-test-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md)',
  },
  'ci-pipeline': {
    condition:
      'Execute when CI pipeline needs creation or significant modification. Skip if CI already exists and is adequate.',
    inputs:
      'Code generation output from code-generation stage, build/test results from build-and-test stage',
    outputs:
      'aidlc-docs/construction/ci-pipeline/ci-config.md, aidlc-docs/construction/ci-pipeline/quality-gates.md, aidlc-docs/construction/ci-pipeline/ci-pipeline-questions.md',
  },
  'code-generation': {
    condition: 'Always executes for every unit in the execution plan.',
    inputs: 'ALL prior design artifacts for this unit',
    outputs:
      'application code + aidlc-docs/construction/{unit-name}/code-generation/ (code-generation-plan.md, code-summary.md)',
  },
  'delivery-planning': {
    condition:
      'Always executes — capstone Inception stage, produces the detailed execution plan for Construction and Operation',
    inputs: 'All Inception artifacts (requirements, stories, mockups, architecture, units)',
    outputs:
      'aidlc-docs/inception/delivery-planning/bolt-plan.md, aidlc-docs/inception/delivery-planning/team-allocation.md, aidlc-docs/inception/delivery-planning/risk-and-sequencing-rationale.md, aidlc-docs/inception/delivery-planning/external-dependency-map.md, aidlc-docs/inception/delivery-planning/delivery-planning-questions.md',
  },
  'deployment-execution': {
    condition: 'Execute after deployment pipeline and environment are ready',
    inputs:
      'CD pipeline config from deployment-pipeline stage, provisioned environments from environment-provisioning stage, built artifacts from Construction',
    outputs:
      'aidlc-docs/operation/deployment-execution/deployment-log.md, aidlc-docs/operation/deployment-execution/smoke-test-results.md, aidlc-docs/operation/deployment-execution/health-check-report.md, aidlc-docs/operation/deployment-execution/deployment-execution-questions.md',
  },
  'deployment-pipeline': {
    condition: 'Execute when CD pipeline needs creation or significant modification',
    inputs:
      'CI pipeline config from ci-pipeline stage, infrastructure design from infrastructure-design stage',
    outputs:
      'aidlc-docs/operation/deployment-pipeline/cd-config.md, aidlc-docs/operation/deployment-pipeline/deployment-strategy.md, aidlc-docs/operation/deployment-pipeline/rollback-runbook.md, aidlc-docs/operation/deployment-pipeline/deployment-pipeline-questions.md',
  },
  'environment-provisioning': {
    condition: 'Execute when AWS environments need provisioning or validation',
    inputs:
      'Infrastructure design from infrastructure-design stage, CD pipeline config from deployment-pipeline stage',
    outputs:
      'aidlc-docs/operation/environment-provisioning/environment-inventory.md, aidlc-docs/operation/environment-provisioning/validation-report.md, aidlc-docs/operation/environment-provisioning/environment-provisioning-questions.md',
  },
  feasibility: {
    condition:
      'Execute when there are integration constraints, regulatory requirements, or significant technical uncertainty. Skip for trivial changes with no technical risk.',
    inputs:
      'Intent statement from intent-capture stage, market research from market-research stage (if executed)',
    outputs:
      'aidlc-docs/ideation/feasibility/feasibility-assessment.md, aidlc-docs/ideation/feasibility/constraint-register.md, aidlc-docs/ideation/feasibility/raid-log.md, aidlc-docs/ideation/feasibility/feasibility-questions.md',
  },
  'feedback-optimization': {
    condition: 'Execute when ongoing operational monitoring and optimization are needed',
    inputs: 'All Operation phase artifacts, production monitoring data',
    outputs:
      'aidlc-docs/operation/feedback-optimization/slo-report.md, aidlc-docs/operation/feedback-optimization/cost-analysis.md, aidlc-docs/operation/feedback-optimization/drift-report.md, aidlc-docs/operation/feedback-optimization/feedback-loop.md, aidlc-docs/operation/feedback-optimization/feedback-optimization-questions.md',
  },
  'functional-design': {
    condition:
      'New data models, complex business logic, or business rules need design. Skip if simple logic changes with no new business logic.',
    inputs:
      'unit-of-work.md, unit-of-work-story-map.md, requirements.md, application design artifacts',
    outputs:
      'aidlc-docs/construction/{unit-name}/functional-design/ (business-logic-model.md, business-rules.md, domain-entities.md, CONDITIONAL: frontend-components.md)',
  },
  'incident-response': {
    condition: 'Execute when operational runbooks and incident response procedures are needed',
    inputs:
      'Observability setup from observability-setup stage, NFR design from nfr-design stage, infrastructure design from infrastructure-design stage',
    outputs:
      'aidlc-docs/operation/incident-response/runbooks.md, aidlc-docs/operation/incident-response/incident-plan.md, aidlc-docs/operation/incident-response/escalation-matrix.md, aidlc-docs/operation/incident-response/incident-response-questions.md',
  },
  'infrastructure-design': {
    condition:
      'Infrastructure services need mapping, deployment architecture required, or cloud resources needed. Skip if no infrastructure changes and infrastructure already defined.',
    inputs: 'NFR design artifacts, application design, functional design',
    outputs:
      'aidlc-docs/construction/{unit-name}/infrastructure-design/ (deployment-architecture.md, infrastructure-services.md, monitoring-design.md, cicd-pipeline.md, CONDITIONAL: shared-infrastructure.md)',
  },
  'intent-capture': {
    condition: "First stage of every workflow — establishes the initiative's foundation",
    inputs: "User's project description ($ARGUMENTS), scope selection",
    outputs:
      'aidlc-docs/ideation/intent-capture/intent-statement.md, aidlc-docs/ideation/intent-capture/stakeholder-map.md, aidlc-docs/ideation/intent-capture/intent-capture-questions.md',
  },
  'market-research': {
    condition:
      'Execute when initiative has external market positioning or build-vs-buy considerations. Skip for internal tools, bug fixes, or refactors.',
    inputs: 'Intent statement from intent-capture stage',
    outputs:
      'aidlc-docs/ideation/market-research/competitive-analysis.md, aidlc-docs/ideation/market-research/market-trends.md, aidlc-docs/ideation/market-research/build-vs-buy.md, aidlc-docs/ideation/market-research/market-research-questions.md',
  },
  'nfr-design': {
    condition:
      'NFR Requirements was executed and NFR patterns need design. Skip if NFR Requirements was skipped.',
    inputs: 'NFR requirements artifacts, functional design artifacts',
    outputs:
      'aidlc-docs/construction/{unit-name}/nfr-design/ (performance-design.md, security-design.md, scalability-design.md, reliability-design.md, logical-components.md)',
  },
  'nfr-requirements': {
    condition:
      'Performance requirements, security considerations, scalability concerns, or tech stack selection needed. Skip if no NFR requirements and tech stack already determined.',
    inputs: 'functional design artifacts, requirements.md, RE artifacts',
    outputs:
      'aidlc-docs/construction/{unit-name}/nfr-requirements/ (performance-requirements.md, security-requirements.md, scalability-requirements.md, reliability-requirements.md, tech-stack-decisions.md)',
  },
  'observability-setup': {
    condition: 'Execute when monitoring, dashboards, alarms, or tracing need configuration',
    inputs:
      'NFR design from nfr-design stage, infrastructure design from infrastructure-design stage, deployed application',
    outputs:
      'aidlc-docs/operation/observability-setup/dashboards.md, aidlc-docs/operation/observability-setup/alarms.md, aidlc-docs/operation/observability-setup/slo-config.md, aidlc-docs/operation/observability-setup/log-queries.md, aidlc-docs/operation/observability-setup/tracing-config.md, aidlc-docs/operation/observability-setup/anomaly-config.md, aidlc-docs/operation/observability-setup/observability-setup-questions.md',
  },
  'performance-validation': {
    condition: 'Execute when NFR performance targets need validation under load',
    inputs:
      'NFR requirements from nfr-requirements stage, NFR design from nfr-design stage, deployed application, observability data from observability-setup stage',
    outputs:
      'aidlc-docs/operation/performance-validation/load-test-plan.md, aidlc-docs/operation/performance-validation/test-results.md, aidlc-docs/operation/performance-validation/nfr-validation-matrix.md, aidlc-docs/operation/performance-validation/performance-validation-questions.md',
  },
  'practices-discovery': {
    condition:
      'Always rerun for freshness. Brownfield discovers from evidence + reverse-engineering artifacts. Greenfield prompts user via structured questions using org.md defaults.',
    inputs: "aidlc-docs/aidlc-state.md + (brownfield) reverse-engineering's 8 artifacts",
    outputs:
      "aidlc-docs/inception/practices-discovery/ (4 artifacts: team-practices.md, discovered-rules.md, evidence.md, practices-discovery-timestamp.md). On affirmation, content is promoted to the harness rule layer's aidlc-team.md and aidlc-project.md.",
  },
  'refined-mockups': {
    condition:
      'Execute when user-facing UI exists and rough mockups were produced in Ideation; for APIs, refine interaction diagrams',
    inputs:
      'Rough mockups from rough-mockups stage, user stories from user-stories stage, requirements from requirements-analysis stage',
    outputs:
      'aidlc-docs/inception/refined-mockups/mockups.md, aidlc-docs/inception/refined-mockups/interaction-spec.md, aidlc-docs/inception/refined-mockups/design-system-mapping.md, aidlc-docs/inception/refined-mockups/accessibility-checklist.md, aidlc-docs/inception/refined-mockups/refined-mockups-questions.md',
  },
  'requirements-analysis': {
    condition: 'Always executes — depth scales with project complexity',
    inputs: "RE artifacts (if brownfield), user's project description (from audit.md)",
    outputs:
      'aidlc-docs/inception/requirements-analysis/requirements.md, aidlc-docs/inception/requirements-analysis/requirements-analysis-questions.md',
  },
  'reverse-engineering': {
    condition:
      'Execute when project is brownfield. Always rerun for freshness. Skip for greenfield projects.',
    inputs: 'aidlc-docs/aidlc-state.md',
    outputs:
      'aidlc-docs/inception/reverse-engineering/ (9 artifacts: business-overview.md, architecture.md, code-structure.md, api-documentation.md, component-inventory.md, technology-stack.md, dependencies.md, code-quality-assessment.md, reverse-engineering-timestamp.md)',
  },
  'rough-mockups': {
    condition:
      'Execute when user-facing UI is part of the initiative; for API/backend, produce system interaction diagrams. Skip for non-UI, API-only, or infrastructure-only initiatives.',
    inputs: 'Intent statement, scope definition, intent backlog',
    outputs:
      'aidlc-docs/ideation/rough-mockups/wireframes.md, aidlc-docs/ideation/rough-mockups/user-flow.md, aidlc-docs/ideation/rough-mockups/rough-mockups-questions.md',
  },
  'scope-definition': {
    condition: 'Always executes — defines the scope boundary and prioritized backlog',
    inputs: 'Intent statement, feasibility assessment, constraint register',
    outputs:
      'aidlc-docs/ideation/scope-definition/scope-document.md, aidlc-docs/ideation/scope-definition/intent-backlog.md, aidlc-docs/ideation/scope-definition/scope-definition-questions.md',
  },
  'state-init': {
    condition: 'Creates full populated state file and determines routing — auto-proceeds',
    inputs: 'workspace classification from workspace-detection, scope from orchestrator',
    outputs: 'aidlc-docs/aidlc-state.md (full populated version)',
  },
  'team-formation': {
    condition:
      'Execute when team composition, capacity, or mob planning is relevant. Skip for solo developer or small team projects.',
    inputs: 'Scope definition, intent backlog, feasibility assessment',
    outputs:
      'aidlc-docs/ideation/team-formation/team-assessment.md, aidlc-docs/ideation/team-formation/skill-matrix.md, aidlc-docs/ideation/team-formation/mob-composition.md, aidlc-docs/ideation/team-formation/team-formation-questions.md',
  },
  'units-generation': {
    condition:
      'Always executes when in scope. Produces the dependency DAG that Stage 2.8 Delivery Planning consumes for Bolt sequencing. In the compiled scope grid, 2.7 and 2.8 travel together — both EXECUTE or both SKIP per scope.',
    inputs:
      'aidlc-docs/inception/application-design/ (all design artifacts), aidlc-docs/inception/requirements-analysis/requirements.md, aidlc-docs/inception/user-stories/stories.md (if produced)',
    outputs:
      'aidlc-docs/inception/units-generation/unit-of-work.md, aidlc-docs/inception/units-generation/unit-of-work-dependency.md, aidlc-docs/inception/units-generation/unit-of-work-story-map.md',
  },
  'user-stories': {
    condition:
      'Execute when user-facing features, multiple personas, complex business logic, or cross-team work is involved. Skip for pure refactoring, isolated bug fixes, infrastructure-only changes, or developer tooling.',
    inputs:
      'aidlc-docs/inception/requirements-analysis/requirements.md, RE artifacts (if brownfield)',
    outputs:
      'aidlc-docs/inception/user-stories/stories.md, aidlc-docs/inception/user-stories/personas.md, aidlc-docs/inception/user-stories/user-stories-assessment.md',
  },
  'workspace-detection': {
    condition: 'Scans and classifies workspace — auto-proceeds (no approval gate)',
    inputs: 'none (scans filesystem)',
    outputs: 'workspace classification (greenfield/brownfield), technology stack detection',
  },
  'workspace-scaffold': {
    condition: 'Scaffolds aidlc-docs/ directory tree — idempotent (skips existing dirs/files)',
    inputs: 'none (first stage after session start)',
    outputs: 'aidlc-docs/ directory tree (knowledge dirs, stage artifact dirs, verification dir)',
  },
};

// Consume edges that only apply to brownfield (existing-codebase) runs, keyed
// by stage id then artifact. V2 frontmatter expresses this as
// `consumes[].conditional_on: brownfield`; greenfield runs skip them.
const CONDITIONAL_ON = {
  'application-design': { architecture: 'brownfield', 'component-inventory': 'brownfield' },
  'nfr-requirements': { 'technology-stack': 'brownfield' },
  'practices-discovery': {
    'code-structure': 'brownfield',
    'technology-stack': 'brownfield',
    dependencies: 'brownfield',
    'code-quality-assessment': 'brownfield',
    architecture: 'brownfield',
    'business-overview': 'brownfield',
  },
  'requirements-analysis': {
    'business-overview': 'brownfield',
    architecture: 'brownfield',
    'code-structure': 'brownfield',
  },
  'user-stories': { 'business-overview': 'brownfield', 'component-inventory': 'brownfield' },
};

const stageBlock = (s) => ({
  type: 'STAGE',
  id: s.id,
  name: titleCase(s.id),
  defaultGrouping: s.phase,
  // V2's branching rationale (free-form prose the orchestrator reads to decide
  // whether a CONDITIONAL stage runs). Required in V2 frontmatter.
  condition: STAGE_PROSE[s.id]?.condition ?? '',
  leadAgent: s.leadAgent,
  supportAgents: s.support ?? [],
  mode: s.mode,
  execution: s.execution,
  forEach: s.forEach ?? null,
  c1_definition: {
    purpose: '',
    // Structured consume edges. `conditional_on` marks an edge that only
    // applies to a brownfield run (V2's consumes[].conditional_on); absent for
    // unconditional consumes.
    inputs: s.consumes.map(([artifact, required]) => {
      const conditionalOn = CONDITIONAL_ON[s.id]?.[artifact];
      return conditionalOn ? { artifact, required, conditionalOn } : { artifact, required };
    }),
    outputs: s.produces,
    intermediates: [],
    requires: s.requires,
    // V2's human Inputs/Outputs prose lines, preserved verbatim for a lossless
    // round-trip (distinct from the structured inputs/outputs above).
    inputsProse: STAGE_PROSE[s.id]?.inputs ?? '',
    outputsProse: STAGE_PROSE[s.id]?.outputs ?? '',
  },
  // Sensors are referenced by id; their modes live on the SENSOR blocks. The
  // baseline ships only deterministic sensors.
  //
  // V2's stage-protocol gates every stage on explicit human approval EXCEPT the
  // 3 Initialization stages (workspace-scaffold/detection, state-init). We
  // encode that universal gate here so the compiled autonomy profile reflects
  // V2's real default (human-gated), not a misleading all-autonomous reading.
  // The gate is a per-stage default a fork can relax.
  c2_verification: {
    sensors: s.sensors,
    humanValidation: s.phase === 'initialization' ? 'none' : 'required',
  },
  c3_learning: { captures: ['human-corrections'], promotionTargets: ['guardrail-library'] },
});

// ─── Artifacts ───
// The artifact vocabulary, derived from the stages so the registry can never
// drift from the graph: one ARTIFACT block per distinct produced name. A
// `terminal` artifact is produced but consumed by no stage — a deliberate
// end-of-flow output (reports, questions files), as opposed to an unregistered
// name, which the compiler now flags as a likely typo.
const buildArtifacts = () => {
  const consumed = new Set();
  for (const s of STAGES) {
    for (const [artifact] of s.consumes) consumed.add(artifact);
  }
  const producedBy = new Map();
  for (const s of STAGES) {
    for (const artifact of s.produces) {
      if (!producedBy.has(artifact)) producedBy.set(artifact, []);
      producedBy.get(artifact).push(s.id);
    }
  }
  return [...producedBy.keys()].toSorted().map((artifact) => ({
    type: 'ARTIFACT',
    id: artifact,
    name: titleCase(artifact),
    producedBy: producedBy.get(artifact),
    terminal: !consumed.has(artifact),
  }));
};
const ARTIFACTS = buildArtifacts();

// ─── Knowledge ───
// The methodology-tier knowledge corpus, ported from V2's core/knowledge/.
// Each entry attaches to an agent id (or the `shared` cross-cutting corpus).
// Only the methodology tier ships in the baseline; the team tier is accrued
// per-project at execution time (the learning-loop write-back seam).
const KNOWLEDGE = [
  ['aidlc-architect-agent', 'adr-template'],
  ['aidlc-architect-agent', 'architecture-guide'],
  ['aidlc-architect-agent', 'architecture-patterns'],
  ['aidlc-architect-agent', 'ddd-patterns'],
  ['aidlc-architect-agent', 'nfr-design-guide'],
  ['aidlc-architect-agent', 'nfr-design-patterns'],
  ['aidlc-aws-platform-agent', 'cdk-best-practices'],
  ['aidlc-aws-platform-agent', 'cost-optimization-patterns'],
  ['aidlc-aws-platform-agent', 'infrastructure-guide'],
  ['aidlc-aws-platform-agent', 'well-architected-framework'],
  ['aidlc-compliance-agent', 'regulatory-frameworks'],
  ['aidlc-delivery-agent', 'mob-programming-guide'],
  ['aidlc-delivery-agent', 'team-topologies'],
  ['aidlc-delivery-agent', 'workflow-planning-guide'],
  ['aidlc-design-agent', 'accessibility-wcag'],
  ['aidlc-design-agent', 'component-spec-template'],
  ['aidlc-design-agent', 'interaction-design-patterns'],
  ['aidlc-design-agent', 'ux-guide'],
  ['aidlc-design-agent', 'wireframing-guide'],
  ['aidlc-developer-agent', 'api-design-guide'],
  ['aidlc-developer-agent', 'code-analysis-guide'],
  ['aidlc-developer-agent', 'code-generation-guide'],
  ['aidlc-developer-agent', 'code-generation-patterns'],
  ['aidlc-developer-agent', 'data-modelling-patterns'],
  ['aidlc-developer-agent', 're-artifacts'],
  ['aidlc-devsecops-agent', 'devsecops-pipeline-patterns'],
  ['aidlc-devsecops-agent', 'nfr-requirements-guide'],
  ['aidlc-devsecops-agent', 'security-guide'],
  ['aidlc-devsecops-agent', 'threat-modelling-stride'],
  ['aidlc-operations-agent', 'incident-response-guide'],
  ['aidlc-operations-agent', 'nfr-performance-guide'],
  ['aidlc-operations-agent', 'observability-patterns'],
  ['aidlc-operations-agent', 'slo-sli-patterns'],
  ['aidlc-pipeline-deploy-agent', 'branching-strategies'],
  ['aidlc-pipeline-deploy-agent', 'cicd-patterns'],
  ['aidlc-pipeline-deploy-agent', 'deployment-strategies'],
  ['aidlc-product-agent', 'functional-design-guide'],
  ['aidlc-product-agent', 'market-research-methods'],
  ['aidlc-product-agent', 'prioritization-frameworks'],
  ['aidlc-product-agent', 'product-guide'],
  ['aidlc-product-agent', 'requirements-elicitation'],
  ['aidlc-product-agent', 'requirements-guide'],
  ['aidlc-product-agent', 'user-story-patterns'],
  ['aidlc-quality-agent', 'nfr-reliability-guide'],
  ['aidlc-quality-agent', 'nfr-validation-methods'],
  ['aidlc-quality-agent', 'test-strategy-patterns'],
  ['aidlc-quality-agent', 'testing-guide'],
  ['aidlc-shared', 'ai-dlc-principles'],
  ['aidlc-shared', 'audit-format'],
  ['aidlc-shared', 'brownfield'],
  ['aidlc-shared', 'knowledge-readme-template'],
  ['aidlc-shared', 'memory-template'],
  ['aidlc-shared', 'rules-reading'],
  ['aidlc-shared', 'state-template'],
  ['aidlc-shared', 'verification'],
  ['aidlc-shared', 'worktree-info-schema'],
];

// `agentRef` is the V2 knowledge namespace: an agent id, or `shared` for the
// cross-cutting corpus. The block id namespaces the doc under its agent so two
// agents can own a same-named doc without colliding.
const knowledgeBlock = ([agentRef, doc]) => ({
  type: 'KNOWLEDGE',
  id: agentRef === 'aidlc-shared' ? `shared-${doc}` : `${agentRef.replace(/^aidlc-/, '')}-${doc}`,
  name: titleCase(doc),
  tier: 'methodology',
  agentRef: agentRef === 'aidlc-shared' ? 'shared' : agentRef,
  description: `Methodology knowledge: ${titleCase(doc)} (${agentRef}).`,
});

const BASELINE_BLOCKS = [
  ...AGENTS.map(agentBlock),
  ...SCOPES.map(scopeBlock),
  ...SENSORS.map(sensorBlock),
  ...RULES.map(ruleBlock),
  ...STAGES.map(stageBlock),
  ...ARTIFACTS,
  ...KNOWLEDGE.map(knowledgeBlock),
];

// ─── Default workflow ───
// The 5 AI-DLC phases, defined inline (path encodes order), and one placement
// per stage homed under its phase. Each placement's scopeMembership is the
// transpose of the stage's V2 `scopes:` list (listed → EXECUTE).
const PHASE_ORDER = ['initialization', 'ideation', 'inception', 'construction', 'operation'];
const phasePath = (phase) => String(PHASE_ORDER.indexOf(phase) + 1).padStart(2, '0');

const DEFAULT_WORKFLOW_PHASES = PHASE_ORDER.map((phase) => ({
  phaseId: phase,
  name: titleCase(phase),
  kind: 'phase',
  path: phasePath(phase),
}));

const DEFAULT_WORKFLOW_PLACEMENTS = STAGES.map((s, i) => ({
  stageId: s.id,
  phasePath: phasePath(s.phase),
  order: i,
  scopeMembership: Object.fromEntries(s.scopes.map((scope) => [scope, 'EXECUTE'])),
}));

// Every rule in the baseline is layered into the default workflow: the 3
// universal layers (org/team/project) plus the 4 phase rules. A phase rule
// resolves onto a placement when its `phase` matches the placement's phase (the
// compiler does the join); the universal layers apply to every stage.
const DEFAULT_WORKFLOW_RULE_REFS = RULES.map(([id, layer]) => ({ layer, ruleId: id }));

const BASELINE_WORKFLOWS = [
  {
    id: 'aidlc-v2',
    name: 'AI-DLC v2 (default)',
    objective: 'The default AI-DLC v2 flow — the full 32-stage methodology to fork and tailor.',
    defaultScope: 'feature',
    phases: DEFAULT_WORKFLOW_PHASES,
    placements: DEFAULT_WORKFLOW_PLACEMENTS,
    ruleRefs: DEFAULT_WORKFLOW_RULE_REFS,
  },
];

module.exports = { BASELINE_BLOCKS, BASELINE_WORKFLOWS };
