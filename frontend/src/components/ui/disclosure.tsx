import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DisclosureVariant = 'row' | 'card' | 'section' | 'inline';

export interface DisclosureProps {
  title: React.ReactNode;
  /** Shown after the title as "(n)". */
  count?: number;
  /** A `StatusPill` (or similar) shown in the header meta. */
  status?: React.ReactNode;
  /** One-line summary shown in the header meta while closed and open. */
  summary?: React.ReactNode;
  /** A second line under the title. */
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Controls rendered in the header, outside the trigger. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: DisclosureVariant;
  /** Keep children mounted (hidden) while closed; by default a collapsed panel never mounts (or fetches). */
  forceMount?: boolean;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}

const VARIANT = {
  row: {
    root: '',
    header: 'min-h-10 gap-3 rounded-md px-2 py-2 hover:bg-accent/40',
    title: 'text-sm font-medium',
    content: 'px-2 pb-3 pt-1',
  },
  card: {
    root: 'overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm',
    header: 'min-h-14 gap-3.5 px-4 py-3 hover:bg-accent/30 sm:px-5',
    title: 'text-sm font-semibold',
    content: 'border-t px-4 py-4 sm:px-5',
  },
  section: {
    root: '',
    header: 'min-h-10 gap-3 border-b py-2 hover:bg-accent/30',
    title: 'text-sm font-semibold',
    content: 'pt-3',
  },
  inline: {
    root: 'inline-block max-w-full',
    header: 'min-h-6 gap-2 text-xs text-muted-foreground hover:text-foreground',
    title: 'text-xs font-medium underline-offset-4 group-hover/disclosure:underline',
    content: 'pt-2',
  },
} satisfies Record<DisclosureVariant, Record<'root' | 'header' | 'title' | 'content', string>>;

const CONTENT_HEIGHT_VARS = {
  '--radix-accordion-content-height': 'var(--radix-collapsible-content-height)',
} as React.CSSProperties;

export function Disclosure({
  title,
  count,
  status,
  summary,
  description,
  icon,
  actions,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  variant = 'row',
  forceMount = false,
  headingLevel,
  className,
  contentClassName,
  children,
}: DisclosureProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const metaId = React.useId();
  const hasMeta = Boolean(summary || status);
  const styles = VARIANT[variant];
  const Heading = headingLevel ? (`h${headingLevel}` as const) : null;

  const trigger = (
    <CollapsiblePrimitive.Trigger
      data-slot="disclosure-trigger"
      aria-describedby={hasMeta ? metaId : undefined}
      className={cn(
        'flex min-h-6 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none',
        'after:absolute after:inset-0 after:rounded-[inherit] after:content-[""]',
        styles.title,
      )}
    >
      <span data-slot="disclosure-title" className="min-w-0 truncate">
        {title}
        {count !== undefined ? (
          <>
            {' '}
            <span className="font-normal text-muted-foreground">({count})</span>
          </>
        ) : null}
      </span>
    </CollapsiblePrimitive.Trigger>
  );

  return (
    <CollapsiblePrimitive.Root
      data-slot="disclosure"
      data-variant={variant}
      open={open}
      onOpenChange={handleOpenChange}
      className={cn('group/disclosure', styles.root, className)}
    >
      <div
        data-slot="disclosure-header"
        className={cn(
          'relative flex items-center transition-colors',
          'has-[[data-slot=disclosure-trigger]:focus-visible]:ring-2 has-[[data-slot=disclosure-trigger]:focus-visible]:ring-inset has-[[data-slot=disclosure-trigger]:focus-visible]:ring-ring',
          styles.header,
        )}
      >
        {icon ? (
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-foreground [&_svg]:h-[17px] [&_svg]:w-[17px]"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {Heading ? (
              <Heading className="flex min-w-0 flex-1 items-center text-[length:inherit] font-[inherit] leading-[inherit]">
                {trigger}
              </Heading>
            ) : (
              trigger
            )}
            {hasMeta ? (
              <span
                id={metaId}
                data-slot="disclosure-meta"
                className="relative z-10 flex min-w-0 shrink items-center gap-2 text-xs text-muted-foreground"
              >
                {summary ? <span className="truncate">{summary}</span> : null}
                {status}
              </span>
            ) : null}
          </div>
          {description ? (
            <span className="block text-xs text-muted-foreground">{description}</span>
          ) : null}
        </div>
        {actions ? (
          <span
            data-slot="disclosure-actions"
            className="relative z-10 flex shrink-0 items-center gap-1"
          >
            {actions}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          data-open={open || undefined}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180',
            variant === 'inline' ? 'h-3.5 w-3.5' : 'h-4 w-4',
          )}
        />
      </div>
      <CollapsiblePrimitive.Content
        data-slot="disclosure-content"
        forceMount={forceMount || undefined}
        hidden={forceMount && !open ? true : undefined}
        style={CONTENT_HEIGHT_VARS}
        className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      >
        <div className={cn(styles.content, contentClassName)}>{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
