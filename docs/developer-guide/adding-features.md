# Adding Features

This guide shows where to put new code depending on what you are building.

## Adding a new database table

1. Create a schema file in `packages/db/src/schema/your-table.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const yourTable = sqliteTable("your_table", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

2. Export it from `packages/db/src/schema/index.ts`

3. Create a repository file in `packages/db/src/repositories/your-entity.ts`:

```typescript
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { DbInstance } from "../connection";
import { yourTable } from "../schema/your-table";

export async function createYourEntity(db: DbInstance, data: { name: string }) {
  const id = uuidv4();
  const now = new Date();
  await db.insert(yourTable).values({ id, name: data.name, createdAt: now });
  return { id, name: data.name, createdAt: now };
}
```

4. Export it from `packages/db/src/repositories/index.ts`

5. Write tests in `packages/db/src/__tests__/your-entity.test.ts`

6. Generate a migration: `npm run db:generate -w packages/db`

## Adding a new API route

Create a route file in `apps/spec-editor/src/app/api/your-resource/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { db } from "@/app/api/db";
import { createYourEntity } from "@dev-workflow/db";

export const POST = withAuth(async (request) => {
  const body = await request.json();
  const entity = await createYourEntity(db, body);
  return NextResponse.json(entity, { status: 201 });
});

export const GET = withAuth(async () => {
  // ...
  return NextResponse.json(results);
});
```

## Adding a new React component

Create the component in `apps/spec-editor/src/components/`:

- Use PascalCase for the filename: `YourComponent.tsx`
- Add `"use client"` directive for client components
- Use Tailwind CSS for styling
- Use `interface` for props

```typescript
"use client";

interface YourComponentProps {
  title: string;
  onSave: (value: string) => void;
}

export default function YourComponent({ title, onSave }: YourComponentProps) {
  // ...
}
```

## Adding a new WebSocket message

1. Add the message type to `server/index.ts` (both client and server types)
2. Add a handler function
3. Add a case to the `switch` statement in the WebSocket message handler
4. Update the client-side WebSocket handling in the relevant React component

## Adding a new page

Create the page in `apps/spec-editor/src/app/` following the Next.js App Router conventions:

```
src/app/[orgSlug]/your-page/page.tsx
```

Read `apps/spec-editor/AGENTS.md` and the Next.js 16 docs before writing page code, as there are breaking changes from earlier versions.
