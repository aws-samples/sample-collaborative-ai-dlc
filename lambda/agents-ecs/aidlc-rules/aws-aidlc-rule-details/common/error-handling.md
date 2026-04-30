# Error Handling and Recovery Procedures

## General Error Handling Principles

### When Errors Occur
1. **Identify the error**: Clearly state what went wrong
2. **Assess impact**: Determine if the error is blocking or can be worked around
3. **Communicate**: Use `ask_question` to inform the team about the error and options
4. **Offer solutions**: Provide clear steps to resolve or work around the error
5. **Record in graph**: Graph node timestamps and Question nodes serve as the audit trail

### Error Severity Levels

**Critical**: Workflow cannot continue
- Graph operations failing (Neptune connection issues)
- Missing required artifacts in graph
- Invalid user input that cannot be processed
- System errors preventing code generation

**High**: Phase cannot complete as planned
- Incomplete answers to required questions
- Contradictory user responses
- Missing dependencies from prior phases

**Medium**: Phase can continue with workarounds
- Optional artifacts missing from graph
- Non-critical validation failures
- Partial completion possible

**Low**: Minor issues that don't block progress
- Formatting inconsistencies
- Optional information missing
- Non-blocking warnings

## Phase-Specific Error Handling

### Context Assessment Errors

**Error**: Cannot read workspace files
- **Cause**: Permission issues, missing directories
- **Solution**: Call `ask_question` to ask the team to verify workspace path and permissions
- **Workaround**: Proceed with user-provided information only

**Error**: Graph connection failure or empty sprint
- **Cause**: Neptune connectivity, missing Sprint node
- **Solution**: Call `ask_question` to inform team of the issue
- **Recovery**: Retry graph operations; if persistent, report to team

**Error**: Cannot determine required phases
- **Cause**: Insufficient information from user
- **Solution**: Call `ask_question` with clarifying questions about intent and scope
- **Workaround**: Default to comprehensive execution plan

### Requirements Assessment Errors

**Error**: User provides contradictory requirements
- **Cause**: Unclear understanding, changing needs
- **Solution**: Call `ask_question` with follow-up questions to resolve contradictions
- **Do Not Proceed**: Until contradictions are resolved

**Error**: Incomplete answers to verification questions
- **Cause**: User skipped questions, unclear what to answer
- **Solution**: Call `ask_question` highlighting unanswered questions with examples
- **Do Not Proceed**: Until all required questions are answered

### Story Development Errors

**Error**: Cannot map requirements to stories
- **Cause**: Requirements too vague, missing functional details
- **Solution**: Return to Requirements Analysis for clarification via `ask_question`
- **Workaround**: Create stories based on available information, mark as incomplete

**Error**: User provides ambiguous story planning answers
- **Cause**: Unclear options, complex decision
- **Solution**: Call `ask_question` with specific examples for follow-up
- **Do Not Proceed**: Until ambiguities are resolved

### Application Design Errors

**Error**: Architectural decision is unclear or contradictory
- **Cause**: Ambiguous answers, conflicting requirements
- **Solution**: Call `ask_question` to clarify the decision
- **Do Not Proceed**: Until decision is clear

**Error**: Cannot determine number of services/units
- **Cause**: Insufficient information about boundaries
- **Solution**: Call `ask_question` about deployment, team structure, scaling
- **Workaround**: Default to monolith, allow change later

### Code Generation Errors

**Error**: Cannot generate code for a step
- **Cause**: Insufficient design information, unclear requirements
- **Solution**: Skip step, call `ask_question` to gather more information
- **Recovery**: Return to step after gathering information

**Error**: Generated code has syntax errors
- **Cause**: Template issues, language-specific problems
- **Solution**: Fix syntax errors, regenerate if needed
- **Validation**: Verify code compiles before proceeding

## Recovery Procedures

### Partial Stage Completion

**Scenario**: Stage was interrupted mid-execution

**Recovery Steps**:
1. Call `get_sprint_graph` to load current state
2. Check Sprint node's `current_stage` property
3. Review Task node statuses to identify completed work
4. Resume from next incomplete step
5. Verify all prior steps are actually complete

### Missing Artifacts in Graph

**Scenario**: Required artifacts from prior stage are missing from graph

**Recovery Steps**:
1. Identify which artifacts are missing using `list_nodes`
2. Determine if they can be regenerated
3. If yes: Return to that stage, regenerate artifacts
4. If no: Call `ask_question` to ask team for information to recreate
5. Error is tracked via the Question node created by `ask_question`

### User Wants to Restart Stage

**Scenario**: User is unhappy with stage results and wants to redo

**Recovery Steps**:
1. Call `ask_question` to confirm user wants to restart (work will be replaced)
2. Update existing graph nodes with new content (nodes are updated, not deleted)
3. Reset stage status via `update_node` on Sprint
4. Re-execute stage from beginning

### User Wants to Skip Stage

**Scenario**: User wants to skip a stage that was planned

**Recovery Steps**:
1. Call `ask_question` to confirm and explain implications
2. Update Sprint node to reflect skip: `update_node(label: "Sprint", ...)`
3. Proceed to next stage
4. Note: May cause issues in later stages if dependencies missing

## Escalation Guidelines

### When to Ask for Team Help via `ask_question`

**Immediately**:
- Contradictory or ambiguous user input
- Missing required information
- Technical constraints AI cannot resolve
- Decisions requiring business judgment

**After Attempting Resolution**:
- Repeated errors in same step
- Complex technical issues
- Unusual project structures
- Integration with external systems

### When to Suggest Starting Over

**Consider Fresh Start If**:
- Multiple stages have errors
- Graph state is severely inconsistent
- User requirements have changed significantly
- Architectural decision needs to be reversed

## Prevention Best Practices

1. **Validate Early**: Check inputs and dependencies before starting work
2. **Update Graph Often**: Update Sprint stage and Task status as work progresses
3. **Communicate Clearly**: Use `ask_question` to explain what you're doing and why
4. **Ask Questions**: Don't assume — clarify ambiguities immediately via `ask_question`
5. **Load Context First**: Always call `get_sprint_graph` before starting any stage
