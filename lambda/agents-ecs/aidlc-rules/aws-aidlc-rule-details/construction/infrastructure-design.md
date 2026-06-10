# Infrastructure Design

## Prerequisites

- Functional Design must be complete for the unit
- NFR Design recommended
- Execution plan must indicate Infrastructure Design should execute

## Overview

Map logical software components to actual infrastructure choices for deployment environments.

## Steps to Execute

### Step 1: Load Context from Graph

- Load unit Task node with functional design and NFR design from graph
- Identify logical components needing infrastructure

### Step 2: Ask Infrastructure Questions via `ask_question`

Call `ask_question` with questions covering relevant areas:

- **Deployment Environment** - cloud provider, environment setup
- **Compute Infrastructure** - compute service choices
- **Storage Infrastructure** - database, storage selection
- **Messaging Infrastructure** - messaging/queuing services
- **Networking Infrastructure** - load balancing, API gateway
- **Monitoring Infrastructure** - observability tooling
- **Shared Infrastructure** - infrastructure sharing strategy

### Step 3: Analyze Answers and Follow Up

Review all answers for ambiguities. Call `ask_question` again for any unclear responses.

### Step 4: Store Infrastructure Design in Graph

```
add_node(label: "Requirement", id: "infra-design-[unit-name]", properties: {
  title: "Infrastructure Design - [Unit Name]",
  description: "[infrastructure mapping, deployment architecture, cloud services]",
  category: "infrastructure-design"
})
```

### Step 5: Update Sprint State

```
update_node(label: "Sprint", id: env.sprintId, properties: {
  current_stage: "infrastructure-design",
  phase_status: "active"
})
```

### Step 6: Request Approval

Call `ask_question` with:

```
"Infrastructure Design Complete - [unit-name]

Infrastructure design has mapped:
- [List key infrastructure services and components]
- [List deployment architecture decisions]
- [Mention cloud provider choices]

Do you want to REQUEST CHANGES or CONTINUE TO NEXT STAGE (Code Generation)?"
```

Wait for explicit approval.
