import { Cpu, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ComputeCapability, ComputeSelection } from '@/services/environments';
import { cn } from '@/lib/utils';
import {
  ARCHITECTURE_OPTIONS,
  COMPUTE_TYPE_OPTIONS,
  DEFAULT_COMPUTE,
  capabilityReason,
  cellFor,
  computeTypeAvailability,
  computeTypeLabel,
  selectComputeType,
} from './model';

// Compact "Instances · x86_64" badge. The two axes are rendered as two
// segments so nobody reads the architecture as part of the compute type.
export function ComputeBadge({
  compute,
  className,
}: {
  compute: ComputeSelection | null | undefined;
  className?: string;
}) {
  const value = compute ?? DEFAULT_COMPUTE;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 px-1.5 py-0 text-[10px] font-medium', className)}
      title={`Compute type: ${computeTypeLabel(value.type)} · Architecture: ${value.architecture}`}
    >
      <Server className="h-3 w-3" aria-hidden="true" />
      <span>{computeTypeLabel(value.type)}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <Cpu className="h-3 w-3" aria-hidden="true" />
      <span className="font-mono">{value.architecture}</span>
    </Badge>
  );
}

interface ComputeSelectorProps {
  value: ComputeSelection;
  // The capability matrix from GET /environments/capabilities.
  cells: ComputeCapability[];
  disabled?: boolean;
  onChange: (compute: ComputeSelection) => void;
}

// Two independent controls: WHERE sessions run (compute type) and WHICH
// image is built (architecture). An option the deployment cannot serve is
// disabled with the reason, so the supported combinations are visible
// instead of being folded into one list.
export function ComputeSelector({ value, cells, disabled, onChange }: ComputeSelectorProps) {
  const selectedType = COMPUTE_TYPE_OPTIONS.find((option) => option.value === value.type);
  const cell = cellFor(cells, value.type, value.architecture);
  const instanceTypes = value.type === 'instances' ? (cell?.allowedInstanceTypes ?? []) : [];

  return (
    <div className="space-y-3" data-testid="compute-selector">
      <div className="space-y-1.5">
        <Label id="compute-type-label" className="text-xs">
          Compute type
        </Label>
        <ToggleGroup
          type="single"
          aria-labelledby="compute-type-label"
          value={value.type}
          onValueChange={(type) => {
            if (!type) return;
            onChange(selectComputeType(cells, value, type as ComputeSelection['type']));
          }}
          disabled={disabled}
          className="flex-wrap"
        >
          {COMPUTE_TYPE_OPTIONS.map((option) => {
            const availability = computeTypeAvailability(cells, option.value);
            return (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                disabled={!availability.available && option.value !== value.type}
                title={availability.reason ?? option.description}
                className="h-8 px-3 text-xs"
              >
                <Server className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {option.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {selectedType?.description}
          {instanceTypes.length > 0 && (
            <>
              {' '}
              Instance types: <span className="font-mono">{instanceTypes.join(', ')}</span>.
            </>
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label id="compute-architecture-label" className="text-xs">
          Architecture
        </Label>
        <ToggleGroup
          type="single"
          aria-labelledby="compute-architecture-label"
          value={value.architecture}
          onValueChange={(architecture) => {
            if (!architecture) return;
            onChange({
              type: value.type,
              architecture: architecture as ComputeSelection['architecture'],
            });
          }}
          disabled={disabled}
          className="flex-wrap"
        >
          {ARCHITECTURE_OPTIONS.map((option) => {
            const optionCell = cellFor(cells, value.type, option.value);
            const available = Boolean(optionCell?.available);
            const reason = capabilityReason(optionCell?.reason);
            return (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                disabled={!available && option.value !== value.architecture}
                title={reason ?? undefined}
                aria-describedby={reason ? `architecture-reason-${option.value}` : undefined}
                className="h-8 px-3 font-mono text-xs"
              >
                <Cpu className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {option.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <ul className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {ARCHITECTURE_OPTIONS.map((option) => {
            const reason = capabilityReason(cellFor(cells, value.type, option.value)?.reason);
            return reason ? (
              <li key={option.value} id={`architecture-reason-${option.value}`}>
                <span className="font-mono">{option.label}</span>: {reason}.
              </li>
            ) : null;
          })}
          {value.architecture === 'x86_64' && (
            <li>
              x86_64 environments derive from the Standard base and use x86_64 tool builds only.
            </li>
          )}
        </ul>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Both choices are fixed when the environment is created.
      </p>
    </div>
  );
}
