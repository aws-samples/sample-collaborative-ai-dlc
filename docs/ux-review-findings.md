# UI/UX Review Findings

Review context: AI-DLC aims to make AI-driven development accessible to the whole software team.
Primary personas: product owners / business stakeholders (defining requirements) and technical
team members (developers, architects, QA). Guiding principles: no unexplained jargon in
stakeholder-facing flows, progressive disclosure for advanced capabilities, and trustworthy
system feedback for everyone.

Severity scale:

- **Critical** — misleads users or blocks a core flow
- **Major** — causes confusion or erodes trust; workaround exists
- **Minor** — polish, consistency, or wording issue

---

## Prioritized fix list

Ordered by value-for-effort. Tier 1 items are individually shippable in hours, not days.

### Tier 1 — Quick wins: low effort, high impact

| # | Finding | Fix | Why first | Done |
|---|---------|-----|-----------|------|
| 1 | UX-020 | Replace green check-circles with neutral dots in "At a glance"; demote model chip | Trivial change; removes an active approval bias at the product's core judgment point | ✅ |
| 2 | UX-017 | Show DiscussButton when thread/unread exists (conditional on the existing wrapper) | One-line per row wrapper; badge logic already built; unblocks collaboration signal | ✅ |
| 3 | UX-001 | Hide fake StatusBar segments until wired (or wire to `usePresence`) | Stop showing false "Connected / No agent active" on every screen | ✅ |
| 4 | UX-011 + UX-032 | Ship the agreed canonical string ("Lean run: X broader steps are skipped on purpose…") with info styling in all 3 locations; hide banner post-success | String already agreed; kills the scariest copy in the app | ✅ |
| 5 | UX-012 | Work products: Code always open, Documents open (closed on SUCCEEDED), Questions + Identified items closed; rename "Derived items" → "Identified items" + plain description; fix scroll-to-item anchor | Config-level change; unburies the intent screen | ✅ |
| 6 | UX-018 | Rewrite review-gate card + page copy (stage title, artifact chips, move instructions to actions, fix "pending/none" contradiction) | Copy-only; the gate is the core human touchpoint | ✅ |
| 7 | UX-009 | Project page: Intents first, metrics below and owner/admin-only | Section reorder + role gate; fixes inverted hierarchy | ✅ |
| 8 | UX-007 | Sidebar: split "Needs your attention" (questions) from "Observability" | Rename + regroup; makes the key signal findable by POs. Deferred — linked to observability rework (UX-029, UX-031); sidebar links should navigate to intent, not observability. | |
| 9 | UX-016 | Render markdown in question bodies; demote `si-…` IDs; number sub-questions | Markdown renderer already exists (artifact viewer); mostly wiring | ✅ |
| 10 | UX-010 | Map status enums / stage ids to human labels at display boundary ("SUCCEEDED" → "Completed") | One mapping table, used app-wide | |

### Tier 2 — Copy & polish batch: low effort, medium impact (bundle into one pass)

| Finding | Fix | Done |
|---------|-----|------|
| UX-003 | Invert v2 badge → "Legacy" badge on old projects only | |
| UX-004 | "Active 1d ago" → "Last activity 1d ago"; unify date formats | |
| UX-006 | One admin label ("Admin") in sidebar + user menu | |
| UX-008 | Rewrite sidebar empty states in outcome language (with UX-007) | |
| UX-013 | Unit tooltip on phase counts; show future phases greyed | |
| UX-014 (part) | Rename "Derived items" + rewrite description (full promotion → Tier 3) | |
| UX-015 (part) | Strip redundant unit suffixes; tooltip the count icon | |
| UX-023 | Filter engine-telemetry events from timeline; fix "(s)" pluralization | |
| UX-024 (part) | Rewrite "sprint graph" tagline; title tooltip (display names → Tier 3) | |
| UX-025 | Tooltips on icon row; collapse triple title; resolve `[[wiki-links]]` | |
| UX-027 | Rename "Park release"; explicit Unlimited instead of 0-sentinel | |
| UX-028 | Drop member UUIDs; guard last-owner removal | |
| UX-033 (part) | Dim instead of strikethrough; fix "fan out" phrasing (stage descriptions → Tier 3) | |
| UX-034 | Label the icon button; confidence % → words; scope option descriptions | |

### Tier 3 — Medium projects: high impact, real work

| Priority | Finding | Fix | Notes | Done |
|----------|---------|-----|-------|------|
| 1 | UX-036 (Critical) | In-app toasts for question/gate/failed/succeeded + notification inbox (bell + history); browser notifications | Highest-impact item in the review; WebSocket plumbing + toast component already exist | |
| 2 | UX-030 | Sensor semantics: rename to "Checks", legend/tooltips, advisory styling (no red FAIL on Succeeded), "not applicable" instead of BLOCKED | Trust-critical on the execution view | |
| 3 | UX-002 | Dashboard attention signals (questions waiting, phase, agent running) | Builds on UX-036's event taxonomy | |
| 4 | UX-019 | Review gate: evidence first, sticky decision bar, textarea behind "Request changes" | Layout restructure of one page | |
| 5 | UX-022 | Agent stream: Narrative default / Verbose toggle | Presentation split; data layers already distinct | |
| 6 | UX-035 | Compose Intent: regroup run-plan section (Option A) or AI-first Accept/Customize (Option B) | B is preferred, A is cheaper | |
| 7 | UX-026 | Settings: value-as-text rendering for members + "About" title | Direction agreed | |
| 8 | UX-014 (rest) | Promote Requirements/Stories/Decisions to first-class sections | After the Tier 2 rename | |
| 9 | UX-024 (rest) | Display names for users (profile field) | Touches auth/profile | |
| 10 | UX-031 | Consolidate execution views to two | Decision + deletion | |

### Tier 4 — Strategic: roadmap-scale

| Finding | Scope | Done |
|---------|-------|------|
| UX-036 (email layer) | Offline/email notifications for parked runs — needs backend delivery infra | |
| UX-029 | Dissolve observability landing page; re-home execution view as intent tab | |
| UX-037 | Loop closure: completion panel, tracker write-back (PR comment → transition on merge) | |
| UX-038 | Contextual help panel ("?" buttons + markdown content set + glossary) | |
| UX-039 | Functional personas (po/dev/archi/…) + question routing via platform-side mapping | |
| UX-005 | Authoring IA — pending the admin-vs-advanced-user decision | |

---

## Findings

### UX-001 — StatusBar shows hardcoded fake status (always "Connected", always "No agent active")

- **Severity:** Critical
- **Area:** Global layout — `frontend/src/components/layout/StatusBar.tsx` (rendered in `AppShell.tsx:205`)
- **Personas affected:** All

**Issue**

The status bar at the bottom of every screen displays hardcoded values, not real state
(`StatusBar.tsx:7-8`):

- Connection status is fixed to `'connected'` — the bar says "Connected" even when the
  WebSocket is down or reconnecting.
- Agent info is fixed to `null` — the bar says "No agent active" even while agents are
  running, streaming, or waiting for a human answer.

This is worse than showing nothing: a status indicator that lies destroys the trust it exists
to build. A non-technical user who sees "Connected / No agent active" while their planning
agent is actually running (or their connection has dropped and edits are not syncing) has no
way to reconcile that with what the rest of the UI shows. For a collaborative real-time app,
silent disconnection is a data-loss risk: users may keep editing believing changes sync.

**Evidence**

- `StatusBar.tsx:6-8` — comment admits it: `// These will be connected to real state via SprintContext later`.
- Real state sources already exist and are unused here:
  - `frontend/src/hooks/usePresence.ts:67` exposes `connectionStatus` derived from Yjs sync state.
  - `frontend/src/services/realtime.ts` tracks WebSocket `readyState`.
  - Agent status is available in multiple views (`AgentPage`, `InceptionPage`, `ConstructionPage`, observability components).

**Recommendation**

1. Short term (if wiring is not imminent): remove the connection and agent segments from the
   StatusBar, or hide the bar entirely. An absent indicator is honest; a fake one is not.
2. Proper fix: wire the bar to real state:
   - Connection: expose a single connection status from the realtime/Yjs layer (context or
     store) and consume it here. On `disconnected`, escalate beyond the subtle footer — e.g.
     a non-dismissable banner "Connection lost — your changes are not being saved" — because
     an 11px footer line is below the attention threshold for a critical state.
   - Agent: show the currently active agent(s) for the project in view, including the
     "waiting for your answer" state, which is the one non-technical users most need surfaced.
3. Consolidate with `frontend/src/components/ConnectionStatus.tsx`, a second, visually
   different connection indicator (different colors, sizes, and an extra `error` state).
   Two components rendering the same concept differently will drift; keep one.

**Related observations**

- The agent status dot colors (`bg-agent-running`, `bg-agent-success`, `bg-agent-idle`) carry
  meaning by color alone with no text label for the state — an accessibility issue
  (color-blind users) once real data is wired in. Pair the dot with the status word.

---

### UX-002 — Dashboard shows no lifecycle state or "needs your attention" signals

- **Severity:** Major
- **Area:** Dashboard — `frontend/src/pages/Dashboard.tsx` (grid and list views)
- **Personas affected:** All, especially stakeholders

**Issue**

Project cards show only static metadata: name, repo, role, created date, last activity. Nothing
tells the user what state the project is in or whether it needs them. The product's core loop is
"agents work, then pause and ask you" — but a product owner landing on the dashboard cannot see:

- Which phase each project is in (Inception / Construction / Review)
- Whether an agent is currently working
- **Whether a question is waiting for their answer** — the single most actionable signal in
  the whole product, since a waiting agent is a blocked agent

"Active 1d ago" is the only dynamic signal, and it answers "when", not "what" or "so what".
Users must click into every project to find out if anything needs them. With 4 projects that's
tolerable; with 15 it defeats the dashboard's purpose.

**Recommendation**

Add per-project state to the cards, in priority order:

1. An attention badge when human input is pending, visually loud (e.g. amber
   "1 question waiting"). This is the dashboard's real job in this product.
2. Phase indicator (Inception / Construction / Review) — a small labeled chip, not just a color.
3. Running-agent indicator (subtle pulse + "Agent working") so users know progress is happening
   without them.

Consider a "Needs your attention" sort/filter or a pinned section at the top. Backend note:
`hasActiveWork` already exists per project (used only to harden the delete dialog,
`Dashboard.tsx:85`) — the data path for richer state signals is partially there.

---

### UX-003 — "v2" badge is internal jargon on a primary surface (and inconsistent between views)

- **Severity:** Minor
- **Area:** Dashboard — `frontend/src/pages/Dashboard.tsx:311-315`
- **Personas affected:** All

**Issue**

Every project card in grid view shows a "v2" badge (`project.kind === 'v2'`). This is an
internal data-model marker (v1-to-v2 migration, cf. `MigrateTrackerCard`), meaningless to every
persona — including developers, who will wonder if it's *their* project's version. Unexplained
badges create "am I missing something?" doubt, exactly what the product wants to avoid for
non-technical users. And since all projects are v2, it's pure noise.

It's also inconsistent: the badge appears in grid view but not in list view (list renders only
the role badge, `Dashboard.tsx:391-398`).

**Recommendation**

Invert the logic: show nothing for current-kind (`v2`) projects, and show a "Legacy" badge with
a tooltip ("Created with an older version — migrate to unlock latest features") only on old-kind
projects. Once migration is done, remove entirely.

---

### UX-004 — Dashboard polish: hover-only actions, "Active" wording, raw date format

- **Severity:** Minor
- **Area:** Dashboard — `frontend/src/pages/Dashboard.tsx`
- **Personas affected:** All

**Issue**

1. The delete button is hover-revealed only (`opacity-0 group-hover:opacity-100`,
   `Dashboard.tsx:326,412`). On touch devices there is no hover, so owners cannot delete
   projects at all. *Decision 2026-07-14: mobile/tablet support is out of scope for now —
   accepted as-is. Revisit if touch support enters scope; an always-visible "..." overflow
   menu would solve it and give future actions (rename, archive, settings) a home.*
2. "Active 1d ago" is ambiguous wording — active *for* a day? "Last activity 1d ago" or
   "Updated 1d ago" reads unambiguously and matches the sort dropdown label ("Last activity").
3. Created date uses raw `toLocaleDateString()` ("7/7/2026") next to a relative time — mixed
   formats in the same line. Prefer relative for both, with the absolute date in a tooltip.

**Positive observations (keep these)**

- Delete requires a confirmation dialog, with an extra warning when the project has live/parked
  work (`confirmDeleteHasActiveWork`) — good destructive-action hygiene.
- Delete is only offered to owners — correct role gating.
- Grid/list toggle, search, and sort are appropriate and unobtrusive for this page.
- Git provider icons (GitHub/GitLab) communicate the integration at a glance.

**Recommendation**

Rename the activity label, unify date formats, and add a touch-accessible way to reach delete
(e.g. an overflow "..." menu that is always visible, which also gives future actions a home —
rename, settings, archive).

---

### UX-005 — Sidebar IA: AUTHORING section floats between "main nav" and "admin"

- **Severity:** Major
- **Area:** Sidebar — `frontend/src/components/layout/AppSidebar.tsx:370-410`
- **Personas affected:** Platform admins (section is `isPlatformAdmin`-gated; other users never see it)

**Issue**

Workflows and Block Library sit in a top-level "AUTHORING" sidebar section, directly above
"Admin & Settings", all gated by the same platform-admin flag. This creates an ambiguous IA:
they look like primary product areas but are actually admin-only capabilities. Admins get a
sidebar where the boundary between "using the product" (Projects, Observability) and
"configuring the platform" (Authoring, Admin) is only a faint section divider.

**Recommendation**

Decide based on the intended long-term audience for authoring:

- **If authoring is platform administration** (only admins will ever build workflows/blocks):
  fold Workflows and Block Library into the `/admin` area as sub-navigation (secondary sidebar
  or tabs: Users, Settings, Workflows, Block Library). Dedicated screens do not require
  top-level nav entries; an admin section with its own sub-nav is the standard pattern.
- **If authoring is the "advanced users customize" capability** (architects/leads tailoring
  their team's process — per the product's stated goal): keep it top-level, but introduce a
  dedicated authoring role/permission instead of reusing `isPlatformAdmin`, and label the
  section for what it is (e.g. "CUSTOMIZATION"). Platform admin and process customization are
  different jobs; coupling them forces every process-tinkerer to be a platform admin.

Either way the current middle ground (top-level placement, admin-only gating) is the weakest
combination.

---

### UX-006 — Two entry points to /admin with different names ("Admin & Settings" vs "Admin Panel")

- **Severity:** Minor
- **Area:** Sidebar `AppSidebar.tsx:401` + user dropdown `AppHeader.tsx:180`
- **Personas affected:** Platform admins

**Issue**

The sidebar item "Admin & Settings" and the user-menu item "Admin Panel" both navigate to
`/admin`. Two labels for one destination make users wonder if they are different places
(is "Settings" something more than the "Panel"?). Additionally, "Settings" in the sidebar label
suggests personal settings, which non-admin users also need eventually — but they see neither.

**Recommendation**

Pick one label ("Admin" is enough) and use it in both places — keeping both entry points is
fine (user-menu access to admin is a common convention). Reserve "Settings" for future personal
preferences accessible to all users from the user menu.

---

### UX-007 — The most important signal ("agent has a question for you") lives under the jargon label "Observability"

- **Severity:** Major
- **Area:** Sidebar — `AppSidebar.tsx` Observability section
- **Personas affected:** Stakeholders primarily; all users

**Issue**

The sidebar's Observability section is actually where the product's key attention signal
surfaces: pending agent questions (e.g. "create README file / empty-repo" with a question icon
and a count badge). This is exactly the signal UX-002 asks for — but it's filed under
"Observability", an engineering term (metrics/tracing/logs) that product owners do not
associate with "someone is waiting for my answer". The label describes the mechanism, not the
user's job to be done. A PO scanning the sidebar has no reason to look there, so the question
sits unanswered and the agent stays blocked.

**Positive:** the signal itself is well designed — count badge, question icon, project context
under the task name. It's only mislabeled and mislocated.

**Recommendation**

1. Split "waiting on you" from "watching the system": give pending questions their own
   plainly-named sidebar group (e.g. "Needs your attention" or "Questions for you") that all
   personas understand, placed above the fold.
2. Keep "Observability" (or rename to "Activity") for the passive monitoring use case —
   agent progress, timelines, system health — which is the advanced/technical audience's tool.
3. Cross-link: answering a question from the attention group can deep-link into the same
   detail view observability uses today.

---

### UX-008 — "Iteration" vocabulary in sidebar empty states and filters

- **Severity:** Minor
- **Area:** Sidebar — `frontend/src/components/layout/AppSidebar.tsx:53-57,319-345`
- **Personas affected:** Stakeholders primarily

**Issue**

The Observability sidebar section shows "No active iterations" as its empty state (with filter
variants like "No iterations in progress"). "Iteration" is product-internal vocabulary — a
non-technical user (and even a new developer) has not been introduced to what an "iteration"
is at this point. The empty state is also purely descriptive: it says what's absent without
telling the user whether that's good ("all quiet, agents have nothing pending") or what would
make something appear here.

Positive: non-admin degradation of the sidebar is otherwise clean — admin/authoring sections
are properly absent and the layout holds up.

**Recommendation**

1. Prefer outcome language over mechanism language: e.g. "All quiet — no agents working and
   nothing waiting for you." A good empty state answers "is this fine?" and "what fills this?"
2. If "iteration" stays as a product concept, it must be introduced (onboarding, tooltip on
   the section header) before it's used in passing. Audit all user-facing strings for it
   (also appears in Project page, usage metrics, stage editor).
3. Resolve together with UX-007 — if the section is split into "Needs your attention" +
   "Activity", the empty states become naturally plain: "No questions for you" / "No agent
   activity".

---

### UX-009 — Project page leads with a wall of telemetry; Intents are pushed below the fold

- **Severity:** Major
- **Area:** Project page — `frontend/src/pages/Project.tsx`, `frontend/src/components/intent/UsageMetrics.tsx`
- **Personas affected:** All; stakeholders most

**Issue**

The first and largest block on the project page is "Usage & cost": ~16 metrics including
"Bolts Planned", "Units Sequenced", "Compiled Context Bytes", "Enrichment Calls",
"Prompt Bytes", "Artifacts Consumed/Produced", "Links Created". Problems, in order of weight:

1. **Hierarchy inversion.** The user's actual work — Intents — sits below a diagnostics panel.
   The page answers "what did the system consume?" before "what are we building and does it
   need me?". For every persona, intents are the reason to visit this page.
2. **Deep jargon, even for developers.** "Bolts" and "Units" are AI-DLC methodology terms
   nobody has been taught; "Compiled Context Bytes" and "Enrichment Calls" are implementation
   internals. This is a debugging/telemetry view presented as a headline dashboard. It
   actively works against the product's promise of hiding technical harnesses.
3. **Non-actionable and broken-looking states.** "Cost: unavailable" headlines a failure to
   compute; "Credits: 259.24" has no unit, budget, or limit context; "Peak context window 65%"
   is styled amber like a warning but gives no explanation of what it means or what to do.
   Metrics that raise questions they don't answer create anxiety — the "scary" effect.
4. **Audience/permissions.** Usage and cost data is shown to every project member. Whether
   members should see spend-related data is a product decision that hasn't been made
   explicitly — currently it's exposed by default.

**Recommendation**

1. Reorder: Intents (with attention/status signals) first, repository/workflow context
   compact at top, telemetry last or elsewhere.
2. Progressive disclosure: replace the metrics wall with a one-line summary (e.g.
   "577K tokens · 259 credits used") that expands or links to a full "Usage" tab / the
   observability area for those who care. Advanced users keep full access; nobody else pays
   the comprehension tax.
3. Curate the audience-facing metric set: tokens/credits/cost are plausibly interesting to an
   owner; "Compiled Context Bytes" and "Bolts Planned" belong in observability only.
4. Decide deliberately who sees cost data (owner-only? all members?) and gate accordingly.
5. Fix the broken-looking states: hide cost when unavailable (or tooltip why), give credits a
   reference point, and either explain the context-window bar (tooltip: what it is, why amber)
   or drop it from this page.

**Resolution (2026-07-14)**

1. ✅ Reordered: Intents now first, Usage & cost moved below.
2. ✅ Role-gated: Usage & cost visible to owners and admins only.
3. ⏭️ Progressive disclosure (one-line summary), metric curation, and broken-state fixes
   deferred — will be addressed together with observability consolidation (UX-029, UX-031)
   when the execution/telemetry views are reworked.

---

### UX-010 — Raw machine vocabulary in intent status and stage labels

- **Severity:** Minor
- **Area:** Project page — `frontend/src/pages/Project.tsx:583,606`
- **Personas affected:** Stakeholders primarily

**Issue**

The intent card renders backend enum values and internal identifiers directly:

- Status badge "SUCCEEDED" — all-caps machine enum. Human label would be "Completed".
  (Also duplicated by the green check icon — two indicators, same information.)
- "stage: build-and-test" — a raw `key: value` pair with an internal stage id, lowercase and
  hyphenated. Reads as debug output, not UI copy.

**Recommendation**

Map statuses and stage ids to human labels at the display boundary ("Completed",
"Build & test"), title-case them, and drop the "stage:" prefix (context makes it clear —
or use "Stage: Build & test" if the label alone is ambiguous). Keep one status indicator,
badge or icon, not both.

---

### UX-011 — Informational plan note styled and worded as an alarming warning ("runs degraded")

- **Severity:** Major
- **Area:** Intent view — `frontend/src/pages/IntentView.tsx:319-338`
- **Personas affected:** All; stakeholders most

**Issue**

At the top of the intent screen: an amber alert-triangle banner reading
*"Scope "feature" runs degraded — 7 declared inputs will not be produced in this scope."*

The code comment states this is **informational only** — a normal consequence of choosing a
narrower scope; the run proceeds as designed. But every signal contradicts that:

- **Vocabulary:** "degraded" means "malfunctioning" to users; "scope", "declared inputs",
  "producer stage" are workflow-engine internals no persona has been taught.
- **Styling:** amber + warning triangle = "something is wrong, act".
- **Persistence:** the banner still shows on an intent whose status is SUCCEEDED — a
  completed, successful intent permanently wearing a warning.
- **No action:** nothing tells the user whether to do anything (they don't need to).

Net effect: the "most important screen" greets every visitor with unexplained anxiety. A PO
reads "degraded" and assumes their feature is broken; even a developer can't assess it without
learning the workflow engine's planning model.

**Recommendation**

1. Restyle as neutral information (muted/info styling, info icon, no triangle), using the
   canonical string agreed in UX-032: *"Lean run: 7 broader steps are skipped on purpose —
   their outputs won't exist."* Expandable details can keep the precise engine messages for
   advanced users.
2. Consider showing it only pre-completion, or collapsing it into the "..." menu / details
   area once the intent has succeeded — a successful outcome should not carry a warning.
3. General rule to adopt app-wide: reserve amber/red + triangle for states requiring user
   action or attention. Informational engine notes get info styling. (Same rule fixes the
   "Peak context window 65%" amber bar in UX-009.)

---

### UX-012 — Work products: everything expanded by default buries the screen; labels vague; counts undifferentiated

- **Severity:** Major
- **Area:** Intent view — Work products accordions (`IntentView.tsx:930-948`, `DerivedItemsSection.tsx`)
- **Personas affected:** All

**Issue**

1. **Default-open overload.** Code, Documents, and Questions accordions are open by default
   (`IntentView.tsx:935-939`; only Derived items starts closed). With realistic data
   (71 documents, 7 questions) the default view is a wall of ~80 rows — the user must close
   sections to see the screen's structure at all. Worse, closed state is per-mount
   (`useState`) — it resets on every reload, so users repeat the cleanup on each visit.
   New groups auto-opening as they appear is a nice touch for *live* runs, but the same
   logic floods a *completed* intent.
2. **"Derived items" (42)** — vague label; users can't predict what's inside before opening.
   The section description also leans on jargon: "Artifacts, human questions and course
   corrections captured during this intent."
3. **Counts carry no state.** "Questions 7" doesn't distinguish answered from waiting — a
   pending question is the one thing that should always be visible and emphasized.
4. **"Documents 71"** — a count that big suggests agent working papers mixed with documents a
   human would read. Consider a curated "key documents" grouping with the rest behind
   "all documents".

**Resolution (2026-07-14)**

1. ✅ New defaults: Code always open, Documents open (closed when SUCCEEDED), Questions and
   Identified items closed. Auto-open logic retained for newly-appearing groups during live runs.
2. ⏭️ localStorage persistence deferred — not needed yet.
3. ✅ Renamed "Derived items" → "Identified items"; description rewritten to
   "Requirements, stories, personas, decisions, and other structured items extracted from
   this intent."
4. ⏭️ Question count split and "key documents" curation deferred — pending questions are
   already surfaced at the top of the screen; not a priority.
5. ✅ Fixed scroll-to-item navigation (hash anchor instead of scrollIntoView).

---

### UX-013 — Phase stepper: unlabeled counts and a missing third phase

- **Severity:** Minor
- **Area:** Intent view header — phase breadcrumb ("Inception 7/7 › Construction 13/13")
- **Personas affected:** All

**Issue**

1. "7/7" and "13/13" have no unit — 7 of 7 *what*? (Stages? Tasks? Units?) A tooltip or label
   is needed for the number to mean anything.
2. The product documents a three-phase lifecycle (Inception, Construction, Review) but the
   stepper shows only two. If Review simply isn't part of this workflow, fine — but then the
   stepper should reflect the workflow's actual phases consistently; if Review is pending
   activation, it should appear as an upcoming (greyed) step so users see the whole journey.

**Recommendation**

Add a unit to the counts (tooltip at minimum), and render all phases of the workflow including
future ones, so the stepper communicates progress *through a known whole* rather than a
trail of completed steps.

---

### UX-014 — "Derived items" hides the product's most stakeholder-relevant content behind its most technical framing

- **Severity:** Major
- **Area:** Intent view — Derived items section (`DerivedItemsSection.tsx`)
- **Personas affected:** Stakeholders most; all

**Issue**

Expanded, "Derived items" turns out to contain: **Requirements** (with must-have priorities),
**User Stories**, **Personas**, **Components**, **Decisions** (accepted/rejected, ADR-style),
Story Map, Contracts. This is precisely what a product owner comes to verify — "did the system
understand what I asked for?" — yet it's:

- Named "Derived items", a term that promises nothing of interest
- Described in pure engineering language: *"Typed items the runtime derives from the
  artifacts' structured blocks — the granular layer of the knowledge graph"*
- Placed last, and the only section closed by default
- Prefixed with machine slugs (`req-auto-submit`, `dec-base64-payload`) rendered *before*
  the human-readable titles; Story Map entries have no human title at all (`map-api-client`)

The framing describes how the data is produced (runtime derivation from structured blocks)
instead of what it *is* (your requirements, stories, and decisions). Meanwhile genuinely good
elements — must-have badges, accepted-decision chips, per-item graph links — are already there.

**Recommendation**

1. Promote Requirements / Stories / Personas / Decisions to first-class, plainly-named
   sections (or one section named for its content, e.g. "Requirements & decisions").
2. Rewrite the description for the reader: "What the agents understood and decided:
   requirements, user stories, personas, and design decisions — each linked to the work it
   influenced."
3. Demote slugs: human title first; slug as secondary metadata or tooltip. Give story-map
   entries human titles.
4. Keep Contracts/Components grouped for the technical audience — sub-grouping by audience
   inside the section is fine.

---

### UX-015 — Documents list: machine-generated repetition, redundant suffixes, no filtering at 71 items

- **Severity:** Minor
- **Area:** Intent view — Documents section
- **Personas affected:** All

**Issue**

The grouping (phase → unit, with stage chips and counts) is genuinely good structure. Friction
at realistic volume (71 docs):

1. **Redundant titles.** Inside the "Upload Page Orchestrator" group, every row repeats
   "— upload-page-orchestrator". The group header already says it; the suffix doubles line
   length and buries the distinctive part of each title.
2. **Same 10-doc template × 4 units** produces visually identical blocks — users can't tell
   whether "Monitoring Design — api-client" differs from "Monitoring Design — ui-components"
   without opening both. No search/filter within the section (a "filter by stage/type" or
   text filter would collapse the repetition).
3. **Unlabeled icon-with-count** on each row (graph links?) — meaning must be guessed; needs
   a tooltip at minimum.
4. Stakeholder-relevant documents (Requirements, User Stories, Personas assessments) are
   interleaved with engine output ("Reverse Engineering Timestamp", "Bolt Plan" — jargon
   again) at equal visual weight.

**Recommendation**

Strip the unit suffix inside unit groups; add a text/stage filter above the list; tooltip the
count icon; and consider a "Key documents" pin (requirements, stories, final summaries) at the
top of the section — complements the curation recommendation in UX-012.

---

### UX-016 — Questions: raw agent text with unrendered markdown, machine IDs, and unnumbered multi-questions

- **Severity:** Minor
- **Area:** Intent view — Questions section
- **Personas affected:** All

**Issue**

The traceability design here is strong: answered/waiting chips, who answered and when, the
ANSWER block, and "Influenced artifacts" links are exactly right. The content rendering isn't:

1. **Markdown is not rendered** — plan-approval questions show literal `**Step 1**`,
   backticks, and asterisk bullets as raw text, producing dense unreadable walls.
2. **Machine IDs headline each card** (`si-acdd7f684ee90d68`) next to the "answered" chip —
   noise with no user value; belongs in a tooltip or nowhere.
3. **Multi-question cards aren't numbered** — answers say "Q1: A. 5 MB / Q2: D. Other…" but
   the questions above carry no Q1/Q2 markers, so mapping answers back requires counting
   paragraphs.
4. Verbose timestamps ("7/12/2026, 4:05:12 PM") where relative time + tooltip would do.

Note the audience split visible in the data: option-based product questions (max file size,
camera behavior) are well-structured for POs, while plan-approval questions are developer
content. Both appear in one undifferentiated list.

**Recommendation**

Render markdown in question bodies; drop or demote the `si-…` IDs; number sub-questions
(Q1/Q2) in the body to match the answer block; use relative timestamps. Consider tagging
questions by kind (product decision vs. technical plan approval) so each persona can find
theirs — this becomes more important on the "waiting" side of the flow.

---

### UX-017 — Hover-hidden DiscussButton defeats its own unread indicators

- **Severity:** Major
- **Area:** Intent view rows — `DocumentsSection.tsx:347`, `DerivedItemsSection.tsx:180`, `DiscussButton.tsx`
- **Personas affected:** All (collaboration feature)

**Issue**

`DiscussButton` is designed with state-aware signals: an unread-count pill when
`unreadCount > 0` and a subtle dot when a thread exists (`DiscussButton.tsx:54-60`). But on
document and derived-item rows the whole button is wrapped in
`opacity-0 group-hover:opacity-100` — invisible until the user hovers that exact row. Result:

- A colleague's comment or @mention on a document produces **no visible signal anywhere in
  the list**. The unread badge renders only for someone already hovering the right row —
  i.e., someone who already knows.
- For a product marketed as *collaborative*, the discussion entry point is undiscoverable to
  first-time users: nothing suggests rows are discussable.

Hover-reveal itself is the right call for threadless rows — 71 permanent icons would be noise,
and the convention (Notion, Google Docs) is established.

**Recommendation**

Make visibility state-dependent:

- No thread → hover-reveal (current behavior, correct)
- Thread with messages → always visible with the existing dot
- Unread > 0 → always visible with the existing count pill

One-line change per row wrapper (conditional on `thread`/`unread`), and the badge design
already built into `DiscussButton` starts doing its job. Consider also swapping prominence
with the always-visible graph-links icon (see UX-015): the icon nobody understands is
permanent while the collaboration icon hides — reversed priorities.

---

### UX-018 — Review gate copy speaks engine language at the product's most critical human moment

- **Severity:** Major
- **Area:** Review gate — "Questions for you" card + gate page header (`IntentView.tsx:1284,1557`, `ReviewPage.tsx`)
- **Personas affected:** All; this gate is the core human-in-the-loop touchpoint

**Issue**

The approval gate — the single moment where the product's "human judgment stays in the loop"
promise gets exercised — is written for the engine, not the human:

1. **The pending card is an unstructured text blob.** "Stage output awaits review" (passive) /
   "Review stage reverse-engineering." (machine slug inline) / "Produced artifacts:
   business-overview, architecture, code-structure, …" (nine raw slugs in a comma list, same
   font and weight as everything else — not links, not chips). Stage and artifacts are the
   two facts a user needs; both are typographically invisible.
2. **Instructions for actions that don't exist here.** "Choose approve to continue, or
   request-changes with feedback to send this stage back to the agent" — but this card offers
   neither; the only button is "Review stage". The copy even leaks the backend enum
   (`request-changes`, hyphenated). Instructions must live where the actions are.
3. **Gate page subtitle is internal documentation:** "Durable human validation gate. This page
   stays open alongside discussions and timeline" (`IntentView.tsx:1284`) describes the
   component's architecture to its users. Nobody outside the dev team parses "durable human
   validation gate".
4. **Stat card "GATE: pending"** — engine vocabulary; and "REVIEWER FINDINGS: 0" sits next to
   a section stating both "pending" *and* "No LLM reviewer findings were recorded" —
   contradictory: is the automated review still running, or finished with zero findings?
   A reviewer can't tell whether to wait before approving.
5. **Taxonomy note:** an approval task filed under "Questions for you" stretches the category.
   Workable — but the card title should then be action-shaped ("Approve the results of
   [stage]") rather than status-shaped ("Stage output awaits review").

**Recommendation**

Rewrite the card: human stage title, artifact names as chips/links, one line of purpose, one
CTA. Move approve/request-changes explanation onto the gate page next to those buttons.
Replace the subtitle with user-value copy ("Review what the agent produced and approve it —
or send it back with feedback"). Disambiguate the automated-reviewer state: "Automated review
running…" vs "Automated review found nothing to flag".

---

### UX-019 — Gate page asks for the decision before showing the evidence

- **Severity:** Major
- **Area:** Review gate page layout (`IntentView.tsx` StageReviewPanel)
- **Personas affected:** All reviewers

**Issue**

Page order is: stats → **Decision panel** (feedback textarea + Approve/Request changes) →
*then* the collapsed evidence ("At a glance", reviewer findings, full artifacts). Two problems:

1. **Decision-first layout invites evidence-free approval.** The path of least resistance is
   to click the dark "Approve stage" button without ever expanding what's being approved.
   For a product whose review gates are the safety mechanism, the layout should make looking
   at the work the natural first step — decision last (or sticky at bottom), evidence first
   and "At a glance" open by default.
2. **The empty feedback textarea headlines the panel**, labeled "Request changes feedback" —
   the pessimistic path gets the visual weight while approve (the common case) is a small
   button at its corner. It also reads as if feedback might be required to proceed.

**Recommendation**

Order: at-a-glance summary (expanded) → findings → artifacts → sticky decision bar with
"Approve" primary and "Request changes" expanding the feedback field on demand (progressive
disclosure of the textarea). Duplicated "Back to intent" (top + bottom) can drop to one.

---

### UX-020 — "At a glance" bullets wear green checkmarks: positive affect on neutral facts biases the decision

- **Severity:** Major
- **Area:** Review gate — At a glance cards
- **Personas affected:** All reviewers; stakeholders most susceptible

**Issue**

The "At a glance" LLM summary is the right idea, well executed in structure (per-artifact
cards, headline + bullets). But every bullet is prefixed with a **green check-circle** — even
bullets like "No business domain or target users have been defined yet". Green check = "OK,
verified, good". Applied to neutral or even concerning statements, it:

- Falsely signals that each item was *checked and passed* (these are summary bullets, not
  validations)
- Gives the whole decision surface a "all green, ship it" affect, nudging reviewers toward
  approval — on the page whose entire purpose is calibrated human judgment

The user's own reaction confirms the effect: "it gives a positive impression" — before any
evidence was evaluated.

Also on these cards: the **model name chip (`claude-opus-4.6`) repeats on all 9 cards** —
internal metadata irrelevant to the review decision (move once into a footer/tooltip if
provenance matters), and each card shows both the human title and its slug (duplication).

**Recommendation**

Use neutral bullets (plain dots). If sentiment is available, use it honestly: neutral dot for
facts, amber for gaps/risks ("no tests configured"), green only for verified positives. Demote
model provenance to a single unobtrusive line or tooltip.

---

### UX-021 — Full artifacts: 9 documents in one continuous scroll, titles rendered three times

- **Severity:** Minor
- **Area:** Review gate — Full artifacts section
- **Personas affected:** All

**Issue**

"Full artifacts" expands into a single uninterrupted scroll of all nine documents. Necessary
content, but:

1. **No navigation** — no per-artifact accordion, tabs, or sticky table of contents; finding
   "Dependencies" means scrolling past six full documents.
2. **Triple title rendering** per artifact: kicker chip ("ARCHITECTURE"), header line
   ("Architecture · produced by reverse-engineering · timestamp"), then the document's own
   H1 ("Architecture") — three consecutive repetitions at the seam of every document.
3. Positive: markdown rendering here is excellent — diagrams, tables, code blocks all render
   properly. (Contrast with Questions, UX-016, where markdown is raw text — the rendering
   capability exists; apply it there.)

**Recommendation**

Accordion per artifact (closed by default, opened via links from "At a glance" cards — the
summary becomes the index) or a sticky side TOC. Collapse the three titles into one header
row: title + stage/timestamp metadata; suppress the duplicate H1 or the kicker.

---

### UX-022 — Agent stream shows raw tool plumbing; the narrative layer the product promises is buried inside it

- **Severity:** Major
- **Area:** Right panel — Agent tab (`AgentStreamPanel.tsx`)
- **Personas affected:** Stakeholders (unusable); developers (fine, even good)

**Issue**

The Agent tab renders the raw execution stream in monospace: tool invocations with JSON
parameters ("Running tool emit_stage_note with the param (from mcp server: aidlc) { … }"),
shell commands ("I will run the following command: find /mnt/workspace -maxdepth 1 …"),
timings ("Completed in 0.105s"). For a developer this is excellent transparency — Claude-Code
style. For the product's promise ("you see what the agent is thinking and doing as it works")
aimed at non-technical users, it fails: a PO sees an incomprehensible terminal, and shell
commands scrolling by can read as alarming rather than reassuring.

The irony: **the PO-friendly narration already exists in the stream, wrapped in JSON.** The
`emit_stage_note` summary ("Starting reverse-engineering stage… Scanning workspace to identify
project structure, languages, frameworks…") and the agent's own prose paragraphs ("The
workspace is essentially empty — …") are exactly the right narrative — they're just
interleaved with, and formatted like, the plumbing.

**Recommendation**

Two display modes on the existing stream:

- **Narrative (default):** agent prose + stage notes rendered as readable text; tool calls
  collapsed to one-line human summaries ("Scanned workspace — 9 entries · 0.1s") expandable
  on click.
- **Verbose (toggle):** exactly today's raw view, for developers.

Data already distinguishes the layers (stage notes, prose, tool events), so this is a
presentation split, not a pipeline change. Persist the user's choice.

---

### UX-023 — Timeline: engine telemetry events mixed into a human-readable feed

- **Severity:** Minor
- **Area:** Right panel — Timeline tab
- **Personas affected:** All

**Issue**

The timeline is mostly well done — plain-language events ("Artifact created: Business
Overview", "Stage reverse-engineering succeeded"), status-colored dots, stage context,
relative timestamps. Two blemishes:

1. Engine telemetry rendered as an event: "Derived graph projection: 9 artifact(s),
   44 section(s), 0 item(s), 0 item edge(s), 0 citation set(s), 9 enriched" — internal
   graph-build stats with awkward "(s)" pluralization, meaningless to any user (developers
   included, without engine knowledge).
2. Stage slugs as context labels ("reverse-engineering") — consistent with the app-wide
   slug issue (UX-010).

**Recommendation**

Filter telemetry events out of the default timeline (or demote to a "system events" toggle),
humanize or drop the graph-projection entry, and make artifact events clickable through to
the artifact preview. Fix pluralization by count.

---

### UX-024 — Discuss tab: strong bones; identity shown as raw email, graph jargon in the tagline

- **Severity:** Minor
- **Area:** Right panel — Discuss tab (`DiscussionPanel.tsx`)
- **Personas affected:** All

**Issue**

The discussion design is one of the strongest surfaces reviewed: NEW unread divider, entity
chip + title context, Resolve action, and the Summarize / Explain / Brainstorm AI assists are
a genuine differentiator for mixed-skill teams. Remaining friction:

1. **Participants are identified by raw email** (jvdl@amazon.com, jvdl+member@amazon.ch) —
   display names would humanize the collaboration surface; emails also get long and truncate
   badly in a narrow panel.
2. **Tagline leaks the data model:** "Team discussion — messages are saved to the sprint
   graph." A user reads "sprint graph" and learns nothing; the intended reassurance is
   "discussions are kept with the work". Say that.
3. Thread title truncates ("Requirements — U…") with no tooltip for the full artifact name.

**Recommendation**

Use display names (fall back to email prefix), rewrite the tagline in outcome language
("Saved with this artifact — the team and agents keep the context"), add a title tooltip.

---

### UX-025 — Artifact preview: unresolved [[wiki-link]] syntax, triple title again, unlabeled icon row

- **Severity:** Minor
- **Area:** Right panel — Preview tab / artifact viewer
- **Personas affected:** All

**Issue**

1. **Raw link syntax in rendered prose:** "This is a greenfield project (per
   [[reverse-engineering-timestamp]]) …" — the wiki-link renders as literal double brackets
   around a slug. Either resolve it to a link with the artifact's human title ("per the
   Reverse Engineering Timestamp") or strip the syntax; showing it breaks the otherwise clean
   rendering and exposes slugs to stakeholders mid-sentence.
2. **Triple title** at the top (kicker "REQUIREMENTS", panel header "Requirements — Upload &
   Capture Analysis Workflow", then the document H1 repeating it) — same seam issue as
   UX-021, worse in a narrow panel where it costs a full screen.
3. **Icon-only action row** (expand, edit, AI-sparkle, discuss) — no labels; the sparkle
   icon's function is guesswork. Tooltips at minimum.

**Recommendation**

Resolve wiki-links to titled links (the graph knows the mapping); collapse header/H1
duplication in the viewer; add tooltips to the action icons.

---

### UX-026 — Members see the full settings surface read-only; exposure policy never decided

- **Severity:** Minor (UX) — but contains a product/security decision to make
- **Area:** Project settings — all tabs (`ProjectSettings.tsx:91`, tab components)
- **Personas affected:** Members (non-owner/admin)

**Issue**

Members can open Project Settings and see every tab. The read-only mechanics are properly
implemented — inputs disabled, Save buttons hidden, per-card notes "Only owners and admins can
change…" (`GeneralTab.tsx:175`, `AgentTab.tsx:309`). Two things remain:

1. **The explanation is repeated per-card instead of stated once.** A member discovers their
   status card by card; a single page-level banner ("You're viewing as Member — settings can
   be changed by owners and admins") communicates it upfront and lets the per-card notes go.
2. **Exposure policy is inconsistent and undocumented.** What members see today: member list
   with roles, agent CLI selection, model overrides, runtime settings, repositories, trackers
   — all read-only. What they don't see: MCP servers and custom agent rules (hidden behind
   `canEdit`, `AgentTab.tsx:434-435` — "read is restricted"). So a line *was* drawn, but
   nobody can articulate why it sits exactly there — the project owner's own reaction was
   "not sure why, because most of the rest is [visible]". A policy that the product's builder
   can't explain will confuse users and won't survive future feature additions consistently.

**Recommendation**

Direction agreed 2026-07-14 — **same screen, dual rendering by role**:

1. For members, render fields as plain text instead of disabled controls (value-as-text when
   `!canEdit`): no greyed inputs, no Save buttons, no per-card "only owners can…" notes.
   Disabled inputs communicate "editable, but not by you" (lock-out framing); plain text
   communicates "information" (fact framing).
2. Retitle the page by role: owners/admins get "Settings" + gear icon; members get
   "About this project" + info icon. Same route, tabs, and data fetching.
3. Member view shows facts members care about and omits meaningless knobs (e.g. "Park
   release: 300" can simply be absent rather than translated). MCP servers stay fully
   restricted; custom agent rules appear as a read-only list without download/delete
   (content-readability to be decided — download is reading, so "visible names, restricted
   content" vs "readable content" should be stated explicitly).

---

### UX-027 — Runtime settings: engine vocabulary and a 0-means-unlimited sentinel

- **Severity:** Minor
- **Area:** Project settings — General tab, Runtime card (`GeneralTab.tsx`)
- **Personas affected:** Owners/admins (including non-technical owners)

**Issue**

1. Card description: "Execution knobs for this project — the workflow is pinned at creation;
   scope is chosen per-intent." — "knobs", "pinned", "scope per-intent": three unexplained
   internal concepts in one sentence.
2. **"Park release (seconds)"** — engine terminology; even developers must read the help text
   ("How long a stage waiting for a human keeps its compute before release") to decode it,
   and the help text itself is infrastructure-speak. The user-meaningful framing: "How long
   to keep the agent ready while waiting for your answer."
3. **"Max parallel units: 0" where 0 = unbounded** — the zero-sentinel is a programmer
   convention; a user can plausibly set 0 intending "none/pause". Use an explicit
   "Unlimited" state (empty field with placeholder, or a toggle) and name the unit
   ("parallel work streams" needs defining or renaming — "units" is engine vocabulary).

**Recommendation**

Rewrite the card copy in outcome language, rename "Park release" to what it controls for the
user, replace the 0-sentinel with an explicit Unlimited affordance.

---

### UX-028 — Members tab: raw user UUIDs displayed; no visible last-owner safeguard

- **Severity:** Minor
- **Area:** Project settings — Members tab (`MembersTab.tsx`)
- **Personas affected:** Owners/admins

**Issue**

1. Each member row shows the internal user UUID truncated under the email
   ("53743802-000…") — debug data with no user value; another instance of the machine-ID
   pattern (UX-016).
2. The remove (trash) action appears on every row including the sole Owner's own row.
   `handleRemoveMember` calls the service directly (`MembersTab.tsx:185`) — no client-side
   guard against removing yourself or the last owner is visible. If the backend blocks it,
   the user gets an error after the fact; if it doesn't, a project can orphan itself.
   **Question to verify:** is last-owner removal blocked server-side?

**Positive (record):** the role legend at the bottom of the tab — plain-language descriptions
of Owner/Admin/Member — is exactly the right pattern, and worth reusing wherever roles appear
(e.g. the dashboard role badges).

**Recommendation**

Drop the UUID line (or move to tooltip); disable remove on the last owner with an explanatory
tooltip; confirm-dialog on self-removal ("You'll lose access to this project").

---

### UX-029 — Observability conflates two jobs: a redundant "mission control" landing page and a genuinely valuable execution-autopsy view

- **Severity:** Major
- **Area:** Observability — landing page (`ObservabilityDashboard.tsx`) vs intent execution view (`IntentObservabilityPage.tsx`)
- **Personas affected:** All

**Issue**

The observability section serves two distinct jobs with very different value:

- **Execution autopsy (per-intent view): keep and invest.** Stage-by-stage progress with
  durations, the detail panel (Depends on / Produces artifact chips, sensor results, per-stage
  tokens/credits/context), and "Restart from this stage" answer questions nothing else in the
  app answers. This is the advanced-audience power tool, and it's also the natural home of
  the "Usage & cost" panel (resolves the duplication flagged in UX-009 — remove from the
  project page, keep here).
- **Mission control (landing page): mostly redundant.** Intent status cards duplicate the
  dashboard/project pages; waiting signals duplicate the sidebar; the two unique panels
  ("Live activity — Listening for agent events…", "Active agents — No recent agent activity")
  are empty whenever nothing runs, which is most of the time. The page's default state is
  emptiness plus duplication.

Additional issues on the landing page:

1. **Contradictory state:** header badge says "1 active" while Active Agents says "No recent
   agent activity" (the waiting intent counts as active in one widget but not the other).
2. **"Business View — L3 · AWS Insights"** — "L3" is unexplained internal jargon; the
   LLM-generated content is thin ("Lowlights: test-collab-aidlc — no sprint started" ×4 —
   listing every project without a sprint as a lowlight is noise, and "sprint" is engine
   vocabulary here).
3. **"V2 INTENTS"** heading — the v2 jargon again (UX-003).
4. "Open in workbench" (execution view) — "workbench" is a new unexplained term for what is
   presumably the intent page.

**Recommendation**

1. Dissolve the landing page: move its one unique widget (live agent event stream) into the
   dashboard or the notification surface, and let the sidebar/dashboard attention signals
   (UX-002/007) carry the "what needs me" job.
2. Re-home the execution view as a tab of the intent ("Execution" or "Run details") — it's
   per-intent data; a separate top-level section adds navigation distance to content that
   belongs with the intent.
3. If a global ops view is still wanted for admins, make it admin-scoped and honest about its
   audience, rather than a default destination for everyone.

---

### UX-030 — Sensor chips: unexplained concept, and red FAIL/BLOCKED chips on succeeded stages

- **Severity:** Major
- **Area:** Observability execution view — stage rows and detail panel
- **Personas affected:** All viewers of the execution view

**Issue**

Stage rows carry chips like `required-sections`, `upstream-coverage`, `graph-coverage`,
`linter`, `type-check`, `reviewer:aidlc-architecture-reviewer-agent`, color-coded
green/amber/red. Problems:

1. **"Sensor" is never explained** — no legend, no tooltip; users must infer that these are
   automated quality checks attached to each stage.
2. **Red chips on green stages:** stages display "Succeeded" alongside red
   `upstream-coverage` (detail: "upstream-coverage FAIL") — a direct contradiction with no
   reconciliation. Did it succeed or fail? (Presumably sensors are advisory, not gating —
   but nothing says so.)
3. **"BLOCKED — sensor has no script"** for linter/type-check on a scaffolding stage — an
   engine-internal condition ("not applicable here") rendered with alarm vocabulary. Same
   pattern as UX-011: informational states dressed as failures.
4. The reviewer-agent chip (`reviewer:aidlc-architecture-reviewer-agent`) is a raw agent id —
   long, repeated on nearly every row, dominating the chip row.

**Recommendation**

Rename/introduce the concept (e.g. "Checks"), add a legend and per-chip tooltips ("Upstream
coverage: did this stage use everything its inputs provided? — advisory"). Reconcile the
semantics visually: if sensors are advisory, render failures as amber "worth a look", never
red FAIL next to Succeeded. Replace "BLOCKED — no script" with neutral "not applicable".
Shorten reviewer chips to "reviewed by Architecture Reviewer".

---

### UX-031 — Three views (Diagram / Graph / List) of the same execution data

- **Severity:** Minor
- **Area:** Observability execution view — view switcher
- **Personas affected:** All viewers of the execution view

**Issue**

Execution progress renders in three switchable representations. Each has a defensible job —
List (scan durations/statuses/sensors), Diagram (phase/unit structure), Graph (dependency
topology) — but three views triple maintenance, create choice paralysis ("which one should I
look at?"), and already diverge: the List shows sensor chips inline, the Diagram doesn't;
the Graph's dependency edges are barely visible dotted lines, adding little over the Diagram.

**Recommendation**

Consolidate to two: List (default — densest and most scannable) and one visual view. Diagram
with an optional "show dependencies" overlay would merge the Diagram/Graph jobs. If usage
telemetry exists, check which views are actually used before deciding. Ensure whatever
remains shows consistent information (same chips, same statuses).

---

### UX-032 — Scope-consequence copy: three phrasings of the same concept, best one not used consistently

- **Severity:** Minor
- **Area:** Compose Intent (`NewIntentPage.tsx` / composer) + Intent view (UX-011)
- **Personas affected:** All

**Issue**

The same fact — "narrower scope skips stages, so some inputs won't exist" — is phrased three
different ways across the product:

1. Compose scope picker: "7 downstream inputs will be absent." (amber warning icon)
2. AI proposal: "7 plan warnings (inputs expected absent / degraded sections) — **by design
   for lean runs**."
3. Intent view banner (UX-011): "Scope "feature" runs degraded — 7 declared inputs will not
   be produced in this scope"

Phrasing #2's strength is only the "by design" clause — its "plan warnings" wrapper is
meta-language (says *there are warnings* without saying what happened). #1 states the
concrete fact but reads as a problem. #3 reads as a malfunction. A user who sees all three
will wonder if they're the same issue or three different ones.

**Positive to record:** the compose flow now surfaces scope consequences *at choice time*
("Runs 14 of 32 stages · 11 approval gates") — this is the correct upstream fix for UX-011,
and "11 approval gates" doubles as an expectation-setter for how often the user will be
needed.

**Recommendation**

Agreed 2026-07-14 — standardize on one string family everywhere the concept appears
(scope picker, AI proposal, intent banner):

> **"Lean run: X broader steps are skipped on purpose — their outputs won't exist."**

The formula: concrete fact + intentionality marker, no meta-language ("warnings"), no
dataflow vocabulary ("downstream inputs"), no malfunction vocabulary ("degraded"). Neutral
info styling (not amber) in the picker; the UX-011 banner inherits the same copy.

---

### UX-033 — Stage checklist: slugs, strikethrough-as-skipped, and "fan out per unit of work"

- **Severity:** Minor
- **Area:** Compose Intent — "Stages to run" section
- **Personas affected:** Stakeholders primarily; new developers too

**Issue**

The expandable stage checklist is the right progressive-disclosure design (collapsed by
default, locked always-run stages, instant validation, phase grouping). Friction:

1. **Stage names are engine slugs** — `nfr-requirements`, `ci-pipeline`,
   `practices-discovery`, `approval-handoff`. No descriptions, no tooltips: a checkbox you
   can't evaluate is a checkbox you toggle blind. Even developers can't guess what
   `practices-discovery` produces.
2. **Strikethrough on unchecked stages** misreads: strikethrough conventionally means
   "deleted/unavailable", while these are "available, currently skipped". The checkbox alone
   carries the state; the strikethrough adds a second, conflicting metaphor.
3. **"3 stages fan out per unit of work"** — double jargon ("fan out", "unit of work") in the
   run-shape summary that otherwise speaks plainly.
4. The lock icons on INITIALIZATION rows are decipherable but unexplained (a tooltip —
   "always runs" — would close it; the section explainer says it, but only for those who
   read it).

**Recommendation**

Human names + one-line descriptions (tooltip or subtitle) per stage; drop the strikethrough,
dim instead; rephrase the fan-out line ("3 stages repeat for each work unit the plan
creates" or similar); tooltip on the lock.

---

### UX-034 — Compose with AI: strong pattern; unlabeled icon button, bare confidence %, opaque scope options

- **Severity:** Minor
- **Area:** Compose Intent — Compose with AI card
- **Personas affected:** All

**Issue**

The AI-proposal pattern is among the best in the app: clear promise ("proposes which stages
to run — you approve before anything applies"), a steering input with a concrete example
placeholder, a readable rationale, and a draft-only apply with explicit next step. Remaining
nits:

1. **Unlabeled icon button** next to "Compose" (file/upload glyph) — function is guesswork;
   needs a label or tooltip.
2. **"confidence 88%"** — a bare model statistic. Users can't act on the difference between
   88% and 74%; it invites false precision. Either translate to words ("high confidence") or
   drop it.
3. **Scope dropdown options are opaque at selection time** — the value is a bare word
   ("feature"); the rationale mentions alternatives (POC, MVP, enterprise) but the dropdown
   itself should carry a one-line description per option (e.g. "feature — build one
   capability, skip market research and ops setup") so the choice is understandable without
   running Compose.

**Recommendation**

Label the icon button; translate or drop the confidence number; add per-option descriptions
to the scope dropdown (they exist implicitly in the AI rationale — reuse those).

---

### UX-035 — Compose Intent: two jobs interleaved, AI assist placed before the thing it configures

- **Severity:** Major
- **Area:** Compose Intent — page structure (`NewIntentPage.tsx` / composer)
- **Personas affected:** All; stakeholders most

**Issue**

The page interleaves two distinct jobs:

- **Content** — "what do I want?" (Title, Prompt)
- **Run configuration** — "how should the system run it?" (Scope, Stages to run, Compose
  with AI)

and orders the configuration part against its own logic: the Compose with AI card — an
optional assistant **whose output is a scope + stage selection** — appears *above* the Scope
and Stages controls it configures. Reading top-down, a user meets the tool before the concept
it operates on. Scope and the stage checklist then appear below as seemingly independent
controls, so the AI path and the manual path read as two unrelated features rather than two
ways to produce the same run plan. Net effect: a screen where each component is individually
fine (see UX-032/033/034) but the whole feels complex and its optional-vs-required structure
is illegible.

**Recommendation**

Two options, in order of preference:

1. **AI-first with progressive disclosure (preferred — matches the product principle):**
   after the prompt, the system composes automatically and presents one proposal card —
   "Proposed: feature — 14 stages, 11 approval gates, 7 broader steps skipped on purpose" —
   with **Accept** and **Customize**. Scope dropdown and stage checklist live behind
   Customize. The common case is zero configuration; advanced users are one click from full
   control.
2. **Regrouped manual-first (cheaper):** a single "Run plan" section ordered concept-first —
   Scope dropdown → run-shape summary → Stages to run (expandable) — with the AI assist
   embedded inside that section ("Let AI propose this from your prompt"), so tool follows
   concept and both paths visibly produce the same thing.

Either way, visually separate the content block (Title/Prompt) from the run-plan block so
the page reads as two steps, not one long mixed form.

---

## Journey-level findings

These come from walking the end-to-end loop rather than individual screens.

### UX-036 — No notifications for the events that block agents: the async loop breaks silently

- **Severity:** Critical
- **Area:** Cross-cutting — only mechanism today is `MentionToasts.tsx` (discussion @mentions, in-app, online-only)
- **Personas affected:** All; the product's core loop

**Issue**

AI-DLC's rhythm is asynchronous: agents work for minutes-to-hours and park WAITING when they
need a human. The entire attention architecture reviewed so far (sidebar badges, dashboard
cards, "Questions for you") is **pull-based — it works only while the user is looking at the
app**. Today:

- The only push mechanism in the codebase is a toast stack for discussion @mentions
  (`MentionToasts.tsx`), online users only; its own header comment names offline/email
  delivery as a future item.
- **Agent-blocking events — question asked, gate waiting, run failed, run succeeded — produce
  no toast, no browser notification, no email. Nothing.**

Consequence: a PO closes the tab, the agent parks, compute is released after the park window
(UX-027's "Park release"), and the run waits hours for an answer nobody knows is pending. The
product's central promise ("human judgment without human bottlenecks") fails exactly at its
central mechanism.

**Field observation (2026-07-14):** even the one existing channel is unreliable-and-silent:
in a two-browser test, a mention toast appeared on the second attempt but not the first.
Every layer of the pipeline fails without feedback — an unparsed mention posts as plain text
indistinguishable from a parsed one; `broadcastToUser` no-ops silently on missing env config
(`services.js:84`); an offline/dropped WebSocket recipient misses the toast forever (no
retry, no history). Neither sender nor recipient can tell whether a notification fired.

**Recommendation**

Layered, in order of implementation value:

1. **In-app toasts** (bottom-right, reuse/extend the MentionToasts stack) for: question
   waiting, gate waiting, run failed, run succeeded. Click-through to the target.
2. **Browser notifications** (Notification API, permission-gated) for the same events when
   the tab is backgrounded — cheap once (1) exists.
3. **Email digest/immediate** for parked runs (offline users) — the "agent has been waiting
   4 hours" safety net. Needs backend; highest value for the PO persona.

Wire all three to one event taxonomy so preferences can be managed per user later. Add a
**persistent notification inbox** (bell icon + history) so a missed toast is recoverable —
this also gives mentions a delivery guarantee the ephemeral stack can't provide. Render
parsed mentions visibly (chip/highlight) in sent messages so senders can see whether the
mention took.

---

### UX-037 — The journey ends at "Open PR": no loop closure for the person who started the intent

- **Severity:** Major
- **Area:** Cross-cutting — intent completion; tracker integration
- **Personas affected:** Stakeholders most

**Issue**

Today the happy path terminates at a created PR (Work products → Code → "Open PR"). For
developers that's a natural hand-off; for the PO who wrote the intent, the story just stops:

1. No "what happens next" communication at completion — who reviews, when it merges, when
   it's live. The intent says SUCCEEDED while the feature is not actually done.
2. **The tracker round-trip is missing.** Intents can be *imported from* GitHub Issues/Jira,
   but nothing flows back: the source issue isn't commented with the PR link, isn't
   transitioned, isn't closed on merge. The PM tool — the stakeholder's home — never learns
   what AI-DLC did. (Owner suggestion 2026-07-14: comment the source issue with the PR when
   a tracker is connected; consider marking it done on merge.)
3. Planned mitigation exists for the review gap: `docs/plans/reintroduce-tech-business-review.md`
   reintroduces tech + business review stages inside construction with a triage gate — this
   will extend the in-product journey up to a reviewed PR. It does not, however, cover
   post-merge closure (merged/deployed/live feedback) or the tracker round-trip.

**Recommendation**

1. Completion panel on the intent: "What happens next" — PR link, expected reviewers, and
   (post-plan) the review reports.
2. Tracker write-back when a tracker is linked: comment the source issue with the PR link at
   completion; optionally transition/close on merge (configurable per project).
3. Longer term: merge/deploy signal back into the intent timeline so SUCCEEDED eventually
   becomes "merged" / "live" — the real end of the stakeholder's story.

---

### UX-038 — No teaching layer for the product's invented vocabulary

- **Severity:** Major
- **Area:** Cross-cutting — onboarding/help
- **Personas affected:** All new users; stakeholders most

**Issue**

Roughly a third of the findings in this review trace back to one root cause: AI-DLC has a
substantial invented vocabulary (intent, stage, scope, gate, unit of work, iteration,
artifact, derived item, sensor, workflow, block…) and **no mechanism anywhere that teaches
it** — no onboarding, no glossary, no first-use explanations, almost no contextual help.
Fixing individual strings (as many findings recommend) reduces the vocabulary load but cannot
eliminate it: some concepts are genuinely load-bearing and must be learned.

**Recommendation**

Owner direction (2026-07-14): an AWS-console-style **contextual help panel** — a right-side
panel openable from "?" affordances placed where concepts first appear (scope picker, stage
checklist, gate page, work products, sensors). Suggested implementation notes:

1. One markdown-driven help content set (concept → short explanation + link to docs), reused
   by every "?" — cheap to maintain, consistent voice.
2. Put "?" buttons at the concept's *decision points* (where the user must act on the
   concept), not on every occurrence.
3. The existing right panel (Agent/Timeline/Discuss/Preview) is a natural host — a Help tab
   or overlay keeps context visible while reading.
4. A one-page glossary in the docs site as the canonical reference the panel links to.

---

### UX-039 — No functional roles/personas: questions and gates can't reach the right person

- **Severity:** Major (roadmap-scale)
- **Area:** Cross-cutting — team collaboration model
- **Personas affected:** Teams (invisible in single-user testing)

**Issue**

Project membership today carries access roles (owner/admin/member) but no *functional* roles.
Consequently every question and gate is addressed to "whoever looks first": the PO sees plan-
approval questions full of file paths; the architect's attention isn't requested for
architecture decisions; in a real team, either everyone triages everything or things stall.
The question kinds already diverge visibly (UX-016: option-based product questions vs
technical plan approvals) — the routing just doesn't exist.

Owner direction (2026-07-14): introduce functional personas assignable to members —
po / dev / archi / secu / uxui / test-qa / business — with an open question: the workflow
definitions come from upstream AI-DLC methodology, so how does routing metadata attach?

**Recommendation (design sketch for the open question)**

Stages already declare their *nature* upstream (requirements-analysis, application-design,
build-and-test…). A small mapping — stage/question kind → suggested persona — could live
either upstream as stage frontmatter (`audience: po`) or platform-side as a default mapping
table, overridable per project. Routing then means: notify members holding that persona
first (ties into UX-036's notification taxonomy), while keeping questions visible to all
(suggested-assignee, not lock). This avoids hard dependency on upstream changes: the
platform-side mapping table works with today's workflows.

---

<!-- Template for new findings

### UX-0XX — Title

- **Severity:** Critical | Major | Minor
- **Area:** page/component + file path
- **Personas affected:** stakeholders | developers | all

**Issue**

**Evidence**

**Recommendation**

-->
