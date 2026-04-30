# Code Generation - Detailed Steps

## Overview
This stage generates code for each unit of work through two integrated parts:
- **Part 1 - Planning**: Create detailed code generation plan, get approval
- **Part 2 - Generation**: Execute approved plan to generate code, tests, and register files in graph

**Note**: For brownfield projects, "generate" means modify existing files when appropriate, not create duplicates.

## Prerequisites
- Design stages must be complete for the unit
- All unit design artifacts must be available in graph
- Unit is ready for code generation

---

# PART 1: PLANNING

## Step 1: Load Unit Context from Graph

- Call `get_node(label: "Task", id: "unit-[name]")` to load unit definition and design
- Call `get_neighbors` to find assigned stories and requirements
- Call `get_dependency_chain` for any relevant requirement to understand full lineage

## Step 2: Create Code Generation Plan

- Determine code location based on project type (workspace root)
- **Brownfield only**: Scan workspace for existing files to modify
- Document exact paths (never create files in aidlc-docs/)
- Plan explicit steps for:
  - Project Structure Setup (greenfield only)
  - Business Logic Generation + Unit Testing
  - API Layer Generation + Unit Testing
  - Repository Layer Generation + Unit Testing
  - Frontend Components (if applicable)
  - Database Migration Scripts (if data models exist)
  - Deployment Artifacts

## Step 3: Request Plan Approval

Call `ask_question` with:
```
"Code Generation Plan for [unit-name]:

I plan to generate the following:
1. [Step description] -> [file path]
2. [Step description] -> [file path]
...

Total: [N] files to generate/modify

Do you APPROVE this plan, or describe what changes are needed?"
```

Wait for explicit approval.

---

# PART 2: GENERATION

## Step 4: Execute Code Generation

For each planned step:
- **If file exists (brownfield)**: Modify it in-place (never create copies)
- **If file doesn't exist**: Create new file
- Write to correct locations:
  - **Application Code**: Workspace root per project structure
  - **Build/Config Files**: Workspace root

## Step 5: Register Generated Files in Graph

For each generated or modified file, register in the graph:

```
add_node(label: "CodeFile", id: "file-[descriptive-name]", properties: {
  file_path: "[relative path from workspace root]",
  summary: "[brief description of what the file does]",
  status: "generated"
}, edges: [
  { direction: "from", label: "Task", id: "unit-[name]", edgeLabel: "IMPLEMENTED_BY" }
])
```

**IMPORTANT**: ALWAYS pass the `edges` parameter when creating CodeFile nodes to link them to their parent Task in the same call.

## Step 6: Commit Changes to Git

**MANDATORY — do this IMMEDIATELY after writing code, before updating the graph or requesting approval.**

```
git add -A
git commit -m "Implement <task-id>: <short description of what was built>"
```

Verify the commit landed:
```
git log --oneline -3
```

If `git log` does not show your commit, something went wrong. Do NOT proceed — retry the commit.

## Step 7: Update Task Status

```
update_node(label: "Task", id: "unit-[name]", properties: {
  status: "done"
})

update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "code-generation"
})
```

## Step 8: Request Approval

Call `ask_question` with:
```
"Code Generation Complete - [unit-name]

Generated/modified files:
- [List files with paths, noting modified vs created for brownfield]

All files registered in the project graph with IMPLEMENTED_BY edges.

Do you want to REQUEST CHANGES or CONTINUE TO NEXT STAGE ([next-unit/Build & Test])?"
```

Wait for explicit approval.

---

## Critical Rules

### Code Location Rules
- **Application code**: Workspace root only (NEVER aidlc-docs/)
- **Read workspace root** before generating code

**Structure patterns by project type**:
- **Brownfield**: Use existing structure
- **Greenfield single unit**: `src/`, `tests/`, `config/` in workspace root
- **Greenfield multi-unit (microservices)**: `{unit-name}/src/`, `{unit-name}/tests/`
- **Greenfield multi-unit (monolith)**: `src/{unit-name}/`, `tests/{unit-name}/`

### Brownfield File Modification Rules
- Check if file exists before generating
- If exists: Modify in-place (never create copies)
- If doesn't exist: Create new file

### Automation Friendly Code Rules
When generating UI code, add `data-testid` attributes to interactive elements.

### Graph Registration Rules
- **EVERY** generated file must be registered via `add_node(label: "CodeFile")` with `edges` parameter to link to its unit via IMPLEMENTED_BY in the same call
- Update Task node status to "done" when unit code generation is complete

### Git Commit Rules (CRITICAL — prevents lost work)
- **COMMIT after every meaningful change.** Use `git add -A && git commit -m "Implement <task-id>: <description>"`.
- **NEVER leave uncommitted work.** The system can only push what is committed. Uncommitted changes are lost.
- **Before finishing**: Always run `git status` to verify a clean working tree. If anything is uncommitted, commit it.
- **DO NOT push.** The system handles pushing your branch to the remote after you exit.
- **DO NOT merge into other branches.** The orchestrator handles merging your task branch into the sprint branch.
