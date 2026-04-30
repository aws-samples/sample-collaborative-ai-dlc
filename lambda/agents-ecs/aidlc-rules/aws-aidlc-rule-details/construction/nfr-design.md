# NFR Design

## Prerequisites
- NFR Requirements must be complete for the unit
- Execution plan must indicate NFR Design should execute

## Overview
Incorporate NFR requirements into unit design using patterns and logical components.

## Steps to Execute

### Step 1: Load Context from Graph

- Load unit Task node and its NFR Requirement nodes from graph
- Understand scalability, performance, availability, security needs

### Step 2: Ask NFR Design Questions via `ask_question`

Call `ask_question` with questions covering relevant areas:
- **Resilience Patterns** - fault tolerance approach
- **Scalability Patterns** - scaling mechanisms
- **Performance Patterns** - optimization strategy
- **Security Patterns** - security implementation
- **Logical Components** - infrastructure components (queues, caches, etc.)

### Step 3: Analyze Answers and Follow Up

Review all answers for ambiguities. Call `ask_question` again for any unclear responses.

### Step 4: Store NFR Design in Graph

Store as properties on Task nodes or dedicated Requirement nodes:

```
add_node(label: "Requirement", id: "nfr-design-[unit-name]", properties: {
  title: "NFR Design - [Unit Name]",
  description: "[design patterns, logical components, resilience/scalability/performance patterns]",
  category: "nfr-design"
})
```

### Step 5: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "nfr-design"
})
```

### Step 6: Request Approval

Call `ask_question` with:
```
"NFR Design Complete - [unit-name]

NFR design has incorporated:
- [List key design patterns]
- [List logical components and infrastructure elements]
- [Mention resilience, scalability, performance patterns]

Do you want to REQUEST CHANGES or CONTINUE TO NEXT STAGE?"
```

Wait for explicit approval.
