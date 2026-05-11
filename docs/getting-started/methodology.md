# Methodology

The [AI-DLC (AI Development Lifecycle)](https://github.com/awslabs/aidlc-workflows) methodology is the framework that underpins this platform. Created by Raja SP at AWS, AI-DLC repositions AI from coding assistant to development orchestrator, defining a structured approach to human-AI collaboration where each phase has clear inputs, outputs, and decision points.

The core idea: instead of treating AI as a black-box code generator, AI-DLC treats it as a collaborator that operates within a defined process. Humans set direction and evaluate results. Agents do the heavy lifting of planning and implementation. The methodology ensures nothing gets lost between intent and code.

## What AI-DLC defines

- **Phases** (Inception, Construction, Review) as the progression of work
- **Artifacts** (requirements, user stories, tasks, code files) as the structured outputs at each phase
- **Agents** (Inception, Construction, Review, Modify) as the AI participants with specific roles
- **Traceability** as the graph connecting every artifact back to the original intent
- **Parallel construction** of loosely coupled components through Domain-Driven Design principles

## Limitations of markdown-only implementations

AI-DLC (and any spec-driven methodology) can be implemented with just markdown files in a local IDE — tools like Kiro, Claude Code, or OpenCode support this today. This approach has real advantages: zero infrastructure, works anywhere, easy to version in git, and great for individual productivity.

However, markdown-only implementations hit inherent limitations when scaling to teams and complex projects:

| Limitation | Why it happens | How this platform solves it |
|------------|----------------|----------------------------|
| **Traceability gaps** | Requirements live in `.md` files, code in repos, decisions in chat. Connections between them exist only in the developer's head and disappear between sessions. | Graph database with typed relationships. Every code file links back to its originating requirement automatically. |
| **Single-user by default** | Markdown files are local. Syncing them across a team requires manual git workflows. AI-DLC envisions Mob Elaboration and Mob Construction, but local files don't support simultaneous editing. | Real-time collaboration via WebSocket + CRDT. Multiple stakeholders work on the same artifacts simultaneously. |
| **Informal oversight** | No mechanism for an agent to formally block execution, present structured options, wait for a human decision, and resume with validated context. Oversight happens through unstructured chat. | Structured approval gates with Question nodes, predefined options, and mandatory ambiguity detection. |
| **Context loss between sessions** | Each AI session starts with a blank context window. Teams re-explain architecture decisions and previous work at every iteration because markdown files don't carry forward automatically. | Cross-sprint carry-forward imports design decisions and requirements from previous sprints automatically. |
| **Manual serial execution** | Local tools process tasks sequentially in a single session. Even when tasks have no dependencies, there is no mechanism to dispatch them in parallel. | Construction Orchestrator reads the dependency graph, identifies unblocked tasks, and dispatches parallel agents. |

These are not limitations of AI-DLC itself — the methodology is implementation-agnostic. They are limitations of using local markdown files as the backing store for any structured development process. Collaborative AI-DLC is one way to overcome them by moving from files to structured databases, from local to collaborative, and from single-agent to multi-agent orchestration.

## How it works in the platform

The [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) is embedded in the platform through agent rules. Each agent (Inception, Construction, Review) has a set of rule files that define how it should operate. These rules enforce the methodology's structure without requiring manual configuration.

The rules live in `lambda/agents-ecs/aidlc-rules/` and cover:

- How the Inception Agent generates user stories and decomposes work
- How the Construction Agent approaches implementation
- How the Review Agent evaluates output

As the open-source AI-DLC methodology evolves (including autonomous practice guidance), the platform inherits updates by adapting its steering files while preserving the graph-aware instructions that connect agents to the structured datastore.
