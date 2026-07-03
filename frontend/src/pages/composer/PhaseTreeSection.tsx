import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trash2 } from 'lucide-react';
import { AddPhaseDialog } from './AddPhaseDialog';
import type { PhaseNode } from '@/services/workflows';

interface PhaseTreeSectionProps {
  phases: PhaseNode[];
  readOnly: boolean;
  onAddPhase: (phaseId: string, name: string, path: string) => void;
  onRemovePhase: (path: string) => void;
}

export function PhaseTreeSection({
  phases,
  readOnly,
  onAddPhase,
  onRemovePhase,
}: PhaseTreeSectionProps) {
  const topPaths = phases.filter((p) => !p.path.includes('.')).map((p) => p.path);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Phase tree</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Your own phases, defined inline. Order and nesting follow the path (e.g. 01, 01.02).
        </p>
        {phases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No phases yet.</p>
        ) : (
          <ul className="space-y-1">
            {phases.map((p) => (
              <li
                key={p.path}
                className="flex items-center gap-2 text-sm"
                style={{ paddingLeft: `${(p.path.split('.').length - 1) * 20}px` }}
              >
                <span className="font-mono text-[11px] text-muted-foreground w-12">{p.path}</span>
                <span className="font-medium">{p.name}</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                  {p.kind}
                </Badge>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 ml-auto"
                    onClick={() => onRemovePhase(p.path)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && <AddPhaseDialog existingTopPaths={topPaths} onAdd={onAddPhase} />}
      </CardContent>
    </Card>
  );
}
