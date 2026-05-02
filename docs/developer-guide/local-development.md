# Local Development

## Starting the dev server

```bash
npm run dev
```

This runs two processes concurrently:

- **Next.js** (`next dev`) on port 3000 with hot module replacement
- **Express server** (`tsx watch server/index.ts`) on port 3001 with file watching

The Express server auto-reloads when you change files in `server/`. Next.js handles its own hot reload for frontend changes.

## Environment

Copy the example env file if you have not already:

```bash
cp apps/spec-editor/.env.local.example apps/spec-editor/.env.local
```

The Express server loads `.env.local` automatically via `set -a && . ./.env.local`.

## Database

The SQLite database is created automatically at `apps/spec-editor/dev-workflow.db` on first run. To reset it, delete the file and restart the server.

To apply schema changes during development:

```bash
npm run db:push -w packages/db
```

Note the [gotcha](../configuration/database.md): `db:push` writes to `packages/db/dev-workflow.db`, not the app's database. For local dev, either copy the file or run ALTER statements directly.

## Type checking

```bash
npx tsc --noEmit -p apps/spec-editor/tsconfig.json
```

This checks the entire spec-editor app including the server code.

## Linting

```bash
npm run lint -w apps/spec-editor
```

ESLint v9 with flat config. Only configured for `apps/spec-editor/`. The `packages/` directories do not have lint configs.

## Running everything before a commit

Use the verify skill to run lint, type-check, and tests in one step:

```bash
npm run lint -w apps/spec-editor && \
npx tsc --noEmit -p apps/spec-editor/tsconfig.json && \
npm test -w packages/db && \
npm test -w packages/auth
```

## Debugging the server

The Express server runs via `tsx`, which supports Node.js debugging. To attach a debugger:

1. Modify the dev:server script to add `--inspect`:

```json
"dev:server": "sh -c 'test -f ./.env.local && set -a && . ./.env.local && set +a; tsx --inspect watch server/index.ts'"
```

2. Attach your IDE's Node.js debugger to port 9229.

## Working with WebSockets

Use browser DevTools to inspect WebSocket traffic:

1. Open DevTools > Network > WS tab
2. Filter by `localhost:3001`
3. Choose a connection to see messages in both directions

The chat WebSocket messages are JSON objects with a `type` field. See [Server](../architecture/server.md) for the full protocol.
