import { Activity, Eye, Network } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  setLastIntentSection,
  intentSectionPath,
  type IntentSection,
} from '@/lib/intentSectionPreference';
const SECTION_NAV: { key: IntentSection; label: string; icon: typeof Eye }[] = [
  { key: 'overview', label: 'Overview', icon: Eye },
  { key: 'work', label: 'Work', icon: Activity },
  { key: 'graph', label: 'Graph', icon: Network },
];

export function IntentSectionTabs({
  projectId,
  intentId,
  currentSection,
  backend = 'platform',
  onNavigate,
}: {
  projectId: string;
  intentId: string;
  currentSection: IntentSection;
  backend?: 'native' | 'platform';
  onNavigate: (path: string) => void;
}) {
  return (
    <nav className="flex flex-col gap-px pl-7 pr-1 py-1" aria-label="Intent sections">
      {SECTION_NAV.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          aria-current={currentSection === key ? 'page' : undefined}
          onClick={() => {
            setLastIntentSection(
              backend === 'native' ? `native:${projectId}:${intentId}` : intentId,
              key,
            );
            onNavigate(intentSectionPath(projectId, intentId, key, backend));
          }}
          className={cn(
            'flex items-center gap-2 px-2.5 py-[3px] text-[11px] font-medium rounded-md transition-colors text-left w-full',
            currentSection === key
              ? 'bg-sidebar-accent/70 text-sidebar-foreground'
              : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/80',
          )}
        >
          <Icon className="h-3 w-3 shrink-0" />
          {label}
        </button>
      ))}
    </nav>
  );
}
