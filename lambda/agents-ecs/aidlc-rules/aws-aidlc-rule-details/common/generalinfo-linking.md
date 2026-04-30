# Question and GeneralInfo Linking Guide

## Purpose
This guide covers two critical linking patterns:
1. **Question → Artifact**: Questions MUST be linked to ALL artifacts they influence (Requirements, UserStories, Tasks, GeneralInfo, CodeFiles)
2. **GeneralInfo → Artifact**: GeneralInfo nodes MUST be linked to related Requirements/UserStories/Tasks

Proper linking enables efficient graph traversal, decision traceability, and complete context loading for agents.

## When to Create GeneralInfo Nodes

Create GeneralInfo nodes for:
- **Reverse Engineering Findings**: Business overview, architecture, code structure, API docs, component inventory, technology stack, dependencies
- **Application Design**: Component definitions, method signatures, service layer design, component dependencies
- **Architecture Decisions**: Design patterns, technology choices, architectural styles
- **API Documentation**: REST endpoints, request/response formats, authentication flows
- **Technical Specifications**: Data models, integration points, protocols
- **Business Context**: Domain knowledge, business rules, workflows

## CRITICAL: Always Link Questions

**MANDATORY RULE**: Every Question that influences an artifact (Requirement, UserStory, Task, GeneralInfo, CodeFile) MUST be linked using the `INFLUENCES` edge label.

### Why Question Linking is Critical
- **Decision Traceability**: Shows which questions shaped which artifacts
- **Context Preservation**: Future agents can understand why decisions were made
- **Audit Trail**: Complete history of clarifications and their impact
- **Knowledge Graph**: Enables traversal from questions to all influenced artifacts

## How to Link Questions to Artifacts

Questions use the `INFLUENCES` edge label and are linked AFTER creating the artifact they influenced.

### Link Questions to Requirements

```javascript
// After creating Requirement
add_edge(
  fromLabel: "Question",
  fromId: "q-performance-target",
  toLabel: "Requirement",
  toId: "req-api-performance",
  edgeLabel: "INFLUENCES"
)
```

### Link Questions to UserStories

```javascript
// After creating UserStory
add_edge(
  fromLabel: "Question",
  fromId: "q-user-workflow",
  toLabel: "UserStory",
  toId: "story-login",
  edgeLabel: "INFLUENCES"
)
```

### Link Questions to Tasks

```javascript
// After creating Task
add_edge(
  fromLabel: "Question",
  fromId: "q-implementation-approach",
  toLabel: "Task",
  toId: "task-auth-service",
  edgeLabel: "INFLUENCES"
)
```

### Link Questions to GeneralInfo

```javascript
// After creating GeneralInfo
add_edge(
  fromLabel: "Question",
  fromId: "q-architecture-style",
  toLabel: "GeneralInfo",
  toId: "design-architecture",
  edgeLabel: "INFLUENCES"
)
```

### Link Questions to CodeFiles (Construction Phase)

```javascript
// After creating CodeFile
add_edge(
  fromLabel: "Question",
  fromId: "q-error-handling",
  toLabel: "CodeFile",
  toId: "file-auth-handler",
  edgeLabel: "INFLUENCES"
)
```

## How to Create Linked GeneralInfo Nodes

GeneralInfo nodes use `RELATES_TO` edges to link to Requirements/UserStories/Tasks. Use the `edges` parameter when creating them:

```javascript
add_node(label: "GeneralInfo", id: "design-rest-api", properties: {
  type: "application-design",
  title: "REST API Endpoints",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-authentication", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-login", edgeLabel: "RELATES_TO" }
])
```

Then link Questions using the section above.

## Linking Rules by GeneralInfo Type

### Reverse Engineering Findings
Link to:
- **Requirements** that describe the existing system or changes to it
- **Questions** that were asked during reverse engineering (use INFLUENCES edge)

Example:
```javascript
// Create GeneralInfo with Requirement links
add_node(label: "GeneralInfo", id: "re-architecture", properties: {
  type: "reverse-engineering",
  title: "System Architecture",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-system-overview", edgeLabel: "RELATES_TO" }
])

// Then link Questions that influenced it
add_edge(
  fromLabel: "Question",
  fromId: "q-architecture-style",
  toLabel: "GeneralInfo",
  toId: "re-architecture",
  edgeLabel: "INFLUENCES"
)
```

### Application Design
Link to:
- **Requirements** that the design addresses
- **UserStories** that the design supports
- **Questions** that influenced design decisions (use INFLUENCES edge)

Example:
```javascript
// Create GeneralInfo with Requirement/UserStory links
add_node(label: "GeneralInfo", id: "design-components", properties: {
  type: "application-design",
  title: "Application Components",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-modularity", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-user-auth", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-todo-crud", edgeLabel: "RELATES_TO" }
])

// Then link Questions that influenced it
add_edge(
  fromLabel: "Question",
  fromId: "q-component-boundaries",
  toLabel: "GeneralInfo",
  toId: "design-components",
  edgeLabel: "INFLUENCES"
)
```

### API Documentation
Link to:
- **Requirements** for the API functionality
- **UserStories** that use the API
- **Tasks** that implement the API endpoints

Example:
```javascript
add_node(label: "GeneralInfo", id: "api-auth-endpoints", properties: {
  type: "api-documentation",
  title: "Authentication API",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-authentication", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-login", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "UserStory", id: "story-logout", edgeLabel: "RELATES_TO" },
  { direction: "to", label: "Task", id: "task-implement-login", edgeLabel: "RELATES_TO" }
])
```

### Architecture Decisions
Link to:
- **Requirements** that drove the decision
- **Questions** that were asked about the decision (use INFLUENCES edge)

Example:
```javascript
// Create GeneralInfo with Requirement links
add_node(label: "GeneralInfo", id: "decision-database", properties: {
  type: "architecture-decision",
  title: "Database Choice: Neptune Graph DB",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-graph-traversal", edgeLabel: "RELATES_TO" }
])

// Then link Questions that influenced it
add_edge(
  fromLabel: "Question",
  fromId: "q-database-type",
  toLabel: "GeneralInfo",
  toId: "decision-database",
  edgeLabel: "INFLUENCES"
)
```

## Finding Related Artifacts to Link

Before creating a GeneralInfo node, identify related artifacts:

```javascript
// Load all requirements
const requirements = await list_nodes({ label: "Requirement" });

// Load all user stories
const userStories = await list_nodes({ label: "UserStory" });

// Load all questions
const questions = await list_nodes({ label: "Question" });

// Analyze which ones relate to your GeneralInfo content
// Then include them in the edges array
```

## Validation Checklist

Before creating any GeneralInfo node, verify:
- [ ] Node has a descriptive `id` (e.g., "design-rest-api", not "general-1")
- [ ] Node has a `type` property (e.g., "application-design", "reverse-engineering")
- [ ] Node has a `title` property
- [ ] Node has meaningful `content`
- [ ] Node has at least one edge in the `edges` array linking to Requirements/UserStories/Tasks
- [ ] All edges in `edges` array use `RELATES_TO` as the edge label
- [ ] All edges point to valid artifact IDs that exist in the graph
- [ ] Edge direction is "to" (from GeneralInfo to the related artifact)
- [ ] After creating node, link all Questions that influenced it using `add_edge` with `INFLUENCES` edge label

## Common Mistakes to Avoid

❌ **Creating GeneralInfo without edges**
```javascript
// BAD - No links!
add_node(label: "GeneralInfo", id: "design-api", properties: {
  type: "application-design",
  title: "API Design",
  content: "..."
})
```

✅ **Creating GeneralInfo with edges**
```javascript
// GOOD - Properly linked
add_node(label: "GeneralInfo", id: "design-api", properties: {
  type: "application-design",
  title: "API Design",
  content: "..."
}, edges: [
  { direction: "to", label: "Requirement", id: "req-api", edgeLabel: "RELATES_TO" }
])
```

❌ **Using wrong edge label**
```javascript
// BAD - Wrong edge label
edges: [
  { direction: "to", label: "Requirement", id: "req-api", edgeLabel: "BREAKS_INTO" }
]
```

✅ **Using correct edge label**
```javascript
// GOOD - Correct edge label
edges: [
  { direction: "to", label: "Requirement", id: "req-api", edgeLabel: "RELATES_TO" }
]
```

❌ **Linking to non-existent artifacts**
```javascript
// BAD - req-xyz doesn't exist
edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
]
```

✅ **Linking to verified artifacts**
```javascript
// GOOD - Verified req-authentication exists
const requirements = await list_nodes({ label: "Requirement" });
// ... verify req-authentication is in the list ...
edges: [
  { direction: "to", label: "Requirement", id: "req-authentication", edgeLabel: "RELATES_TO" }
]
```

## Summary

**Every Question MUST:**
1. Be linked to ALL artifacts it influenced using `INFLUENCES` edge
2. Use `add_edge` after creating the influenced artifact
3. Link to Requirements, UserStories, Tasks, GeneralInfo, or CodeFiles as appropriate

**Every GeneralInfo node MUST:**
1. Have a descriptive ID and type
2. Include the `edges` parameter with at least one `RELATES_TO` edge to Requirements/UserStories/Tasks
3. After creation, have all Questions that influenced it linked via `INFLUENCES`

**Edge Label Rules:**
- Question → ANY Artifact: Use `INFLUENCES` (via `add_edge` after artifact creation)
- GeneralInfo → Requirement/UserStory/Task: Use `RELATES_TO` (in `edges` parameter)

**This ensures:**
- Complete decision traceability from questions to all influenced artifacts
- Agents can traverse the graph to understand why decisions were made
- Design decisions are linked to both requirements AND the questions that shaped them
- The graph remains complete and navigable
