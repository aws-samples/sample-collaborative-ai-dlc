# Decompose

The Decompose stage takes a finished spec and breaks it into a directed acyclic graph (DAG) of implementation tasks.

## How it works

1. The system runs a readiness check on the spec
2. If the spec passes, the LLM analyzes it and produces a set of tasks
3. Tasks are arranged in a dependency graph (DAG)
4. Each task has metadata: description, acceptance criteria, complexity, dependencies, and relevant files
5. Tasks are persisted in the database and can be pushed to GitHub as issues

## Task structure

Each task includes:

| Field | Description |
|-------|-------------|
| **Title** | Short summary of what the task does |
| **Description** | Detailed explanation of the work |
| **Acceptance criteria** | List of conditions that must be met |
| **Test requirements** | What tests need to be written or pass |
| **Complexity** | Size estimate: S, M, L, or XL |
| **Dependencies** | IDs of tasks that must complete first |
| **Relevant files** | Files the task is likely to touch |
| **Spec section** | Which part of the spec this task relates to |
| **Status** | ready, blocked, in-progress, validating, review, done, or error |

## The DAG

Tasks form a dependency graph. A task is "blocked" until all its dependencies are "done". A task is "ready" when all dependencies are satisfied.

The UI shows this graph visually with nodes and edges. You can choose any task to see its details.

## Staleness detection

After a decompose is complete, the system tracks whether the spec has changed. If you edit the spec after decomposing, the system detects the staleness by comparing content hashes and warns you that the tasks may be out of date.

## Caching

If you trigger a decompose and the spec content has not changed since the last decompose, the system returns the cached tasks without calling the LLM again. This saves time and cost.

## Repo scoping

When a spec has repos assigned to it, the decompose step also assigns each task to a specific repo. This is used later in the Execute stage to create branches in the correct repository.
