// Unit-kind pruning — PURE helpers for V2's `produces_kinds` narrowing
// (upstream ≥2.2.18): a stage may declare that an artifact only applies to
// units of certain kinds (service | spec | ui | packaging | library). At
// per-unit dispatch the engine prunes non-matching artifacts from BOTH the
// output contract the agent sees and the set the sensors/coverage inspect; a
// stage whose whole required set prunes away for a unit is a deterministic
// no-op the scheduler skips without a spawn.
//
// Rules (mirroring the upstream engine):
//   - a unit with no kind (untagged) gets the FULL artifact matrix;
//   - an artifact not listed in producesKinds applies to EVERY kind;
//   - a listed artifact applies only to units whose kind is in its list.
//
// Consumed by the orchestrator's lane scheduler (skip decision) and the
// runtime's run-stage (effective output contract). Kept here so the two sides
// can never disagree.

// The kinds an artifact applies to, or null for "all kinds".
const kindsFor = (producesKinds, artifact) => {
  const kinds = producesKinds?.[artifact];
  return Array.isArray(kinds) && kinds.length > 0 ? kinds : null;
};

// Does `artifact` apply to a unit of `unitKind` under `producesKinds`?
const artifactAppliesToKind = (producesKinds, artifact, unitKind) => {
  if (!unitKind) return true; // untagged unit → full matrix
  const kinds = kindsFor(producesKinds, artifact);
  return kinds == null || kinds.includes(unitKind);
};

// Prune a stage instance's outputArtifacts ({ artifact, optional?, … }) for
// one unit. Returns { outputs, pruned } — `outputs` keeps the original entry
// objects (flags intact), `pruned` lists the artifact names removed so the
// caller can record WHY the contract shrank.
const pruneOutputArtifactsForUnit = (outputArtifacts, producesKinds, unitKind) => {
  const outputs = [];
  const pruned = [];
  for (const o of outputArtifacts ?? []) {
    const artifact = o?.artifact ?? o;
    if (artifactAppliesToKind(producesKinds, artifact, unitKind)) outputs.push(o);
    else pruned.push(artifact);
  }
  return { outputs, pruned };
};

// True when EVERY required (non-optional) output of the stage prunes away for
// this unit kind — the whole stage is a no-op for the unit and the scheduler
// skips the dispatch. A stage with no required outputs at all never no-ops
// this way (it may exist for its side effects), and an untagged unit never
// prunes anything.
const stageIsNoopForUnit = (outputArtifacts, producesKinds, unitKind) => {
  if (!unitKind) return false;
  const required = (outputArtifacts ?? []).filter((o) => !(o?.optional ?? false));
  if (required.length === 0) return false;
  return required.every((o) => !artifactAppliesToKind(producesKinds, o?.artifact ?? o, unitKind));
};

export { artifactAppliesToKind, pruneOutputArtifactsForUnit, stageIsNoopForUnit };
export default { artifactAppliesToKind, pruneOutputArtifactsForUnit, stageIsNoopForUnit };
