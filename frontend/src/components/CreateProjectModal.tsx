import { useState, useEffect, useId } from 'react';
import { Check } from 'lucide-react';
import {
  GitHubIcon,
  GitLabIcon,
  BitbucketIcon,
  CodeCommitIcon,
} from '@/components/icons/git-providers';
import { projectsService, type CreateProjectInput } from '../services/projects';
import { workflowsService, type WorkflowSummary } from '../services/workflows';
import { trackersService } from '../services/trackers';
import { useGitProviderStatus } from '../hooks/useGitProviderStatus';
import { GitConnectButton } from './GitConnectButton';
import { GitRepoSelect } from './GitRepoSelect';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { KeyValueList } from './ui/key-value-list';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from '@/lib/utils';
import {
  codecommitStatus,
  githubAppService,
  gitProviderTerminology,
  isOAuthGitProvider,
  repoDisplayName,
  trackerIdForGitProvider,
  type GitProvider,
  type GitRepo,
} from '../services/gitProvider';
import {
  sourceControlService,
  defaultAuthTypeFor,
  type SourceControlAuthType,
} from '../services/sourceControl';

interface Props {
  onClose: () => void;
  onCreated: () => void;
  // Provider to preselect — used to restore the user's choice after an OAuth
  // round-trip (the redirect to the provider and back resets in-memory state).
  // Empty string (the default) leaves the provider UNSELECTED so opening the
  // modal does not trigger a connection check / OAuth login until the user picks.
  initialProvider?: GitProvider | '';
  initialInstance?: string;
}

const STEPS = ['Provider', 'Repositories', 'Details'] as const;

// Short name for space naming: the last path segment for owner/repo ids, the
// repository name for a CodeCommit ARN (whose last ':' segment is the name).
const repoShortName = (fullName: string) =>
  (fullName.startsWith('arn:') ? fullName.split(':').pop() : fullName.split('/').pop()) || '';

// Local form shape: gitProvider may be '' before the user selects one.
type ProjectForm = Omit<CreateProjectInput, 'gitProvider'> & { gitProvider: GitProvider | '' };

function StepProgress({ step }: { step: number }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STEPS.map((label, index) => {
        const n = index + 1;
        const state = step === n ? 'current' : step > n ? 'done' : 'todo';
        return (
          <li
            key={label}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums',
                state === 'current' && 'bg-primary text-primary-foreground',
                state === 'done' && 'bg-agent-success/15 text-agent-success-fg',
                state === 'todo' && 'bg-muted text-muted-foreground',
              )}
            >
              {state === 'done' ? <Check className="h-3.5 w-3.5" /> : n}
            </span>
            {state === 'done' && <span className="sr-only">Completed: </span>}
            <span
              className={cn(
                state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {index < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-4 sm:w-8',
                  state === 'done' ? 'bg-agent-success/40' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function CreateProjectModal({
  onClose,
  onCreated,
  initialProvider = '',
  initialInstance,
}: Props) {
  const [step, setStep] = useState(1);
  const [instance, setInstance] = useState(
    initialProvider === 'gitlab' ? initialInstance : undefined,
  );
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [primaryRepo, setPrimaryRepo] = useState<string>('');
  const [formData, setFormData] = useState<ProjectForm>({
    name: '',
    gitProvider: initialProvider,
    gitRepo: '',
    issueIntegrationEnabled: false,
  });
  // Personal OAuth is needed only for the OAuth-delegation path; the GitHub
  // App path discovers repositories with platform App credentials.
  const {
    status: gitStatus,
    instances: gitlabInstances,
    loading: gitStatusLoading,
    error: gitStatusError,
    refresh: gitRefresh,
  } = useGitProviderStatus(formData.gitProvider, instance);
  const [sourceControlAuthType, setSourceControlAuthType] = useState<SourceControlAuthType>(
    defaultAuthTypeFor(initialProvider),
  );
  // Whether the platform GitHub App is configured — gates the App option in
  // step 1. null = still loading.
  const [appConfigured, setAppConfigured] = useState<boolean | null>(null);
  // The configured CodeCommit region, for the step-3 summary. null until the
  // status route answers (or when the provider is not CodeCommit).
  const [codecommitRegion, setCodecommitRegion] = useState<string | null>(null);
  const [delegationConfirmed, setDelegationConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (formData.gitProvider !== 'github') return;
    let cancelled = false;
    githubAppService
      .getStatus()
      .then(({ configured }) => {
        if (!cancelled) setAppConfigured(configured);
      })
      .catch(() => {
        if (!cancelled) setAppConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.gitProvider]);

  // The configured CodeCommit region drives the step-3 summary label.
  useEffect(() => {
    if (formData.gitProvider !== 'codecommit') {
      setCodecommitRegion(null);
      return;
    }
    let cancelled = false;
    codecommitStatus()
      .then((status) => {
        if (!cancelled) setCodecommitRegion(status.region);
      })
      .catch(() => {
        if (!cancelled) setCodecommitRegion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.gitProvider]);

  // If the App turns out to be unconfigured, fall back to the OAuth path.
  useEffect(() => {
    if (appConfigured === false && sourceControlAuthType === 'github-app') {
      setSourceControlAuthType('github-oauth');
    }
  }, [appConfigured, sourceControlAuthType]);

  // v2 workflow options — every new project is a v2 (AI-DLC workflow runtime)
  // project; the backend rejects v1 creation. Scope is chosen per-intent (not
  // on the project), and park release is tuned later in project settings.
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState<string>('');
  const [v2Loading, setV2Loading] = useState(false);
  const [v2Error, setV2Error] = useState<string | null>(null);

  // Load the workflow catalog on mount — a workflow is always required.
  useEffect(() => {
    let cancelled = false;
    setV2Loading(true);
    setV2Error(null);
    workflowsService
      .list()
      .then(({ workflows: list }) => {
        if (cancelled) return;
        setWorkflows(list);
        // Prefer the canonical aidlc-v2 workflow if present.
        const preferred = list.find((w) => w.workflowId === 'aidlc-v2') ?? list[0];
        if (preferred) setWorkflowId(preferred.workflowId);
      })
      .catch((err) => {
        if (!cancelled) setV2Error(err instanceof Error ? err.message : 'Failed to load workflows');
      })
      .finally(() => {
        if (!cancelled) setV2Loading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPrimaryRepo = (nextPrimary: string) => {
    const prevPrimaryName = repoShortName(primaryRepo);
    const nextPrimaryName = repoShortName(nextPrimary);
    setPrimaryRepo(nextPrimary);
    setFormData((prev) => ({
      ...prev,
      gitRepo: nextPrimary,
      name: prev.name === '' || prev.name === prevPrimaryName ? nextPrimaryName : prev.name,
    }));
  };

  const handleReposChange = (repos: GitRepo[]) => {
    const fullNames = repos.map((r) => r.fullName);
    setSelectedRepos(fullNames);
    applyPrimaryRepo(
      fullNames.length === 0 ? '' : fullNames.includes(primaryRepo) ? primaryRepo : fullNames[0],
    );
  };

  const handleProviderChange = (provider: GitProvider) => {
    setInstance(undefined);
    setFormData((prev) => ({ ...prev, gitProvider: provider, gitRepo: '' }));
    setSourceControlAuthType(defaultAuthTypeFor(provider));
    setSelectedRepos([]);
    setPrimaryRepo('');
    setDelegationConfirmed(false);
  };

  // App vs OAuth discover different repo sets, so switching resets the picks.
  const handleAuthTypeChange = (authType: SourceControlAuthType) => {
    setSourceControlAuthType(authType);
    setDelegationConfirmed(false);
    setSelectedRepos([]);
    setPrimaryRepo('');
    setFormData((prev) => ({ ...prev, gitRepo: '' }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRepos.length > 0 && !selectedRepos.includes(primaryRepo)) {
      setError('Select exactly one primary repository.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const gitProvider = formData.gitProvider;
      if (!gitProvider) {
        setError('Select a git provider.');
        setSubmitting(false);
        return;
      }
      if (!workflowId) {
        setError('Select a workflow for the space.');
        setSubmitting(false);
        return;
      }
      const repos = selectedRepos.map((url) => ({
        url,
        role: url === primaryRepo ? ('primary' as const) : ('secondary' as const),
      }));
      const input: CreateProjectInput = {
        ...formData,
        gitProvider,
        repos,
        kind: 'v2',
        workflowId,
      };
      const project = await projectsService.create(input);
      // A failed bind leaves the project unbound rather than deleting it — the
      // launch guard blocks repository-backed starts until an owner rebinds in
      // project settings, which is also where an interrupted create lands.
      try {
        await sourceControlService.bind(project.id, {
          [gitProvider]: {
            authType: sourceControlAuthType,
            ...(sourceControlAuthType.endsWith('-oauth') ? { confirmDelegation: true } : {}),
          },
        });
      } catch (bindingError) {
        console.error('Source-control binding failed; project created unbound:', bindingError);
        onCreated();
        onClose();
        return;
      }
      // GitHub and GitLab issues both reuse the project's git connection; code-
      // host-only providers (Bitbucket, CodeCommit) have no tracker to add.
      const trackerProvider = trackerIdForGitProvider(gitProvider);
      if (formData.issueIntegrationEnabled && formData.gitRepo && trackerProvider) {
        try {
          await trackersService.addToProject(project.id, {
            provider: trackerProvider,
            instance: instance ?? 'public',
            externalProjectKey: formData.gitRepo,
            displayName: formData.gitRepo,
          });
        } catch (err) {
          console.error(`Failed to add ${trackerProvider} tracker:`, err);
        }
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create space');
    } finally {
      setSubmitting(false);
    }
  };

  // The App path needs no personal connection — only a configured App. The
  // OAuth paths (github-oauth / gitlab-oauth) need the caller connected for
  // both repository discovery and binding delegation.
  const canProceedStep1 = formData.gitProvider
    ? sourceControlAuthType === 'github-app'
      ? appConfigured === true
      : // OAuth and CodeCommit both gate on a platform-level connection the
        // status route reports (OAuth: the caller connected; CodeCommit: an
        // admin configured the one platform role).
        !gitStatusLoading && Boolean(gitStatus?.connected)
    : false;
  const canProceedStep2 = selectedRepos.length > 0;
  const repoCount = selectedRepos.length;
  const nextHintId = useId();
  const step1Blocker = !formData.gitProvider
    ? 'Select a git provider'
    : sourceControlAuthType === 'github-app'
      ? appConfigured === false
        ? 'GitHub App is not configured'
        : null
      : gitStatusLoading
        ? null
        : formData.gitProvider === 'codecommit'
          ? 'CodeCommit is not set up yet'
          : `Connect ${gitProviderTerminology(formData.gitProvider).label} to continue`;
  const step1Hint = canProceedStep1 ? null : step1Blocker;
  const step2Hint = canProceedStep2 ? null : 'Select at least one repository';
  const providerLabel = formData.gitProvider
    ? gitProviderTerminology(formData.gitProvider).label
    : 'Git';
  const connectionSummary =
    sourceControlAuthType === 'github-app'
      ? 'GitHub App installation'
      : sourceControlAuthType === 'codecommit-role'
        ? `AWS CodeCommit (${codecommitRegion ?? 'region set by your platform admin'})`
        : `Delegated ${providerLabel} OAuth identity`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        // A stray click or Escape must not throw away a half-filled wizard:
        // only Cancel or Close end it once the reader is past the first step.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (step > 1) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Create space</DialogTitle>
          <DialogDescription>
            Connect a code host, choose its repositories, then name the space.
          </DialogDescription>
        </DialogHeader>

        <StepProgress step={step} />

        {error && (
          <Alert tone="danger" live>
            {error}
          </Alert>
        )}

        {/* Step 1: Connect Git Provider */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="git-provider-select">Git provider</Label>
              <p className="text-xs text-muted-foreground">
                A space connects to a single git provider.
              </p>
              <Select
                value={formData.gitProvider}
                onValueChange={(v) => handleProviderChange(v as GitProvider)}
              >
                <SelectTrigger id="git-provider-select">
                  <SelectValue placeholder="Select a git provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">
                    <span className="flex items-center gap-2">
                      <GitHubIcon className="h-4 w-4" />
                      GitHub
                    </span>
                  </SelectItem>
                  <SelectItem value="gitlab">
                    <span className="flex items-center gap-2">
                      <GitLabIcon className="h-4 w-4" />
                      GitLab
                    </span>
                  </SelectItem>
                  <SelectItem value="bitbucket">
                    <span className="flex items-center gap-2">
                      <BitbucketIcon className="h-4 w-4" />
                      Bitbucket
                    </span>
                  </SelectItem>
                  <SelectItem value="codecommit">
                    <span className="flex items-center gap-2">
                      <CodeCommitIcon className="h-4 w-4" />
                      AWS CodeCommit
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.gitProvider === 'gitlab' && (gitlabInstances?.length || instance) ? (
              <div className="space-y-1.5">
                <Label htmlFor="gitlab-instance-select">GitLab instance</Label>
                <Select
                  value={instance ?? 'gitlab.com'}
                  onValueChange={(host) => {
                    setInstance(host === 'gitlab.com' ? undefined : host);
                    handleReposChange([]);
                    setDelegationConfirmed(false);
                  }}
                >
                  <SelectTrigger id="gitlab-instance-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gitlab.com">gitlab.com</SelectItem>
                    {instance && !gitlabInstances?.includes(instance) && (
                      <SelectItem value={instance} disabled>
                        {instance}
                      </SelectItem>
                    )}
                    {(gitlabInstances ?? []).map((host) => (
                      <SelectItem key={host} value={host}>
                        {host}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {gitStatusError && sourceControlAuthType !== 'github-app' && (
              <Alert
                tone="danger"
                action={
                  <Button type="button" variant="outline" size="sm" onClick={gitRefresh}>
                    Retry
                  </Button>
                }
              >
                {gitStatusError}
              </Alert>
            )}
            {!formData.gitProvider ? (
              <p className="text-sm text-muted-foreground">Select a git provider to continue.</p>
            ) : (
              <>
                {formData.gitProvider === 'github' && (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Authentication</legend>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="sourceControlAuthType"
                        checked={sourceControlAuthType === 'github-app'}
                        onChange={() => handleAuthTypeChange('github-app')}
                        disabled={appConfigured === false}
                        className="mt-1 accent-primary"
                      />
                      <span className="text-sm">
                        <span className="font-medium">GitHub App</span>
                        <span className="block text-xs text-muted-foreground">
                          {appConfigured === false
                            ? 'Not configured — ask a platform admin to set up the GitHub App.'
                            : 'Uses the platform GitHub App installation. No personal GitHub connection needed.'}
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="sourceControlAuthType"
                        checked={sourceControlAuthType === 'github-oauth'}
                        onChange={() => handleAuthTypeChange('github-oauth')}
                        className="mt-1 accent-primary"
                      />
                      <span className="text-sm">
                        <span className="font-medium">My GitHub OAuth identity</span>
                        <span className="block text-xs text-muted-foreground">
                          The space delegates your personal connection for repository access.
                        </span>
                      </span>
                    </label>
                  </fieldset>
                )}
                {sourceControlAuthType === 'github-app' ? (
                  appConfigured === null ? (
                    <p className="text-sm text-muted-foreground" role="status">
                      Checking GitHub App configuration…
                    </p>
                  ) : null
                ) : gitStatusLoading ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Checking connection…
                  </p>
                ) : formData.gitProvider === 'gitlab' &&
                  instance &&
                  gitStatusError ? null : isOAuthGitProvider(formData.gitProvider) ? (
                  gitStatus?.connected ? (
                    <p className="flex items-center gap-1.5 text-sm text-agent-success-fg">
                      <Check className="h-4 w-4" aria-hidden="true" />
                      {providerLabel} connected
                    </p>
                  ) : (
                    <GitConnectButton
                      provider={formData.gitProvider}
                      instance={instance}
                      connected={false}
                      reauthorizationRequired={gitStatus?.reauthorizationRequired}
                      missingScopes={gitStatus?.missingScopes}
                      onDisconnect={() => {}}
                    />
                  )
                ) : formData.gitProvider === 'codecommit' && !gitStatus?.connected ? (
                  // Not configured: a platform admin sets up the one CodeCommit
                  // connection. Same pattern as the GitHub App — Next is blocked
                  // until it exists (canProceedStep1).
                  <Alert tone="warning" title="CodeCommit is not set up yet.">
                    Ask a platform admin to set up CodeCommit in Platform Admin › Source Control.
                  </Alert>
                ) : null}
              </>
            )}
            <DialogFooter className="sm:items-center">
              {step1Hint && (
                <p
                  id={`${nextHintId}-1`}
                  className="text-xs text-muted-foreground sm:mr-auto"
                  aria-live="polite"
                >
                  {step1Hint}
                </p>
              )}
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => setStep(2)}
                disabled={!canProceedStep1}
                aria-describedby={step1Hint ? `${nextHintId}-1` : undefined}
              >
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 2: Select Repositories (provider is always set past step 1) */}
        {step === 2 && formData.gitProvider && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Select repositories</h3>
              <p className="text-xs text-muted-foreground">
                Choose one or more repositories. The primary repository drives issue integration and
                the space name.
              </p>
            </div>
            <GitRepoSelect
              provider={formData.gitProvider}
              instance={instance}
              multiple
              value={selectedRepos}
              onChange={handleReposChange}
              repoSource={sourceControlAuthType === 'github-app' ? 'github-app' : 'oauth'}
            />
            {selectedRepos.length > 1 && (
              <fieldset className="divide-y rounded-md border">
                <legend className="sr-only">Primary repository</legend>
                <div className="bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  Primary repository
                </div>
                {selectedRepos.map((repo) => (
                  <label
                    key={repo}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-accent/50"
                  >
                    <input
                      type="radio"
                      name="primaryRepo"
                      checked={primaryRepo === repo}
                      onChange={() => applyPrimaryRepo(repo)}
                      className="accent-primary"
                    />
                    <span className="flex-1 truncate text-sm" title={repo}>
                      {formData.gitProvider ? repoDisplayName(formData.gitProvider, repo) : repo}
                    </span>
                    {primaryRepo === repo && (
                      <Badge variant="secondary" size="sm">
                        Primary
                      </Badge>
                    )}
                  </label>
                ))}
              </fieldset>
            )}
            <DialogFooter className="sm:items-center">
              {step2Hint && (
                <p
                  id={`${nextHintId}-2`}
                  className="text-xs text-muted-foreground sm:mr-auto"
                  aria-live="polite"
                >
                  {step2Hint}
                </p>
              )}
              <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                type="button"
                onClick={() => setStep(3)}
                disabled={!canProceedStep2}
                aria-describedby={step2Hint ? `${nextHintId}-2` : undefined}
              >
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Project Details */}
        {step === 3 && formData.gitProvider && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <h3 className="text-sm font-medium">Space details</h3>
            <div className="space-y-1.5">
              <Label htmlFor="space-name">Space name</Label>
              <Input
                id="space-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                disabled={submitting}
              />
            </div>
            <KeyValueList
              items={[
                {
                  label: repoCount > 1 ? 'Primary repository' : 'Repository',
                  value: (
                    <>
                      <span className="break-all">
                        {repoDisplayName(formData.gitProvider, formData.gitRepo)}
                      </span>
                      {repoCount > 1 && (
                        <span className="block text-xs text-muted-foreground">
                          +{repoCount - 1} more{' '}
                          {repoCount - 1 === 1 ? 'repository' : 'repositories'}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  label: 'Source control',
                  value: (
                    <>
                      {connectionSummary}
                      <span className="block text-xs text-muted-foreground">
                        {sourceControlAuthType === 'codecommit-role'
                          ? 'Managed by your platform admin.'
                          : 'Chosen in step 1 — go back to change it.'}
                      </span>
                    </>
                  ),
                },
              ]}
            />
            <div className="space-y-3 rounded-md border p-3">
              {sourceControlAuthType.endsWith('-oauth') && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={delegationConfirmed}
                    onChange={(event) => setDelegationConfirmed(event.target.checked)}
                    disabled={submitting}
                    className="mt-0.5 accent-primary"
                  />
                  I confirm that this space may use my connected identity for all selected
                  repositories.
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                Every repository is verified before the space is available.
              </p>
            </div>
            {(formData.gitProvider === 'github' || formData.gitProvider === 'gitlab') && (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={formData.issueIntegrationEnabled ?? false}
                  onChange={(e) =>
                    setFormData({ ...formData, issueIntegrationEnabled: e.target.checked })
                  }
                  className="mt-0.5 accent-primary"
                  disabled={submitting}
                />
                <span className="text-sm">
                  <span className="font-medium">
                    Enable {formData.gitProvider === 'gitlab' ? 'GitLab' : 'GitHub'} issue
                    integration
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Browse issues on the space page and start intents from them.
                    {repoCount > 1 ? ' Applies to the primary repository only.' : ''}
                  </span>
                </span>
              </label>
            )}
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1">
                <h4 id="space-workflow-label" className="text-sm font-medium">
                  Workflow
                </h4>
                <p className="text-xs text-muted-foreground">
                  The method every intent in this space follows. Scope is chosen per intent; runtime
                  settings can be tuned later in space settings.
                </p>
              </div>
              {v2Error && <Alert tone="danger">{v2Error}</Alert>}
              <Select value={workflowId} onValueChange={setWorkflowId} disabled={submitting}>
                <SelectTrigger aria-labelledby="space-workflow-label">
                  <SelectValue placeholder={v2Loading ? 'Loading…' : 'Select a workflow'} />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((w) => (
                    <SelectItem key={w.workflowId} value={w.workflowId}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(2)}
                disabled={submitting}
              >
                Back
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={
                  !workflowId || (sourceControlAuthType.endsWith('-oauth') && !delegationConfirmed)
                }
              >
                Create space
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
