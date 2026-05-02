# Database

AIDLC Collaborative uses SQLite for local development and plans to use PostgreSQL (Amazon RDS) for production.

## SQLite setup

The database is created automatically on first server start. No manual setup is needed.

The default location is `dev-workflow.db` in the current working directory. You can change this with the `DATA_DIR` environment variable.

## Schema management

The database schema is managed with **Drizzle ORM**. Schema files live in `packages/db/src/schema/`, one file per table.

### Push schema changes

During development, push schema changes directly to the database:

```bash
npm run db:push -w packages/db
```

Note: This updates the database at `packages/db/dev-workflow.db`. The app uses `apps/spec-editor/dev-workflow.db` (relative to where the server runs). For local dev, either run Drizzle from the spec-editor directory or apply changes directly.

### Generate migrations

For production-style migrations:

```bash
npm run db:generate -w packages/db   # Generate migration SQL
npm run db:migrate -w packages/db    # Run migrations
```

Migrations are stored in `packages/db/drizzle/` as numbered SQL files.

## Tables

The database has 29 tables organized by domain:

### Core

| Table | Purpose |
|-------|---------|
| `orgs` | Organizations |
| `projects` | Projects within organizations |
| `users` | User accounts |
| `org_members` | Organization membership and roles |
| `project_members` | Project membership and roles |
| `settings` | Application settings (key-value) |

### Specs

| Table | Purpose |
|-------|---------|
| `specs` | Spec definitions |
| `spec_versions` | Version history for specs |
| `documents` | Documents (files) within a spec |
| `virtual_files` | Generated files |
| `comments` | Comments on spec text |
| `replies` | Replies to comments |
| `chat_messages` | Chat history for specs |

### Decompose

| Table | Purpose |
|-------|---------|
| `decomposes` | Decompose runs |
| `decompose_tasks` | Tasks within a decompose |
| `decompose_task_repos` | Task-to-repo assignments with branch names |
| `readiness_reports` | Readiness check results |
| `task_reviews` | Review records for tasks |

### Git

| Table | Purpose |
|-------|---------|
| `repos` | Registered repositories |
| `spec_repos` | Spec-to-repo associations with branch patterns |
| `git_connections` | OAuth connections to git providers |

### Methodologies

| Table | Purpose |
|-------|---------|
| `methodologies` | Methodology definitions |
| `methodology_files` | Files within a methodology |
| `methodology_versions` | Published methodology versions |
| `methodology_version_files` | Files frozen in a version snapshot |
| `methodology_sessions` | Chat sessions for methodology editing |
| `methodology_chat_messages` | Chat history for methodologies |
| `methodology_comments` | Comments on methodology files |

## Backup

SQLite databases can be backed up by copying the `.db` file. Make sure the server is stopped or use SQLite's backup API to avoid corruption.

For production, use PostgreSQL with automated backups via RDS.
