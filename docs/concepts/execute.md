# Execute

The Execute stage is where AI agents pick up tasks and write code autonomously.

## How it works

1. A task in "ready" status is started (manually or by the cascade engine)
2. The system creates a git worktree for the task, branching from the base ref
3. A Claude CLI session is spawned via `node-pty` inside the worktree
4. The agent receives the task description, acceptance criteria, and context
5. The agent writes code, runs tests, and commits changes
6. When the agent finishes, the task moves to "review" status

## Isolation

Each task runs in its own **git worktree**. This means:

- The agent has a full copy of the repo on a dedicated branch
- Multiple agents can work in parallel without conflicts
- The main branch is never modified directly
- If an agent fails, the worktree can be cleaned up without affecting anything else

## Agent sessions

The platform uses Claude CLI as the agent runtime. Each session:

- Runs in a pseudo-terminal (`node-pty`)
- Has its output streamed to the browser in real time
- Can receive terminal input from the user
- Tracks exit codes and summaries

You can watch what the agent is doing live through the terminal panel in the UI.

## Cascade engine

The cascade engine automates task scheduling. When a task completes:

1. The engine checks which blocked tasks now have all dependencies met
2. Those tasks are moved to "ready" status
3. If auto-start is enabled, ready tasks are started automatically (up to the parallel agent limit)

This means you can start the first task and the rest will cascade through the graph without manual intervention.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `maxParallelAgents` | 3 | How many agents can run at the same time |
| `autoStartReadyTasks` | true | Whether to start tasks automatically when they become ready |
| `baseRef` | main | The git branch to create worktrees from |
| `defaultReviewPolicy` | manual | What happens when an agent finishes (manual, auto_commit, auto_pr) |

## Worktree lifecycle

1. **Created** when a task starts, branching from the base ref
2. **Active** while the agent is running
3. **Watched** for file changes (diffs streamed to the browser)
4. **Cleaned up** after the task is reviewed and completed

Stale worktrees from crashed sessions are garbage collected on server startup.
