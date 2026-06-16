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

// ─── Rules (7) ── layered guardrails; V2 ships them frontmatter-free ───
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
    'grouping',
    'ideation',
    'Ideation rules: evidence standards, scope discipline, output quality.',
  ],
  [
    'aidlc-phase-inception',
    'grouping',
    'inception',
    'Inception rules: requirements quality, architecture standards, traceability.',
  ],
  [
    'aidlc-phase-construction',
    'grouping',
    'construction',
    'Construction rules: code completeness, error handling, testing, security.',
  ],
  [
    'aidlc-phase-operation',
    'grouping',
    'operation',
    'Operation rules: infra safety, deployment procedures, observability, incident response.',
  ],
];

const ruleBlock = ([id, layer, groupingRef, summary]) => ({
  type: 'RULE',
  id,
  name: titleCase(id.replace(/^aidlc-/, '')),
  layer,
  groupingRef,
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

const stageBlock = (s) => ({
  type: 'STAGE',
  id: s.id,
  name: titleCase(s.id),
  defaultGrouping: s.phase,
  leadAgent: s.leadAgent,
  supportAgents: s.support ?? [],
  mode: s.mode,
  execution: s.execution,
  forEach: s.forEach ?? null,
  c1_definition: {
    purpose: '',
    inputs: s.consumes.map(([artifact, required]) => ({ artifact, required })),
    outputs: s.produces,
    intermediates: [],
    requires: s.requires,
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

const BASELINE_WORKFLOWS = [
  {
    id: 'aidlc-v2',
    name: 'AI-DLC v2 (default)',
    objective: 'The default AI-DLC v2 flow — the full 32-stage methodology to fork and tailor.',
    defaultScope: 'feature',
    phases: DEFAULT_WORKFLOW_PHASES,
    placements: DEFAULT_WORKFLOW_PLACEMENTS,
  },
];

module.exports = { BASELINE_BLOCKS, BASELINE_WORKFLOWS };
