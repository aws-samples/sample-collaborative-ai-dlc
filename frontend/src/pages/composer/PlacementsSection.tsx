import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Trash2 } from 'lucide-react';
import { AddPicker } from './AddPicker';
import type { PhaseNode, Placement } from '@/services/workflows';
import type { Block } from '@/services/blocks';

// Radix <SelectItem> forbids value="" — sentinel maps back to '' (null phasePath).
const NO_PHASE = '__none__';

interface PlacementsSectionProps {
  placements: Placement[];
  phases: PhaseNode[];
  unplacedStages: Block[];
  stagesById: Record<string, Block>;
  readOnly: boolean;
  onSetPhase: (stageId: string, phasePath: string) => void;
  onRemove: (stageId: string) => void;
  onAdd: (stageId: string) => void;
}

export function PlacementsSection({
  placements,
  phases,
  unplacedStages,
  stagesById,
  readOnly,
  onSetPhase,
  onRemove,
  onAdd,
}: PlacementsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Stage placements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Reference library stages into this workflow and home each under a phase.
        </p>
        {placements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stages placed yet.</p>
        ) : (
          <ul className="space-y-2">
            {placements.map((p) => (
              <li key={p.stageId} className="flex items-center gap-2 text-sm">
                <span className="font-medium min-w-0 truncate">
                  {stagesById[p.stageId]?.name ?? p.stageId}
                </span>
                <Select
                  value={p.phasePath ?? NO_PHASE}
                  onValueChange={(val) => onSetPhase(p.stageId, val === NO_PHASE ? '' : val)}
                  disabled={readOnly}
                >
                  <SelectTrigger className="h-8 ml-auto w-48 text-xs">
                    <SelectValue placeholder="— no phase —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PHASE}>— no phase —</SelectItem>
                    {phases.map((ph) => (
                      <SelectItem key={ph.path} value={ph.path}>
                        {ph.path} {ph.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => onRemove(p.stageId)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && unplacedStages.length > 0 && (
          <AddPicker
            placeholder="Place a stage…"
            options={unplacedStages.map((s) => ({ id: s.id, label: s.name }))}
            onAdd={onAdd}
          />
        )}
      </CardContent>
    </Card>
  );
}
