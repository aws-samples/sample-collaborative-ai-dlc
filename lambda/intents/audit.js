// Tools that return targeted/compact context (sections, items, tocs, compact
// metadata) versus a full-document `get_artifact` read. Used to measure how
// much of the agents' context diet came from the fine-grained graph — the
// adoption signal for judging whether derivation/enrichment earns its cost.
const COMPACT_READ_TOOLS = new Set([
  'get_artifact_toc',
  'get_section',
  'get_items',
  'get_coverage',
  'lookup_artifacts',
  'get_intent_graph',
  'get_artifact_neighbors',
  'search_graph',
]);

// A get_artifact call only counts as a FULL read in 'full' mode; summary/toc
// modes are compact by construction (the read ledger records the mode arg).
const isFullRead = (r) => (r.tool ?? '') === 'get_artifact' && (r.args?.mode ?? 'full') === 'full';
const isCompactRead = (r) =>
  COMPACT_READ_TOOLS.has(r.tool ?? '') ||
  ((r.tool ?? '') === 'get_artifact' && (r.args?.mode ?? 'full') !== 'full');

const sumMetric = (rows, key) =>
  rows.reduce((n, row) => n + (typeof row.metrics?.[key] === 'number' ? row.metrics[key] : 0), 0);

const unitOf = (row) => row.unitSlug ?? null;

export const buildIntentAudit = ({ records = {} } = {}) => {
  const metrics = records.metrics ?? [];
  const graphReads = records.graphReads ?? [];
  const sensorRuns = records.sensorRuns ?? [];
  const events = records.events ?? [];
  const humanTasks = records.humanTasks ?? [];
  const stages = records.stages ?? [];

  const totalReadBytes = graphReads.reduce((n, r) => n + Number(r.bytes ?? 0), 0);
  const readsByTool = Object.values(
    graphReads.reduce((acc, r) => {
      const key = r.tool ?? 'unknown';
      acc[key] ??= { tool: key, calls: 0, bytes: 0, resultCount: 0 };
      acc[key].calls += 1;
      acc[key].bytes += Number(r.bytes ?? 0);
      acc[key].resultCount += Number(r.resultCount ?? 0);
      return acc;
    }, {}),
  ).toSorted((a, b) => b.bytes - a.bytes || a.tool.localeCompare(b.tool));

  const metricsByKey = metrics.reduce((acc, row) => {
    for (const [k, v] of Object.entries(row.metrics ?? {})) {
      if (typeof v !== 'number') continue;
      acc[k] ??= { key: k, samples: 0, total: 0, max: v };
      acc[k].samples += 1;
      acc[k].total += v;
      acc[k].max = Math.max(acc[k].max, v);
    }
    return acc;
  }, {});

  const failedSensors = sensorRuns.filter((s) => s.result && s.result !== 'PASS');

  // ── Enrichment / graph-usefulness block ──
  // Answers "is the derived graph + enrichment mechanism paying off?" from
  // data we already collect: enrichment spend (METRIC rows stamped with the
  // `enrichmentCalls` marker by derive-artifacts) vs. how much of the agents'
  // context diet came from compact graph reads instead of full documents.
  const enrichmentRows = metrics.filter((row) => Number(row.metrics?.enrichmentCalls ?? 0) > 0);
  const compactReads = graphReads.filter(isCompactRead);
  const fullReads = graphReads.filter(isFullRead);
  const compactBytes = compactReads.reduce((n, r) => n + Number(r.bytes ?? 0), 0);
  const fullBytes = fullReads.reduce((n, r) => n + Number(r.bytes ?? 0), 0);
  const enrichment = {
    // Mode the execution ran with (snapshotted at intent create; 'off' for
    // executions predating the setting).
    mode: records.meta?.deriveEnrichment === 'llm' ? 'llm' : 'off',
    calls: sumMetric(enrichmentRows, 'enrichmentCalls'),
    tokensInput: sumMetric(enrichmentRows, 'tokensInput'),
    tokensOutput: sumMetric(enrichmentRows, 'tokensOutput'),
    credits: sumMetric(enrichmentRows, 'credits'),
    // Compact-read adoption: share of graph-read traffic served by targeted
    // reads. High adoption + low full-read bytes = the projection is used.
    reads: {
      compactCalls: compactReads.length,
      compactBytes,
      fullCalls: fullReads.length,
      fullBytes,
      compactShare:
        compactBytes + fullBytes > 0
          ? Math.round((compactBytes / (compactBytes + fullBytes)) * 100) / 100
          : null,
    },
  };

  const advisories = [];
  if (totalReadBytes > 250_000) {
    advisories.push({
      kind: 'context-heavy',
      severity: 'warning',
      summary: `Graph reads returned ${totalReadBytes} bytes; inspect high-byte tools and prefer sections/items.`,
    });
  }

  // ── Derivation / structure-contract compliance block ──
  // "Did the projection actually get built, and did agents follow the
  // structure contracts?" — derive events + the structured_block detail the
  // required-sections sensor stamps per produced artifact.
  const deriveEvents = events.filter((e) => String(e.type ?? '').startsWith('v2.derive.'));
  const eventCount = (type) => deriveEvents.filter((e) => e.type === type).length;
  const structuredChecks = sensorRuns
    .filter((s) => s.sensorId === 'required-sections')
    .flatMap((s) => s.detail?.artifacts ?? [])
    .filter((a) => a.structured_block !== undefined);
  const blockCounts = { present: 0, absent: 0, malformed: 0 };
  const absentArtifacts = new Set();
  for (const check of structuredChecks) {
    blockCounts[check.structured_block] = (blockCounts[check.structured_block] ?? 0) + 1;
    if (check.structured_block === 'absent') absentArtifacts.add(check.artifact ?? check.id ?? '?');
  }
  const derivation = {
    runs: eventCount('v2.derive.completed') + eventCount('v2.derive.partial'),
    failures: eventCount('v2.derive.failed'),
    partial: eventCount('v2.derive.partial'),
    enrichmentSkips: eventCount('v2.derive.enrichment_skipped'),
    structuredBlocks: {
      checked: structuredChecks.length,
      ...blockCounts,
      // The field-test number: share of registered artifacts whose structured
      // block was present and parseable.
      complianceRate:
        structuredChecks.length > 0
          ? Math.round((blockCounts.present / structuredChecks.length) * 100) / 100
          : null,
    },
  };

  // ── Write-side context ledger ──
  // What we PUSH into fresh stage prompts (run-stage records one sample per
  // fresh run). Joined with the read ledger above, this answers "does the
  // compiled graph context pay for itself": promptContext.compiledContextBytes
  // is the machinery's prompt cost; the compact-read adoption is its return.
  const promptRows = metrics.filter((row) => typeof row.metrics?.promptBytes === 'number');
  const promptContext = {
    samples: promptRows.length,
    promptBytes: sumMetric(promptRows, 'promptBytes'),
    compiledContextBytes: sumMetric(promptRows, 'compiledContextBytes'),
    avgPromptBytes:
      promptRows.length > 0
        ? Math.round(sumMetric(promptRows, 'promptBytes') / promptRows.length)
        : null,
  };
  if (absentArtifacts.size > 0) {
    advisories.push({
      kind: 'structured-block-missing',
      severity: 'advisory',
      summary: `Structured block absent on: ${[...absentArtifacts].toSorted().join(', ')} — typed items were not derived for them.`,
    });
  }
  if (derivation.failures > 0) {
    advisories.push({
      kind: 'derivation-failed',
      severity: 'warning',
      summary: `${derivation.failures} derive run(s) failed; the graph projection may be stale for the affected stages.`,
    });
  }

  for (const s of failedSensors) {
    advisories.push({
      kind: 'sensor-finding',
      severity: s.held ? 'blocking' : 'advisory',
      summary: `${s.sensorId ?? 'sensor'} returned ${s.result}`,
      stageInstanceId: s.stageInstanceId ?? null,
    });
  }
  // Enrichment ran but nothing consumed the compact projection — flag the
  // spend so the Admin can judge whether to keep the toggle on.
  if (enrichment.mode === 'llm' && enrichment.calls > 0 && compactReads.length === 0) {
    advisories.push({
      kind: 'enrichment-unused',
      severity: 'warning',
      summary: `Enrichment made ${enrichment.calls} summary call(s) but no compact graph reads followed; consider turning the toggle off.`,
    });
  }

  // ── Per-unit lane split ──
  // Reads and token spend attributed to unit lanes (rows carry unitSlug).
  // Lets the audit compare lanes and spot a context-hungry unit.
  const unitRollup = new Map();
  for (const r of graphReads) {
    const slug = unitOf(r);
    if (!slug) continue;
    const u = unitRollup.get(slug) ?? {
      unitSlug: slug,
      readCalls: 0,
      readBytes: 0,
      tokensInput: 0,
      tokensOutput: 0,
    };
    u.readCalls += 1;
    u.readBytes += Number(r.bytes ?? 0);
    unitRollup.set(slug, u);
  }
  for (const m of metrics) {
    const slug = unitOf(m);
    if (!slug) continue;
    const u = unitRollup.get(slug) ?? {
      unitSlug: slug,
      readCalls: 0,
      readBytes: 0,
      tokensInput: 0,
      tokensOutput: 0,
    };
    u.tokensInput += typeof m.metrics?.tokensInput === 'number' ? m.metrics.tokensInput : 0;
    u.tokensOutput += typeof m.metrics?.tokensOutput === 'number' ? m.metrics.tokensOutput : 0;
    unitRollup.set(slug, u);
  }
  const units = [...unitRollup.values()].toSorted((a, b) => a.unitSlug.localeCompare(b.unitSlug));

  return {
    summary: {
      stageCount: stages.length,
      eventCount: events.length,
      humanTaskCount: humanTasks.length,
      metricSamples: metrics.length,
      graphReadCalls: graphReads.length,
      graphReadBytes: totalReadBytes,
      sensorRuns: sensorRuns.length,
      sensorFindings: failedSensors.length,
    },
    graphReads: { totalBytes: totalReadBytes, byTool: readsByTool },
    enrichment,
    derivation,
    promptContext,
    units,
    metrics: Object.values(metricsByKey).toSorted((a, b) => a.key.localeCompare(b.key)),
    sensors: {
      runs: sensorRuns.length,
      findings: failedSensors.map((s) => ({
        sensorId: s.sensorId,
        result: s.result,
        severity: s.severity,
        held: Boolean(s.held),
        stageInstanceId: s.stageInstanceId ?? null,
        detail: s.detail ?? null,
      })),
    },
    advisories,
  };
};
