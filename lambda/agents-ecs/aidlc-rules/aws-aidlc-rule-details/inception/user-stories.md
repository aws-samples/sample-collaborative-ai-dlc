# User Stories - Detailed Steps

## Purpose

**Convert requirements into user-centered stories with acceptance criteria**

User Stories focus on:

- Translating business requirements into user-centered narratives
- Defining clear acceptance criteria for each story
- Creating user personas that represent different stakeholder types
- Establishing shared understanding across teams
- Providing testable specifications for implementation

## Prerequisites

- Workspace Detection must be complete
- Requirements Analysis recommended (can reference requirements if available)
- Workflow Planning must indicate User Stories stage should execute

## Intelligent Assessment Guidelines

**WHEN TO EXECUTE USER STORIES**: Use this enhanced assessment before proceeding:

### High Priority Execution (ALWAYS Execute)

- **New User Features**: Any new functionality users will directly interact with
- **User Experience Changes**: Modifications to existing user workflows or interfaces
- **Multi-Persona Systems**: Applications serving different types of users
- **Customer-Facing APIs**: Services that external users or systems will consume
- **Complex Business Logic**: Requirements with multiple scenarios or business rules
- **Cross-Team Projects**: Work requiring shared understanding across multiple teams

### Medium Priority Execution (Assess Complexity)

- **Backend User Impact**: Internal changes that indirectly affect user experience
- **Performance Improvements**: Enhancements with user-visible benefits
- **Integration Work**: Connecting systems that affect user workflows
- **Data Changes**: Modifications affecting user data, reports, or analytics
- **Security Enhancements**: Changes affecting user authentication or permissions

### Skip Only For Simple Cases

- **Pure Refactoring**: Internal code improvements with zero user impact
- **Isolated Bug Fixes**: Simple, well-defined fixes with clear scope
- **Infrastructure Only**: Changes with no user-facing effects
- **Developer Tooling**: Build processes, CI/CD, or development environment changes

### Default Decision Rule

**When in doubt, include user stories AND ask clarifying questions.**

---

# PART 1: PLANNING

## Step 1: Validate User Stories Need (MANDATORY)

Perform assessment using the criteria above. If justified, proceed.

## Step 2: Load Context from Graph

- Call `list_nodes(label: "Requirement")` to load all requirements
- Call `list_nodes(label: "Question")` to review previous Q&A context
- If brownfield, load reverse engineering artifacts from graph

## Step 3: Ask Planning Questions via `ask_question`

**DIRECTIVE**: Thoroughly analyze the requirements and context to identify ALL areas where clarification would improve story quality.

**CRITICAL**: Default to asking questions when there is ANY ambiguity or missing detail.

Call `ask_question` with batched questions covering relevant areas:

- **User Personas** - user types, roles, characteristics, motivations
- **Story Granularity** - level of detail, story size, breakdown approach
- **Breakdown Approach** - organization method, prioritization, grouping
- **Acceptance Criteria** - detail level, format, testing approach
- **User Journeys** - workflows, interaction patterns, experience flows
- **Business Context** - goals, success metrics, stakeholder needs

## Step 4: Analyze Answers (MANDATORY)

Before proceeding, carefully review all answers for:

- **Vague or ambiguous responses**: "mix of", "somewhere between", "not sure", "depends"
- **Undefined criteria or terms**: References without clear definitions
- **Contradictory answers**: Responses that conflict with each other
- **Missing details**: Answers that lack specific guidance

## Step 5: Follow-up Questions (if needed)

If Step 4 reveals ANY ambiguous answers, call `ask_question` again with targeted follow-ups:

```
Call `ask_question` with:
"I need clarification on some of your responses:
1. You mentioned '[ambiguous answer]' — [specific clarification question]
2. [Additional follow-up questions]
Please provide specific answers."
```

DO NOT proceed to approval until ALL ambiguities are resolved.

## Step 6: Request Plan Approval

Call `ask_question` with:

```
"User story planning is complete. Based on your answers, I plan to:
- Create [approach] user stories organized by [method]
- Define [N] user personas
- Include acceptance criteria in [format]
- [Other key decisions]

Do you APPROVE this approach, or describe what changes are needed?"
```

Wait for explicit approval before proceeding to generation.

---

# PART 2: GENERATION

## Step 7: Create UserStory Nodes in Graph

For each user story, create a UserStory node and link it to its parent Requirement:

```
add_node(label: "UserStory", id: "story-[descriptive-id]", properties: {
  title: "As a [persona], I want [action] so that [benefit]",
  description: "[detailed story description with acceptance criteria]",
  story_points: "[estimate]",
  persona: "[persona name]"
}, edges: [
  { direction: "from", label: "Requirement", id: "req-[id]", edgeLabel: "BREAKS_INTO" }
])
```

**IMPORTANT**: ALWAYS pass the `edges` parameter when creating UserStories to link them to their parent Requirement in the same call. Do NOT use separate `add_edge` calls for this.

**CRITICAL**: After creating UserStories, link ALL Questions from Step 3 that influenced them:

```
// For each Question that influenced a UserStory
add_edge(
  fromLabel: "Question",
  fromId: "[question-id]",
  toLabel: "UserStory",
  toId: "story-[id]",
  edgeLabel: "INFLUENCES"
)
```

Ensure stories follow INVEST criteria:

- **I**ndependent, **N**egotiable, **V**aluable, **E**stimable, **S**mall, **T**estable

## Step 8: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "user-stories",
  phase_status: "active"
})
```

## Step 9: Request Approval

Call `ask_question` with:

```
"User Stories Complete

User stories generation has created:
- [N] user personas: [list persona names]
- [N] user stories organized by [method]
- All stories include acceptance criteria and follow INVEST criteria
- Stories are linked to their parent Requirements in the graph

Do you APPROVE to proceed to Workflow Planning, or describe what changes are needed?"
```

Wait for explicit approval. If changes requested, update story nodes and re-request approval.

---

# CRITICAL RULES

## Planning Phase Rules

- **CONTEXT-APPROPRIATE QUESTIONS**: Only ask questions relevant to this specific context
- **MANDATORY ANSWER ANALYSIS**: Always analyze answers for ambiguities before proceeding
- **NO PROCEEDING WITH AMBIGUITY**: Must resolve all vague answers before generation
- **EXPLICIT APPROVAL REQUIRED**: User must approve plan before generation starts

## Generation Phase Rules

- **USE APPROVED METHODOLOGY**: Follow the story approach from Planning
- **VERIFY COMPLETION**: Ensure all story artifacts are complete before proceeding
- **GRAPH IS SOURCE OF TRUTH**: All stories stored as UserStory nodes with proper edges
