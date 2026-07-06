# Running Agents

!!! note "Retired v1 lifecycle"
This page describes the v1 sprint lifecycle, which is now read-only: existing v1 projects and their history (including agent transcripts) stay viewable, but new sprints and agent runs can no longer be started. New work runs on v2 intents, executed by the Bedrock AgentCore runtime — see the [architecture overview](../concepts/architecture.md#agent-runtime).

After running Inception to generate tasks, you can start the Construction Agent to implement them.

## Prerequisites

- A git repository must be accessible (local or cloned via the workspace)
- A branch and base branch must be configured for the sprint

## Starting construction

In the sprint view, choose **Launch Agent** to start the Construction Agent. This triggers the following actions.

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

## Sending comments to the agent

You can send structured feedback to a running agent:

- **Inline comments** on specific files and lines
- **Batch comments** for multiple issues at once

The comments are formatted and injected into the agent's terminal as text input.

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
