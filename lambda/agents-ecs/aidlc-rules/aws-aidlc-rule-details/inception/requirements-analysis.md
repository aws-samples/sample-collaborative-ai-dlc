# Requirements Analysis (Adaptive)

**Assume the role** of a product owner

**Adaptive Phase**: Always executes. Detail level adapts to problem complexity.

**See [depth-levels.md](../common/depth-levels.md) for adaptive depth explanation**

## Prerequisites
- Workspace Detection must be complete
- Reverse Engineering must be complete (if brownfield)

## Execution Steps

### Step 1: Load Reverse Engineering Context (if available)

**IF brownfield project**:
- Call `list_nodes(label: "Requirement")` and filter for nodes with `category: "reverse-engineering"`
- Use these to understand existing system when analyzing request

### Step 2: Analyze User Request (Intent Analysis)

#### 2.1 Request Clarity
- **Clear**: Specific, well-defined, actionable
- **Vague**: General, ambiguous, needs clarification
- **Incomplete**: Missing key information

#### 2.2 Request Type
- **New Feature**: Adding new functionality
- **Bug Fix**: Fixing existing issue
- **Refactoring**: Improving code structure
- **Upgrade**: Updating dependencies or frameworks
- **Migration**: Moving to different technology
- **Enhancement**: Improving existing feature
- **New Project**: Starting from scratch

#### 2.3 Initial Scope Estimate
- **Single File**: Changes to one file
- **Single Component**: Changes to one component/package
- **Multiple Components**: Changes across multiple components
- **System-wide**: Changes affecting entire system
- **Cross-system**: Changes affecting multiple systems

#### 2.4 Initial Complexity Estimate
- **Trivial**: Simple, straightforward change
- **Simple**: Clear implementation path
- **Moderate**: Some complexity, multiple considerations
- **Complex**: Significant complexity, many considerations

### Step 3: Determine Requirements Depth

**Based on request analysis, determine depth:**

**Minimal Depth** - Use when:
- Request is clear and simple
- No detailed requirements needed

**Standard Depth** - Use when:
- Request needs clarification
- Functional and non-functional requirements needed

**Comprehensive Depth** - Use when:
- Complex project with multiple stakeholders
- High risk or critical system
- Detailed requirements with traceability needed

### Step 4: Assess Current Requirements

Analyze whatever the user has provided:
- Intent statements or descriptions
- Existing requirements documents (search workspace if mentioned)
- Pasted content or file references

### Step 5: Thorough Completeness Analysis

**CRITICAL**: Use comprehensive analysis to evaluate requirements completeness. Default to asking questions when there is ANY ambiguity or missing detail.

**MANDATORY**: Evaluate ALL of these areas and ask questions for ANY that are unclear:
- **Functional Requirements**: Core features, user interactions, system behaviors
- **Non-Functional Requirements**: Performance, security, scalability, usability
- **User Scenarios**: Use cases, user journeys, edge cases, error scenarios
- **Business Context**: Goals, constraints, success criteria, stakeholder needs
- **Technical Context**: Integration points, data requirements, system boundaries
- **Quality Attributes**: Reliability, maintainability, testability, accessibility

**When in doubt, ask questions** - incomplete requirements lead to poor implementations.

### Step 6: Ask Clarifying Questions via `ask_question`

**ALWAYS** ask clarifying questions unless requirements are exceptionally clear and complete.

Call `ask_question` with a batched list of questions covering any missing, unclear, or ambiguous areas. Focus on functional requirements, non-functional requirements, user scenarios, and business context.

Example:
```
Call `ask_question` with:
"I need clarification on the following requirements:
1. [Question about functional requirement]
2. [Question about non-functional requirement]
3. [Question about user scenario]
4. [Question about business context]
Please answer all questions."
```

Wait for the answer. Then **MANDATORY**: Analyze the answer for ambiguities. If any answers are unclear, call `ask_question` again with targeted follow-up questions.

Keep asking until ALL ambiguities are resolved OR the team explicitly asks to proceed.

### GATE: Await User Answers
DO NOT proceed to Step 7 until all questions are answered and validated.

### Step 7: Create Requirement Nodes in Graph

**PREREQUISITE**: Step 6 gate must be passed — all answers received and analyzed.

For each identified requirement, create a Requirement node:

```
add_node(label: "Requirement", id: "req-[descriptive-id]", properties: {
  title: "[requirement title]",
  description: "[detailed description including context from Q&A]",
  acceptance_criteria: "[testable acceptance criteria]",
  category: "functional" or "non-functional",
  priority: "high" or "medium" or "low"
})
```

**CRITICAL**: After creating Requirements, link ALL Questions that influenced them:

```
// For each Question from Step 6 that influenced a Requirement
add_edge(
  fromLabel: "Question",
  fromId: "[question-id]",
  toLabel: "Requirement",
  toId: "req-[id]",
  edgeLabel: "INFLUENCES"
)
```

### Step 8: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "requirements-analysis"
})
```

### Step 9: Request Approval

Call `ask_question` with:
```
"Requirements Analysis Complete

Requirements analysis has identified [project type/complexity]:
- [List key functional requirements as bullet points]
- [List key non-functional requirements as bullet points]
- [Mention architectural considerations if relevant]

I have created [N] Requirement nodes in the project graph.

Do you APPROVE to proceed to [User Stories/Workflow Planning], or describe what changes are needed?"
```

If the response includes "Add User Stories" (when stories were going to be skipped), update the execution plan accordingly.

Wait for explicit user approval before proceeding.
