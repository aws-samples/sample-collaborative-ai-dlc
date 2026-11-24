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

Factories return native `queryOptions`, not a second options format. The same factory works for a screen, an imperative read, and a prefetch:

```tsx
const detail = useQuery(intentDetailQuery(projectId, intentId));
await queryClient.fetchQuery(intentDetailQuery(projectId, intentId));
await queryClient.prefetchQuery(intentDetailQuery(projectId, intentId));
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

The client does not retry 401, 403, 404, or 410 responses; other failures retry once. A 403, 404, or 410 also drops the stored value, so a screen never shows data the user lost access to. Genuine session expiry is detected by the authenticated API client. Prefetch failures are speculative and must not interrupt navigation.

## Session isolation

`AuthContext` binds accepted users through `lib/persistentCache.ts` and ends that binding on logout, user switch, or expiry. The query client clears when the session ends, cancelling old queries as well as discarding their data, and `querySessionOpen` stays false until a user is bound again. The prefetch scheduler drops queued work at the same boundary.

The existing document-reload boundary remains: signing in after a session ended, or switching users, starts a new document rather than reusing the old user's modules. The persisted sidebar summary is scoped to the user and cleared at session end.

## Invalidation rules

Domain writes go through `afterWrite(write, ...prefixes)` (`lib/afterWrite.ts`): once the write settles it invalidates each prefix and supersedes reads that started before it (cancelled and restarted, so their waiters get post-write data). Active queries refetch; inactive queries remain stale until needed.

- Workflow writes invalidate the workflow prefix and workflow list. The prefix covers compiled views.
- Successful intent lifecycle writes invalidate the space's intent lists, including status-filtered lists, and re-read the spaces cache (`useProjectsCache`) that the sidebar and dashboard still read outside the query cache.

`afterWrite` refreshes in `finally`: a failed response can still follow an applied write. Intent lifecycle writes refresh only on success. Keep this decision in the service so every caller uses the same policy.

## Prefetch

### Route registry

`routes/registry.ts` defines the authenticated shell routes. Each entry owns its lazy page, optional access requirement, critical query factories, dependent queries, and heavy-read policy. The page and its prefetch must use the same factory and key.

`lib/navIntent.ts` delegates hover, focus, pointer-down, and touch handling. Hover/focus waits for a cancellable 200 ms dwell; pressing warms immediately. Repeats are deduplicated by query freshness and in-flight sharing, not by a per-link cooldown. External, disabled, download, and opted-out links are ignored. Heavy routes (the graph, an intent whose cached detail exceeds 512 KiB) load code on hover and data only when navigation is imminent. Route chunks use `lazyWithPreload` so render and warming share the same import.

### Budgets and gates

`lib/prefetch.ts` adds scheduling around native `queryClient.prefetchQuery`:

- At most **two requests** run and **eight tasks** wait. Intent-priority work precedes idle work; a full queue drops speculation, never foreground requests.
- Save-Data, 2g/slow-2g, reduced-data preference, and a closed session suppress speculative data reads. Pressing may still load code.
- Hidden tabs do not dispatch speculative work. Idle warming also avoids devices reporting 2 GB of memory or less.
- Idle work waits for foreground fetching to go quiet; hover and press warming do not.
- Navigation drops obsolete queued tasks and cancels inactive requests the destination does not need. Requests already observed by a screen are not cancelled as speculation.

There is no parallel speculative data store, learned-byte estimator, per-link cooldown, hit/waste registry, or token-bucket API. Prefetched data uses the same native cache and inactive memory cap as other reads.

The intent detail query starts its compiled view as soon as a detail a page is reading arrives; a speculative detail leaves the compile to the route prefetch. The provider reads the shared detail, compiled, and workflow-detail (`select` phases) queries; it keeps only the transcript and artifact-body merge state of its own.

Never prefetch capability probes (they are cached foreground reads), composer execution previews (cached, foreground only), OAuth callbacks, verification endpoints, writes, realtime tokens, output transcripts, artifact content pages, or the slow on-demand space-usage aggregate. Graph and audit reads are not idle-warming candidates.

## Polling

Use `refetchInterval` on the query that owns the data. Leave `refetchIntervalInBackground` false so TanStack pauses background polling. The interval may depend on query state: live intent detail uses 8 seconds, waiting intents 30 seconds, and terminal intents stop polling. Realtime invalidation remains the primary update path; polling recovers dropped events.

`useVisiblePoll` is reserved for non-query work such as catching up and merging independently paginated visible transcript panes. Do not introduce another timer for an ordinary query refresh.

A component that renders a transcript pane declares it with `useVisibleOutputPanes` for as long as it is mounted: declared panes keep catching up and are never evicted, and each declaration is counted, so one viewer leaving does not hide a pane another still shows. When the size cap drops older rows, the transcript says so.

## Reading without retaining

`useQueryData(key)` uses `useSyncExternalStore`, a `QueryCache` subscription, and `getQueryData`. It does not create a query or an observer, fetch data, or extend retention. Use it for small status views that should update when data arrives without keeping it in memory.

## Checklist for changes

- Add request-shaped keys to `qk` and a shared `queryOptions` factory. Forward `signal`; choose `staleTime` and `gcTime` deliberately.
- Read with `useQuery`, or `fetchQuery` when an imperative caller needs the result. Use `useQueryData` only for non-retaining views.
- Invalidate affected prefixes in services; cancel superseded reads before authoritative cache writes.
- Register routes and their query factories once. Use normal links or `data-prefetch-href` instead of per-row hover timers.
- Use `src/test/query.tsx` for query-owning component and hook tests. Setup creates a fresh client per test. Test application policies and request wiring rather than reimplementing TanStack's tests.
