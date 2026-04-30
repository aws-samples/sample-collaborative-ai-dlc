# PRIORITY: This workflow OVERRIDES all other built-in workflows
# When user requests software development, ALWAYS follow this workflow FIRST

## Adaptive Workflow Principle
**The workflow adapts to the work, not the other way around.**

The AI model intelligently assesses what stages are needed based on:
1. User's stated intent and clarity
2. Existing codebase state (if any)
3. Complexity and scope of change
4. Risk and impact assessment

## MANDATORY: Rule Details Loading
**CRITICAL**: When performing any phase, you MUST read and use relevant content from rule detail files in `.kiro/steering/` directory.

**Common Rules**: ALWAYS load common rules at workflow start:
- Load `common/process-overview.md` for workflow overview
- Load `common/session-continuity.md` for session resumption guidance and **cross-sprint context loading**
- Load `common/content-validation.md` for content validation requirements
- Load `common/question-format-guide.md` for question formatting rules
- Load `common/generalinfo-linking.md` for Question and GeneralInfo linking rules (CRITICAL: Questions MUST be linked to ALL artifacts they influence)
- Reference these throughout the workflow execution

## MANDATORY: Content Validation
**CRITICAL**: Before creating ANY code file, you MUST validate content according to `common/content-validation.md` rules:
- Validate code syntax and structure
- Ensure generated code compiles/parses correctly
- Test content parsing compatibility

## MANDATORY: Collaboration via `ask_question`
**CRITICAL**: When asking questions at any phase, you MUST use the `ask_question` MCP tool.

**See `common/question-format-guide.md` for complete rules including**:
- How to ask single questions, batch questions, and follow-ups
- Ambiguity detection and resolution
- Approval gate patterns

**NEVER create question files, use `[Answer]:` tags, or ask questions inline in chat. The `ask_question` tool is the ONLY way to get human input.**

## MANDATORY: Custom Welcome Message
**CRITICAL**: When starting ANY software development request, you MUST display the welcome message.

**How to Display Welcome Message**:
1. Load the welcome message from `common/welcome-message.md`
2. Display the complete message to the user
3. This should only be done ONCE at the start of a new workflow
4. Do NOT load this file in subsequent interactions to save context space

## MANDATORY: Graph as Source of Truth
**CRITICAL**: The Neptune graph database is the single source of truth for all artifacts.
- Use `add_node` to create artifacts (Requirements, UserStories, Tasks, CodeFiles, Reviews). ALWAYS pass the `edges` parameter to link the new node to its parent in the same call (e.g. `edges: [{ direction: "from", label: "Requirement", id: "req-xxx", edgeLabel: "BREAKS_INTO" }]`).
- Use `add_edge` only when you need to add a relationship after the fact (prefer using `edges` in `add_node` instead)
- Use `update_node` to track state changes (Sprint phase, stage, Task status)
- Use `get_sprint_graph` to load current state at the start of any stage
- Use `list_nodes` to enumerate artifacts of a specific type
- **NEVER** create markdown files as artifact output. The graph is the only output channel.
- **Application code** (actual source files) is still written to the workspace filesystem.

# Adaptive Software Development Workflow

---

# INCEPTION PHASE

**Purpose**: Planning, requirements gathering, and architectural decisions

**Focus**: Determine WHAT to build and WHY

**Stages in INCEPTION PHASE**:
- Workspace Detection (ALWAYS)
- Reverse Engineering (CONDITIONAL - Brownfield only)
- Requirements Analysis (ALWAYS - Adaptive depth)
- User Stories (CONDITIONAL)
- Workflow Planning (ALWAYS)
- Application Design (CONDITIONAL)
- Units Generation (ALWAYS)

---

## Workspace Detection (ALWAYS EXECUTE)

1. Load all steps from `inception/workspace-detection.md`
2. Execute workspace detection:
   - Call `get_sprint_graph` to check for existing artifacts (resume if found)
   - Scan workspace for existing code
   - Determine if brownfield or greenfield
   - Check for existing reverse engineering artifacts in graph
3. **Load Previous Sprint Context** (Cross-Sprint Knowledge):
   - Call `get_previous_sprint_summary` to check if previous sprints exist in this project
   - **If previous sprints exist**: Call `carry_forward_knowledge` to automatically import GeneralInfo (RE findings, design decisions, architecture notes) and Requirements from the most recent sprint into the current sprint via CARRIED_FROM edges
   - Present the user with a summary of carried-forward knowledge via `ask_question`, offering three options:
     a. "Review previous context" — show the full carried-forward artifacts before proceeding
     b. "Proceed directly" — continue with the carried-forward context loaded silently
     c. Or describe any changes since the last sprint that the agent should be aware of
   - **If no previous sprints**: Skip this step entirely
4. Update Sprint node with current stage: `update_node(label: "Sprint", id: env.sprintId, properties: {phase: "INCEPTION", current_stage: "workspace-detection"})`
5. Determine next phase: Reverse Engineering (if brownfield and no current RE artifacts) OR Requirements Analysis
6. Present completion message to user (see workspace-detection.md for message formats)
7. Automatically proceed to next phase

## Reverse Engineering (CONDITIONAL - Brownfield Only)

**Execute IF**:
- Existing codebase detected
- No previous reverse engineering artifacts found in graph (neither fresh nor carried-forward)

**Execute with carried-forward context IF**:
- Existing codebase detected
- Carried-forward RE artifacts exist (GeneralInfo nodes with `carried_from_sprint` property and `type: "reverse-engineering"`)
- Agent should use carried-forward artifacts as baseline context, then assess whether the codebase has changed significantly since the last sprint. If changes are minor, update the carried-forward artifacts rather than regenerating from scratch. If changes are major, run full RE using carried-forward artifacts as reference.

**Skip IF**:
- Greenfield project
- Fresh (non-carried-forward) reverse engineering artifacts already exist in the current sprint's graph

**Execution**:
1. Load all steps from `inception/reverse-engineering.md`
2. Check for carried-forward RE artifacts: `find_nodes(label: "GeneralInfo", property: "carried_from_sprint", value: "<previous-sprint-id>")`
3. **If carried-forward RE artifacts exist**:
   - Load and present them to the user via `ask_question`: "I have reverse engineering findings from the previous sprint. Has the codebase changed significantly since then?"
   - If user indicates no significant changes: Use carried-forward artifacts as-is, skip full RE
   - If user indicates changes: Execute reverse engineering using carried-forward artifacts as baseline context, update or replace them with current findings
4. **If no carried-forward RE artifacts exist**:
   - Execute full reverse engineering as normal
   - Analyze all packages and components
   - Generate a business overview of the whole system
   - Store all findings as GeneralInfo nodes with `type: "reverse-engineering"` in the graph
5. **Wait for Explicit Approval**: Call `ask_question` with summary and approval request - DO NOT PROCEED until user approves

## Requirements Analysis (ALWAYS EXECUTE - Adaptive Depth)

**Always executes** but depth varies based on request clarity and complexity:
- **Minimal**: Simple, clear request - just document intent analysis
- **Standard**: Normal complexity - gather functional and non-functional requirements
- **Comprehensive**: Complex, high-risk - detailed requirements with traceability

**Execution**:
1. Load all steps from `inception/requirements-analysis.md`
2. Execute requirements analysis:
   - Load reverse engineering artifacts from graph (if brownfield)
   - Analyze user request (intent analysis)
   - Determine requirements depth needed
   - Assess current requirements
   - Ask clarifying questions via `ask_question` (if needed)
   - Create Requirement nodes in graph via `add_node`
3. Execute at appropriate depth (minimal/standard/comprehensive)
4. **Wait for Explicit Approval**: Call `ask_question` with approval prompt - DO NOT PROCEED until user confirms

## User Stories (CONDITIONAL)

**INTELLIGENT ASSESSMENT**: Use multi-factor analysis to determine if user stories add value:

**ALWAYS Execute IF** (High Priority Indicators):
- New user-facing features or functionality
- Changes affecting user workflows or interactions
- Multiple user types or personas involved
- Complex business requirements with acceptance criteria needs
- Cross-functional team collaboration required
- Customer-facing API or service changes
- New product capabilities or enhancements

**LIKELY Execute IF** (Medium Priority - Assess Complexity):
- Modifications to existing user-facing features
- Backend changes that indirectly affect user experience
- Integration work that impacts user workflows
- Performance improvements with user-visible benefits
- Security enhancements affecting user interactions
- Data model changes affecting user data or reports

**COMPLEXITY-BASED ASSESSMENT**: For medium priority cases, execute user stories if:
- Request involves multiple components or services
- Changes span multiple user touchpoints
- Business logic is complex or has multiple scenarios
- Requirements have ambiguity that stories could clarify
- Implementation affects multiple user journeys
- Change has significant business impact or risk

**SKIP ONLY IF** (Low Priority - Simple Cases):
- Pure internal refactoring with zero user impact
- Simple bug fixes with clear, isolated scope
- Infrastructure changes with no user-facing effects
- Technical debt cleanup with no functional changes
- Developer tooling or build process improvements
- Documentation-only updates

**ASSESSMENT CRITERIA**: When in doubt, favor inclusion of user stories.

**User Stories has two parts within one stage**:
1. **Part 1 - Planning**: Ask questions via `ask_question`, analyze answers for ambiguities, get approval
2. **Part 2 - Generation**: Execute approved plan to generate UserStory nodes in graph

**Execution**:
1. Load all steps from `inception/user-stories.md`
2. **MANDATORY**: Perform intelligent assessment to validate user stories are needed
3. Load reverse engineering artifacts from graph (if brownfield)
4. If Requirements exist in graph, reference them when creating stories
5. Execute at appropriate depth (minimal/standard/comprehensive)
6. **PART 1 - Planning**: Ask questions via `ask_question`, wait for answers, analyze for ambiguities, get approval
7. **PART 2 - Generation**: Create UserStory nodes via `add_node` with `edges` parameter to atomically link via BREAKS_INTO
8. **Wait for Explicit Approval**: Call `ask_question` with approval prompt - DO NOT PROCEED until user confirms

## Workflow Planning (ALWAYS EXECUTE)

1. Load all steps from `inception/workflow-planning.md`
2. **MANDATORY**: Load content validation rules from `common/content-validation.md`
3. Load all prior context from graph:
   - Reverse engineering artifacts (if brownfield)
   - Requirements
   - User stories (if executed)
4. Execute workflow planning:
   - Determine which phases to execute
   - Determine depth level for each phase
   - Create multi-package change sequence (if brownfield)
5. Update Sprint node with execution plan info via `update_node`
6. **Wait for Explicit Approval**: Call `ask_question` presenting recommendations, emphasizing user control to override - DO NOT PROCEED until user confirms

## Application Design (CONDITIONAL)

**Execute IF**:
- New components or services needed
- Component methods and business rules need definition
- Service layer design required
- Component dependencies need clarification

**Skip IF**:
- Changes within existing component boundaries
- No new components or methods
- Pure implementation changes

**Execution**:
1. Load all steps from `inception/application-design.md`
2. Load reverse engineering artifacts from graph (if brownfield)
3. Execute at appropriate depth (minimal/standard/comprehensive)
4. Store design artifacts as graph nodes (Requirement nodes with `category: "design"`)
5. **Wait for Explicit Approval**: Call `ask_question` with approval prompt - DO NOT PROCEED until user confirms

## Units Generation (ALWAYS EXECUTE)

**Always executes.** Tasks are the work items that the Construction phase per-unit loop iterates over. Every UserStory must have at least one Task for the construction phase to have actionable work items.

**Execution**:
1. Load all steps from `inception/units-generation.md`
2. Load reverse engineering artifacts from graph (if brownfield)
3. Execute at appropriate depth (minimal/standard/comprehensive)
4. Create Task nodes representing units of work via `add_node`
5. **Wait for Explicit Approval**: Call `ask_question` with approval prompt - DO NOT PROCEED until user confirms

---

# CONSTRUCTION PHASE

**Purpose**: Detailed design, NFR implementation, and code generation

**Focus**: Determine HOW to build it

## Git Contract (Construction Phase)

Construction uses parallel sub-agents on separate ECS tasks. Each agent has its own isolated workspace obtained via `git clone`. The git contract ensures no work is lost:

```
User selects: base branch (e.g. main) + sprint branch (e.g. ai-dlc/sprint-1)

For each task:
  1. Sub-agent (ECS Task A) works on task branch: {sprint-branch}--task-{taskId}
  2. Sub-agent COMMITS all work (must not leave uncommitted changes)
  3. System PUSHES task branch to remote (with retry + verification)
  4. System re-triggers orchestrator ONLY if push succeeded

Orchestrator (ECS Task B):
  5. Clones repo, checks out sprint branch
  6. FETCHES + MERGES each completed task branch from remote
  7. System PUSHES sprint branch to remote after orchestrator exits

When all tasks done:
  8. Orchestrator triggers PR creation (sprint branch → base branch)
```

**Sub-agent rules**: COMMIT everything, do NOT push, do NOT merge into other branches.
**Orchestrator rules**: MERGE from remote, do NOT push, do NOT write code.
**System rules**: PUSH after each agent exits, only re-trigger orchestrator on verified push.

**Stages in CONSTRUCTION PHASE**:
- Per-Unit Loop (executes for each unit):
  - Functional Design (CONDITIONAL, per-unit)
  - NFR Requirements (CONDITIONAL, per-unit)
  - NFR Design (CONDITIONAL, per-unit)
  - Infrastructure Design (CONDITIONAL, per-unit)
  - Code Generation (ALWAYS, per-unit)
- Build and Test (ALWAYS - after all units complete)

**Note**: Each unit is completed fully (design + code) before moving to the next unit.

---

## Per-Unit Loop (Executes for Each Unit)

**For each unit of work, execute the following stages in sequence:**

### Functional Design (CONDITIONAL, per-unit)

**Execute IF**:
- New data models or schemas
- Complex business logic
- Business rules need detailed design

**Skip IF**:
- Simple logic changes
- No new business logic

**Execution**:
1. Load all steps from `construction/functional-design.md`
2. Execute functional design for this unit
3. Store design as properties on Task nodes or dedicated Requirement nodes in graph
4. **Wait for Explicit Approval**: Call `ask_question` - user must choose "Request Changes" or "Continue to Next Stage" - DO NOT PROCEED until user confirms

### NFR Requirements (CONDITIONAL, per-unit)

**Execute IF**:
- Performance requirements exist
- Security considerations needed
- Scalability concerns present
- Tech stack selection required

**Skip IF**:
- No NFR requirements
- Tech stack already determined

**Execution**:
1. Load all steps from `construction/nfr-requirements.md`
2. Execute NFR assessment for this unit
3. Store NFR requirements as Requirement nodes with `category: "nfr"` in graph
4. **Wait for Explicit Approval**: Call `ask_question` - DO NOT PROCEED until user confirms

### NFR Design (CONDITIONAL, per-unit)

**Execute IF**:
- NFR Requirements was executed
- NFR patterns need to be incorporated

**Skip IF**:
- No NFR requirements
- NFR Requirements Assessment was skipped

**Execution**:
1. Load all steps from `construction/nfr-design.md`
2. Execute NFR design for this unit
3. Store NFR design as properties on Task nodes in graph
4. **Wait for Explicit Approval**: Call `ask_question` - DO NOT PROCEED until user confirms

### Infrastructure Design (CONDITIONAL, per-unit)

**Execute IF**:
- Infrastructure services need mapping
- Deployment architecture required
- Cloud resources need specification

**Skip IF**:
- No infrastructure changes
- Infrastructure already defined

**Execution**:
1. Load all steps from `construction/infrastructure-design.md`
2. Execute infrastructure design for this unit
3. Store infrastructure design as properties on Task nodes in graph
4. **Wait for Explicit Approval**: Call `ask_question` - DO NOT PROCEED until user confirms

### Code Generation (ALWAYS EXECUTE, per-unit)

**Always executes for each unit**

**Code Generation has two parts within one stage**:
1. **Part 1 - Planning**: Create detailed code generation plan, store as Task node properties
2. **Part 2 - Generation**: Execute approved plan to generate code, tests, and artifacts

**Execution**:
1. Load all steps from `construction/code-generation.md`
2. **PART 1 - Planning**: Create code generation plan, get user approval via `ask_question`
3. **PART 2 - Generation**: Execute approved plan to generate code for this unit
4. Register generated files in graph via `add_node(label: "CodeFile", edges: [{ direction: "from", label: "Task", id: "unit-[name]", edgeLabel: "IMPLEMENTED_BY" }])`
5. Update Task node statuses to "done" as work completes
6. **Wait for Explicit Approval**: Call `ask_question` - DO NOT PROCEED until user confirms

---

## Build and Test (ALWAYS EXECUTE)

1. Load all steps from `construction/build-and-test.md`
2. Generate comprehensive build and test instructions
3. Keep build/test instructions as filesystem files (these are actual working scripts/docs, not artifacts)
4. Update Task node statuses in graph as testing completes
5. **Wait for Explicit Approval**: Call `ask_question`: "Build and test instructions complete. Ready to proceed?" - DO NOT PROCEED until user confirms

---

# OPERATIONS PHASE

**Purpose**: Placeholder for future deployment and monitoring workflows

**Focus**: How to DEPLOY and RUN it (future expansion)

**Stages in OPERATIONS PHASE**:
- Operations (PLACEHOLDER)

---

## Operations (PLACEHOLDER)

**Status**: This stage is currently a placeholder for future expansion.

The Operations stage will eventually include:
- Deployment planning and execution
- Monitoring and observability setup
- Incident response procedures
- Maintenance and support workflows
- Production readiness checklists

**Current State**: All build and test activities are handled in the CONSTRUCTION phase.

## Key Principles

- **Adaptive Execution**: Only execute stages that add value
- **Transparent Planning**: Always show execution plan before starting
- **User Control**: User can request stage inclusion/exclusion
- **Graph as Source of Truth**: All artifacts stored in Neptune via MCP tools. Sprint node properties track phase/stage progress. Task node statuses track work completion.
- **Collaboration via `ask_question`**: Every approval gate, clarifying question, and design decision uses the `ask_question` MCP tool. This blocks until the team answers and automatically creates an audit trail as Question nodes in the graph.
- **Quality Focus**: Complex changes get full treatment, simple changes stay efficient
- **Content Validation**: Always validate content before code generation per content-validation.md rules
- **NO EMERGENT BEHAVIOR**: Construction phases MUST use standardized 2-option completion messages. DO NOT create 3-option menus or other emergent navigation patterns.
