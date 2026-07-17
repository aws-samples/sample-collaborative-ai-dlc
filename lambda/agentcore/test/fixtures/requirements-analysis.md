# Requirements Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

### Step 2: Load Prior Context

- If brownfield: Read RE artifacts from `aidlc-docs/inception/reverse-engineering/`
- Read user's project description from `aidlc-docs/audit.md`

### Step 3: Analyze User Request

Assess the user's request for:

- **Clarity**: How well-defined is the request?
- **Type**: New feature, enhancement, refactoring, bug fix, migration
- **Scope**: Single component, multi-component, system-wide
- **Complexity**: Simple, standard, complex

### Step 7: Generate Clarifying Questions

PROACTIVE: Always generate clarifying questions unless requirements are exceptionally clear and complete across all six dimensions.

Create `aidlc-docs/inception/requirements-analysis/requirements-analysis-questions.md` using the [Answer]: tag format from stage-protocol.md. Include context-appropriate questions with A-E options. EVERY question MUST end with `X. Other (please specify)` as the final option. Leave all [Answer]: tags blank.

Then follow the unified question flow from stage-protocol.md section 3: offer the user a choice between guided (interactive) and self-guided (file edit) modes. In either case, ensure all answers are written to the file before proceeding.

### Step 10: Generate Requirements

Create `aidlc-docs/inception/requirements-analysis/requirements.md` containing:

- **Intent analysis** — What the user is trying to achieve (goals, not just features)
- **Functional requirements** — Organized by feature area or domain
- **Non-functional requirements** — Performance, security, scalability targets

### Step 11: Update State

Update `aidlc-docs/aidlc-state.md`:

- Mark Requirements Analysis as `[x]` completed
- Update current stage and next stage

### Step 12: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :mag:

- Summary of requirements produced
- Review path: `aidlc-docs/inception/requirements-analysis/`

```question
prompt: "Requirements Analysis complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to next stage
  - label: Request Changes
    description: Provide revision feedback
```

## Learn

While running this stage, maintain a running log in
`aidlc-docs/<phase>/<stage>/memory.md` (create on stage start if absent).

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `{{HARNESS_DIR}}/rules/aidlc-phase-<phase>.md` (phase-scoped)
- Verification check → new manifest at `{{HARNESS_DIR}}/sensors/aidlc-<id>.md`

Run `bun {{HARNESS_DIR}}/tools/aidlc-learnings.ts surface --slug requirements-analysis`.
