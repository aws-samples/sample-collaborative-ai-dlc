# Reviewing Work

When an agent finishes a task, it moves to "review" status. A human reviewer evaluates the changes and decides to approve or reject.

## Opening a review

Choose a task in "review" status. You see the following information.

- **Diff view** showing all file changes the agent made
- **Terminal output** from the agent session
- **Acceptance criteria** with checkboxes for each criterion
- **Task summary** written by the agent

!!! info "NEED IMAGE HERE"
    Screenshot of the review panel showing the diff view, acceptance criteria checklist, and approve/reject buttons.

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

You can set a review policy per task or per decompose:

| Policy | What happens |
|--------|-------------|
| **manual** | Task waits for human review (default) |
| **auto_commit** | Agent output is committed automatically |
| **auto_pr** | Agent output is pushed as a pull request automatically |
| **board_default** | Uses the decompose-level default |

For early development, `manual` is recommended. As you build trust in the agent's output for specific types of tasks, you can switch to `auto_commit` or `auto_pr`.
