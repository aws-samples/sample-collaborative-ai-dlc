# Units Generation - Detailed Steps

## Overview

This stage decomposes the system into manageable units of work through two integrated parts:

- **Part 1 - Planning**: Ask questions via `ask_question`, analyze answers, get approval
- **Part 2 - Generation**: Execute approved plan to create Task nodes in the graph

**DEFINITION**: A unit of work is a logical grouping of stories for development purposes.

**Terminology**: Use "Service" for independently deployable components, "Module" for logical groupings within a service, "Unit of Work" for planning context.

## Prerequisites

- Workspace Detection must be complete
- Requirements Analysis recommended
- Application Design phase REQUIRED

**This stage ALWAYS executes.** Tasks are the work items that the Construction phase per-unit loop iterates over. Without Tasks, the construction phase has no actionable work items to process.

---

# PART 1: PLANNING

## Step 1: Load Context from Graph

- Call `get_sprint_graph` to load all artifacts
- Call `list_nodes(label: "Requirement")` — focus on design artifacts
- Call `list_nodes(label: "UserStory")` to understand story assignments

## Step 2: Ask Planning Questions via `ask_question`

Call `ask_question` with batched questions covering relevant areas:

- **Story Grouping** - Only if multiple stories and grouping is unclear
- **Dependencies** - Only if multiple units and integration approach is ambiguous
- **Team Alignment** - Only if team structure or ownership is unclear
- **Technical Considerations** - Only if scalability/deployment requirements differ
- **Business Domain** - Only if domain boundaries are unclear
- **Code Organization (Greenfield)** - Deployment model and directory structure

## Step 3: Analyze Answers (MANDATORY)

Review all answers for ambiguities. If ANY are detected, call `ask_question` again.

## Step 4: Request Plan Approval

Call `ask_question` with:

```
"Unit of work planning is complete. Based on the design and your answers, I plan to decompose into:
- [N] units: [list unit names and brief descriptions]
- Dependencies: [brief dependency overview]
- [Other key decisions]

Do you APPROVE this decomposition, or describe what changes are needed?"
```

Wait for explicit approval.

---

# PART 2: GENERATION

## Step 5: Create Task Nodes for Units

For each unit of work, create a Task node and link stories:

```
add_node(label: "Task", id: "unit-[name]", properties: {
  title: "[Unit Name]",
  description: "[unit responsibilities, boundaries, dependencies]",
  status: "todo",
  unit_type: "service" or "module"
}, edges: [
  { direction: "from", label: "UserStory", id: "story-[id]", edgeLabel: "BREAKS_INTO" }
])
```

**IMPORTANT**: ALWAYS pass the `edges` parameter when creating Tasks to link them to their parent UserStory in the same call. Do NOT use separate `add_edge` calls for this. If a Task relates to multiple UserStories, include multiple entries in the `edges` array.

**CRITICAL**: After creating Tasks, link ALL Questions from Step 2 that influenced them:

```
// For each Question that influenced a Task
add_edge(
  fromLabel: "Question",
  fromId: "[question-id]",
  toLabel: "Task",
  toId: "unit-[name]",
  edgeLabel: "INFLUENCES"
)
```

## Step 6: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "units-generation",
  phase_status: "ready_for_transition"
})
```

## Step 7: Finalize Inception Phase

Present a final status summary in chat. Do **not** call `ask_question` for the phase transition.

```
"Units Generation Complete

[AI-generated summary of units and decomposition in bullet points]
- [N] units created with dependencies mapped
- All user stories assigned to units

Inception phase is ready for human review. When the team is ready, click Approve & Move to Construction in the Sprint page."
```

Exit cleanly after the summary. If the team later requests changes, handle that as a new intra-phase refinement request and update the relevant Task nodes.

---

## Critical Rules

### Planning Phase Rules

- Generate ONLY context-relevant questions
- Analyze all answers for ambiguities before proceeding
- Resolve ALL ambiguities with follow-up `ask_question` calls
- Get explicit user approval before generation

### Generation Phase Rules

- **GRAPH IS SOURCE OF TRUTH**: All units stored as Task nodes with proper edges
- **EVERY UserStory MUST HAVE AT LEAST ONE Task**: The construction per-unit loop iterates over Task nodes. If a UserStory has no Task, its work will never be executed.
- **USE APPROVED APPROACH**: Follow the decomposition methodology from Planning
- **VERIFY COMPLETION**: Ensure all stories are assigned to units
- **Sprint CONTAINS edge**: Created automatically by `add_node` when creating Task nodes — no separate `add_edge` call needed
