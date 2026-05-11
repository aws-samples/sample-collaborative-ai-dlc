# Roadmap

Where AIDLC Collaborative is today and where it is heading.

## Current status

| Phase | Status | Notes |
|-------|--------|-------|
| **Inception** | Working | Inception Agent, requirements, user stories, tasks, Q&A, collaborative editing |
| **Construction** | Working | Construction Agent, ECS workers, code file tracking, real-time status, parallel dispatch |
| **Review** | Working | Blind and full review agents, modify agent, manual comments, pass/fail |

## What has been built

### Inception
- Free-form project descriptions as input (greenfield and brownfield)
- Inception Agent that generates requirements, user stories, and tasks
- Structured Q&A for clarifying ambiguities with mandatory ambiguity detection
- Real-time collaborative editing of all artifacts (Yjs CRDT)
- Graph-based traceability between requirements, stories, and tasks

### Construction
- Construction Orchestrator with parallel task dispatch
- Multiple agents working simultaneously on independent tasks (up to `maxParallelAgents`)
- Code file artifact tracking (path, commit, summary)
- Follow-up questions during implementation
- Real-time agent status streaming via WebSocket
- Automatic PR creation on completion

### Review
- Blind Review Agent (evaluates without file details)
- Full Review Agent (evaluates with complete context)
- Risk scores and structured comments
- Manual comments on both review types
- Modify Agent for iterative refinement
- Pass/fail decision workflow

### Infrastructure
- Multi-org, multi-project RBAC
- AWS Cognito authentication
- GitHub integration (OAuth, issue creation, status sync)
- Neptune graph database for traceability
- DynamoDB for operational state
- Cross-sprint knowledge carry-forward
- Terraform for full AWS deployment

## What is next

### Operate stage
- Post-deployment monitoring integration
- Error tracking and alerting
- Feedback loop from production incidents back to specs
- CI/CD pipeline integration

### Agent improvements
- Agent cost tracking and budget limits
- Agent self-feedback after task completion
- Review feedback extraction into reusable rules
- Deeper brownfield support with semantic codebase indexing

### Platform features
- Notification system
- Dashboard with project metrics and traceability reports
- Audit log for all actions
- Search across sprints and artifacts
- Orphaned work detection (tasks without requirement justification)
- Incomplete implementation detection (requirements without code)

### Native integrations
- **Atlassian** (Jira, Confluence) — sync requirements and tasks bidirectionally
- **GitLab** — full Git integration parity with GitHub support
- **Other enterprise tools** — based on user and customer demand

### Alternative compute and data surfaces
- **[Bedrock AgentCore](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/)** as an alternative agent runtime
- **Vector databases** for semantic codebase search (complementing the graph for backward traceability: code → purpose)
- **Alternative graph engines** — the platform is not locked to Neptune; any graph DB that models the AI-DLC hierarchy works

### Tooling evolution
- Continued integration with tools adopted by users: Claude Code, OpenCode, Kiro, and emerging AI coding tools
- The platform remains tool-agnostic — we integrate what works best for each module
