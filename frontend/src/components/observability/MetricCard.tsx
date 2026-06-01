import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, onClick }: MetricCardProps) {
  return (
    <Card
      className={cn(
        'transition-colors',
        onClick && 'cursor-pointer hover:bg-accent/50',
      )}
      onClick={onClick}
    >
      <CardContent className="px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {value}
            </p>
            <p className="text-xs font-medium text-muted-foreground mt-1">
              {label}
            </p>
            {description && (
              <div className="text-[11px] text-muted-foreground/70 mt-1.5">
                {description}
              </div>
            )}
          </div>
          <Icon className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
        </div>
      </CardContent>
    </Card>
  );
}
