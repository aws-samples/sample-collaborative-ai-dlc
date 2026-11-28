import { useEffect, useState, type ReactNode } from 'react';
import { Disclosure } from '@/components/ui/disclosure';

interface SettingsDisclosureCardProps {
  icon: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  description: ReactNode;
  /** Compact current value shown in the header, e.g. "eu-west-1 · role configured". */
  summary?: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
  className?: string;
}

// The status may arrive after the card first renders. Reveal a saved setup,
// but never close a panel the administrator has already opened.
function useRevealWhenConfigured(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return [open, setOpen] as const;
}

/** A settings option whose summary stays visible while its controls are one click away. */
export function SettingsDisclosureCard({
  icon,
  title,
  status,
  description,
  summary,
  defaultOpen,
  children,
  className,
}: SettingsDisclosureCardProps) {
  const [open, setOpen] = useRevealWhenConfigured(defaultOpen);
  return (
    <Disclosure
      variant="card"
      icon={icon}
      title={title}
      status={status}
      summary={summary}
      description={description}
      open={open}
      onOpenChange={setOpen}
      forceMount
      className={className}
    >
      {children}
    </Disclosure>
  );
}
