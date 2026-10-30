// Static orientation evidence from Git data. No project code is executed.
const SOURCE =
  /\.(py|[cm]?[jt]sx?|vue|svelte|go|rs|java|kt|kts|swift|rb|php|cs|fs|c|cc|cpp|cxx|h|hh|hpp|m|mm|scala|ex|exs|erl|clj|dart|lua|zig)$/;
const readable = (path) =>
  path.endsWith('.py') || (/\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path));
const production = (role) => ['source', 'runtime-input', 'infrastructure'].includes(role);

function roleOf(path, isTest) {
  if (isTest(path)) return 'test';
  if (path.startsWith('lambda/agentcore/prompts/')) return 'runtime-input';
  if (/^(docs|aidlc-docs)\//.test(path) || /\.(md|mdx|rst|adoc)$/i.test(path))
    return 'documentation';
  if (
    /^(terraform|scripts|\.github)\//.test(path) ||
    /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|compose[^/]*)$|\.(tf|tfvars|sh|ya?ml)$/.test(path)
  )
    return 'infrastructure';
  if (SOURCE.test(path)) return 'source';
  if (/\.(json|toml|ini|conf|cfg|env|lock)$|(^|\/)(requirements[^/]*\.txt|Makefile)$/.test(path))
    return 'runtime-input';
  return 'unknown';
}

function annotationOf(change, rows) {
  const matched = rows.filter(
    (row) => row.of === change.path && row.evidence === 'name-match' && !row.isChanged,
  ).length;
  const imports = rows.filter(
    (row) => row.of === change.path && row.evidence === 'import-fallback' && !row.isChanged,
  ).length;
  const reach = matched
    ? `${matched} static name-match target${matched === 1 ? '' : 's'}`
    : imports
      ? `${imports} file-level import-link target${imports === 1 ? '' : 's'}`
      : change.reachStatus === 'unavailable'
        ? 'static reach unavailable'
        : 'no static reach detected';
  return {
    path: change.path,
    leafId: change.leafId,
    title: change.path.split('/').at(-1),
    detail: `${change.status} file · ${reach}`,
    kind: change.kind,
    role: change.role,
  };
}

export function evidenceOf({
  frame,
  facts,
  changes,
  read,
  graph,
  baseGraph,
  reachOf,
  isTest,
  anchors,
  revision,
  mapDigest,
}) {
  const changed = new Set(changes.map(({ path }) => path));
  const eligible = changes.filter(
    (c) => !c.isNew && !c.isDeleted && readable(c.path) && (facts.lines.get(c.path) ?? 0) <= 20_000,
  );
  const selected = new Set(eligible.slice(0, 40).map(({ path }) => path));
  const reachByCause = [];
  const result = changes.map((change) => {
    const { path } = change;
    const shape = read?.shapes?.get(path);
    const kind = shape?.kind ?? 'file';
    const role = roleOf(path, isTest);
    const semantic = kind !== 'comments' && kind !== 'imports';
    const status = change.isDeleted ? 'deleted' : change.isNew ? 'added' : 'modified';
    let fallbackReason = null;
    if (production(role) && kind === 'file') {
      fallbackReason =
        read?.fallbacks?.get(path) ??
        (change.isDeleted
          ? baseGraph
            ? 'deleted-file-base-import-fallback'
            : 'deleted-head-graph-unavailable'
          : change.isNew
            ? 'new-file'
            : !readable(path)
              ? 'unsupported-language'
              : (facts.lines.get(path) ?? 0) > 20_000
                ? 'head-line-limit'
                : !selected.has(path)
                  ? 'declaration-file-limit'
                  : read?.added?.has(path)
                    ? 'module-level-or-unparsed'
                    : 'declaration-read-unavailable');
    }
    const sourceGraph = change.isDeleted ? baseGraph : graph;
    const rows =
      !production(role) || !semantic
        ? []
        : kind === 'file'
          ? sourceGraph
            ? reachOf(sourceGraph, [path], 3).map((row) => ({ ...row, of: path, uses: null }))
            : []
          : (read?.users ?? []).filter(({ of }) => of === path);
    const ownRows = rows.map((row) => ({
      of: path,
      path: row.path,
      via: row.via,
      hop: row.hop,
      uses: row.uses ?? null,
      evidence:
        row.uses == null ? 'import-fallback' : row.uses > 0 ? 'name-match' : 'transit-import',
      isChanged: changed.has(row.path),
      targetRole: roleOf(row.path, isTest),
    }));
    reachByCause.push(...ownRows);
    const uncertain =
      production(role) &&
      semantic &&
      (fallbackReason === 'deleted-head-graph-unavailable' ||
        (kind === 'file' && rows.length === 0 && (role !== 'source' || !readable(path))));
    const { section, leaf } = frame.assign(path);
    return {
      id: path,
      path,
      role,
      kind,
      status,
      added: change.added,
      deleted: change.deleted,
      sectionId: section.id,
      leafId: leaf.id,
      anchor: anchors?.get(path) ?? null,
      touches: (shape?.touches ?? []).map(({ name, owner, kind: touchKind }) => ({
        name,
        ...(owner === undefined ? {} : { owner }),
        kind: touchKind,
      })),
      analysisMode: !production(role)
        ? 'not-applicable'
        : kind === 'file'
          ? 'file-wide'
          : 'declaration',
      fallbackReason,
      reachStatus: uncertain ? 'unavailable' : rows.length ? 'observed' : 'not-detected',
    };
  });
  reachByCause.sort(
    (a, b) => a.of.localeCompare(b.of) || a.hop - b.hop || a.path.localeCompare(b.path),
  );
  const ranked = result.toSorted((a, b) => {
    const named = (change) =>
      reachByCause.some(
        (row) => row.of === change.path && row.evidence === 'name-match' && !row.isChanged,
      );
    return (
      Number(production(b.role) && named(b)) - Number(production(a.role) && named(a)) ||
      Number(production(b.role)) - Number(production(a.role)) ||
      b.added + b.deleted - a.added - a.deleted ||
      a.path.localeCompare(b.path)
    );
  });
  const chosen = ranked.slice(0, 1);
  if (ranked.length > 1)
    chosen.push(ranked.slice(1).find((c) => c.leafId !== chosen[0].leafId) ?? ranked[1]);
  const reached = (predicate) =>
    new Set(
      reachByCause
        .filter((r) => !r.isChanged && r.evidence !== 'transit-import' && predicate(r.targetRole))
        .map((r) => r.path),
    ).size;
  return {
    version: 1,
    analysis: {
      toolRevision: revision,
      mapDigest,
      comparison: 'merge-base-to-head',
      declarationLimits: { files: 40, headLines: 20_000, words: 60 },
      declarationSelection: {
        eligibleFiles: eligible.length,
        selectedFiles: selected.size,
        omittedFiles: Math.max(0, eligible.length - selected.size),
      },
      reachLimits: { fileFallbackHops: 3, symbolHops: 64 },
      limitations: [
        'Static import-linked name matches do not prove execution or API visibility.',
        'Import fallback is file-wide, not declaration-level impact.',
        'Infrastructure and runtime inputs can affect consumers absent from static imports.',
        'File-wide shapes cannot distinguish all module-level edits from failed source reads.',
        'Known lexical ambiguity falls back to file-wide imports, without named declaration claims.',
        "Paths outside the fixed map use Other files; paths without a child match use their section's fallback; new paths use deterministic fallback positions.",
      ],
    },
    changes: result,
    reachByCause,
    summary: {
      productionChanges: result.filter(({ role }) => production(role)).length,
      testChanges: result.filter(({ role }) => role === 'test').length,
      documentationChanges: result.filter(({ role }) => role === 'documentation').length,
      nameMatchTargets: reachByCause.filter(({ evidence }) => evidence === 'name-match').length,
      importFallbackTargets: reachByCause.filter(({ evidence }) => evidence === 'import-fallback')
        .length,
      transitTargets: reachByCause.filter(({ evidence }) => evidence === 'transit-import').length,
      productionReachFiles: reached(production),
      testReachFiles: reached((role) => role === 'test'),
      unavailableReachFiles: result.filter((c) => c.reachStatus === 'unavailable').length,
    },
    annotations: chosen.map((change, index) => ({
      key: index === 0 ? 'A' : 'B',
      ...annotationOf(change, reachByCause),
    })),
  };
}
