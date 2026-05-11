# Reviewing Work

When an agent finishes a task, it moves to "review" status. A human reviewer evaluates the changes and decides to approve or reject.

## Opening a review

Choose a task in "review" status. You see the following information.

- **Diff view** showing all file changes the agent made
- **Terminal output** from the agent session
- **Acceptance criteria** with checkboxes for each criterion
- **Task summary** written by the agent

## Approving a task

1. Review the diff and terminal output
2. Check each acceptance criterion as met or not met
3. Choose **Approve**.

The task moves to "done" and the cascade engine checks for newly unblocked tasks.

## Rejecting a task

1. Review the changes and mark criteria results
2. Add notes explaining what needs to change
3. Optionally add inline comments on specific lines
4. Choose **Reject**.

What happens next:

1. A review record is saved with your feedback
2. The review iteration counter increments
3. The task resets to "ready"
4. A new agent session starts with your structured feedback in the prompt
5. The agent reads your notes and criteria results and tries again

## Review iterations

Each rejection creates a new iteration. The agent sees the full feedback history, including all previous iterations. This helps it converge on the right solution.

The review iteration number is tracked on the task, so you can see how many attempts it took.

## Review policies

You can set a review policy per sprint:

| Policy | What happens |
|--------|-------------|
| **manual** | Work waits for human review (default) |
| **auto_commit** | Agent output is committed automatically |
| **auto_pr** | Agent output is pushed as a pull request automatically |

For early development, `manual` is recommended. As you build trust in the agent's output, you can switch to `auto_commit` or `auto_pr`.
