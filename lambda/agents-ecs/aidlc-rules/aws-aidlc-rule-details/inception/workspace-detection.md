# Workspace Detection

**Purpose**: Determine workspace state, check for existing sprint artifacts, and load previous sprint context

## Step 1: Check for Existing Sprint Artifacts

Call `get_sprint_graph` to check the current sprint state:

- **If artifacts exist** (Requirement, UserStory, Task nodes): Resume from current stage (see `common/session-continuity.md`)
- **If graph is empty**: Continue with new project assessment

## Step 1.5: Load Previous Sprint Context (Cross-Sprint Knowledge)

**Purpose**: Ensure knowledge from previous sprints is not lost when starting a new sprint.

### 1.5.1 Check for Previous Sprints

Call `get_previous_sprint_summary` to check if previous sprints exist for this project.

**If no previous sprints exist**: Skip to Step 2.

### 1.5.2 Carry Forward Knowledge

If previous sprints are found, call `carry_forward_knowledge` to automatically import:

- All **GeneralInfo** nodes (reverse-engineering findings, design decisions, architecture notes)
- All **Requirement** nodes (functional requirements, NFRs, acceptance criteria)

These are copied into the current sprint as new nodes with:

- `carried_from_sprint` property linking to the source sprint
- `CARRIED_FROM` edges linking back to the original nodes

### 1.5.3 Present Context to User

Call `ask_question` with the following message:

```
Previous Sprint Context Loaded

I found [count] previous sprint(s) for this project. From the most recent sprint ("[sprint name]"), I've carried forward:
- [X] knowledge artifacts (design decisions, architecture notes, RE findings)
- [Y] requirements

[Brief summary of key carried-forward items — list titles of GeneralInfo and Requirements]

How would you like to proceed?
1. **Review previous context** — I'll present the full carried-forward artifacts for your review before continuing
2. **Proceed directly** — I'll use the carried-forward context and move on to workspace scanning
3. Or describe any changes since the last sprint that I should be aware of
```

### 1.5.4 Handle User Response

- **If user chooses "Review previous context"**: Present all carried-forward GeneralInfo and Requirement nodes in detail. After review, ask if anything needs updating before proceeding.
- **If user chooses "Proceed directly"**: Continue to Step 2 with carried-forward context loaded.
- **If user describes changes**: Note the changes on the Sprint node as a `context_notes` property via `update_node`. Use these notes to inform subsequent stages (especially Reverse Engineering if brownfield).

### 1.5.5 Deep Dive (Optional)

If during context review the agent or user needs more detail about a specific previous sprint, use `get_previous_sprint_graph` with the sprint ID to retrieve the full artifact graph including all relationships.

## Step 2: Scan Workspace for Existing Code

**Determine if workspace has existing code:**

- Scan workspace for source code files (.java, .py, .js, .ts, .jsx, .tsx, .kt, .kts, .scala, .groovy, .go, .rs, .rb, .php, .c, .h, .cpp, .hpp, .cc, .cs, .fs, etc.)
- Check for build files (pom.xml, package.json, build.gradle, etc.)
- Look for project structure indicators
- Identify workspace root directory

## Step 3: Determine Next Phase

**IF workspace is empty (no existing code)**:

- Set flag: `brownfield = false`
- Next phase: Requirements Analysis

**IF workspace has existing code**:

- Set flag: `brownfield = true`
- Check for carried-forward RE artifacts: GeneralInfo nodes with `carried_from_sprint` property AND `type: "reverse-engineering"`
- Check for fresh RE artifacts: GeneralInfo nodes with `type: "reverse-engineering"` and no `carried_from_sprint` property
- **IF fresh RE artifacts exist in graph**: Load them, skip to Requirements Analysis
- **IF only carried-forward RE artifacts exist**: Next phase is Reverse Engineering (with carried-forward context as baseline)
- **IF no RE artifacts at all**: Next phase is Reverse Engineering

## Step 4: Update Sprint State

Update the Sprint node to track current stage:

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  phase: "INCEPTION",
  current_stage: "workspace-detection",
  phase_status: "active",
  project_type: "greenfield" or "brownfield",
  has_previous_context: "true" or "false"
})
```

## Step 5: Present Completion Message

**For Brownfield Projects (with previous context):**

```
Workspace Detection Complete

Workspace analysis findings:
- Project Type: Brownfield project
- Previous Context: Loaded [X] artifacts from sprint "[name]"
- [AI-generated summary of workspace findings in bullet points]
- Next Step: Proceeding to Reverse Engineering to validate/update existing knowledge...
```

**For Brownfield Projects (no previous context):**

```
Workspace Detection Complete

Workspace analysis findings:
- Project Type: Brownfield project
- [AI-generated summary of workspace findings in bullet points]
- Next Step: Proceeding to Reverse Engineering to analyze existing codebase...
```

**For Greenfield Projects:**

```
Workspace Detection Complete

Workspace analysis findings:
- Project Type: Greenfield project
- Next Step: Proceeding to Requirements Analysis...
```

## Step 6: Automatically Proceed

- **No user approval required** - this is informational only
- Automatically proceed to next phase:
  - **Brownfield**: Reverse Engineering (if no fresh RE artifacts) or Requirements Analysis (if fresh artifacts exist)
  - **Greenfield**: Requirements Analysis
