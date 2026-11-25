import { useNavigate } from 'react-router';
import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Blocks,
  Bot,
  Container,
  FolderGit2,
  GitBranch,
  Inbox,
  Layers,
  LayoutDashboard,
  ListTodo,
  Plus,
  Target,
  UserCog,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useProjectsCache, type ProjectIntentSummary } from '@/hooks/useProjectsCache';
import { usePanelsInline } from '@/hooks/usePanelsInline';
import { useAuth } from '@/contexts/AuthContext';
import { GitRepoLink } from '@/components/GitRepoLink';
import { StatusPill } from '@/components/ui/status-pill';
import { intentEntryPath } from '@/lib/intentEntry';
import { prefetchHref } from '@/lib/routePrefetch';
import { intentStatusLabel, useIntentStatus } from '@/lib/statusModel';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the shell's Create space dialog on the current page. */
  onCreateSpace: () => void;
}

interface PageEntry {
  label: string;
  path: string;
  icon: LucideIcon;
  keywords: string[];
  adminOnly?: boolean;
  /** A page that only exists where the sidebar does not already serve its purpose. */
  narrowOnly?: boolean;
}

const PAGES: PageEntry[] = [
  {
    label: 'My work',
    path: '/dashboard',
    icon: Inbox,
    keywords: ['dashboard', 'home', 'inbox', 'attention', 'questions'],
  },
  {
    label: 'Spaces',
    path: '/spaces',
    icon: LayoutDashboard,
    keywords: ['projects', 'list'],
    narrowOnly: true,
  },
  {
    label: 'Workflows',
    path: '/workflows',
    icon: Workflow,
    keywords: ['authoring', 'composer', 'phases', 'stages'],
    adminOnly: true,
  },
  {
    label: 'Block library',
    path: '/blocks/stage',
    icon: Blocks,
    keywords: ['authoring', 'blocks', 'stages', 'sensors', 'personas', 'reviewers'],
    adminOnly: true,
  },
  {
    label: 'Admin › Users',
    path: '/admin?tab=users',
    icon: Users,
    keywords: ['admin', 'settings', 'members', 'administrators', 'invite', 'roles'],
    adminOnly: true,
  },
  {
    label: 'Admin › Agents',
    path: '/admin?tab=agents',
    icon: Bot,
    keywords: ['admin', 'settings', 'cli', 'claude', 'codex', 'kiro', 'models', 'sandboxing'],
    adminOnly: true,
  },
  {
    label: 'Admin › Environments',
    path: '/admin?tab=environments',
    icon: Container,
    keywords: ['admin', 'settings', 'runtime', 'sandbox', 'docker', 'image', 'revisions'],
    adminOnly: true,
  },
  {
    label: 'Admin › Tools',
    path: '/admin?tab=environments&subtab=tools',
    icon: Wrench,
    keywords: ['admin', 'settings', 'mcp', 'registry', 'packages', 'environments'],
    adminOnly: true,
  },
  {
    label: 'Admin › AI-DLC versions',
    path: '/admin?tab=aidlc-versions',
    icon: Layers,
    keywords: ['admin', 'settings', 'releases', 'framework', 'method', 'upgrade', 'aidlc'],
    adminOnly: true,
  },
  {
    label: 'Admin › Source control',
    path: '/admin?tab=source-control',
    icon: GitBranch,
    keywords: [
      'admin',
      'settings',
      'git',
      'github',
      'gitlab',
      'bitbucket',
      'codecommit',
      'repositories',
      'code host',
    ],
    adminOnly: true,
  },
  {
    label: 'Admin › Trackers',
    path: '/admin?tab=trackers',
    icon: ListTodo,
    keywords: ['admin', 'settings', 'jira', 'issues', 'github issues', 'gitlab issues', 'tickets'],
    adminOnly: true,
  },
  {
    label: 'Account settings',
    path: '/account/settings',
    icon: UserCog,
    keywords: ['profile', 'password', 'theme', 'preferences', 'tokens', 'account'],
  },
];

interface IntentEntry {
  projectId: string;
  spaceName: string;
  intent: ProjectIntentSummary;
  path: string;
  activityAt: number;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const matchesAt = (field: string[], token: string[]) =>
  field.some((_, i) => token.every((part, j) => field[i + j]?.startsWith(part)));

/**
 * Relevance: every typed word must start a word of the item's keywords (its
 * name first, then space, repository, status…). Scattered letters never
 * match — "cart" finds "cart-analytics" and "Cart page", not
 * "llm-router-hackathon". A typed "low-stock" matches the words "low stock".
 * Item `value`s are ids and never matched. Matches in the name rank first.
 */
export function paletteMatchScore(search: string, keywords: readonly string[] = []): number {
  const query = search
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(words)
    .filter((t) => t.length);
  if (query.length === 0) return 1;
  const fields = keywords.map(words);
  let inName = 0;
  for (const token of query) {
    const fieldIndex = fields.findIndex((field) => matchesAt(field, token));
    if (fieldIndex === -1) return 0;
    if (fieldIndex === 0) inName += 1;
  }
  return 0.5 + (0.5 * inName) / query.length;
}

const paletteFilter = (_value: string, search: string, keywords?: string[]) =>
  paletteMatchScore(search, keywords);

function activityTime(intent: ProjectIntentSummary): number {
  const parsed = Date.parse(intent.updatedAt ?? intent.createdAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Open work ranks above finished runs at equal match quality (R5-28).
const STATUS_RANK: Partial<Record<string, number>> = {
  WAITING: 0,
  RUNNING: 1,
  CREATED: 1,
};
const statusRank = (intent: ProjectIntentSummary) => STATUS_RANK[intent.status] ?? 2;

export function CommandPalette({ open, onOpenChange, onCreateSpace }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { projects } = useProjectsCache();
  const { isPlatformAdmin } = useAuth();

  // Global keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open, onOpenChange]);

  const runCommand = useCallback(
    (command: () => void) => {
      onOpenChange(false);
      command();
    },
    [onOpenChange],
  );

  const intents = useMemo<IntentEntry[]>(
    () =>
      projects
        .flatMap(({ project, intents: list, latestIntent }) => {
          if (project.kind !== 'v2') return [];
          return (list ?? (latestIntent ? [latestIntent] : [])).map((intent) => ({
            projectId: project.id,
            spaceName: project.name,
            intent,
            path: intentEntryPath(project.id, intent),
            activityAt: activityTime(intent),
          }));
        })
        .toSorted(
          (a, b) => statusRank(a.intent) - statusRank(b.intent) || b.activityAt - a.activityAt,
        ),
    [projects],
  );

  const panelsInline = usePanelsInline();
  const pages = PAGES.filter(
    (page) => (!page.adminOnly || isPlatformAdmin) && (!page.narrowOnly || !panelsInline),
  );

  // Pointer hover is covered by the shell's delegated listener (each item
  // carries data-prefetch-href). Arrow keys move cmdk's selection without
  // moving focus, so the highlighted item is warmed after the same 100 ms dwell.
  // cmdk reports selection changes only when controlled, hence the state.
  const hrefByValue = useMemo(
    () =>
      new Map<string, string>([
        ...projects.map(({ project }) => [`space:${project.id}`, `/space/${project.id}`] as const),
        ...intents.map(
          (entry) => [`intent:${entry.projectId}:${entry.intent.id}`, entry.path] as const,
        ),
        ...PAGES.map((page) => [`page:${page.path}`, page.path] as const),
      ]),
    [projects, intents],
  );
  const [highlighted, setHighlighted] = useState('');
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const highlight = (value: string) => {
    setHighlighted(value);
    clearTimeout(highlightTimer.current);
    const href = hrefByValue.get(value);
    if (href)
      highlightTimer.current = setTimeout(() => prefetchHref(href, { trigger: 'focus' }), 100);
  };
  // A reopened palette starts from its first result, as an uncontrolled cmdk did.
  useEffect(() => {
    if (open) return;
    clearTimeout(highlightTimer.current);
    setHighlighted('');
  }, [open]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  return (
    // CommandDialog composed by hand: it does not forward `filter` to cmdk.
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <VisuallyHidden.Root>
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search intents, spaces and pages.</DialogDescription>
        </VisuallyHidden.Root>
        <Command
          filter={paletteFilter}
          value={highlighted}
          onValueChange={highlight}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput placeholder="Search intents, spaces and pages…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>

            {projects.length > 0 && (
              <CommandGroup heading="Spaces">
                {projects.map((p) => (
                  <CommandItem
                    key={p.project.id}
                    value={`space:${p.project.id}`}
                    data-prefetch-href={`/space/${p.project.id}`}
                    keywords={[p.project.name, p.project.gitRepo ?? '']}
                    onSelect={() => runCommand(() => navigate(`/space/${p.project.id}`))}
                  >
                    <FolderGit2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    {p.project.name}
                    {p.project.gitRepo && (
                      <GitRepoLink
                        gitRepo={p.project.gitRepo}
                        gitProvider={p.project.gitProvider}
                        className="ml-auto text-xs text-muted-foreground"
                        noLink
                      />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {intents.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Intents">
                  {intents.map((entry) => (
                    <IntentCommandItem
                      key={`${entry.projectId}:${entry.intent.id}`}
                      entry={entry}
                      onSelect={() => runCommand(() => navigate(entry.path))}
                    />
                  ))}
                </CommandGroup>
              </>
            )}

            <CommandSeparator />
            <CommandGroup heading="Pages">
              {pages.map((page) => (
                <PageCommandItem
                  key={page.path}
                  page={page}
                  onSelect={() => runCommand(() => navigate(page.path))}
                />
              ))}
            </CommandGroup>

            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem
                value="action:create-space"
                keywords={['new space', 'create space', 'project']}
                onSelect={() => runCommand(onCreateSpace)}
              >
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Create new space
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function IntentCommandItem({ entry, onSelect }: { entry: IntentEntry; onSelect: () => void }) {
  const { projectId, intent, spaceName, path } = entry;
  const derived = useIntentStatus(projectId, intent);
  const title = intent.title ?? 'Intent';
  const statusLabel = intentStatusLabel(derived);

  return (
    <CommandItem
      value={`intent:${projectId}:${intent.id}`}
      data-prefetch-href={path}
      keywords={[title, spaceName, statusLabel]}
      onSelect={onSelect}
    >
      <Target className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{title}</span>
        <span className="truncate text-2xs text-muted-foreground">{spaceName}</span>
      </span>
      <StatusPill
        kind="intent"
        status={derived.key}
        stalled={derived.stalled}
        since={derived.since}
        size="sm"
        className="ml-2 shrink-0"
      />
    </CommandItem>
  );
}

function PageCommandItem({ page, onSelect }: { page: PageEntry; onSelect: () => void }) {
  const Icon = page.icon;
  return (
    <CommandItem
      value={`page:${page.path}`}
      data-prefetch-href={page.path}
      keywords={[page.label, ...page.keywords]}
      onSelect={onSelect}
    >
      <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
      {page.label}
    </CommandItem>
  );
}
