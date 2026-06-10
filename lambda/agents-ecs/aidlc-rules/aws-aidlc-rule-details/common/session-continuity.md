# Session Continuity

## Resuming an Existing Sprint

When resuming work on an existing AI-DLC sprint, follow these steps:

### Step 1: Load Current State from Graph

Call `get_sprint_graph` to load all existing artifacts and understand the current state of the sprint.

### Step 2: Analyze Sprint Status

From the Sprint node properties, determine:

- **Current Phase**: INCEPTION, CONSTRUCTION, or REVIEW
- **Current Stage**: The specific stage in progress
- **Phase Status**: `active`, `ready_for_transition`, or `completed`

If `phase_status` is `ready_for_transition`, do not ask for phase-transition approval. Present the ready state and tell the team to use the Sprint page transition button when they are ready.

From the presence of graph nodes, determine what has been completed:

- **Requirement nodes exist** -> Requirements Analysis is complete
- **UserStory nodes exist** -> User Stories stage is complete
- **Task nodes exist** -> Units Generation / planning is complete
- **CodeFile nodes exist** -> Code Generation has started or completed
- **Review nodes exist** -> Review process has started

### Step 3: Present Status Summary

Present the current status to the team:

```
Welcome back! Based on the sprint graph, here's your current status:
- **Current Phase**: [phase from Sprint node]
- **Current Stage**: [stage from Sprint node]
- **Phase Status**: [phase_status from Sprint node]
- **Artifacts**: [count] Requirements, [count] User Stories, [count] Tasks, [count] Code Files
- **Carried-Forward Context**: [count] artifacts from previous sprint (if any)
- **Questions Asked**: [count] (view in Sprint page)
- **Next Step**: [determined from graph analysis]

Continuing from where you left off.
```

### Step 4: Load Stage-Specific Context

Before resuming any stage, load relevant artifacts from the graph:

- **Early Stages (Workspace Detection, Reverse Engineering)**: Call `get_sprint_graph` for overview
- **Requirements/Stories**: Call `list_nodes(label: "Requirement")` + any reverse engineering nodes
- **Design Stages**: Call `list_nodes` for Requirements, UserStories, and any design-related nodes
- **Code Stages**: Call `get_sprint_graph` to load ALL artifacts + review existing code files on filesystem
- **For any stage**: Call `list_nodes(label: "Question")` to review previous Q&A context

### Step 5: Resume Execution

Continue with the next incomplete stage following the normal workflow rules.

## Cross-Sprint Context Loading

When starting a **new sprint** (empty graph), the agent should load context from previous sprints to ensure knowledge continuity.

### When to Load Cross-Sprint Context

- **Always** at the start of a new sprint during the Workspace Detection stage
- This happens automatically as part of Step 1.5 in `inception/workspace-detection.md`

### MCP Tools for Cross-Sprint Context

Three tools support cross-sprint knowledge management:

1. **`get_previous_sprint_summary`** — Call at sprint start to understand project history
   - Returns a condensed summary of all previous sprints: names, descriptions, artifact counts, GeneralInfo (design decisions, RE findings), Requirements, and metrics
   - Use this to quickly assess what was done before and what knowledge exists
   - No parameters needed — automatically scoped to the current project

2. **`get_previous_sprint_graph`** — Call when detailed information about a specific previous sprint is needed
   - Returns the full subgraph (nodes + edges) for a specific sprint
   - Takes a `sprintId` parameter — get the ID from `get_previous_sprint_summary` results
   - Use this to deep-dive into a previous sprint's artifacts and their relationships
   - Example: understanding why a particular design decision was made, or reviewing the full requirement chain

3. **`carry_forward_knowledge`** — Call once at sprint start to import relevant knowledge
   - Automatically copies GeneralInfo nodes and Requirement nodes from the most recent previous sprint
   - Creates new nodes in the current sprint with `carried_from_sprint` property
   - Creates `CARRIED_FROM` edges linking back to the originals for traceability
   - Idempotent — safe to call multiple times (will skip if already carried forward)

### Carried-Forward Artifact Identification

Carried-forward artifacts can be identified by:

- **`carried_from_sprint` property**: Contains the source sprint ID
- **`carried_from_id` property**: Contains the original node's ID
- **`CARRIED_FROM` edge**: Directed edge from the new node to the original node
- **ID prefix**: Carried-forward nodes use the `cf-` prefix (e.g., `cf-re-business-overview`)

### Cross-Sprint Context Flow

```
New Sprint Start
    |
    v
get_sprint_graph (empty) --> get_previous_sprint_summary
    |
    v
Previous sprints found? --NO--> Continue normally (greenfield or first sprint)
    |
    YES
    v
carry_forward_knowledge --> Import GeneralInfo + Requirements
    |
    v
ask_question: "Review context / Proceed / Describe changes"
    |
    v
Continue with Workspace Detection Step 2
```

## MANDATORY: Session Continuity Instructions

1. **Always call `get_sprint_graph` first** when detecting an existing sprint
2. **Parse current status** from Sprint node properties and graph structure
3. **Load Previous Stage Artifacts** from the graph before resuming
4. **Smart Context Loading by Stage**: Load only what's relevant for the current stage
5. **Show specific next steps** rather than generic descriptions
6. **Use `ask_question`** if the current state is ambiguous and you need team input on where to resume
7. **For new sprints**: Always check for previous sprint context via `get_previous_sprint_summary` and carry forward knowledge when available

## Error Handling

If the graph is empty or Sprint node is missing, see `common/error-handling.md` for recovery procedures.
