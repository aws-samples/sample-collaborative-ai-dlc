# Roadmap

!!! abstract "About this section"
    Where AIDLC Collaborative is today and where it is heading. This page lists what has been built, what is actively being worked on, and what is planned for future releases. Use it to understand the current capabilities and to see which features are coming next.

## Current status

AIDLC Collaborative has three of five pipeline stages working, with the fourth partially implemented.

| Stage | Status | Notes |
|-------|--------|-------|
| **Specify** | Working | Collaborative editor, LLM chat, comments, documents, methodologies, version history |
| **Decompose** | Working | Readiness checks, task DAG generation, GitHub issue sync, staleness detection |
| **Execute** | Working | Agent sessions, worktrees, cascade engine, terminal streaming, diff watching |
| **Review** | Working | Accept/reject with criteria, review iterations, structured feedback |
| **Operate** | Planned | Monitoring, alerting, feedback loops back to specs |

## What has been built

### Spec editing
- Real-time collaborative Markdown editor (Yjs + CodeMirror)
- LLM chat with methodology-aware system prompts
- Multi-document specs with file explorer
- Inline comments with threaded replies
- Version history
- Markdown and ZIP export

### Decomposition
- Structural and AI readiness checks before decompose
- LLM-generated task DAGs with dependencies and complexity
- Content hash-based caching (no duplicate LLM calls)
- Staleness detection when specs change
- Push tasks to GitHub as issues with labels and references

### Agent execution
- Claude CLI sessions via node-pty in isolated git worktrees
- Cascade engine for automatic task scheduling
- Live terminal streaming to the browser
- Real-time diff watching on worktree changes
- Structured comment injection to running agents

### Review
- Accept/reject with per-criterion evaluation
- Review iteration tracking
- Structured feedback injection on rejection
- Configurable review policies (manual, auto_commit, auto_pr)
- Task validation runner

### Infrastructure
- Multi-org, multi-project RBAC
- Provider-agnostic auth (Cognito with OIDC swappable)
- GitHub integration (OAuth, PAT, issue creation, status sync)
- Local and remote repo support
- Terraform for AWS deployment
- Docker containerization

## What is next

### Operate stage
- Post-deployment monitoring integration
- Error tracking and alerting
- Feedback loop from production incidents back to specs

### Memory system
- Cross-session memory for agents (similar to ABCA's approach)
- Repo knowledge persistence
- Review feedback extraction into reusable rules
- Task episode summaries for future context

### Validation pipeline
- Tiered validation (tool checks, code quality, risk analysis)
- PR risk classification
- Automated test execution in agent worktrees

### Agent improvements
- Multiple LLM provider support (direct Anthropic API, local models)
- Agent cost tracking and budget limits
- Turn limits and timeout configuration
- Agent self-feedback after task completion

### Platform features
- Notification system (Slack, email)
- Dashboard with project metrics
- Audit log for all actions
- Search across specs and tasks

### Scale
- PostgreSQL for production (replacing SQLite)
- Multi-node agent execution
- Queueing system for task scheduling
- Horizontal scaling for the WebSocket server
