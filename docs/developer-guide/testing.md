# Testing

AIDLC Collaborative uses **Vitest** for all tests. Tests exist for the `packages/db` and `packages/auth` packages. There are no frontend component tests.

## Running tests

```bash
# All db tests
npm test -w packages/db

# All auth tests
npm test -w packages/auth

# Watch mode
npm run test:watch -w packages/db

# Single file
npx vitest run __tests__/repositories/specs.test.ts --dir packages/db

# Single test by name
npx vitest run -t "creates a spec" --dir packages/db
```

## Test patterns

### Database tests

Database tests use `createTestDb()` which creates an in-memory SQLite database with the full schema applied. Each test gets a fresh database:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, createSpec, getSpecById } from "@dev-workflow/db";
import type { DbInstance } from "@dev-workflow/db";

describe("specs", () => {
  let db: DbInstance;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a spec", async () => {
    const spec = await createSpec(db, {
      title: "Test Spec",
      projectId: "project-1",
    });
    expect(spec.title).toBe("Test Spec");
  });
});
```

Key points:

- No mocking. Tests run against real SQLite.
- Each test is fully isolated (fresh in-memory database).
- Repository functions are pure (`db` as first argument), making them easy to test.

### Auth tests

Auth tests follow the same pattern with `createTestDb()` for permission resolution tests, and mock JWTs for token verification tests.

## Assertions

The codebase uses these Vitest matchers:

- `toBe()` for primitives
- `toEqual()` for objects and arrays
- `toHaveLength()` for arrays
- `toBeUndefined()` for missing values

No snapshot tests.

## Test file locations

| Package | Test directory |
|---------|---------------|
| `packages/db` | `src/__tests__/*.test.ts` and `__tests__/*.test.ts` |
| `packages/auth` | `__tests__/*.test.ts` |

## Writing new tests

1. Create a `.test.ts` file in the appropriate `__tests__/` directory
2. Use `describe` for the module and flat `it` blocks (no deep nesting)
3. Use `createTestDb()` in `beforeEach` for database tests
4. Run the test to make sure it passes before committing
