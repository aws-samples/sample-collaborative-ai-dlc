# AI-DLC Terminology Glossary

## Core Terminology

### Phase vs Stage

**Phase**: One of the three high-level lifecycle phases in AI-DLC
- **INCEPTION PHASE** - Planning & Architecture (WHAT and WHY)
- **CONSTRUCTION PHASE** - Design, Implementation & Test (HOW)
- **OPERATIONS PHASE** - Deployment & Monitoring (future expansion)

**Stage**: An individual workflow activity within a phase
- Examples: Workspace Detection stage, Requirements Analysis stage, Code Generation stage
- Each stage has specific prerequisites, steps, and outputs
- Stages can be ALWAYS-EXECUTE or CONDITIONAL

**Usage Examples**:
- "The CONSTRUCTION phase contains 7 stages"
- "The Code Generation stage is always executed"
- "We're in the INCEPTION phase, executing the Requirements Analysis stage"

## Platform Terminology

### Graph Database (Neptune)
The Neptune graph database is the **single source of truth** for all artifacts. All Requirements, User Stories, Tasks, Code Files, Reviews, and Questions are stored as nodes in the graph with edges representing relationships between them.

### MCP Server (Graph MCP Server)
The Model Context Protocol server that provides tools for interacting with the Neptune graph database. Available tools:
- **`add_node`**: Create a new artifact node (Requirement, UserStory, Task, CodeFile, Review, GeneralInfo). Supports an optional `edges` parameter to atomically link the new node to existing nodes in the same call — ALWAYS use this for BREAKS_INTO, IMPLEMENTED_BY, and RELATES_TO edges.
- **`add_edge`**: Create a relationship between two existing nodes. Prefer using the `edges` parameter in `add_node` instead when creating a node and its relationship together.
- **`update_node`**: Update properties on an existing node
- **`get_node`**: Fetch a single node by label and id
- **`list_nodes`**: List all nodes of a given type in the current sprint
- **`find_nodes`**: Search for nodes by matching a property value
- **`get_neighbors`**: Get all nodes connected to a given node
- **`get_sprint_graph`**: Get the full subgraph for the current sprint
- **`get_dependency_chain`**: Trace the full dependency chain from a Requirement down to CodeFiles
- **`ask_question`**: Ask a clarifying question to the team (blocks until answered)

### `ask_question`
The MCP tool used for ALL human communication. When called, it sends the question to all connected team members via WebSocket and **blocks** until someone answers. The answer text is returned directly. Every call automatically creates a Question node in Neptune, forming the audit trail.

### Sprint
A Sprint is a graph node that represents a development cycle. It contains all artifacts (Requirements, UserStories, Tasks, CodeFiles, Questions, Reviews) via CONTAINS edges. The Sprint node's properties track the current `phase` and `current_stage`.

### Graph Nodes
Artifacts stored in Neptune:
- **Project**: Top-level container
- **Sprint**: Development cycle container
- **Requirement**: A functional or non-functional requirement
- **UserStory**: A user-centered story with acceptance criteria
- **Task**: A unit of work with status tracking (todo, in-progress, done)
- **CodeFile**: A registered source code file with path and summary
- **Review**: A code review with status (PENDING, PASSED, FAILED)
- **Question**: A question asked via `ask_question` with its answer

### Graph Edges
Relationships between nodes:
- **HAS_SPRINT**: Project -> Sprint
- **CONTAINS**: Sprint -> Requirement|UserStory|Task|CodeFile|Question
- **HAS_REVIEW**: Sprint -> Review
- **BREAKS_INTO**: Requirement -> UserStory, UserStory -> Task
- **IMPLEMENTED_BY**: Task -> CodeFile, UserStory -> CodeFile
- **REVIEWS**: Review -> CodeFile
- **VALIDATES**: Review -> Requirement|UserStory
- **INFLUENCES**: Question -> Requirement|UserStory|Task
- **CARRIED_FROM**: Requirement -> Requirement (cross-sprint lineage), GeneralInfo -> GeneralInfo (cross-sprint knowledge carry-forward)

## Cross-Sprint Knowledge Management

### Cross-Sprint Context
Knowledge and artifacts that persist across sprint boundaries. When a new sprint starts, the agent loads context from previous sprints to ensure continuity. This includes design decisions, reverse-engineering findings, architecture notes, and requirements.

### Knowledge Carry-Forward
The automatic process of importing relevant artifacts from previous sprints into the current sprint. Executed during Workspace Detection (Step 1.5) via the `carry_forward_knowledge` MCP tool. Creates new nodes in the current sprint linked to their originals via `CARRIED_FROM` edges.

### Carried-Forward Artifact
A graph node that was imported from a previous sprint. Identified by:
- **`carried_from_sprint` property**: The source sprint ID
- **`carried_from_id` property**: The original node's ID in the source sprint
- **`CARRIED_FROM` edge**: Directed edge from the carried node to its original
- **`cf-` ID prefix**: e.g., `cf-re-business-overview` is carried from `re-business-overview`

### Cross-Sprint MCP Tools
- **`get_previous_sprint_summary`**: Returns condensed summaries of all previous sprints in the project (artifact counts, GeneralInfo, Requirements, metrics)
- **`get_previous_sprint_graph`**: Returns the full subgraph of a specific previous sprint (all nodes and edges)
- **`carry_forward_knowledge`**: Imports GeneralInfo and Requirement nodes from the most recent previous sprint into the current sprint

## Three-Phase Lifecycle

### INCEPTION PHASE
**Purpose**: Planning and architectural decisions
**Focus**: Determine WHAT to build and WHY

**Stages**:
- Workspace Detection (ALWAYS)
- Reverse Engineering (CONDITIONAL - Brownfield only)
- Requirements Analysis (ALWAYS - Adaptive depth)
- User Stories (CONDITIONAL)
- Workflow Planning (ALWAYS)
- Application Design (CONDITIONAL)
- Units Generation (CONDITIONAL)

**Outputs**: Requirement nodes, UserStory nodes, Task nodes in the graph

### CONSTRUCTION PHASE
**Purpose**: Detailed design and implementation
**Focus**: Determine HOW to build it

**Stages**:
- Functional Design (CONDITIONAL, per-unit)
- NFR Requirements (CONDITIONAL, per-unit)
- NFR Design (CONDITIONAL, per-unit)
- Infrastructure Design (CONDITIONAL, per-unit)
- Code Planning (ALWAYS)
- Code Generation (ALWAYS)
- Build and Test (ALWAYS)

**Outputs**: Task node updates, CodeFile nodes, Review nodes in the graph; actual source code on filesystem

### OPERATIONS PHASE
**Purpose**: Deployment and operational readiness
**Focus**: How to DEPLOY and RUN it

**Stages**:
- Operations (PLACEHOLDER)

## Architecture Terms

### Unit of Work
A logical grouping of user stories for development purposes. Represented as Task nodes in the graph.

### Service
An independently deployable component in a microservices architecture. Each service is a separate unit of work.

### Module
A logical grouping of functionality within a single service or monolith.

### Component
A reusable building block within a service or module.

## Stage Terminology

### Planning vs Generation
- **Planning**: Analyzing requirements, asking questions via `ask_question`, getting approval
- **Generation**: Executing the approved plan to create artifacts in the graph or code on filesystem

### Depth Levels
- **Minimal**: Quick, focused execution for simple changes
- **Standard**: Normal depth with standard artifacts for typical projects
- **Comprehensive**: Full depth with all artifacts for complex/high-risk projects

## Artifact Types

### Graph Node Artifacts
All design artifacts are stored as nodes in the Neptune graph database:
- **Requirements**: `add_node(label: "Requirement", ...)` with title, description, acceptance_criteria
- **User Stories**: `add_node(label: "UserStory", ...)` with title, description, story_points
- **Tasks**: `add_node(label: "Task", ...)` with title, description, status
- **Code Files**: `add_node(label: "CodeFile", ...)` with file_path, commit_ref, summary
- **General Info**: `add_node(label: "GeneralInfo", ...)` with type, title, content (for design artifacts, architecture decisions, etc.)

### Filesystem Artifacts
Only actual application source code is written to the filesystem:
- Source code files (.js, .ts, .py, etc.)
- Configuration files (package.json, tsconfig.json, etc.)
- Build scripts and test files

## Common Abbreviations

- **AI-DLC**: AI-Driven Development Life Cycle
- **NFR**: Non-Functional Requirements
- **UOW**: Unit of Work
- **MCP**: Model Context Protocol
- **API**: Application Programming Interface
