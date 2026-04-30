# Application Design - Detailed Steps

## Purpose
**High-level component identification and service layer design**

Application Design focuses on:
- Identifying main functional components and their responsibilities
- Defining component interfaces (not detailed business logic)
- Designing service layer for orchestration
- Establishing component dependencies and communication patterns

**Note**: Detailed business logic design happens later in Functional Design (per-unit, CONSTRUCTION phase)

## Prerequisites
- Workspace Detection must be complete
- Requirements Analysis recommended
- User Stories recommended
- Execution plan must indicate Application Design stage should execute

## Step-by-Step Execution

### 1. Load Context from Graph

- Call `list_nodes(label: "Requirement")` to load requirements
- Call `list_nodes(label: "UserStory")` to load user stories
- Identify key business capabilities and functional areas

### 2. Ask Design Questions via `ask_question`

**DIRECTIVE**: Analyze the requirements and stories to generate ONLY questions relevant to THIS specific application design.

Call `ask_question` with batched questions covering relevant areas:
- **Component Identification** - Only if component boundaries are unclear
- **Component Methods** - Only if method signatures need clarification
- **Service Layer Design** - Only if service orchestration is ambiguous
- **Component Dependencies** - Only if communication patterns are unclear
- **Design Patterns** - Only if architectural style needs user input

### 3. Analyze Answers (MANDATORY)

Review all answers for ambiguities, contradictions, and missing details.

### 4. Follow-up Questions (if needed)

If ANY ambiguous answers, call `ask_question` again with targeted follow-ups.
DO NOT proceed until all ambiguities are resolved.

### 5. Store Design Artifacts in Graph

**CRITICAL**: Before creating any GeneralInfo nodes, load and follow the rules in `common/generalinfo-linking.md`.

First, identify which Questions from Step 2 influenced the design decisions. Then store design findings as GeneralInfo nodes with **MANDATORY** links:

```
add_node(label: "GeneralInfo", id: "design-components", properties: {
  type: "application-design",
  title: "Application Components",
  content: "[component definitions, responsibilities, interfaces]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-abc", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "design-methods", properties: {
  type: "application-design",
  title: "Component Methods",
  content: "[method signatures, purposes, input/output types]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "design-services", properties: {
  type: "application-design",
  title: "Service Layer",
  content: "[service definitions, responsibilities, orchestration]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "design-dependencies", properties: {
  type: "application-design",
  title: "Component Dependencies",
  content: "[dependency matrix, communication patterns, data flow]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])
```

**After creating GeneralInfo nodes**, link Questions that influenced them:

```
// For each Question that influenced a GeneralInfo node
add_edge(
  fromLabel: "Question",
  fromId: "q-component-boundaries",
  toLabel: "GeneralInfo",
  toId: "design-components",
  edgeLabel: "INFLUENCES"
)

add_edge(
  fromLabel: "Question",
  fromId: "q-service-orchestration",
  toLabel: "GeneralInfo",
  toId: "design-services",
  edgeLabel: "INFLUENCES"
)
```

**CRITICAL LINKING RULES**:
- **ALWAYS** use the `edges` parameter when creating GeneralInfo nodes to link them to Requirements/UserStories
- After creating GeneralInfo, use `add_edge` to link Questions that influenced them (Question → GeneralInfo via INFLUENCES)
- Link to **ALL relevant Requirements** that the design artifact addresses
- Link to **ALL relevant UserStories** that the design artifact supports
- Link **ALL Questions from Step 2** that influenced the design decisions
- Use `RELATES_TO` for GeneralInfo → Requirement/UserStory edges
- Use `INFLUENCES` for Question → GeneralInfo edges

### 6. Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "application-design"
})
```

### 7. Request Approval

Call `ask_question` with:
```
"Application Design Complete

[AI-generated summary of application design in bullet points]

I have stored all design artifacts in the project graph (components, methods, services, dependencies).

Do you APPROVE to proceed to [Units Generation/CONSTRUCTION PHASE], or describe what changes are needed?"
```

Wait for explicit approval. If changes requested, update graph nodes and re-request.
