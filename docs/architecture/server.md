# Server

The Express server (`apps/spec-editor/server/index.ts`) is the backend hub for all real-time features. It runs on port 3001 alongside the Next.js app on port 3000.

## Startup

When the server starts, it:

1. Creates the SQLite database and runs migrations
2. Initializes the LLM client
3. Cleans up stale workspaces from previous sessions
4. Detects local git repositories
5. Kills orphaned Claude CLI processes
6. Marks stale in-progress tasks as "error"
7. Schedules worktree garbage collection
8. Starts listening for HTTP and WebSocket connections

## WebSocket servers

The server runs three WebSocket servers on the same HTTP server, routed by URL path:

| Path | Server | Purpose |
|------|--------|---------|
| `/` (default) | Chat WSS | LLM chat, decompose, agent control |
| `/collab/{specId}/{documentId}` | Collab WSS | Yjs document synchronization |
| `/agent/{sessionId}/terminal` | Agent WSS | Agent terminal streaming |

All connections are authenticated via signed tickets in production. See [Authentication](../configuration/authentication.md).

## Chat WebSocket protocol

The chat WebSocket uses a JSON message protocol. Messages have a `type` field that determines how they are handled.

### Client to server messages

| Type | Description |
|------|-------------|
| `init` | Initialize workspace with repos and spec context |
| `message` | Send a chat message to the LLM |
| `add_repo` | Clone and add a repository to the workspace |
| `remove_repo` | Remove a repository from the workspace |
| `framework_change` | Methodology changed, reset chat |
| `readiness_check` | Run a readiness check on the spec |
| `decompose_start` | Start decomposing the spec into tasks |
| `decompose_start_override` | Start decompose, bypassing readiness |
| `decompose_reset` | Reset decompose state |
| `check_staleness` | Check if spec changed since last decompose |
| `create_issues` | Push tasks to GitHub as issues |
| `sync_issue_status` | Sync issue status from GitHub |
| `task_start` | Start an agent for a task |
| `task_stop` | Stop a running agent |
| `task_approve` | Approve a task in review |
| `task_reject` | Reject a task with feedback |
| `task_terminal_input` | Send input to a running agent |
| `task_comment` | Send a code comment to a running agent |
| `task_comments_batch` | Send multiple comments to a running agent |

### Server to client messages

| Type | Description |
|------|-------------|
| `status` | Status update (cloning, ready, error, thinking) |
| `text` | Streaming text from the LLM |
| `document_update` | LLM updated a document |
| `file_write` | LLM wrote a file |
| `done` | LLM finished responding |
| `repo_added` / `repo_removed` | Repo state change |
| `decompose_tasks` | Task list from decompose |
| `decompose_done` | Decompose completed |
| `decompose_stale` | Spec changed since last decompose |
| `readiness_result` / `readiness_text` | Readiness check results |
| `issues_created` | GitHub issues created |
| `issue_status_update` | GitHub issue status sync results |
| `task_status_update` | Agent task status changed |

## REST API

The server also exposes REST endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `GET /api/local-repo` | Get detected local git repo |
| `POST /api/local-repo/browse` | Open folder picker dialog |
| `POST /invalidate-llm` | Reset LLM client cache |
| `/api/agent/tasks/*` | Task management API for agents |

## Connection state

Each WebSocket connection maintains its own state:

- **Workspace** with cloned repos
- **Chat session** (LLM conversation)
- **Decompose session** (task generation)
- **Message history** for both chat and decompose
- **Spec and methodology IDs** for context

State is cleaned up when the connection closes. Workspaces are destroyed, sessions are aborted, and file watchers are stopped.
