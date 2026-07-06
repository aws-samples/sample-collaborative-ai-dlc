# Construction

!!! note "Retired v1 lifecycle"
This page describes the v1 sprint lifecycle, which is now read-only: existing v1 projects and their history stay viewable, but no new sprints or agent runs can start. New work runs on v2 intents, executed by the Bedrock AgentCore runtime — see the [architecture overview](architecture.md#agent-runtime).

The Construction phase is where AI agents write code based on the requirements, user stories, and tasks defined during Inception.

## How it works

1. You select a git branch and base branch for the work
2. You launch the Construction Agent
3. The agent picks up tasks and writes code to fulfill them
4. The agent may ask follow-up questions if implementation details are unclear
5. You answer questions as they arise
6. The agent commits changes and tracks which files were modified
7. When all tasks are complete, the sprint moves to Review

## The Construction Agent

The Construction Agent ran in an ECS Fargate container with access to the full repository. It received:

- The project description
- All requirements and acceptance criteria
- User stories for context
- Tasks to implement

The agent works through tasks, generating code files and committing changes to the configured branch. Its progress is tracked in real time.

## Code files

As the agent works, it produces **CodeFile** artifacts that track:

- The file path modified
- The commit reference
- A summary of what was changed

This creates a traceable link from each requirement down to the exact code that implements it.

## Questions during construction

The agent can ask clarifying questions during construction, just like in Inception. If an implementation decision is ambiguous (choice of library, API design, error handling strategy), the agent asks rather than guessing. You answer in the UI and the agent continues.

## Agent status

Agent progress is streamed in real time via WebSocket. You can see:

- Live text output and tool calls as the agent works
- Which tasks have been completed
- Which files have been modified

Polling runs in the background as a fallback to catch missed events and keep state in sync.

## Moving to Review

When the Construction Agent finishes all tasks, it creates a pull request with the changes. The sprint phase transitions from Construction to Review.
