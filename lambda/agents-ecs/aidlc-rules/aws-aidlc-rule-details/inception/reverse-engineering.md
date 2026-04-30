# Reverse Engineering

**Purpose**: Analyze existing codebase and store findings in the graph

**Execute when**: Brownfield project detected (existing code found in workspace)

**Skip when**: Greenfield project (no existing code)

**Rerun behavior**: Always rerun when brownfield project detected, even if artifacts exist. This ensures artifacts reflect current code state.

## Step 0: Check for Carried-Forward RE Artifacts

Before running full reverse engineering, check if carried-forward RE artifacts exist from a previous sprint:

### 0.1 Query Carried-Forward Artifacts
- Use `list_nodes(label: "GeneralInfo")` and filter for nodes with `carried_from_sprint` property AND `type: "reverse-engineering"`
- Also check for carried-forward Requirements with `category: "reverse-engineering"`

### 0.2 If Carried-Forward RE Artifacts Exist

Present the carried-forward findings to the user via `ask_question`:

```
"Previous Reverse Engineering Context Available

I have reverse engineering findings carried forward from sprint "[sprint name]":

[List titles and brief summaries of carried-forward RE GeneralInfo nodes]

Has the codebase changed significantly since the last sprint? Options:
1. **No significant changes** — I'll use the existing findings and verify them with a quick scan
2. **Some changes** — Describe what changed, and I'll update the relevant findings
3. **Major changes** — I'll run a full reverse engineering analysis using the previous findings as baseline context"
```

**If user says no significant changes**:
- Perform a quick verification scan: check package.json/build files for new dependencies, scan for new source files
- If verification confirms no major changes: Update the `carried_from_sprint` artifacts' content if minor updates needed, then skip to Step 3
- If verification reveals unexpected changes: Inform user and suggest running the full analysis

**If user says some changes**:
- Note the described changes
- Run targeted reverse engineering on the changed areas only
- Update the carried-forward GeneralInfo nodes via `update_node` with revised content
- Create new GeneralInfo nodes for any entirely new areas discovered
- Skip to Step 3

**If user says major changes**:
- Proceed with full reverse engineering (Step 1) using carried-forward artifacts as reference context
- The agent should compare new findings with carried-forward artifacts to identify what changed

### 0.3 If No Carried-Forward RE Artifacts Exist
- Proceed with full reverse engineering starting at Step 1

## Step 1: Multi-Package Discovery

### 1.1 Scan Workspace
- All packages (not just mentioned ones)
- Package relationships via config files
- Package types: Application, CDK/Infrastructure, Models, Clients, Tests

### 1.2 Understand the Business Context
- The core business that the system is implementing overall
- The business overview of every package
- List of Business Transactions that are implemented in the system

### 1.3 Infrastructure Discovery
- CDK packages (package.json with CDK dependencies)
- Terraform (.tf files)
- CloudFormation (.yaml/.json templates)
- Deployment scripts

### 1.4 Build System Discovery
- Build systems: Maven, Gradle, npm, etc.
- Config files for build-system declarations
- Build dependencies between packages

### 1.5 Service Architecture Discovery
- Lambda functions (handlers, triggers)
- Container services (Docker/ECS configs)
- API definitions (OpenAPI specs, etc.)
- Data stores (DynamoDB, S3, etc.)

### 1.6 Code Quality Analysis
- Programming languages and frameworks
- Test coverage indicators
- Linting configurations
- CI/CD pipelines

## Step 2: Store Findings in Graph

**CRITICAL**: Before creating any GeneralInfo nodes, load and follow the rules in `common/generalinfo-linking.md`.

**If updating carried-forward artifacts**: Use `update_node` to update the existing carried-forward GeneralInfo nodes with revised content rather than creating duplicates. Only create new nodes for entirely new discovery areas.

**If creating fresh artifacts**: Store all reverse engineering findings as GeneralInfo nodes with `type: "reverse-engineering"` and **MANDATORY** links to related artifacts. Create one node per major finding area:

```
add_node(label: "GeneralInfo", id: "re-business-overview", properties: {
  type: "reverse-engineering",
  title: "Business Overview",
  content: "[comprehensive business context, transactions, dictionary]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-architecture", properties: {
  type: "reverse-engineering",
  title: "System Architecture",
  content: "[architecture overview, component descriptions, data flow, integration points, infrastructure]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-code-structure", properties: {
  type: "reverse-engineering",
  title: "Code Structure",
  content: "[build system, key classes/modules, files inventory, design patterns, dependencies]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-api-documentation", properties: {
  type: "reverse-engineering",
  title: "API Documentation",
  content: "[REST APIs, internal APIs, data models]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-component-inventory", properties: {
  type: "reverse-engineering",
  title: "Component Inventory",
  content: "[application packages, infrastructure packages, shared packages, test packages]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-technology-stack", properties: {
  type: "reverse-engineering",
  title: "Technology Stack",
  content: "[languages, frameworks, infrastructure, build tools, testing tools]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "GeneralInfo", id: "re-dependencies", properties: {
  type: "reverse-engineering",
  title: "Dependencies",
  content: "[internal dependencies, external dependencies, dependency graph]"
}, edges: [
  { direction: "to", label: "Requirement", id: "req-xyz", edgeLabel: "RELATES_TO" }
])

add_node(label: "Requirement", id: "re-code-quality", properties: {
  title: "Code Quality Assessment",
  description: "[test coverage, code quality indicators, technical debt, patterns and anti-patterns]",
  category: "reverse-engineering"
})
```

**CRITICAL LINKING RULES**:
- **ALWAYS** use the `edges` parameter when creating GeneralInfo nodes to link them to Requirements
- After creating GeneralInfo, use `add_edge` to link Questions that influenced them (Question → GeneralInfo via INFLUENCES)
- Link to **ALL relevant Requirements** that the reverse engineering findings relate to
- Link **ALL Questions** that were asked during reverse engineering
- Use `RELATES_TO` for GeneralInfo → Requirement edges
- Use `INFLUENCES` for Question → GeneralInfo edges

**If Questions were asked during reverse engineering**, link them after creating GeneralInfo nodes:

```
// For each Question that influenced a GeneralInfo node
add_edge(
  fromLabel: "Question",
  fromId: "q-architecture-style",
  toLabel: "GeneralInfo",
  toId: "re-architecture",
  edgeLabel: "INFLUENCES"
)
```
- If findings relate to multiple requirements, include multiple edges in the array
- After creating all GeneralInfo nodes, if you discover additional relationships, use `add_edge` to connect them

## Step 3: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "reverse-engineering"
})
```

## Step 4: Present Completion and Request Approval

Call `ask_question` with:
```
"Reverse Engineering Complete

[AI-generated summary of key findings from analysis in bullet points]

I have stored all findings in the project graph (8 reverse engineering artifacts covering business overview, architecture, code structure, APIs, components, technology stack, dependencies, and code quality).

Do you APPROVE to proceed to Requirements Analysis, or describe what changes are needed?"
```

## Step 5: Wait for User Approval

- **MANDATORY**: Do not proceed until user explicitly approves via the `ask_question` response
- If the response is not a clear approval, treat as change request and update artifacts accordingly
