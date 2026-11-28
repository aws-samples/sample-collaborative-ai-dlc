import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Info, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const TONES = {
  info: { box: 'border-primary/30 bg-primary/5', icon: 'text-primary', Icon: Info },
  success: {
    box: 'border-agent-success/30 bg-agent-success/5',
    icon: 'text-agent-success-fg',
    Icon: CheckCircle2,
  },
  warning: { box: 'border-warning/30 bg-warning/10', icon: 'text-warning-fg', Icon: AlertTriangle },
  danger: {
    box: 'border-destructive/30 bg-destructive/5',
    icon: 'text-destructive',
    Icon: CircleAlert,
  },
  neutral: { box: 'border-border bg-muted/40', icon: 'text-muted-foreground', Icon: Info },
} satisfies Record<string, { box: string; icon: string; Icon: LucideIcon }>;

type AlertTone = keyof typeof TONES;

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  /** Rendered as an h2: alerts sit directly under the page h1 (P2-4). */
  title?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  /** Danger/warning alerts become `role="alert"`; everything else stays a polite status. */
  live?: boolean;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  (
    { className, tone = 'neutral', title, action, icon, live = false, children, role, ...props },
    ref,
  ) => {
    const { box, icon: iconClass, Icon } = TONES[tone];
    const interrupting = live && (tone === 'danger' || tone === 'warning');
    return (
      <div
        ref={ref}
        role={role ?? (interrupting ? 'alert' : 'status')}
        data-tone={tone}
        className={cn(
          'relative flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm text-foreground',
          box,
          className,
        )}
        {...props}
      >
        <span aria-hidden="true" className={cn('mt-0.5 shrink-0 [&_svg]:size-4', iconClass)}>
          {icon === undefined ? <Icon /> : icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          {title ? <h2 className="leading-snug font-medium">{title}</h2> : null}
          {children}
        </div>
        {action ? <div className="shrink-0 self-center">{action}</div> : null}
      </div>
    );
  },
);
Alert.displayName = 'Alert';

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('text-sm text-muted-foreground [&_p]:leading-relaxed', className)}
      {...props}
    />
  ),
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertDescription };
