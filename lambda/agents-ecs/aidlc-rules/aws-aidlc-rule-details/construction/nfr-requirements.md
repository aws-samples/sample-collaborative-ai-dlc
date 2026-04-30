# NFR Requirements

## Prerequisites
- Functional Design must be complete for the unit
- Execution plan must indicate NFR Requirements should execute

## Overview
Determine non-functional requirements for the unit and make tech stack choices.

## Steps to Execute

### Step 1: Load Context from Graph

- Call `get_node(label: "Task", id: "unit-[name]")` to load unit with functional design
- Call `list_nodes(label: "Requirement")` to load existing requirements

### Step 2: Ask NFR Questions via `ask_question`

**DIRECTIVE**: Thoroughly analyze the functional design to identify ALL areas where NFR clarification is needed.

**CRITICAL**: Default to asking questions when there is ANY ambiguity.

Call `ask_question` with batched questions covering relevant areas:
- **Scalability** - expected load, growth patterns, capacity planning
- **Performance** - response times, throughput, latency
- **Availability** - uptime expectations, disaster recovery, failover
- **Security** - data protection, compliance, authentication, authorization
- **Tech Stack** - technology preferences, constraints, integration requirements
- **Reliability** - error handling, fault tolerance, monitoring
- **Maintainability** - code quality, documentation, testing
- **Usability** - user experience, accessibility

### Step 3: Analyze Answers and Follow Up

**MANDATORY**: Review all answers for ambiguities. Call `ask_question` again for any unclear responses.

### Step 4: Store NFR Requirements in Graph

Create Requirement nodes with `category: "nfr"`:

```
add_node(label: "Requirement", id: "nfr-[unit-name]-[area]", properties: {
  title: "NFR - [Unit Name] - [Area]",
  description: "[detailed NFR requirements and tech stack decisions]",
  category: "nfr"
})
```

### Step 5: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "nfr-requirements"
})
```

### Step 6: Request Approval

Call `ask_question` with:
```
"NFR Requirements Complete - [unit-name]

NFR requirements assessment has identified:
- [List key scalability, performance, availability requirements]
- [List security and compliance requirements]
- [Mention tech stack decisions and rationale]

Do you want to REQUEST CHANGES or CONTINUE TO NEXT STAGE?"
```

Wait for explicit approval.
