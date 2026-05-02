# Decomposing Specs

Decomposing turns a spec into a set of implementation tasks organized in a dependency graph.

## Starting a decompose

Navigate to the spec and choose the **Decompose** tab. Choose **Start Decompose**.

Before the decompose runs, the system performs a readiness check.

## Readiness check

The readiness check has two parts:

### Structural checks

These are fast, deterministic checks:

- Minimum content length
- Required sections present
- Acceptance criteria defined
- Repository assigned (if repos are configured)

!!! info "NEED IMAGE HERE"
    Screenshot of the readiness check panel showing structural check results (passed/failed items).

### AI analysis

If structural checks pass, the LLM reviews the spec for:

- Clarity and completeness
- Ambiguous requirements
- Missing technical details
- Feasibility of decomposition

You see the results in real time as the AI streams its analysis. If the check fails, you get specific feedback about what to fix.

### Bypassing readiness

If you believe the spec is ready despite failing the readiness check, you can choose **Decompose Anyway** to skip the check.

## The task graph

After decompose completes, you see:

- A **task list** showing all tasks with their status, complexity, and dependencies
- A **DAG view** showing the dependency graph visually
- Task details when you choose any task

!!! info "NEED IMAGE HERE"
    Screenshot of the decompose view showing the task list and the DAG visualization with nodes and dependency edges.

### Task statuses

| Status | Meaning |
|--------|---------|
| **ready** | All dependencies are met, task can start |
| **blocked** | Waiting for one or more dependencies |
| **in-progress** | An agent is working on this task |
| **validating** | Automated checks are running |
| **review** | Agent finished, waiting for human review |
| **done** | Approved and complete |
| **error** | Something went wrong |

!!! info "NEED IMAGE HERE"
    Screenshot of a task detail panel showing the description, acceptance criteria, complexity, and dependencies.

## Staleness detection

If you edit the spec after decomposing, the system detects the change and shows a warning that the tasks may be out of date. You can re-run the decompose to generate updated tasks.

## Caching

If you choose decompose and the spec has not changed since the last run, the system returns the cached results immediately without calling the LLM.

## Pushing to GitHub

If a GitHub connection is configured, you can push the tasks as GitHub Issues. See [Git Integration](git-integration.md) for details.
