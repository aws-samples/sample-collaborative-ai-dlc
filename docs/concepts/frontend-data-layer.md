# Frontend data layer

This page explains how the browser loads, keeps, and refreshes data from the REST API.

The browser uses **TanStack Query v5** for REST data. `lib/queryClient.ts` creates the one shared client, and `main.tsx` passes it to the app through `QueryClientProvider`. TanStack Query does the hard parts for us: it shares identical requests, tracks loading and error state, cancels requests, decides when data is out of date, and frees data nobody uses. We do not add our own cache layer on top.

The two WebSocket connections are separate from this. Application events (agent progress, notifications) can tell the cache that some data changed, but the cache never stores the events themselves. Yjs document sync does not go through the cache at all. See the [architecture overview](architecture.md).

## Query cache

In TanStack Query, a _query_ is one piece of server data, stored under a _key_. Every screen that asks for the same key gets the same stored data and the same request.

### Keys

Build keys with the helpers in `lib/queryKeys.ts` (`qk`). Keys are arrays that go from general to specific:

- Platform-wide lists start with their own name, such as `['projects']` or `['agents', 'settings']`.
- Space data starts with `['project', projectId, …]`.
- Intent detail starts with `['intent', projectId, intentId, …]`.
- Workflow detail and compiled workflows start with `['workflow', workflowId, …]`.

Put every parameter that changes the response into the key. For example, a compiled-workflow key includes the version, the release, the importer revision, and the version an intent is pinned to. Two different responses must never share a key. Because related keys share a start, one call can refresh all of them, for example everything under one workflow.

### Using a query in React

Each helper returns a standard TanStack `queryOptions` object. The same helper works in a component, in code that needs the result once, and for loading data ahead of time:

```tsx
const detail = useQuery(intentDetailQuery(projectId, intentId));
await queryClient.fetchQuery(intentDetailQuery(projectId, intentId));
await queryClient.prefetchQuery(intentDetailQuery(projectId, intentId));
```

The shared helpers live in `lib/settingsQueries.ts`, `lib/authoringQueries.ts`, and `lib/intentEntry.ts`. Each one passes TanStack's `signal` to the HTTP call, so the request can be cancelled. HTTP calls stay in the domain service or the authenticated API client. A query must not call a service that itself reads through the same cache.

Read the standard result fields: `data`, `error`, `isPending`, `isFetching`, `isPlaceholderData`, `dataUpdatedAt`, and `refetch`.

To show a preview while the real data loads (for example a row from a list), use `placeholderData`. Do not write partial server records into the cache with `setQueryData` or `initialData`.

### How long data is kept

| Setting                                          | Value                    |
| ------------------------------------------------ | ------------------------ |
| Data counts as fresh for (`staleTime`)           | 30 seconds               |
| Unused data is freed after (`gcTime`)            | 60 seconds               |
| Most unused data kept                            | 150 queries, about 8 MiB |
| Most unused data kept after 60 s in a hidden tab | 50 queries, about 2 MiB  |
| Reload when the window gets focus                | Off by default           |

Fresh data is used as is; older data is reloaded the next time a screen needs it. `staleTime` is not a polling interval: nothing reloads just because time passed. "Unused" means no mounted component is reading the data. If two readers ask for different `gcTime` values for the same key, the longest one wins.

On top of that, a small listener in `queryClient.ts` limits how much unused data stays in memory, by count and by approximate size. When the limit is reached it removes the data that was used least recently. It only removes data that no screen is reading and that has no request running, so it never takes data away from a screen. Data counts as used when it changes or when a component starts or stops reading it; a `fetchQuery` that is answered from the cache does not count. The limit gets tighter after the tab has been hidden for 60 seconds. Size is an estimate taken when the data changes, not an exact memory measurement.

### Shared requests and cancellation

If two readers ask for the same key at once, TanStack sends one request. Passing its `AbortSignal` to the HTTP client lets that request be cancelled. When a save returns the new value, an older read that is still running could finish later and overwrite it. Cancel that read before storing the saved value:

```ts
await queryClient.cancelQueries({ queryKey, exact: true });
queryClient.setQueryData(queryKey, savedValue);
```

### Errors

A 401, 403, 404, or 410 response is not retried; any other failure is retried once. A 403, 404, or 410 also removes the stored data, so a screen never keeps showing data the user can no longer see. The authenticated API client decides when the session has really expired. A failed load-ahead (see [Loading data before a click](#loading-data-before-a-click)) is ignored and never blocks navigation.

## Signing out and switching users

`AuthContext` registers the signed-in user through `lib/persistentCache.ts` and ends that registration on logout, on a user switch, or when the session expires. At that moment the query client is cleared: running requests are cancelled and all stored data is dropped. `querySessionOpen` stays false until a user signs in again. Loads that were waiting to start ahead of time are dropped too.

Signing in after a session ended, or switching users, still reloads the whole page, so no code or memory from the previous user is reused. The sidebar summary saved in the browser belongs to one user and is cleared when the session ends.

## Refreshing data after a save

Saves go through `afterWrite(write, ...prefixes)` in `lib/afterWrite.ts`. When the save finishes, it marks every key under each given prefix as out of date. It also restarts any read of those keys that started before the save, so whoever waits on that read gets the data after the save. Data a screen is showing reloads at once; other data reloads the next time it is needed.

- Workflow saves refresh the workflow's keys (including its compiled views) and the workflow list.
- Agent settings and credential saves refresh the settings and credential views they change.
- Successful intent changes (create, cancel, delete, and so on) refresh the space's intent lists, including the lists filtered by status. The spaces view behind the sidebar, the dashboard, and the command palette shows those lists without reloading them on its own, so it re-reads a list it shows as soon as that list is marked out of date.
- Deleting an intent removes all of that intent's data from the cache.

`afterWrite` refreshes even when the save fails, because the server may have applied the change before the error. Intent changes refresh only when they succeed. Keep this choice in the service, so every caller follows the same rule.

## Loading data before a click

When the user is about to open a page, the app starts loading that page's code and data early. By the time the click lands, much of it is already there. This is called _prefetching_.

### Which data a page needs

`routes/registry.ts` lists the pages inside the signed-in app. For each page it says:

- which code to load (the page is split into its own file and loaded on demand);
- who may open it (for example platform admins only);
- the data the page needs first, and data that can only be loaded once that first data is known;
- whether the page is _heavy_ (large data, see below);
- the pages the user is likely to open next from it.

The page and its prefetch use the same query helper, so they share one key and one request.

### When loading starts

`lib/navIntent.ts` watches the whole document instead of adding a handler to every link. It reacts as follows:

- **Pointer rests on a link, or the link gets keyboard focus:** it waits 200 ms, then starts loading. Moving away within those 200 ms cancels it, so sweeping the mouse across a menu loads nothing.
- **Mouse button or finger goes down on a link:** it starts at once, because the click is about to happen.
- **Ignored:** links to other sites, links that open in another tab, downloads, disabled links, and links inside an element marked `data-prefetch="none"`.

Hovering the same link again does not send the request again: data that is still fresh, or a request that is still running, is reused.

The intent graph and very large intents (cached detail over 512 KiB) are heavy. For them, hovering only loads the page's code; the data waits until the button goes down. Page code is loaded with `lazyWithPreload`, so showing the page and loading it early use the same download.

### Limits

`lib/prefetch.ts` decides when early loads may run, around TanStack's own `queryClient.prefetchQuery`:

- At most **two** early loads run at once, and at most **eight** wait. Loads for a link the user is pointing at go before loads started when the browser is idle. When the queue is full, the last waiting load is dropped. Requests a screen makes itself are never limited or dropped.
- No early data loads when the browser asks to save data, on a 2G connection, when the user prefers reduced data, or when nobody is signed in. Pressing a link may still load its code.
- Nothing starts while the tab is hidden. Idle loading is also skipped on devices that report 2 GB of memory or less.
- Idle loading waits until the current page has finished its own requests. Hover and press loading do not wait.
- When the user navigates, waiting loads for other pages are dropped. Running early loads that the new page does not need are cancelled. A request a screen is already reading is never cancelled.

Early-loaded data goes into the same cache, under the same memory limit, as any other data. There is no separate store for it.

### Loading the likely next page

`useIdleNext` waits until the current page has its first data. Then, while the browser is idle, it loads the pages the user is likely to open next and the rows the sidebar offers.

The intent detail query starts loading the compiled workflow as soon as the detail arrives for a page that shows it. When the detail was only loaded early, the page's prefetch loads the compiled workflow itself. The intent page reads the shared detail, compiled workflow, and workflow detail queries; it only keeps the live transcript and artifact text of its own.

Never load these early:

- capability checks and composer previews of how a workflow will run (the page asks for these itself, when it needs them);
- OAuth callbacks and verification links;
- saves of any kind;
- realtime tokens;
- agent transcripts and pages of artifact content;
- the slow space-usage total.

The graph and the audit log are never loaded while the browser is idle.

## Polling

To reload data on a timer, set `refetchInterval` on the query that owns it. Leave `refetchIntervalInBackground` off, so polling pauses while the tab is hidden. The interval can depend on the data: a running intent reloads every 8 seconds, a waiting intent every 30 seconds, and a finished intent stops. Realtime events are the main way data stays current; polling only catches events that were missed.

`useVisiblePoll` is only for work that is not a query, such as catching up the transcript panes that are on screen. Do not add another timer to refresh an ordinary query.

## Intent status from the cache

`useQueryData(key)` reads what is already in the cache and re-renders when it changes. It does not send a request and does not keep the data in memory longer. Status pills use it: they update when an intent's detail arrives, and fall back to the list summary when the detail is freed.

`useIntentStatus` uses the cached detail only when it is at least as recent as the list summary. So the sidebar shows the same status as the intent page, without keeping every visited intent in memory or sending a request per row.

Filters and counts over a list read the same status through `useIntentStatusReader`, so “Needs your attention”, its count, the space badges and the live dot always agree with the pills.

## Checklist for changes

- Add the key to `qk` and a shared `queryOptions` helper. Pass `signal` on. Choose `staleTime` and `gcTime` on purpose.
- Read with `useQuery`, or `fetchQuery` when code needs the result once. Use `useQueryData` only to read without keeping.
- Refresh the affected keys in the service after a save. Cancel older reads before storing a saved value.
- Add each page and its query helpers to the route registry once. Use normal links, or `data-prefetch-href` on other elements, instead of a hover timer per row.
- Test components and hooks that read queries with `src/test/query.tsx`. Each test gets a new client. Test our own rules and request wiring, not TanStack's behavior.
