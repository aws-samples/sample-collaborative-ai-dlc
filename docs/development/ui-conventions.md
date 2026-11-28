# UI conventions

These conventions apply to every change under `frontend/src/`. They keep one word, one color, and one behavior per concept across the application, so a status, a date, or a destructive action reads the same on every page.

Shared primitives live in `frontend/src/components/ui/`; shared helpers live in `frontend/src/lib/`. Reuse them before adding a local variant. Several conventions are enforced by tests; see [Frontend design-system guards](testing.md#frontend-design-system-guards). For how screens load and refresh data, see [Frontend data layer](../concepts/frontend-data-layer.md).

## Status

Every status word, tone, icon, and help sentence comes from the registry in `lib/statusModel.ts`. Render a status with `StatusPill` (`components/ui/status-pill.tsx`), for example `<StatusPill kind="intent" status={derived.key} since={derived.since} stalled={derived.stalled} />`.

- **No local status maps.** Do not map a backend value to a label or a color in a component, and do not print a backend value such as `FAILED` as text. The registry labels are the product vocabulary: `CREATED` reads "Starting", `SUCCEEDED` reads "Completed", `WAITING` reads "Waiting for input".
- **Kinds.** The registry covers `intent`, `stage`, `gate`, `unit`, `connection`, `config`, and `sensor`. An unknown value degrades to a neutral, humanized label instead of failing.
- **Derive, then render.** For an intent, compute `{ key, stalled, since }` with `deriveIntentStatus` or, in lists, `useIntentStatus`, and pass the result to the pill. Every surface then shows the same state and the same age.
- **Compact variant.** In dense lists pass `compact`. The pill shows a short label ("Waiting · 108 d", "Stalled · 4 mo") and keeps the full label for assistive technology and as its title. A pill is never truncated: give it room and truncate the neighboring text.
- **Stalled is a qualifier, not a status.** A run that is `RUNNING` or `CREATED` with no recorded activity for 30 minutes (`STALL_AFTER_MS`) is shown as "Stalled · no activity for …" in the warning tone, without animation. Use the word "Stalled" for this everywhere.
- **Motion.** Only states marked `live` in the registry pulse, and only when the user has not asked for reduced motion.
- **Sizes and help.** `size="sm"` (default) shows a dot, `size="md"` shows the registry icon. `hint` adds the registry help sentence as a tooltip that is reachable by keyboard.
- **Status text outside a pill.** Use `statusLabel` for the words and `TONE_CLASSES` for the color.

## Names

Slugs and identifiers the backend emits are not labels. Use the helpers in `lib/displayNames.ts`:

- `displayStageName(slug, compiled)` returns the compiled stage name when there is one, otherwise the humanized slug.
- `displayPhase` humanizes phase slugs: `02-construction` becomes "Construction".
- `displayProvider` returns the product name, such as "GitHub" and "Amazon Bedrock".

Never use a slug or a UUID as the primary label of a row, badge, heading, or menu item. When the raw value is useful for support, put it in technical details.

## Disclosure

Use `Disclosure` (`components/ui/disclosure.tsx`) for any collapsible content. Do not use the HTML `<details>` element.

- `variant` is `row`, `card`, `section`, or `inline`.
- `summary` and `status` stay visible while the panel is collapsed. Use them to show the current value, so a reader does not have to open the panel to learn it.
- `actions` (Retry, Copy) are rendered next to the trigger, never inside it.
- `count` is appended to the title, as in "Diagnostics (6)".
- By default, children are not mounted while the panel is closed, so a collapsed panel never fetches. Pass `forceMount` only when the content must keep its state while hidden.

## Dates and times

- Render a timestamp with `RelativeTime` (`components/ui/relative-time.tsx`). It outputs a `<time dateTime>` element with a relative age ("3h ago") for the first 30 days and an absolute date ("5 Aug 2026") after that. The exact timestamp appears in a tooltip on hover and on focus. A missing or invalid value renders as "—".
- When plain text is needed, use the helpers in `lib/timeAgo.ts`: `formatAbsolute` for an exact timestamp ("5 Aug 2026, 15:08"), `formatRelative` for the same text `RelativeTime` shows, and `formatAge` for a duration ("3 hours").
- Never show a raw ISO string or a locale-dependent date such as "5/22/2026", and never mix formats within one list.
- State durations with their verb: an active state shows elapsed time ("Waiting for input · 109 days"); a finished state shows time since ("Failed 137 days ago").

## Failures

`describeFailure(code, message)` in `lib/failureReasons.ts` turns a failure code, or the legacy `stage_failed: …` string, into `{ sentence, technical, code, stageId }`.

- Show `sentence` to the user, for example "This stage uses a mode this platform version does not support yet."
- When the orchestrator or the agent runtime gains a failure code, add its sentence to `FAILURE_SENTENCES`. An unknown code falls back to "The run stopped because of an internal error."

## Navigation

- The **Spaces** dashboard (`/dashboard`, also `/spaces`; the default after login) shows the spaces as cards, or as a table when the reader chose it (`aidlc-spaces-view`, per browser). A card folds its open intents behind one line; the space page has the rest. **My work** (`/my-work`) lists what needs the reader across spaces. Register a new top-level page in `routes/registry.ts`, add its breadcrumb in `AppHeader`, and its entry in the command palette's `PAGES`.
- The layout breakpoint is `hooks/usePanelsInline.ts` (Tailwind `lg`), shared by the shell and the pages. At and above it the sidebar lists the spaces: three rows in one style — **My work**, **Pinned** (only with pins; `useSidebarSpaces`, persisted per user) and **Spaces**. The Spaces label opens the dashboard, folds and unfolds the list once the reader is there, and its chevron only folds; the row also carries the sort menu and **New space**. Below the breakpoint the drawer links to My work and the dashboard. Return paths without a settings page go to `/dashboard`. `?reopenCreateSpace=1` (with an optional `gitProvider`) is handled by `AppShell`, which owns the Create space dialog, on whatever page the reader lands.
- Expanding a space lists only active intents (`isTerminalIntentStatus` false), most recent first, `INTENTS_PAGE_SIZE` at a time; finished intents belong to the space page. Work status counts come from `components/space/spaceSignals.ts`, the same helper the Spaces table uses for its pills.
- Rows are plain links: hover warming is the shell's delegated listener (`navIntent`); a sidebar row never fetches on its own.

## Page headers

- Every page has one `PageHeader` (`components/ui/page-header.tsx`), which renders the page's single `h1`. Put the `StatusPill` in `status`, short facts and badges in `meta`, and the one primary button in `primaryAction`. Use `backTo` for the link to the parent page.
- A long title is truncated on one line and exposes the full text as its title; `status` and `meta` wrap under the title on narrow screens.

## Text size, target size, and color

- **11 px is the floor.** `text-2xs` (11 px on a 16 px line) is the smallest text size. Do not use arbitrary sizes such as `text-[10px]`.
- **Interactive targets are at least 24 by 24 CSS pixels.** The shared controls already meet this: the smallest button (`size="xs"`) is 28 px high and an icon button is 36 px. Do not shrink a control below the floor with custom classes.
- **Use status tokens for status colors.** Pair `text-agent-*-fg` with `bg-agent-*/15`, and `text-warning-fg` with `bg-warning/15`. Do not use palette classes such as `text-amber-600` or `indigo-*`; the token pairs are tested for contrast in both themes.
- **Buttons use sentence case and a specific verb:** "Start intent", "View activity".

## Row actions

Use `RowActions` (`components/RowActions.tsx`) for the secondary actions of a list row, next to the row's primary link.

- The trigger is always visible on touch devices, where it is 40 px square on narrow screens.
- On devices with a pointer that can hover, it appears when the row is hovered, when keyboard focus is inside the row, and while its menu is open. The row element needs the `group` class for this.
- `label` is required and names the menu for assistive technology, for example "Actions for Checkout redesign".
- Offer the same set of actions on every row where the action is allowed. Do not remove the menu for one status.

## Before opening a pull request

Run the frontend suite and the production build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
```

The suite includes the guard ratchet and the token contrast test. If the ratchet fails, replace the flagged pattern with the primitive named on this page instead of raising the baseline.
