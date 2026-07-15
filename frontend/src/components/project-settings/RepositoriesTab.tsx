// Project Settings → Source Control tab: the repositories linked to this
// project (add / remove / set primary). Self-contained — owns the add dialog
// and the remove confirmation; the page provides the project and a reload.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { GitBranch, Loader2, Plus, Star, Trash2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { projectsService, type Project } from '@/services/projects';
import { gitProviderTerminology, type GitRepo } from '@/services/gitProvider';
import { GitRepoSelect } from '@/components/GitRepoSelect';
import { SettingsCard } from '@/components/settings/SettingsCard';

const REPO_ROLE_COLORS: Record<string, string> = {
  primary: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  secondary: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  frontend: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  backend: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  api: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  infra: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  shared: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  docs: 'bg-gray-100 text-gray-600 dark:bg-gray-800/60 dark:text-gray-400',
  unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-800/60 dark:text-gray-400',
};

interface Props {
  project: Project;
  canEdit: boolean;
  reload: () => Promise<void>;
}

export function RepositoriesTab({ project, canEdit, reload }: Props) {
  const repos = project.repos ?? [];
  const providerLabel = gitProviderTerminology(project.gitProvider ?? 'github').label;

  const [error, setError] = useState<string | null>(null);

  // Add dialog
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [selectedNewRepos, setSelectedNewRepos] = useState<string[]>([]);
  const [addingRepo, setAddingRepo] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Row actions
  const [removingRepo, setRemovingRepo] = useState<string | null>(null);
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null);
  const [confirmRemoveRepo, setConfirmRemoveRepo] = useState<string | null>(null);

  const handleAddRepos = async () => {
    if (selectedNewRepos.length === 0) return;
    setAddError(null);
    setAddingRepo(true);
    const results = await Promise.allSettled(
      selectedNewRepos.map((url) =>
        projectsService.addRepo(project.id, { url, provider: project.gitProvider }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failedRepos = results
      .map((r, i) => (r.status === 'rejected' ? selectedNewRepos[i] : null))
      .filter((n): n is string => n !== null);
    await reload();
    setAddingRepo(false);
    if (failedRepos.length === 0) {
      setSelectedNewRepos([]);
      setShowAddRepo(false);
    } else {
      // Keep the dialog open with only the failed repos still selected so the
      // user can retry or deselect them.
      setSelectedNewRepos(failedRepos);
      setAddError(
        succeeded > 0
          ? `${succeeded} added. Failed to add: ${failedRepos.join(', ')}`
          : `Failed to add: ${failedRepos.join(', ')}`,
      );
    }
  };

  const handleRemoveRepo = async (repoUrl: string) => {
    setConfirmRemoveRepo(null);
    setError(null);
    setRemovingRepo(repoUrl);
    try {
      await projectsService.removeRepo(project.id, repoUrl);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove repository');
    } finally {
      setRemovingRepo(null);
    }
  };

  const handleSetPrimaryRepo = async (repoUrl: string) => {
    setError(null);
    setSettingPrimary(repoUrl);
    try {
      await projectsService.update(project.id, { gitRepo: repoUrl });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set primary repository');
    } finally {
      setSettingPrimary(null);
    }
  };

  return (
    <>
      <SettingsCard
        icon={<GitBranch />}
        title="Repositories"
        badge={
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground">
            {repos.length} linked · {providerLabel}
          </span>
        }
        description="Repos this space's agents can work in — role and tech stack are detected automatically."
        headerAction={
          canEdit && (
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setShowAddRepo(true)}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          )
        }
      >
        <div className="space-y-3">
          {error && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <XCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}
          {repos.length === 0 ? (
            <div className="rounded-lg border border-dashed px-3.5 py-6 text-center text-xs text-muted-foreground">
              No repositories linked yet — agents need at least one to run.
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {repos.map((repo) => (
                <div key={repo.url} className="flex items-center gap-3 px-3.5 py-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                    <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{repo.url}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-4 shrink-0 text-[10px]',
                        REPO_ROLE_COLORS[repo.role] || REPO_ROLE_COLORS.unknown,
                      )}
                    >
                      {repo.role}
                    </Badge>
                    {repo.detectedStack && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {repo.detectedStack}
                      </span>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-1">
                      {repo.role !== 'primary' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px]"
                          onClick={() => handleSetPrimaryRepo(repo.url)}
                          disabled={removingRepo === repo.url || settingPrimary !== null}
                        >
                          {settingPrimary === repo.url ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Star className="h-3 w-3" />
                          )}
                          Set primary
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmRemoveRepo(repo.url)}
                        disabled={removingRepo === repo.url || settingPrimary !== null}
                        title="Remove repository"
                      >
                        {removingRepo === repo.url ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Add Repos Dialog */}
      <Dialog
        open={showAddRepo}
        onOpenChange={(open) => {
          if (!addingRepo) {
            setShowAddRepo(open);
            if (!open) {
              setSelectedNewRepos([]);
              setAddError(null);
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAddRepos();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add Repositories</DialogTitle>
              <DialogDescription>
                Select repositories to link to this space. Role and tech stack are detected
                automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <GitRepoSelect
                provider={project.gitProvider ?? 'github'}
                multiple
                value={selectedNewRepos}
                onChange={(selected: GitRepo[]) => {
                  setSelectedNewRepos(selected.map((r) => r.fullName));
                }}
                exclude={repos.map((r) => r.url)}
              />
              {addError && <p className="text-sm text-destructive">{addError}</p>}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowAddRepo(false);
                  setSelectedNewRepos([]);
                  setAddError(null);
                }}
                disabled={addingRepo}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={addingRepo || selectedNewRepos.length === 0}>
                {addingRepo
                  ? 'Adding...'
                  : selectedNewRepos.length > 0
                    ? `Add ${selectedNewRepos.length} Repositor${selectedNewRepos.length === 1 ? 'y' : 'ies'}`
                    : 'Add Repositories'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirm Remove Repo */}
      <AlertDialog open={!!confirmRemoveRepo} onOpenChange={() => setConfirmRemoveRepo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Repository</AlertDialogTitle>
            <AlertDialogDescription>
              Remove <span className="font-mono">{confirmRemoveRepo}</span> from this space?
              {repos.find((r) => r.url === confirmRemoveRepo)?.role === 'primary' &&
                repos.length > 1 &&
                ' This is the primary repository — the oldest remaining repository will be promoted to primary.'}
              {repos.length === 1 &&
                ' This is the last repository — the space will have no linked repository and sprints cannot run until one is added.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRemoveRepo && handleRemoveRepo(confirmRemoveRepo)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
