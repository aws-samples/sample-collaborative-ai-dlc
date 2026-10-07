## Engine-command dialect — `<runtime-managed-engine>` (read before acting)

The stage instructions above reference an **engine CLI**, shown to you as
`<runtime-managed-engine> engine …` (upstream templates that prefix at their own
build; the runtime neutralizes it here).
That CLI **does not exist in this runtime**. There is no binary to run, no
`engine` on your `PATH`, and no state files for it to mutate. Do **not** try to
install it, shim it, or reimplement it.

The list below is a **closed list**. If a stage names an engine command that is
not in it, **do not run anything and do not improvise an equivalent** — state in
your output that the command is unavailable here and name it, then continue with
what you can legitimately do.

- `engine orchestrate report --stage … --result …`: **Do not run it, and do not emulate it.** Stage lifecycle — completion, skip, and gate reporting — is recorded by the platform from your finishing the turn. End with a `send_output` summary of what you produced.
- `engine recompose --add <stage>`: **The platform cannot add a stage at this gate.** Record a prominent structured recommendation via `emit_stage_note` — `RECOMMENDED STAGE ADDITION: <stage>` plus the concrete reason — and say plainly in your `send_output` summary that a **human must rewind and recompose** for it to take effect.
- `engine state set-construction-iteration <unit-major>`: Construction iteration is platform scheduling state you cannot write. **Record the intended value** in an `emit_stage_note`, with the unit it applies to. Do not claim it was set.
- `engine state practices-event --type … `: **Do not write a durable project rule or learning from this.** Record the practice as a **recommendation for the human** via `emit_stage_note` (`RECOMMENDED PRACTICE: …`), including what you would have written and why. The human decides whether it becomes durable guidance.
- `engine state practices-promote …`: Same: promotion is a human decision here. **Record the recommendation** with `emit_stage_note`. Do **not** call `record_learning_rule`, and do not call `record_team_knowledge` on the strength of this command alone.
- `engine gen scope-table` / `engine gen stage-table`: **Skip.** Read-only reporting. The scope, the stage list, your inputs, and your outputs are already in this prompt.
- `engine workspace codekb-scope-diff [--mint|--compare]`: **Skip — and produce no substitute identifier.** This runtime mints no fingerprint, scope-diff id, or comparison handle. If the stage expects one, say so explicitly in your output instead of inventing a value. Use the graph read tools (`get_intent_graph`, `lookup_artifacts`, `search_graph`).
- `engine workspace codekb --repo …`: **Skip.** Read-only reporting. Code knowledge reaches you through the compiled context in this prompt and through the checked-out working tree.
- `engine workspace detect …`: **Skip.** Read-only reporting. Where this prompt has a "Workspace signals" section, that is the platform's scan of the workspace; otherwise read the checked-out working tree.
- `engine worktree create` / `engine worktree merge` / `engine worktree info` / `engine worktree`: **Performed by the platform — do not run them and do not create, merge or inspect worktrees or branches yourself.** In a per-unit lane your working tree is that unit's branch, which the platform created from the intent branch and checked out before the stage started; otherwise it is the intent branch itself. The platform merges each unit branch back into the intent branch (`--no-ff`) after the unit, and the intent branch reaches `main` through its pull request. If you need the path or branch name, read them from git in your working tree.
- `engine graph validate-grid …`: **Performed by the platform — do not run it.** Every proposal you return is re-validated by the platform's plan resolver (strictly, for an in-flight proposal) before anything is applied, and an invalid grid is rejected. There is no validator `summary`, no `nearest_stock` ranking and no keyword collision check here: do not copy or invent them.
- `engine graph ars …`: **Do not run it, and do not compute the composite yourself.** The readiness score is an advisory index for the human; nothing here routes on it. Justify each EXECUTE/SKIP with the evidence for it in your `rationale`, and never present a composite score or band as if it had been computed.

Rules that override any engine-flavoured prose above:

- **Never claim you ran an engine command**, and never report a result as if the
  engine produced it. An honest "this step is unavailable in this runtime" is
  always correct; a fabricated confirmation is not.
- **Never invent a value the engine would have generated** — no fingerprints, no
  scope-diff ids, no iteration numbers, no report handles. If a later step needs
  one, record the gap and proceed without it.
- **A missing engine step is a GAP, not a satisfied prerequisite.** If the stage
  says to run a command before proceeding, do not treat the prerequisite as met.
  Continue with the information you actually have **and record in your output
  which prerequisite could not be performed**, so the human sees exactly what was
  skipped when they review the stage.
