# UI conventions

These conventions apply to every change under `frontend/src/`. They keep one word, one color, and one behavior per concept across the application, so a status, a date, or a destructive action reads the same on every page.

Shared primitives live in `frontend/src/components/ui/`; shared helpers live in `frontend/src/lib/`. Reuse them before adding a local variant. Several conventions are enforced by tests; see [Frontend design-system guards](testing.md#frontend-design-system-guards). For how screens load and refresh data, see [Frontend data layer](../concepts/frontend-data-layer.md).

## Status

Every status word, tone, icon, and help sentence comes from the registry in `lib/statusModel.ts`. Render a status with `StatusPill` (`components/ui/status-pill.tsx`), for example `<StatusPill kind="intent" status={derived.key} since={derived.since} stalled={derived.stalled} />`.

- **No local status maps.** Do not map a backend value to a label or a color in a component, and do not print a backend value such as `FAILED` as text. The registry labels are the product vocabulary: `CREATED` reads "Starting", `SUCCEEDED` reads "Completed", `WAITING` reads "Waiting for input".
- **Kinds.** The registry covers `intent`, `stage`, `gate`, `unit`, `connection`, `config`, and `sensor`. An unknown value degrades to a neutral, humanized label instead of failing.
- **Compact variant.** In dense lists pass `compact`. The pill shows a short label ("Waiting · 108 d", "Stalled · 4 mo") and keeps the full label for assistive technology and as its title. A pill is never truncated: give it room and truncate the neighboring text.
- **Motion.** Only states marked `live` in the registry pulse, and only when the user has not asked for reduced motion.
- **Sizes and help.** `size="sm"` (default) shows a dot, `size="md"` shows the registry icon. `hint` adds the registry help sentence as a tooltip that is reachable by keyboard.
- **Status text outside a pill.** Use `statusLabel` for the words and `TONE_CLASSES` for the color.

## Text size, target size, and color

- **11 px is the floor.** `text-2xs` (11 px on a 16 px line) is the smallest text size. Do not use arbitrary sizes such as `text-[10px]`.
- **Use status tokens for status colors.** Pair `text-agent-*-fg` with `bg-agent-*/15`, and `text-warning-fg` with `bg-warning/15`. Do not use palette classes such as `text-amber-600` or `indigo-*`; the token pairs are tested for contrast in both themes.
- **Buttons use sentence case and a specific verb:** "Start intent", "View activity".

## Before opening a pull request

Run the frontend suite and the production build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
```

The suite includes the guard ratchet and the token contrast test. If the ratchet fails, replace the flagged pattern with the primitive named on this page instead of raising the baseline.
