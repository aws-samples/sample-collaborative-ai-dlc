// Intent Audit — process-evidence drill-down for one intent: what the agents
// READ from the business graph (the attention ledger), what derive-time
// enrichment cost, sensor findings, and derived advisories. This page is how
// an Admin judges whether the graph projection / enrichment toggle earn their
// keep: compact-read adoption vs. enrichment spend, per intent.
//
// Routed page following IntentGraphPage/IntentObservabilityPage: ids/loading
// from IntentContext, the audit DTO fetched lazily with a tiny module cache.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService, type IntentAudit } from '@/services/intents';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { ArrowLeft, Sparkles } from 'lucide-react';

const AUDIT_CACHE_MAX = 20;
const auditCache = new Map<string, IntentAudit>();

function trimAuditCache() {
  while (auditCache.size > AUDIT_CACHE_MAX) {
    const oldest = auditCache.keys().next().value!;
    auditCache.delete(oldest);
  }
}

const formatBytes = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
};

const formatCount = (n: number): string => n.toLocaleString();

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

export default function IntentAuditPage() {
  const { projectId, intentId, detail, loading: contextLoading, error: contextError } = useIntent();
  const navigate = useNavigate();
  const { project } = useProjectCache(projectId);

  const key = `${projectId}#${intentId}`;
  const [audit, setAudit] = useState<IntentAudit | null>(() => auditCache.get(key) ?? null);
  const [loading, setLoading] = useState(() => !auditCache.get(key));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !intentId) return;
    let cancelled = false;
    const k = `${projectId}#${intentId}`;
    const hit = auditCache.get(k);
    if (hit) {
      setAudit(hit);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    intentsService
      .audit(projectId, intentId)
      .then((a) => {
        auditCache.set(k, a);
        trimAuditCache();
        if (!cancelled) setAudit(a);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load intent audit');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId]);

  if ((contextLoading || loading) && !audit) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (contextError || error || !audit) {
    return (
      <div className="text-sm text-destructive">{contextError ?? error ?? 'Audit unavailable'}</div>
    );
  }

  const { summary, graphReads, enrichment, derivation, promptContext, units, sensors, advisories } =
    audit;
  const sharePct =
    enrichment.reads.compactShare != null ? Math.round(enrichment.reads.compactShare * 100) : null;
  const compliancePct =
    derivation.structuredBlocks.complianceRate != null
      ? Math.round(derivation.structuredBlocks.complianceRate * 100)
      : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate(`/space/${projectId}/intent/${intentId}`)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Back to workbench"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h1 className="text-lg font-bold tracking-tight truncate">
              {project?.name ?? 'Space'}
            </h1>
            <span className="text-xs text-muted-foreground truncate max-w-[240px]">
              {detail?.intent.title ?? intentId}
            </span>
            <Badge variant="outline" className="text-[10px] h-5 bg-muted/40">
              Audit
            </Badge>
          </div>
        </div>

        {/* ── SUMMARY ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Process summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
              <SummaryStat label="Stages" value={formatCount(summary.stageCount)} />
              <SummaryStat label="Events" value={formatCount(summary.eventCount)} />
              <SummaryStat label="Human tasks" value={formatCount(summary.humanTaskCount)} />
              <SummaryStat label="Metric samples" value={formatCount(summary.metricSamples)} />
              <SummaryStat label="Graph reads" value={formatCount(summary.graphReadCalls)} />
              <SummaryStat label="Read volume" value={formatBytes(summary.graphReadBytes)} />
              <SummaryStat label="Sensor runs" value={formatCount(summary.sensorRuns)} />
              <SummaryStat label="Findings" value={formatCount(summary.sensorFindings)} />
            </div>
          </CardContent>
        </Card>

        {/* ── ENRICHMENT & COMPACT-READ ADOPTION ─────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                Graph enrichment
              </CardTitle>
              <Badge
                variant="outline"
                className={
                  enrichment.mode === 'llm'
                    ? 'text-[10px] h-5 bg-agent-running/10 text-agent-running border-agent-running/30'
                    : 'text-[10px] h-5 text-muted-foreground'
                }
              >
                {enrichment.mode === 'llm' ? 'LLM summaries on' : 'off'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryStat label="Summary calls" value={formatCount(enrichment.calls)} />
              <SummaryStat
                label="Enrichment tokens"
                value={formatCount(enrichment.tokensInput + enrichment.tokensOutput)}
              />
              <SummaryStat
                label="Enrichment credits"
                value={enrichment.credits ? enrichment.credits.toFixed(2) : '0'}
              />
              <SummaryStat
                label="Compact reads"
                value={`${formatCount(enrichment.reads.compactCalls)} / ${formatCount(
                  enrichment.reads.compactCalls + enrichment.reads.fullCalls,
                )}`}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  Compact-read share — {formatBytes(enrichment.reads.compactBytes)} targeted vs{' '}
                  {formatBytes(enrichment.reads.fullBytes)} full-document
                </span>
                <span className="tabular-nums">{sharePct != null ? `${sharePct}%` : '—'}</span>
              </div>
              <Progress value={sharePct ?? 0} className="h-1.5" />
              <p className="text-[11px] text-muted-foreground">
                High share = agents orient via sections/items/summaries instead of loading whole
                documents. Judge enrichment by this adoption against its token/credit spend above.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── DERIVATION & STRUCTURE COMPLIANCE ──────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Graph derivation & structure compliance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryStat label="Derive runs" value={formatCount(derivation.runs)} />
              <SummaryStat label="Derive failures" value={formatCount(derivation.failures)} />
              <SummaryStat
                label="Blocks checked"
                value={formatCount(derivation.structuredBlocks.checked)}
              />
              <SummaryStat
                label="Contract compliance"
                value={compliancePct != null ? `${compliancePct}%` : '—'}
              />
            </div>
            {derivation.structuredBlocks.checked > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Structured blocks: {derivation.structuredBlocks.present} present,{' '}
                {derivation.structuredBlocks.absent} absent, {derivation.structuredBlocks.malformed}{' '}
                malformed. Absent blocks mean typed graph items were not derived for those artifacts
                — the compliance signal for the prompt-injected structure contracts.
              </p>
            )}
            {promptContext.samples > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Prompt context (write side): {promptContext.samples} fresh stage prompt(s),{' '}
                {formatBytes(promptContext.promptBytes)} total (avg{' '}
                {formatBytes(promptContext.avgPromptBytes ?? 0)}), of which{' '}
                {formatBytes(promptContext.compiledContextBytes)} was compiled graph context — weigh
                this cost against the compact-read adoption above.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── READS BY TOOL ──────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Graph reads by tool</CardTitle>
          </CardHeader>
          <CardContent>
            {graphReads.byTool.length === 0 ? (
              <span className="text-xs text-muted-foreground">No graph reads recorded</span>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 font-medium">Tool</th>
                    <th className="py-1.5 font-medium text-right">Calls</th>
                    <th className="py-1.5 font-medium text-right">Bytes</th>
                    <th className="py-1.5 font-medium text-right">Results</th>
                    <th className="py-1.5 font-medium text-right">Avg bytes/call</th>
                  </tr>
                </thead>
                <tbody>
                  {graphReads.byTool.map((t) => (
                    <tr key={t.tool} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 font-mono">{t.tool}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatCount(t.calls)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatBytes(t.bytes)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCount(t.resultCount)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatBytes(Math.round(t.bytes / Math.max(1, t.calls)))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* ── PER-UNIT LANE SPLIT ────────────────────────────────────── */}
        {units.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Unit lanes</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 font-medium">Unit</th>
                    <th className="py-1.5 font-medium text-right">Reads</th>
                    <th className="py-1.5 font-medium text-right">Read bytes</th>
                    <th className="py-1.5 font-medium text-right">Tokens in</th>
                    <th className="py-1.5 font-medium text-right">Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u.unitSlug} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 font-mono">{u.unitSlug}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatCount(u.readCalls)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatBytes(u.readBytes)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCount(u.tokensInput)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCount(u.tokensOutput)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* ── ADVISORIES + SENSOR FINDINGS ───────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Advisories & sensor findings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {advisories.length === 0 && sensors.findings.length === 0 ? (
              <span className="text-xs text-muted-foreground">Nothing flagged</span>
            ) : (
              <>
                {advisories.map((a, i) => (
                  <div key={`adv-${i}`} className="flex items-start gap-2 text-xs">
                    <Badge
                      variant="outline"
                      className={
                        a.severity === 'blocking'
                          ? 'text-[10px] h-5 shrink-0 bg-destructive/10 text-destructive border-destructive/30'
                          : 'text-[10px] h-5 shrink-0 bg-muted/40'
                      }
                    >
                      {a.kind}
                    </Badge>
                    <span className="text-muted-foreground">{a.summary}</span>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
