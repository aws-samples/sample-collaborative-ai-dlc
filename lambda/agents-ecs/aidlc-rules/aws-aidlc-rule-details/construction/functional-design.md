# Functional Design

## Purpose
**Detailed business logic design per unit**

Functional Design focuses on:
- Detailed business logic and algorithms for the unit
- Domain models with entities and relationships
- Detailed business rules, validation logic, and constraints
- Technology-agnostic design (no infrastructure concerns)

**Note**: This builds upon high-level component design from Application Design (INCEPTION phase)

## Prerequisites
- Units Generation must be complete
- Unit Task nodes must exist in graph
- Application Design recommended
- Execution plan must indicate Functional Design should execute

## Steps to Execute

### Step 1: Load Unit Context from Graph

- Call `get_node(label: "Task", id: "unit-[name]")` to load the unit definition
- Call `get_neighbors(label: "Task", id: "unit-[name]", direction: "in", edgeLabel: "BREAKS_INTO")` to find assigned stories
- Call `list_nodes(label: "Requirement")` to load design artifacts

### Step 2: Ask Design Questions via `ask_question`

**DIRECTIVE**: Thoroughly analyze the unit definition and functional design needs. Be proactive in asking questions.

**CRITICAL**: Default to asking questions when there is ANY ambiguity.

Call `ask_question` with batched questions covering relevant areas:
- **Business Logic** - core entities, workflows, data transformations
- **Domain Model** - entity relationships, data structures
- **Business Rules** - decision rules, validation logic, constraints
- **Data Flow** - inputs, outputs, transformations, persistence
- **Integration Points** - external system interactions, APIs
- **Error Handling** - error scenarios, validation failures
- **Frontend Components** (if applicable) - UI structure, interactions, state management

### Step 3: Analyze Answers and Follow Up

**MANDATORY**: Review all answers for ambiguities. Call `ask_question` again for any unclear responses.
Do not proceed until ALL ambiguities are resolved.

### Step 4: Store Functional Design in Graph

Store as properties on the unit's Task node or as dedicated Requirement nodes:

```
update_node(label: "Task", id: "unit-[name]", properties: {
  functional_design: "[business logic model, domain entities, business rules]",
  status: "in-progress"
})
```

Or for complex designs, create dedicated nodes:
```
add_node(label: "Requirement", id: "fd-[unit-name]-business-logic", properties: {
  title: "Functional Design - [Unit Name] - Business Logic",
  description: "[detailed business logic, domain model, rules]",
  category: "functional-design"
})
```

### Step 5: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "functional-design"
})
```

### Step 6: Request Approval

Call `ask_question` with:
```
"Functional Design Complete - [unit-name]

Functional design has created:
- [List key business logic models and entities]
- [List business rules and validation logic]
- [Mention domain model structure]

Do you want to REQUEST CHANGES or CONTINUE TO NEXT STAGE?"
```

Wait for explicit approval. If changes requested, update and re-request.
