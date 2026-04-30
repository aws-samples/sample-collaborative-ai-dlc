# Adaptive Depth

**Purpose**: Explain how AI-DLC adapts detail level to problem complexity

## Core Principle

**When a stage executes, ALL its defined artifacts are created as graph nodes. The "depth" refers to the level of detail and rigor within those artifacts, which adapts to the problem's complexity.**

## Stage Selection vs Detail Level

### Stage Selection (Binary)
- **Workflow Planning** decides: EXECUTE or SKIP for each stage
- **If EXECUTE**: Stage runs and creates ALL its defined graph nodes
- **If SKIP**: Stage doesn't run at all

### Detail Level (Adaptive)
- **Simple problems**: Concise node properties with essential detail
- **Complex problems**: Comprehensive node properties with extensive detail
- **Model decides**: Based on problem characteristics, not prescriptive rules

## Factors Influencing Detail Level

The model considers these factors when determining appropriate detail:

1. **Request Clarity**: How clear and complete is the user's request?
2. **Problem Complexity**: How intricate is the solution space?
3. **Scope**: Single file, component, multiple components, or system-wide?
4. **Risk Level**: What's the impact of errors or omissions?
5. **Available Context**: Greenfield vs brownfield, existing graph artifacts
6. **User Preferences**: Has user expressed preference for brevity or detail?

## Example: Requirements Analysis Artifacts

**All scenarios create the same graph node types**:
- Requirement nodes (via `add_node`)
- Question nodes (automatically via `ask_question` calls)

**Detail level varies by complexity**:

### Simple Scenario (Bug Fix)
- **Requirement nodes**: 1-2 concise requirements with clear acceptance criteria
- **Questions**: Minimal clarifying questions (if any)

### Complex Scenario (System Migration)
- **Requirement nodes**: 10+ detailed requirements with comprehensive acceptance criteria, traceability, priority
- **Questions**: Multiple rounds of `ask_question` calls, 10+ questions

## Example: Application Design Artifacts

**All scenarios create the same graph node types**:
- Requirement nodes with `category: "design"`

**Detail level varies by complexity**:

### Simple Scenario (Single Component)
- **Design nodes**: Basic component description, key methods
- **Minimal detail**: Essential relationships only

### Complex Scenario (Multi-Component System)
- **Design nodes**: Detailed component responsibilities, all methods with signatures, design patterns
- **Comprehensive detail**: All relationships, data flows, integration points

## Guiding Principle for Model

**"Create exactly the detail needed for the problem at hand - no more, no less."**

- Don't artificially inflate simple problems with unnecessary detail
- Don't shortchange complex problems by omitting critical detail
- Let problem characteristics drive detail level naturally
- All required graph nodes are always created when stage executes
