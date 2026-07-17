// A realistic mini aidlc-workflows `core/**` tree as a Map<path, content>,
// faithful to the real frontmatter shapes (verbatim slices of the v2 source),
// exercising every block-mapper path: stages (incl. conditional_on, reviewer,
// for_each), agents (incl. a reviewer agent), scopes (incl. testStrategy
// override), sensors (+ their tools/aidlc-sensor-*.ts scripts), frontmatter-less
// rules + knowledge, a skill, a template, plus internal runtime files.

const F = (content) => content;

const CORE_FILES = new Map(
  Object.entries({
    // ── Stages (2 — one ALWAYS, one CONDITIONAL with reviewer + conditional_on)
    'core/aidlc-common/stages/ideation/intent-capture.md': F(`---
slug: intent-capture
phase: ideation
execution: ALWAYS
condition: First stage of every workflow — establishes the initiative's foundation
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-architect-agent
mode: inline
produces:
  - intent-statement
  - stakeholder-map
consumes: []
requires_stage: []
sensors:
  - required-sections
scopes:
  - feature
  - mvp
inputs: User's project description ($ARGUMENTS), scope selection
outputs: aidlc-docs/ideation/intent-capture/intent-statement.md
---

# Intent Capture & Framing

MANDATORY: Follow stage-protocol.md.
`),
    'core/aidlc-common/stages/inception/application-design.md': F(`---
slug: application-design
phase: inception
execution: CONDITIONAL
condition: Execute when new components or services are needed.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
produces:
  - components
  - decisions
consumes:
  - artifact: requirements
    required: true
  - artifact: architecture
    required: false
    conditional_on: brownfield
requires_stage:
  - requirements-analysis
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - feature
---

# Application Design

The design body.
`),
    'core/aidlc-common/stages/construction/functional-design.md': F(`---
slug: functional-design
name: Functional Design
number: 3.1
phase: construction
execution: CONDITIONAL
condition: New data models or business rules need design.
lead_agent: aidlc-architect-agent
mode: inline
for_each: unit-of-work
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
produces:
  - business-logic-model
optional_produces:
  - frontend-components
produces_kinds:
  business-logic-model:
    - service
    - ui
    - library
  frontend-components:
    - ui
required_sections:
  - Business Logic Model
consumes:
  - artifact: requirements
    required: true
requires_stage:
  - units-generation
sensors:
  - linter
scopes:
  - feature
---

# Functional Design
`),

    // ── Agents (a builder + a reviewer). The model keys exercise every pin
    // era: `tier` (≥2.3.1), `model` (2.2.15 rename), `modelOverride` (legacy).
    'core/agents/aidlc-product-agent.md': F(`---
name: aidlc-product-agent
display_name: Product Agent
examples:
  - roadmap.md
  - personas.md
description: >
  Product manager and business analyst responsible for requirements.
disallowedTools: Task
modelOverride: opus
---

# Product Agent

You are a senior product manager.
`),
    'core/agents/aidlc-architecture-reviewer-agent.md': F(`---
name: aidlc-architecture-reviewer-agent
display_name: Architecture Reviewer
description: >
  Senior solutions architect who reviews technical design artifacts.
disallowedTools: Task
tier: balanced
---

# Architecture Reviewer
`),
    'core/agents/aidlc-architect-agent.md': F(`---
name: aidlc-architect-agent
display_name: Architect Agent
description: Solutions architect.
disallowedTools: Task
tier: judgment
---

# Architect Agent
`),
    'core/agents/aidlc-aws-platform-agent.md': F(`---
name: aidlc-aws-platform-agent
display_name: AWS Platform Agent
description: AWS solutions architect.
model: sonnet
---

# AWS Platform Agent
`),

    // ── Scopes (default + testStrategy override)
    'core/scopes/aidlc-feature.md': F(`---
name: feature
depth: Standard
keywords: []
description: Default for new features, practical depth
---

# feature scope

Body.
`),
    'core/scopes/aidlc-workshop.md': F(`---
name: workshop
depth: Standard
testStrategy: Minimal
keywords:
  - workshop
  - lab
description: Facilitated group session with mandatory gates
---

# workshop scope
`),

    // ── Sensors (with nested schema; scripts live in core/tools/)
    'core/sensors/aidlc-linter.md': F(`---
id: linter
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts
default_severity: advisory
description: Wraps the project's configured linter; fires on TS/JS code outputs
category: code-quality
matches: "**/*.{ts,js}"
input_schema:
  file_path: string
output_schema:
  pass: boolean
timeout_seconds: 30
---

# linter sensor

Manifest prose.
`),
    'core/sensors/aidlc-required-sections.md': F(`---
id: required-sections
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-required-sections.ts
default_severity: advisory
description: Checks H2 headings
category: document-shape
matches: "**/aidlc-docs/**"
timeout_seconds: 5
---

# required-sections sensor
`),

    // ── Rules (NO frontmatter — derive from filename)
    'core/rules/aidlc-org.md': F(`# Org-Level Rules

Framework defaults: trunk-based development.
`),
    'core/rules/aidlc-phase-ideation.md': F(`# Ideation Phase Guardrails

These rules apply to every ideation stage.
`),

    // ── Knowledge (NO frontmatter — derive agentRef/doc from path)
    'core/knowledge/aidlc-product-agent/requirements-guide.md': F(`# Requirements Guide

How to elicit requirements.
`),
    'core/knowledge/aidlc-shared/ai-dlc-principles.md': F(`# AI-DLC Principles

The eight principles.
`),

    // ── Skill (user-invocable runner pack)
    'core/skills/aidlc-replay/SKILL.md': F(`---
name: aidlc-replay
description: >
  Print a structured session narrative.
argument-hint: ""
user-invocable: true
classification: read-only
---

# AI-DLC Session Replay
`),

    // ── Template
    'core/templates/onboarding.md': F(`{{SLOT:title_block}}

## Prerequisites

{{SLOT:prereq_bullets}}
`),

    // ── Internal runtime: a sensor script, a generic engine tool, a hook,
    //    protocols, and the conductor — NOT editable blocks.
    'core/tools/aidlc-sensor-linter.ts': F(`// aidlc-sensor-linter.ts — the linter sensor script.
export function run() {}
`),
    'core/tools/aidlc-sensor-required-sections.ts': F(`// required-sections sensor script.
export function run() {}
`),
    'core/tools/aidlc-orchestrate.ts': F(`// The orchestration engine.
export function next() {}
`),
    'core/hooks/aidlc-session-start.ts': F(`// session-start hook.
export function onStart() {}
`),
    'core/aidlc-common/protocols/stage-protocol.md': F(`# Stage Protocol

MANDATORY: All stages follow this protocol.
`),
    'core/aidlc-common/conductor.md': F(`# The Conductor's Craft

You are the AI-DLC conductor.
`),

    // ── Scaffold (.gitkeep-style) — ignored by the mappers and runtime filter.
    'core/tools/data/scaffold/ideation/intent-capture/.gitkeep': F(''),
  }),
);

export { CORE_FILES };
export default { CORE_FILES };
