import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { WorkflowPackageImport } from './WorkflowPackageImport';
import type { GitProvider } from '@/services/gitProvider';
import {
  isWorkflowSourceApiDisabled,
  workflowSourcesService,
  type WorkflowSource,
  type WorkflowSourceAuthType,
  type WorkflowSourceList,
} from '@/services/workflowSources';

const PROVIDERS: GitProvider[] = ['github', 'gitlab', 'bitbucket'];
const LABELS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
const selectStyle = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

interface Props {
  projectId: string;
  canEdit: boolean;
}

export function WorkflowSourcesSection({ projectId, canEdit }: Props) {
  const id = useId();
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const request = useRef(0);
  const viewEpoch = useRef(0);
  const [loaded, setLoaded] = useState<(WorkflowSourceList & { projectId: string }) | null>(null);
  const [settledProject, setSettledProject] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkflowSource | null>(null);
  const [provider, setProvider] = useState<GitProvider>('github');
  const [repository, setRepository] = useState('awslabs/aidlc-workflows');
  const [authType, setAuthType] = useState<WorkflowSourceAuthType>('public');
  const [confirmed, setConfirmed] = useState(false);
  const [removing, setRemoving] = useState<WorkflowSource | null>(null);

  const resetEditor = () => {
    setEditing(null);
    setProvider('github');
    setRepository('awslabs/aidlc-workflows');
    setAuthType('public');
    setConfirmed(false);
    setRemoving(null);
  };

  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const listing = await workflowSourcesService.listWithCapabilities(projectId);
      if (sequence !== request.current || currentProject.current !== projectId) return;
      setLoaded({ ...listing, projectId });
      setDisabled(false);
    } catch (cause) {
      if (sequence !== request.current || currentProject.current !== projectId) return;
      // A failed refresh must not present an old revision as current or
      // re-enable mutations after a successful save/removal.
      setLoaded(null);
      setDisabled(isWorkflowSourceApiDisabled(cause));
      setError(errorMessage(cause, 'Could not load workflow sources.'));
    } finally {
      if (sequence === request.current && currentProject.current === projectId) {
        setLoading(false);
        setSettledProject(projectId);
      }
    }
  }, [projectId]);

  useEffect(() => {
    viewEpoch.current += 1;
    setLoaded(null);
    setBusy(false);
    setDisabled(false);
    resetEditor();
    void load();
    return () => {
      request.current += 1;
      viewEpoch.current += 1;
    };
  }, [load]);

  const edit = (source: WorkflowSource) => {
    setEditing(source);
    setProvider(source.provider);
    setRepository(source.repository);
    setAuthType(source.authType);
    setConfirmed(false);
    setRemoving(null);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || busy || loading || loaded?.projectId !== projectId) return;
    const epoch = viewEpoch.current;
    const isCurrent = () => viewEpoch.current === epoch && currentProject.current === projectId;
    if (authType.endsWith('-oauth') && !confirmed) {
      setError('Confirm that project members may read releases using your connection.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workflowSourcesService.configure(projectId, {
        provider,
        repository: repository.trim(),
        authType,
        ...(authType.endsWith('-oauth') ? { confirmDelegation: true } : {}),
        expectedRevision: editing?.revision ?? null,
      });
      if (!isCurrent()) return;
      resetEditor();
      await load();
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause, 'Could not verify this workflow source.'));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const remove = async (source: WorkflowSource) => {
    if (!canEdit || busy || loading || loaded?.projectId !== projectId) return;
    const epoch = viewEpoch.current;
    const isCurrent = () => viewEpoch.current === epoch && currentProject.current === projectId;
    setBusy(true);
    setError(null);
    try {
      await workflowSourcesService.remove(projectId, source);
      if (!isCurrent()) return;
      resetEditor();
      await load();
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause, 'Could not remove this workflow source.'));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  // A disabled API intentionally keeps this configuration out of the pilot UI.
  // Successful source configuration does not enable native execution.
  if (disabled || settledProject !== projectId) return null;
  const sources = loaded?.projectId === projectId ? loaded.sources : [];
  const packageImportsEnabled =
    loaded?.projectId === projectId && loaded.capabilities?.packageImportsEnabled === true;
  const formDisabled = busy || loading || loaded?.projectId !== projectId;

  return (
    <SettingsCard
      icon={<GitBranch />}
      title="AI-DLC workflow sources"
      description="Repositories supplying native AI-DLC release packages for this space."
      headerAction={
        <Button
          variant="outline"
          size="sm"
          disabled={busy || loading}
          onClick={() => {
            resetEditor();
            void load();
          }}
        >
          Reload
        </Button>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {sources.length === 0 && loaded?.projectId === projectId && (
          <p className="text-sm text-muted-foreground">No workflow sources configured.</p>
        )}
        {loaded?.projectId === projectId && !packageImportsEnabled && (
          <p className="text-xs text-muted-foreground">Package imports are unavailable.</p>
        )}
        <ul className="divide-y rounded-md border empty:hidden">
          {sources.map((source) => (
            <li key={source.sourceId} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">{source.repository}</p>
                  <p className="text-xs text-muted-foreground">
                    {LABELS[source.provider]} ·{' '}
                    {source.authType === 'public'
                      ? 'Public access'
                      : source.authType === 'github-app'
                        ? 'GitHub App'
                        : 'Personal connection'}{' '}
                    · {source.status === 'active' ? 'Configured' : 'Needs verification'}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={formDisabled}
                      onClick={() => edit(source)}
                      aria-label={`Verify access to ${source.repository}`}
                    >
                      Verify access
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={formDisabled}
                      onClick={() => setRemoving(source)}
                      aria-label={`Remove ${source.repository}`}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
              {packageImportsEnabled && (
                <WorkflowPackageImport
                  projectId={projectId}
                  source={source}
                  suspended={formDisabled}
                />
              )}
              {canEdit && removing?.sourceId === source.sourceId && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Remove this workflow source from the space?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={formDisabled}
                    onClick={() => void remove(source)}
                  >
                    Confirm removal
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={formDisabled}
                    onClick={() => setRemoving(null)}
                  >
                    Cancel removal
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit ? (
          <form className="space-y-3 border-t pt-4" onSubmit={(event) => void save(event)}>
            <p className="text-sm font-medium">
              {editing ? 'Verify this source with your access' : 'Add a workflow source'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${id}-provider`}>Git host</Label>
                <select
                  id={`${id}-provider`}
                  className={selectStyle}
                  value={provider}
                  disabled={formDisabled || editing !== null}
                  onChange={(event) => {
                    const value = event.target.value as GitProvider;
                    if (!PROVIDERS.includes(value)) return;
                    setProvider(value);
                    setAuthType('public');
                    setConfirmed(false);
                  }}
                >
                  {PROVIDERS.map((value) => (
                    <option key={value} value={value}>
                      {LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-access`}>Repository access</Label>
                <select
                  id={`${id}-access`}
                  className={selectStyle}
                  value={authType}
                  disabled={formDisabled}
                  onChange={(event) => {
                    setAuthType(event.target.value as WorkflowSourceAuthType);
                    setConfirmed(false);
                  }}
                >
                  <option value="public">Public repository</option>
                  <option value={`${provider}-oauth`}>My {LABELS[provider]} connection</option>
                  {provider === 'github' && (
                    <option value="github-app">GitHub App installation</option>
                  )}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-repository`}>Repository</Label>
              <Input
                id={`${id}-repository`}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                disabled={formDisabled || editing !== null}
                required
                maxLength={512}
                placeholder="owner/repository"
              />
              <p className="text-xs text-muted-foreground">
                Enter the repository name, such as owner/repository. GitLab subgroups are supported.
              </p>
            </div>
            {authType.endsWith('-oauth') && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmed}
                  disabled={formDisabled}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Allow project members to read AI-DLC releases using my existing {LABELS[provider]}{' '}
                connection.
              </label>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={
                  formDisabled || !repository.trim() || (authType.endsWith('-oauth') && !confirmed)
                }
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save and verify
              </Button>
              {editing && (
                <Button type="button" variant="ghost" disabled={formDisabled} onClick={resetEditor}>
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            Owners and admins manage workflow sources.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
