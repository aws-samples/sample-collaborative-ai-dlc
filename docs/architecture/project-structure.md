# Project Structure

```text
aidlc-collaborative-workflow/
├── apps/
│   └── spec-editor/
│       ├── src/
│       │   ├── app/                  # Next.js App Router pages and API routes
│       │   │   ├── [orgSlug]/        # Org, project, and spec pages
│       │   │   ├── api/              # REST API route handlers
│       │   │   ├── auth/             # Auth callback and logout routes
│       │   │   └── login/            # Login page
│       │   ├── components/           # React components
│       │   │   └── decompose/        # Decompose-specific components
│       │   └── lib/                  # Shared utilities, types, API client
│       ├── server/                   # Express WebSocket server
│       │   ├── agent/                # Agent orchestration
│       │   ├── collab/               # Yjs collaboration server
│       │   └── git/                  # Git provider abstraction
│       ├── public/                   # Static assets
│       └── .env.local                # Environment variables (not committed)
├── packages/
│   ├── db/
│   │   ├── src/
│   │   │   ├── schema/              # Drizzle table definitions (one per table)
│   │   │   ├── repositories/        # CRUD functions (one per entity)
│   │   │   └── __tests__/           # Vitest tests
│   │   └── drizzle/                 # Generated migration SQL files
│   └── auth/
│       ├── src/
│       │   ├── providers/           # Auth provider implementations
│       │   ├── types.ts             # Auth interfaces and role types
│       │   ├── permissions.ts       # Permission resolution logic
│       │   └── ws-auth.ts           # WebSocket ticket signing/verification
│       └── __tests__/               # Vitest tests
├── infra/
│   └── terraform/                   # AWS infrastructure (ECS, CloudFront, etc.)
├── scripts/
│   └── seed-admin.ts               # Bootstrap first org and admin user
├── docs/
│   └── superpowers/
│       ├── specs/                   # Design specifications
│       └── plans/                   # Implementation plans
├── package.json                     # Root workspace config
├── CLAUDE.md                        # AI agent instructions
└── AGENTS.md                        # Guidelines for AI coding agents
```

## Key directories

### `src/app/api/`

Next.js App Router API routes. Each folder represents an endpoint. Route handlers export named HTTP methods (`GET`, `POST`, `PATCH`, `DELETE`) and are wrapped with `withAuth()`.

### `server/`

The Express server that runs alongside Next.js. It handles:

- Chat WebSocket (LLM interactions)
- Collab WebSocket (Yjs document sync)
- Agent WebSocket (terminal streaming)
- REST API for agent task management

### `server/agent/`

Agent orchestration code:

| File | Purpose |
|------|---------|
| `agent-session-manager.ts` | Manages active Claude CLI sessions |
| `cascade-engine.ts` | Auto-starts tasks when dependencies complete |
| `task-agent.ts` | Starts and stops agent sessions |
| `worktree-manager.ts` | Creates and cleans up git worktrees |
| `worktree-watcher.ts` | Watches worktrees for file changes |
| `review-policy.ts` | Executes review policies after agent completion |
| `validation-runner.ts` | Runs automated validation on agent output |
| `task-agent-prompt.ts` | Builds the prompt for task agents |
| `local-cli-session.ts` | Wraps Claude CLI in a pty session |
| `comment-formatter.ts` | Formats review comments for agent input |
| `diff-service.ts` | Computes diffs between branches |

### `server/collab/`

Yjs collaboration infrastructure:

| File | Purpose |
|------|---------|
| `setup.ts` | Sets up the Y-WebSocket server |
| `room.ts` | Manages collaboration rooms (one per document) |
| `persistence.ts` | Persists Yjs state to SQLite |
| `diff.ts` | Computes diffs for version history |
