# Coding Standards

## Language

TypeScript everywhere. Strict mode is enabled. Avoid `any`.

## Imports

Order: external modules, then internal packages (`@dev-workflow/*`), then relative imports. Use `import type` for type-only imports.

```typescript
import { eq } from "drizzle-orm";
import type { DbInstance } from "@dev-workflow/db";
import { createSpec } from "@dev-workflow/db";
import type { ResolvedPermission } from "./types";
```

The path alias `@/*` maps to `apps/spec-editor/src/*` in the Next.js app. Server files under `server/` use relative imports with `.js` extensions (ESM resolution).

## Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `chat-session.ts` |
| React components | PascalCase | `ChatPanel.tsx` |
| Functions | camelCase, verb-first | `createSpec`, `getSpecById` |
| Variables | camelCase | `specId`, `isLoading` |
| Refs | camelCase with `Ref` suffix | `wsRef`, `messagesEndRef` |
| Constants | UPPER_SNAKE_CASE | `DECOMPOSE_SYSTEM_PROMPT` |
| DB tables (JS) | camelCase | `specVersions` |
| DB tables (SQL) | snake_case | `spec_versions` |

## Types

Use `interface` for object shapes. Use `type` for unions and aliases.

```typescript
export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export type TaskStatus = "ready" | "blocked" | "in-progress" | "done";
```

Types live in dedicated files: `packages/auth/src/types.ts`, `apps/spec-editor/src/lib/types.ts`, `server/agent/types.ts`.

## Exports

Named exports everywhere. Barrel files (`index.ts`) re-export with `export *`. React components may use `export default`.

## Error handling

- API routes: `NextResponse.json({ error: "..." }, { status: N })`
- Auth: `withAuth()` handles 401/403 early returns
- Server: `try/catch` with `console.error`
- Client: `.catch()` with silent fallbacks

## React patterns

- All functional components
- `"use client"` directive on client components
- Local `useState` only (no global state library)
- Wrap event handler props in `useCallback`
- Use `useRef` for mutable values that should not trigger re-renders
- `memo()` for expensive components
- Tailwind CSS v4 for all styling (no inline styles, no CSS modules)

## Database patterns

- One schema file per table in `packages/db/src/schema/`
- One repository file per entity in `packages/db/src/repositories/`
- Repository functions are pure: first argument is always `db: DbInstance`
- UUIDs as text primary keys
- Timestamps as integers with `{ mode: "timestamp" }`
- Enums as text columns with `{ enum: [...] }`

## Commits

Conventional commits with optional scopes:

```
feat(db): add spec versioning
fix: resolve WebSocket reconnection issue
chore: update dependencies
refactor(auth): simplify permission resolution
test: add decompose task tests
docs: update getting started guide
```

## Unused variables

ESLint allows `_`-prefixed unused variables (`argsIgnorePattern: "^_"`). Use this for intentionally unused parameters:

```typescript
export const GET = withAuth(async (_request, context) => {
  // _request is unused but required by the handler signature
});
```
