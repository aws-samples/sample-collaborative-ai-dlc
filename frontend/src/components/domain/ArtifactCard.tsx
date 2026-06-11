import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Pencil, Trash2, Sparkles, Save, X, Link2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArtifactGraphPopover } from '@/components/domain/ArtifactGraphPopover';
import type { ArtifactNeighbor } from '@/hooks/useSprintGraph';
import { DiscussButton } from '@/components/discussion';
import type { DiscussionEntityType } from '@/services/discussions';

export type ArtifactType = 'requirement' | 'user-story' | 'task' | 'code-file' | 'general-info';

// ArtifactType → discussion anchor entity type (plan §5). Code files have no
// discussion anchor in v1.
const DISCUSSION_ENTITY_TYPES: Partial<Record<ArtifactType, DiscussionEntityType>> = {
  requirement: 'requirement',
  'user-story': 'userstory',
  task: 'task',
  'general-info': 'generalinfo',
};

interface ArtifactField {
  key: string;
  label: string;
  value: string;
  multiline?: boolean;
}

interface ArtifactCardProps {
  id: string;
  type: ArtifactType;
  title: string;
  fields: ArtifactField[];
  status?: string;
  badges?: Array<{ label: string; variant?: 'default' | 'secondary' | 'outline' }>;
  relationships?: Array<{ label: string; targetType: string }>;
  graphNeighbors?: ArtifactNeighbor[];
  onSave?: (fields: Record<string, string>) => void;
  onDelete?: () => void;
  onAiModify?: () => void;
  readOnly?: boolean;
  className?: string;
}

const TYPE_STYLES: Record<ArtifactType, { border: string; label: string; icon: string }> = {
  requirement: { border: 'border-l-orange-500', label: 'Requirement', icon: 'R' },
  'user-story': { border: 'border-l-green-500', label: 'User Story', icon: 'S' },
  task: { border: 'border-l-amber-500', label: 'Task', icon: 'T' },
  'code-file': { border: 'border-l-red-500', label: 'Code File', icon: 'C' },
  'general-info': { border: 'border-l-blue-500', label: 'Info', icon: 'I' },
};

const STATUS_STYLES: Record<string, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-phase-inception/15 text-phase-inception',
  'in-progress': 'bg-phase-inception/15 text-phase-inception',
  done: 'bg-agent-success/15 text-agent-success',
  failed: 'bg-agent-error/15 text-agent-error',
};

export function ArtifactCard({
  id,
  type,
  title,
  fields,
  status,
  badges = [],
  relationships = [],
  graphNeighbors,
  onSave,
  onDelete,
  onAiModify,
  readOnly = false,
  className,
}: ArtifactCardProps) {
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const typeStyle = TYPE_STYLES[type];
  const discussionEntityType = DISCUSSION_ENTITY_TYPES[type];

  const startEdit = () => {
    const values: Record<string, string> = {};
    fields.forEach((f) => {
      values[f.key] = f.value;
    });
    setEditValues(values);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditValues({});
  };

  const saveEdit = () => {
    onSave?.(editValues);
    setEditing(false);
  };

  return (
    <Card
      className={cn(
        'group border-l-[3px] transition-all hover:shadow-md',
        typeStyle.border,
        editing && 'ring-1 ring-ring',
        className,
      )}
    >
      <CardContent className="p-3">
        {/* Header row */}
        <div className="flex items-start gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {/* Type indicator */}
              <span className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider">
                {typeStyle.label}
              </span>
              {status && (
                <Badge
                  variant="secondary"
                  className={cn('h-4 px-1.5 text-[9px]', STATUS_STYLES[status])}
                >
                  {status.replace('_', ' ')}
                </Badge>
              )}
              {badges.map((badge, i) => (
                <Badge
                  key={i}
                  variant={badge.variant || 'outline'}
                  className="h-4 px-1.5 text-[9px]"
                >
                  {badge.label}
                </Badge>
              ))}
            </div>

            {editing ? (
              <Input
                value={editValues['title'] ?? title}
                onChange={(e) => setEditValues((prev) => ({ ...prev, title: e.target.value }))}
                className="mt-1 h-7 text-sm font-medium"
              />
            ) : (
              <h4 className="text-sm font-medium mt-0.5 leading-tight">{title}</h4>
            )}
          </div>

          {/* Graph context popover -- always visible when relationships exist */}
          {graphNeighbors && graphNeighbors.length > 0 && !editing && (
            <ArtifactGraphPopover neighbors={graphNeighbors} className="shrink-0" />
          )}

          {/* Action buttons */}
          {(!readOnly || discussionEntityType) && (
            <div
              className={cn(
                'flex items-center gap-0.5 shrink-0',
                !editing && 'opacity-0 group-hover:opacity-100 transition-opacity',
              )}
            >
              {editing ? (
                <>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={saveEdit}>
                    <Save className="h-3 w-3 text-agent-success" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={cancelEdit}>
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <>
                  {discussionEntityType && (
                    <DiscussButton
                      entityType={discussionEntityType}
                      entityId={id}
                      entityTitle={title}
                    />
                  )}
                  {!readOnly && onAiModify && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={onAiModify}
                        >
                          <Sparkles className="h-3 w-3 text-phase-inception" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>AI Modify</TooltipContent>
                    </Tooltip>
                  )}
                  {!readOnly && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={startEdit}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                  )}
                  {!readOnly && onDelete && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDelete}>
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Fields */}
        <div className="space-y-2">
          {fields
            .filter((f) => f.key !== 'title')
            .map((field) => (
              <div key={field.key}>
                {editing ? (
                  <div>
                    <Label className="text-[10px] text-muted-foreground uppercase">
                      {field.label}
                    </Label>
                    {field.multiline ? (
                      <Textarea
                        value={editValues[field.key] ?? field.value}
                        onChange={(e) =>
                          setEditValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="mt-0.5 text-xs min-h-[60px]"
                        rows={3}
                      />
                    ) : (
                      <Input
                        value={editValues[field.key] ?? field.value}
                        onChange={(e) =>
                          setEditValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="mt-0.5 h-7 text-xs"
                      />
                    )}
                  </div>
                ) : (
                  field.value && (
                    <p className="text-xs text-muted-foreground line-clamp-3">{field.value}</p>
                  )
                )}
              </div>
            ))}
        </div>

        {/* Relationships */}
        {relationships.length > 0 && !editing && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t">
            {relationships.map((rel, i) => (
              <Tooltip key={i}>
                <TooltipTrigger>
                  <div className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer">
                    <Link2 className="h-2.5 w-2.5" />
                    <span>{rel.label}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {rel.targetType}: {rel.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
