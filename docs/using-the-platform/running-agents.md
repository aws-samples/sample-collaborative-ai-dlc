# Running Agents

After decomposing a spec into tasks, you can start AI agents to implement them.

## Prerequisites

- **Claude CLI** must be installed and configured on the machine running the server
- A git repository must be accessible (local or cloned via the workspace)

## Starting a task

In the decompose view, choose a task that is in "ready" status and choose **Start**. This triggers the following actions.

1. A git worktree is created from the base branch
2. A Claude CLI session is spawned inside the worktree
3. The agent receives the task description, acceptance criteria, and codebase context
4. The task status changes to "in-progress"

## Watching the agent

The UI shows a live terminal for the running agent. You can:

- **Watch the output** as the agent thinks, writes code, and runs commands
- **Send input** by typing in the terminal (useful if the agent asks a question)
- **See file changes** as the agent modifies code (diffs are streamed in real time)
- **Stop the agent** if it is going in the wrong direction

!!! info "NEED IMAGE HERE"
    Screenshot of the agent terminal panel showing live output from a running Claude CLI session.

## Sending comments to the agent

You can send structured feedback to a running agent:

- **Inline comments** on specific files and lines
- **Batch comments** for multiple issues at once

The comments are formatted and injected into the agent's terminal as text input.

!!! info "NEED IMAGE HERE"
    Screenshot of the diff panel showing real-time file changes made by the agent.

## Cascade mode

When the cascade engine is enabled (default), tasks run automatically:

1. You start the first "ready" task
2. When it completes and is approved, dependent tasks that become "ready" are started automatically
3. This continues until all tasks are done or something fails

The cascade engine respects the `maxParallelAgents` setting (default: 3). It will not start more agents than this limit.

## Stopping an agent

Choose **Stop** on a running task. This performs the following actions.

1. Terminates the Claude CLI process
2. Changes the task status to "error"
3. Preserves the worktree so you can inspect what happened
4. Stops the file watcher for that task

## What happens on server restart

If the server restarts while agents are running:

- All in-progress tasks are marked as "error" (since the processes are lost)
- Stale worktrees are garbage collected
- Orphaned Claude processes are cleaned up
- You can restart the tasks manually
