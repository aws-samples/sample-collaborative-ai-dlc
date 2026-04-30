import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { ProjectAgentInfo, StuckDetection, VelocityMetrics } from '@/hooks/useObservability';
import { buildInsights } from './buildInsights';

interface Props {
  projects: ProjectAgentInfo[];
  stuckDetections: StuckDetection[];
  velocityMap: Record<string, VelocityMetrics>;
}

// Never returns null — always renders something
export function BusinessView({ projects, stuckDetections, velocityMap }: Props) {
  const { highlights, lowlights, risks, actions } = buildInsights(projects, stuckDetections, velocityMap);

  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">Business View</span>
          <span className="text-[10px] text-muted-foreground/50">L3 · AWS Insights</span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {highlights.length > 0 && (
          <Section icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-600" />} label="Highlights" labelClass="text-green-700 dark:text-green-400">
            {highlights.map((h, i) => <Item key={i} text={h.text} color="text-green-800 dark:text-green-200" />)}
          </Section>
        )}
        {lowlights.length > 0 && (
          <Section icon={<Info className="h-3.5 w-3.5 text-yellow-500" />} label="Lowlights" labelClass="text-yellow-700 dark:text-yellow-400">
            {lowlights.map((l, i) => <Item key={i} text={l.text} color="text-yellow-800 dark:text-yellow-200" />)}
          </Section>
        )}
        {risks.length > 0 && (
          <Section icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />} label="Risks" labelClass="text-red-600 dark:text-red-400">
            {risks.map((r, i) => (
              <Item key={i} text={r.text} color={r.severity === 'high' ? 'text-red-800 dark:text-red-200' : 'text-orange-800 dark:text-orange-200'} />
            ))}
          </Section>
        )}
        {actions.length > 0 && (
          <Section icon={<Info className="h-3.5 w-3.5 text-blue-500" />} label="Action Items" labelClass="text-blue-600 dark:text-blue-400">
            {actions.map((a, i) => (
              <div key={i} className={cn('flex items-start gap-1.5 text-xs', a.done ? 'text-muted-foreground line-through' : 'text-foreground')}>
                <span className="mt-0.5 shrink-0">{a.done ? '☑' : '□'}</span>
                <span>{a.text}</span>
              </div>
            ))}
          </Section>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ icon, label, labelClass, children }: {
  icon: React.ReactNode; label: string; labelClass: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className={cn('flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-1.5', labelClass)}>
        {icon}{label}
      </div>
      <div className="space-y-1 pl-5">{children}</div>
    </div>
  );
}

function Item({ text, color }: { text: string; color: string }) {
  return <p className={cn('text-xs', color)}>• {text}</p>;
}
