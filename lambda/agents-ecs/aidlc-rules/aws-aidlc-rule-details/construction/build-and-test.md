# Build and Test

**Purpose**: Build all units and execute comprehensive testing strategy

## Prerequisites

- Code Generation must be complete for all units
- All CodeFile nodes must be registered in graph
- Project is ready for build and testing

---

## Step 1: Analyze Testing Requirements

Analyze the project to determine appropriate testing strategy:

- **Unit tests**: Already generated per unit during code generation
- **Integration tests**: Test interactions between units/services
- **Performance tests**: Load, stress, and scalability testing
- **End-to-end tests**: Complete user workflows
- **Contract tests**: API contract validation between services
- **Security tests**: Vulnerability scanning

---

## Step 2: Generate Build and Test Instructions

Build and test instructions are actual working documents (not design artifacts), so they are written to the workspace filesystem:

- `build-instructions.md` - Build steps, dependencies, environment setup
- `unit-test-instructions.md` - Unit test execution commands
- `integration-test-instructions.md` - Integration test scenarios and commands
- `performance-test-instructions.md` (if applicable) - Load test configuration

These are practical instruction files, not graph artifacts.

---

## Step 3: Commit All Changes to Git

**MANDATORY — do this BEFORE updating the graph or requesting approval.**

Commit all generated instruction files and any remaining uncommitted work:

```
git add -A
git commit -m "Add build and test instructions for <task-id>"
```

Verify the commit:

```
git log --oneline -3
```

If `git log` does not show your commit, retry. Do NOT proceed with uncommitted work.

---

## Step 4: Update Graph State

Update Sprint and Task nodes:

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "build-and-test",
  phase: "CONSTRUCTION",
  phase_status: "ready_for_transition"
})
```

Create a Review node if needed:

```
add_node(label: "Review", id: "review-build-test", properties: {
  status: "PENDING",
  comments: "[build and test summary]"
})
```

---

## Step 5: Finalize Construction Phase

Present a final status summary in chat. Do **not** call `ask_question` for the phase transition.

```
"Build and Test Complete

Build Status: [Success/Pending]

Test Results:
- Unit Tests: [status]
- Integration Tests: [status]
- Performance Tests: [status if applicable]

Generated instruction files:
1. build-instructions.md
2. unit-test-instructions.md
3. integration-test-instructions.md
4. [additional files as needed]

Construction phase is ready for human review. When the team is ready, create or inspect the PR, then click End Construction & Move to Review in the Sprint page."
```

Exit cleanly after the summary. If the team later requests changes, handle that as a new intra-phase refinement request and update the relevant Task or Review nodes.
