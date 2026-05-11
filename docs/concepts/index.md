# Vision

Software development is increasingly a collaboration between humans and AI agents. But most tools treat agents as isolated code generators that receive a prompt and return code. They miss the bigger picture: how do you go from a business idea to production software when AI is involved? How do you keep traceability between what was intended and what was built? How do you prevent agents from losing context as scope grows?

AIDLC Collaborative answers these questions with an opinionated workflow built on principles that outlast any single tool or technology.

## Core principles

### Structured data as the backbone

Requirements, user stories, tasks, interactions (questions/answers between humans and agents), and code files live in a graph database. The link between what was intended and what was implemented is never lost. When a requirement changes, you can trace exactly what downstream work is affected.

**Why structured data instead of large context windows?** Traditional AI coding tools rely on feeding entire codebases into massive context windows (200k+ tokens) and letting transformer attention mechanisms find relevant connections. This works for small projects but breaks down at scale: context gets diluted, irrelevant information competes for attention, and the model loses track of what matters.

By storing artifacts in a structured database with explicit relationships (requirement → user story → task → code file → review comment), we give agents exactly the context they need — no more, no less. Token usage stays bounded and agents don't waste cycles exploring irrelevant code paths.

This also opens the door to supplementary approaches: vector databases for general codebase semantic search, while the graph database handles the structured relationships specific to the human/agent software development process (inception, construction, review, operation).

### Traceability

The graph database enables full traceability across the development lifecycle. Every artifact is connected:

- A business requirement links to the user stories that describe it
- User stories link to the tasks that implement them
- Tasks link to the code files produced
- Review comments link back to the requirements they evaluate

This means you can answer questions like: "Which code implements requirement X?", "What requirements are affected if I change this module?", "Who approved this change and when?"

Beyond the graph, the NoSQL layer (DynamoDB) tracks operational state: task status, agent execution history, ownership, timestamps. Together, they give humans complete visibility into what happened, why, and by whom — human or agent.

### Human observability

The workflow has clear phases where humans approve, redirect, or refine. But observability is more than just approval gates.

**The key insight:** abstract away the noise of each agent's raw output and surface only the high-level, business-relevant information. An agent might produce thousands of lines of terminal output, dozens of file changes, and multiple intermediate reasoning steps. The human reviewer doesn't need all of that. They need: "What was built? Does it meet the requirements? What are the risks?"

This is fundamentally about respecting the human's "context window" — their brain has limited bandwidth too. The platform structures agent output into digestible summaries, structured reviews, and clear pass/fail decisions so humans can make informed judgments without drowning in noise.

### Real-time collaboration

Most AI coding tools today are local and individual. They excel at personal productivity: a developer and an AI pair-programming in a single IDE. But enterprise software development is inherently collaborative. Teams need:

- Shared state that everyone can see and edit simultaneously
- Multiple agents working on different tasks in parallel
- Visibility into what others (humans and agents) are doing
- No manual syncing of markdown files, skill configs, or local state

AIDLC Collaborative is collaborative-first. Specs, requirements, and tasks are edited in real time via Yjs CRDT. Multiple agents execute concurrently. All state lives in shared infrastructure, not on individual machines.

### Tool-agnostic architecture

The platform is not locked into any single technology. We integrate what works best for each module:

- **Agent compute:** Currently ECS Fargate containers on AWS. Could be [Bedrock AgentCore](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/) or other serverless agent runtimes.
- **Structured data:** Currently Neptune (graph DB) + DynamoDB. Could be other graph engines (Neo4j, etc.) or supplemented with vector databases for semantic search.
- **Agent tooling:** Integrates with Claude Code, OpenCode, Kiro, and other adopted tools rather than replacing them.
- **Source control:** GitHub today, with GitLab and other providers on the roadmap.

The important thing is the *concept* at each layer — structured data, traceability, collaboration, observability — not the specific implementation. Tools evolve fast; these principles don't.

## The lifecycle

The platform implements a three-phase lifecycle organized around **sprints**:

```mermaid
graph LR
  INCEPTION --> CONSTRUCTION --> REVIEW
  REVIEW -. refinement .-> CONSTRUCTION
```

Each phase has a clear purpose:

| Phase | Purpose | Output |
|-------|---------|--------|
| **Inception** | Define what to build, remove ambiguity | Requirements, user stories, and tasks |
| **Construction** | Build it | Code changes in a branch |
| **Review** | Evaluate the result | Approval or feedback for another iteration |

A sprint moves through these phases sequentially. The Review phase can send work back to Construction with structured feedback, creating an iterative improvement loop until the result meets expectations.

## Sprints

A sprint is one iteration of the [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows). It groups a set of requirements, user stories, and tasks under a single lifecycle.

You can think of a sprint as one feature, one issue, or one project scope. It can vary in size — the methodology automatically adapts the number of units of work (tasks) depending on the scope. A small bug fix might produce 2-3 tasks; a greenfield project might produce 30+.

Each sprint tracks:

- Its current phase (Inception, Construction, or Review)
- The project description that scopes the work
- Git branch information for code changes
- Agent execution state
- Review history and iterations

You start a sprint by writing a description, then launch the Inception Agent to break it down into structured artifacts.

## Current status

| Phase | Status |
|-------|--------|
| Inception | Working |
| Construction | Working |
| Review | Working |

Read about each phase in detail:

- [Inception](inception.md)
- [Construction](construction.md)
- [Review](review.md)
