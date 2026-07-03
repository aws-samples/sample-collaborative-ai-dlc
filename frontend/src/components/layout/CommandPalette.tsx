import { useNavigate } from 'react-router-dom';
import { useEffect, useCallback } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import {
  FolderGit2,
  Lightbulb,
  Hammer,
  Search,
  Plus,
  LayoutDashboard,
  Network,
  Shield,
  Activity,
} from 'lucide-react';
import { useProjectsCache } from '@/hooks/useProjectsCache';
import { GitRepoLink } from '@/components/GitRepoLink';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { projects: projectsWithSprint } = useProjectsCache();

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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search projects, navigate, or run actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Navigation */}
        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runCommand(() => navigate('/dashboard'))}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
            <CommandShortcut>Go</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate('/admin'))}>
            <Shield className="mr-2 h-4 w-4" />
            Admin Panel
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate('/observability'))}>
            <Activity className="mr-2 h-4 w-4" />
            Observability
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Projects */}
        {projectsWithSprint.length > 0 && (
          <CommandGroup heading="Projects">
            {projectsWithSprint.map((p) => (
              <CommandItem
                key={p.project.id}
                onSelect={() => runCommand(() => navigate(`/project/${p.project.id}`))}
              >
                <FolderGit2 className="mr-2 h-4 w-4" />
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

        <CommandSeparator />

        {/* Actions */}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runCommand(() => navigate('/dashboard'))}>
            <Plus className="mr-2 h-4 w-4" />
            Create New Project
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Phases */}
        <CommandGroup heading="Sprint Phases">
          <CommandItem disabled>
            <Lightbulb className="mr-2 h-4 w-4 text-phase-inception" />
            Go to Inception
            <CommandShortcut>Requires sprint</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Hammer className="mr-2 h-4 w-4 text-phase-construction" />
            Go to Construction
            <CommandShortcut>Requires sprint</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Search className="mr-2 h-4 w-4 text-phase-review" />
            Go to Review
            <CommandShortcut>Requires sprint</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <Network className="mr-2 h-4 w-4" />
            View Sprint Graph
            <CommandShortcut>Requires sprint</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
