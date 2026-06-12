# Workflow Planning

**Purpose**: Determine which phases to execute and create comprehensive execution plan

**Always Execute**: This phase always runs after understanding requirements and scope

## Step 1: Load All Prior Context from Graph

- Call `get_sprint_graph` to load the complete sprint state
- Call `list_nodes(label: "Requirement")` for all requirements (including reverse engineering artifacts)
- Call `list_nodes(label: "UserStory")` for user stories (if executed)
- Call `list_nodes(label: "Question")` for Q&A context

## Step 2: Detailed Scope and Impact Analysis

**Now that we have complete context (requirements + stories), perform detailed analysis:**

### 2.1 Transformation Scope Detection (Brownfield Only)

**IF brownfield project**, analyze transformation scope:

- **Single component change** vs **architectural transformation**
- **Infrastructure changes** vs **application changes**
- Related component identification
- Cross-package impact

### 2.2 Change Impact Assessment

1. **User-facing changes**: Does this affect user experience?
2. **Structural changes**: Does this change system architecture?
3. **Data model changes**: Does this affect database schemas?
4. **API changes**: Does this affect interfaces or contracts?
5. **NFR impact**: Does this affect performance, security, or scalability?

### 2.3 Risk Assessment

1. **Low**: Isolated change, easy rollback, well-understood
2. **Medium**: Multiple components, moderate rollback, some unknowns
3. **High**: System-wide impact, complex rollback, significant unknowns
4. **Critical**: Production-critical, difficult rollback, high uncertainty

## Step 3: Phase Determination

### 3.1 User Stories - Already Executed or Skip?

### 3.2 Application Design - Execute IF new components/services needed

### 3.3 Units Generation - Execute IF multiple units of work needed

### 3.4 NFR Implementation - Execute IF performance/security/scalability concerns

## Step 4: Note Adaptive Detail

**See [depth-levels.md](../common/depth-levels.md) for adaptive depth explanation**

For each stage that will execute:

- All defined artifacts will be created as graph nodes
- Detail level within artifacts adapts to problem complexity

## Step 5: Multi-Module Coordination Analysis (Brownfield Only)

**IF brownfield with multiple modules/packages**, analyze dependencies and determine optimal update strategy.

## Step 6: Update Sprint with Execution Plan

Store the execution plan as Sprint node properties:

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "workflow-planning",
  phase_status: "active",
  execution_plan: "[JSON or text summary of stages to execute/skip with rationale]",
  risk_level: "[low/medium/high/critical]"
})
```

## Step 7: Present Plan to User via `ask_question`

Call `ask_question` with:

```
"Workflow Planning Complete

I've created a comprehensive execution plan based on:
- Your request: [Summary]
- Existing system: [Summary if brownfield]
- Requirements: [Summary]
- User stories: [Summary if executed]

Detailed Analysis:
- Risk level: [Level]
- Impact: [Summary of key impacts]

Recommended Execution Plan:

INCEPTION PHASE:
1. [Stage name] - [EXECUTE/SKIP] - Rationale: [Why]
2. [Stage name] - [EXECUTE/SKIP] - Rationale: [Why]
...

CONSTRUCTION PHASE:
3. [Stage name] - [EXECUTE/SKIP] - Rationale: [Why]
4. [Stage name] - [EXECUTE/SKIP] - Rationale: [Why]
...

[IF brownfield with multiple packages]
Recommended Package Update Sequence:
1. [Package] - [Reason]
2. [Package] - [Reason]

You may:
- APPROVE this plan and proceed
- Request changes to include/exclude specific stages
- Add skipped stages back into the plan

What would you like to do?"
```

## Step 8: Handle User Response

- **If approved**: Proceed to next stage in execution plan
- **If changes requested**: Update execution plan and call `ask_question` again
- **If user wants to force include/exclude stages**: Update plan accordingly
