# Methodology

The [AI-DLC (AI Development Lifecycle)](https://github.com/awslabs/aidlc-workflows) methodology is the framework that underpins this platform. Created by Raja SP at AWS, AI-DLC repositions AI from coding assistant to development orchestrator, defining a structured approach to human-AI collaboration where each phase has clear inputs, outputs, and decision points.

The core idea: instead of treating AI as a black-box code generator, AI-DLC treats it as a collaborator that operates within a defined process. Humans set direction and evaluate results. Agents do the heavy lifting of planning and implementation. The methodology ensures nothing gets lost between intent and code.

## What AI-DLC defines

- **Phases** (Inception, Construction, Operations) as the progression of work, broken into **stages** — the atomic units of agent work
- **Artifacts** (requirements, user stories, designs, decisions, units of work, code) as the structured outputs stages produce and consume
- **Agent personas** (domain experts acting as lead, support, or reviewer per stage) as the AI participants with specific roles
- **Scopes** (feature, bugfix, greenfield, …) that decide which stages execute for a given piece of work
- **Verification** through deterministic sensors, reviewer agents, and human validation gates
- **Traceability** as the graph connecting every artifact back to the original intent
- **Parallel construction** of loosely coupled units of work through Domain-Driven Design principles

## Limitations of markdown-only implementations

AI-DLC (and any spec-driven methodology) can be implemented with just markdown files in a local IDE — tools like Kiro, Claude Code, or OpenCode support this today. This approach has real advantages: zero infrastructure, works anywhere, easy to version in git, and great for individual productivity.

However, markdown-only implementations hit inherent limitations when scaling to teams and complex projects:

| Limitation                        | Why it happens                                                                                                                                                                                 | How this platform solves it                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Traceability gaps**             | Requirements live in `.md` files, code in repos, decisions in chat. Connections between them exist only in the developer's head and disappear between sessions.                                | Graph database with typed relationships. Every code file links back to its originating requirement automatically.    |
| **Single-user by default**        | Markdown files are local. Syncing them across a team requires manual git workflows. AI-DLC envisions Mob Elaboration and Mob Construction, but local files don't support simultaneous editing. | Real-time collaboration via WebSocket + CRDT. Multiple stakeholders work on the same artifacts simultaneously.       |
| **Informal oversight**            | No mechanism for an agent to formally block execution, present structured options, wait for a human decision, and resume with validated context. Oversight happens through unstructured chat.  | Structured approval gates with Question nodes, predefined options, and mandatory ambiguity detection.                |
| **Context loss between sessions** | Each AI session starts with a blank context window. Teams re-explain architecture decisions and previous work at every iteration because markdown files don't carry forward automatically.     | Team knowledge and learning rules accrue on the project graph and are injected into every relevant stage prompt.      |
| **Manual serial execution**       | Local tools process tasks sequentially in a single session. Even when tasks have no dependencies, there is no mechanism to dispatch them in parallel.                                          | The execution engine reads the dependency graph, identifies unblocked units of work, and dispatches parallel agents. |

These are not limitations of AI-DLC itself — the methodology is implementation-agnostic. They are limitations of using local markdown files as the backing store for any structured development process. Collaborative AI-DLC is one way to overcome them by moving from files to structured databases, from local to collaborative, and from single-agent to multi-agent orchestration.

## How it works in the platform

The [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) is embedded in the platform as a library of building blocks. The upstream repository is pinned to a specific ref (`aidlc_repo_ref` in the Terraform variables) and imported unmodified: its stages, agent personas, rules, sensors, and knowledge are seeded into the platform's block library, and workflows arrange those blocks into an executable plan.

At execution time, the runtime assembles each stage's prompt from these blocks. They cover:

- How agents generate user stories and decompose work into units
- How agents approach implementation
- How reviewer agents and deterministic sensors evaluate output

As the open-source AI-DLC methodology evolves (including autonomous practice guidance), the platform inherits updates by re-pinning the upstream ref, while a binding annex maps the methodology's file-based conventions onto the graph-aware tools that connect agents to the structured datastore.
