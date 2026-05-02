# Review

The Review stage is where humans evaluate the code an agent produced and decide whether to accept or reject it.

## How it works

1. An agent finishes its task and moves to "review" status
2. A human reviewer opens the task and sees the diff, terminal output, and acceptance criteria
3. The reviewer checks each acceptance criterion as met, not met, or unclear
4. The reviewer either approves or rejects the task

## Approval flow

When a task is **approved**:

1. The task status changes to "done"
2. The cascade engine checks for newly unblocked tasks
3. Dependent tasks move to "ready" and may auto-start

## Rejection flow

When a task is **rejected**:

1. A review record is created with the criteria results and notes
2. The review iteration counter is incremented
3. The task status resets to "ready"
4. A new agent session starts with the review feedback injected into the prompt
5. The agent sees what was wrong and tries to fix it

This creates an iterative improvement loop. The agent gets more specific guidance with each rejection.

## Review policies

Each task (or the entire decompose) can have a review policy:

| Policy | Behavior |
|--------|----------|
| **manual** | Task waits in "review" for a human to approve or reject |
| **auto_commit** | Agent output is automatically committed without review |
| **auto_pr** | Agent output is automatically pushed as a pull request |
| **board_default** | Uses the decompose-level default policy |

## Structured feedback

When rejecting a task, reviewers can provide:

- **Per-criterion results** with reasons for each acceptance criterion
- **Inline comments** on specific files and lines
- **General notes** explaining what needs to change

All of this is formatted into a structured prompt that the agent receives when it restarts.

## Validation

Before a task reaches review, it can go through a validation step where automated checks (tests, lint) run against the agent's changes. If validation fails, the agent gets a chance to fix the issues before the human reviewer sees the work.
