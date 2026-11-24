# Frontend data layer

The browser uses **TanStack Query v5** for REST data. `lib/queryClient.ts` exports the application client; `main.tsx` supplies that instance through `QueryClientProvider`. TanStack owns request sharing, query state, cancellation, freshness, observers, and garbage collection. There is no application cache adapter.

Application WebSocket events and Yjs document sync remain separate transports. A WebSocket event can invalidate a query; realtime frames are not stored as query results. See the [architecture overview](architecture.md).

## Query cache

### Keys

Use the factories in `lib/queryKeys.ts` (`qk`) for hierarchical, request-shaped keys:

- Space reads live under `['project', projectId, …]`.
- Intent detail lives under `['intent', projectId, intentId, …]`.
- Workflow detail and compilation live under `['workflow', workflowId, …]`.

Include every parameter that changes the response. In particular, compiled-workflow keys include the version, release, importer revision, and intent-specific pin. A shared prefix permits targeted invalidation without merging distinct responses.

### React binding

Factories return native `queryOptions`, not a second options format. The same factory works for a screen and an imperative read:

```tsx
const detail = useQuery(intentDetailQuery(projectId, intentId));
await queryClient.fetchQuery(intentDetailQuery(projectId, intentId));
```

`lib/authoringQueries.ts` and `lib/intentEntry.ts` own the shared descriptors. Each query function passes TanStack's `signal` to the transport. Keep HTTP calls in the domain service or authenticated API client; do not call a cache-backed service recursively from its own query function.

Use native result fields: `data`, `error`, `isPending`, `isFetching`, `isPlaceholderData`, `dataUpdatedAt`, and `refetch`.

Use `placeholderData` for an observer-local preview, not `setQueryData` or `initialData` for incomplete server records.

### Freshness and retention

| Policy                         | Value                         |
| ------------------------------ | ----------------------------- |
| Default `staleTime`            | 30 seconds                    |
| Default inactive `gcTime`      | 60 seconds                    |
| Inactive memory cap            | 150 queries and roughly 8 MiB |
| Cap after 60 seconds hidden    | 50 queries and roughly 2 MiB  |
| Automatic window-focus refetch | Disabled by default           |

`staleTime` is a freshness window, not a polling interval. `gcTime` is TanStack's inactive retention timer; when consumers configure different retention for the same key, the longest applies.

A small `QueryCache` subscriber additionally bounds unused data by count and approximate serialized size. It evicts the least recently used queries with **no observers and no request in flight**, where use means a data change or an observer subscribing or leaving (a fresh `fetchQuery` hit does not count); it never evicts a screen's observed data. A visibility timer tightens the cap after 60 seconds hidden. Size is measured when a stored value changes and is an estimate, not an exact measurement of heap usage.

### Request sharing and cancellation

TanStack shares in-flight requests for the same key. Passing its `AbortSignal` to the HTTP client enables transport cancellation. An authoritative write must not race an older read; cancel that read before installing the write result:

```ts
await queryClient.cancelQueries({ queryKey, exact: true });
queryClient.setQueryData(queryKey, savedValue);
```

### Errors

The client does not retry 401, 403, 404, or 410 responses; other failures retry once. A 403, 404, or 410 also drops the stored value, so a screen never shows data the user lost access to. Genuine session expiry is detected by the authenticated API client.

## Session isolation

`AuthContext` binds accepted users through `lib/persistentCache.ts` and ends that binding on logout, user switch, or expiry. The query client clears when the session ends, cancelling old queries as well as discarding their data, and `querySessionOpen` stays false until a user is bound again.

The existing document-reload boundary remains: signing in after a session ended, or switching users, starts a new document rather than reusing the old user's modules. The persisted sidebar summary is scoped to the user and cleared at session end.

## Invalidation rules

Domain writes go through `afterWrite(write, ...prefixes)` (`lib/afterWrite.ts`): once the write settles it invalidates each prefix and supersedes reads that started before it (cancelled and restarted, so their waiters get post-write data). Active queries refetch; inactive queries remain stale until needed.

- Workflow writes invalidate the workflow prefix and workflow list. The prefix covers compiled views.
- Successful intent lifecycle writes invalidate the space's intent lists, including status-filtered lists.

`afterWrite` refreshes in `finally`: a failed response can still follow an applied write. Intent lifecycle writes refresh only on success. Keep this decision in the service so every caller uses the same policy.

## Polling

Use `refetchInterval` on the query that owns the data. Leave `refetchIntervalInBackground` false so TanStack pauses background polling. The interval may depend on query state: live intent detail uses 8 seconds, waiting intents 30 seconds, and terminal intents stop polling. Realtime invalidation remains the primary update path; polling recovers dropped events.

`useVisiblePoll` is reserved for non-query work such as catching up and merging independently paginated visible transcript panes. Do not introduce another timer for an ordinary query refresh.

## Reading without retaining

`useQueryData(key)` uses `useSyncExternalStore`, a `QueryCache` subscription, and `getQueryData`. It does not create a query or an observer, fetch data, or extend retention. Use it for small status views that should update when data arrives without keeping it in memory.

## Checklist for changes

- Add request-shaped keys to `qk` and a shared `queryOptions` factory. Forward `signal`; choose `staleTime` and `gcTime` deliberately.
- Read with `useQuery`, or `fetchQuery` when an imperative caller needs the result. Use `useQueryData` only for non-retaining views.
- Invalidate affected prefixes in services; cancel superseded reads before authoritative cache writes.
- Use `src/test/query.tsx` for query-owning component and hook tests. Setup creates a fresh client per test. Test application policies and request wiring rather than reimplementing TanStack's tests.
