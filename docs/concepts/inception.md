# Inception

!!! note "Retired v1 lifecycle"
This page describes the v1 sprint lifecycle, which is now read-only: existing v1 projects and their history stay viewable, but no new sprints or agent runs can start. New work runs on v2 intents, executed by the Bedrock AgentCore runtime — see the [architecture overview](architecture.md#agent-runtime).

The Inception phase is where you define what to build. An AI agent helps break down a project description into structured requirements, user stories, and tasks. The goal is to remove ambiguity throughout the entire phase so that when you move to design and code, there is as little ambiguity as possible.

## How it works

1. You create a sprint and write a description in free-form text:
   - For a **greenfield project** (from scratch): describe the new system, its goals, constraints, and scope
   - For a **brownfield project** (existing codebase): describe the feature, issue, or change you want to make
2. You launch the Inception Agent
3. The agent analyzes the description and asks clarifying questions to remove ambiguity
4. You answer the questions (structured multiple-choice or free text)
5. The agent generates requirements, user stories, and tasks
6. You review and refine the generated artifacts

The [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) drives this process. Given what you want to do, the agent systematically identifies gaps, asks the right questions, and produces artifacts that are specific enough for autonomous construction.

## The Inception Agent

The Inception Agent reads your project description and produces:

- **Requirements** with titles, descriptions, and acceptance criteria
- **User stories** with titles, descriptions, and story points
- **Tasks** that map to concrete implementation work
- **General info** artifacts that capture context and decisions

The agent asks questions when the description is ambiguous or incomplete. These are structured questions with suggested answers, making it easy to provide direction without writing long explanations.

## Artifacts

### Requirements

A requirement defines a capability the system must have. Each requirement includes:

- A title and description
- Acceptance criteria that define when the requirement is met
- Links to the user stories and tasks that implement it

### User stories

A user story describes a feature from the user's perspective. Each story includes:

- A title and description
- Story points indicating relative complexity
- Links to the tasks that implement it

### Tasks

A task is a concrete unit of implementation work. Tasks are what the Construction Agent picks up and codes. Each task includes:

- A title and description
- Acceptance criteria
- Dependencies on other tasks
- Links back to the requirements and stories it fulfills

The number of tasks scales automatically with the scope of the sprint. A small feature might produce 3-5 tasks; a full project might produce 30+.

## Collaborative editing

All artifacts support real-time collaborative editing. Multiple team members can refine requirements, adjust story points, or rewrite task descriptions simultaneously. Changes sync instantly via Yjs CRDT.

## Moving to Construction

Once you are satisfied with the generated artifacts, you select a git branch and base branch, then launch the Construction Agent. The sprint phase transitions from Inception to Construction.
