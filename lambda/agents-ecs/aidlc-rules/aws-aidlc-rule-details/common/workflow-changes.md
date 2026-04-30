# Mid-Workflow Changes and Phase Management

## Overview

Users may request changes to the execution plan or phase execution during the workflow. This document provides guidance on handling these requests safely and effectively.

---

## Types of Mid-Workflow Changes

### 1. Adding a Skipped Phase

**Scenario**: User wants to add a phase that was originally skipped

**Handling**:
1. **Confirm Request**: Call `ask_question`: "You want to add [stage name]. This will [description of what it does]. Confirm?"
2. **Check Dependencies**: Verify all prerequisite phases are complete via `get_sprint_graph`
3. **Update Execution Plan**: Update Sprint node via `update_node` with revised execution_plan
4. **Execute Phase**: Follow normal phase execution process
5. **Change tracked**: The `ask_question` call and `update_node` call provide the audit trail

### 2. Skipping a Planned Phase

**Scenario**: User wants to skip a phase that was planned to execute

**Handling**:
1. **Confirm Request**: Call `ask_question`: "You want to skip [stage]. This means [impact]. Confirm?"
2. **Get Explicit Confirmation**: User must explicitly confirm understanding of impact
3. **Update Sprint**: `update_node(label: "Sprint", ...)` to reflect skip
4. **Adjust Later Phases**: Note that later phases may need manual intervention

### 3. Restarting Current Stage

**Scenario**: User is unhappy with current stage results

**Handling**:
1. **Understand Concern**: Call `ask_question`: "What specifically would you like to change?"
2. **Offer Options**:
   - **Option A**: Modify existing graph nodes (update existing artifacts)
   - **Option B**: Complete restart (re-create all stage artifacts)
3. **If Restart Chosen**:
   - Update existing graph nodes with new content via `update_node`
   - Update Sprint stage status
   - Re-execute from beginning
4. **Change tracked**: via `ask_question` and `update_node` calls

### 4. Restarting Previous Stage

**Scenario**: User wants to go back and redo a completed stage

**Handling**:
1. **Assess Impact**: Use `get_sprint_graph` to identify all dependent artifacts
2. **Call `ask_question`**: "Restarting [stage] will require redoing: [list dependent stages]. Confirm?"
3. **Get Explicit Confirmation**: User must understand full impact
4. **If Confirmed**:
   - Update Sprint node to reset to earlier stage
   - Update affected graph nodes
   - Re-execute from that point forward

### 5. Changing Stage Depth

**Scenario**: User wants more or less detail in current/upcoming stage

**Handling**:
1. **Confirm**: Call `ask_question`: "You want [depth level] depth for [stage]. This will be [more/less] thorough. Confirm?"
2. **Update Sprint**: Record depth preference
3. **Adjust Approach**: Follow depth-appropriate guidelines
4. **Change tracked**: via the `ask_question` call

### 6. Pausing Workflow

**Scenario**: User needs to pause and resume later

**Handling**:
1. **Complete Current Step**: Finish the current step if possible
2. **Update Sprint**: Ensure Sprint node reflects current status via `update_node`
3. **Update Task Statuses**: Mark completed tasks as "done"
4. **Provide Resume Instructions**: "When you return, the agent will load the sprint graph and continue from: [current phase, current step]"

**On Resume**:
1. Call `get_sprint_graph` to load all state
2. See `common/session-continuity.md` for detailed resume procedure

### 7. Changing Architectural Decision

**Scenario**: User wants to change from monolith to microservices (or vice versa)

**Handling**:
1. **Assess Current Progress**: Check Sprint node for current stage
2. **Explain Impact via `ask_question`**:
   - If before Units Generation: Minimal impact, update design nodes
   - If after Units Generation: Must redo Units, all per-unit design, Code Generation
   - If after Code Generation: Significant rework required
3. **Get Confirmation**: User must understand full scope of change
4. **Execute Change**: Update graph nodes, re-execute affected stages

### 8. Adding/Removing Units

**Scenario**: User wants to add or remove units after Units Generation

**Handling**:
1. **Assess Impact**: Use `get_sprint_graph` to identify affected Task nodes
2. **Call `ask_question`**: Explain consequences of adding/removing/splitting units
3. **Update Graph**: Create new Task nodes or update existing ones
4. **Reset Affected Units**: Mark affected tasks as needing redesign

---

## General Guidelines for Handling Changes

### Before Making Changes
1. **Understand the Request**: Call `ask_question` to clarify what user wants and why
2. **Assess Impact**: Use `get_sprint_graph` to identify all affected artifacts
3. **Explain Consequences**: Use `ask_question` to communicate what will need to be redone
4. **Offer Alternatives**: Sometimes modification is better than restart
5. **Get Explicit Confirmation**: User must understand and accept the impact

### During Changes
1. **Update Graph Nodes**: Use `update_node` to modify existing artifacts
2. **Track State**: Keep Sprint node properties current
3. **Communicate Progress**: Use `ask_question` if decisions arise during the change
4. **Validate Changes**: Ensure changes are consistent across all graph artifacts

### After Changes
1. **Verify Consistency**: Check that all graph nodes are aligned with changes
2. **Confirm with User**: Call `ask_question` to verify changes meet expectations
3. **Resume Workflow**: Continue with normal execution from new state

---

## Change Request Decision Tree

```
User requests change
    |
    +-- Is it current stage?
    |   +-- Yes: Can modify graph nodes or restart current stage
    |   +-- No: Go to next question
    |
    +-- Is it a completed stage?
    |   +-- Yes: Assess impact on dependent stages via get_sprint_graph
    |   |   +-- Low impact: Update graph nodes and continue
    |   |   +-- High impact: Confirm restart from that stage
    |   +-- No: Go to next question
    |
    +-- Is it adding a skipped stage?
    |   +-- Yes: Check prerequisites, add to plan, execute
    |   +-- No: Go to next question
    |
    +-- Is it skipping a planned stage?
    |   +-- Yes: Warn about impact via ask_question, get confirmation, skip
    |   +-- No: Go to next question
    |
    +-- Is it changing depth level?
        +-- Yes: Update Sprint, adjust approach
        +-- No: Clarify request via ask_question
```

---

## Best Practices

1. **Always Confirm**: Never make destructive changes without explicit user confirmation via `ask_question`
2. **Explain Impact**: Users need to understand consequences before deciding
3. **Offer Options**: Sometimes there are multiple ways to handle a change
4. **Update Graph First**: Always update graph state before proceeding
5. **Validate After**: Ensure workflow can continue smoothly
6. **Be Flexible**: Workflow should adapt to user needs, not force rigid process
