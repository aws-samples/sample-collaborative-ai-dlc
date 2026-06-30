import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  projectsService,
  type Project,
  type Member,
  type ProjectRole,
  type CognitoUser,
  type AgentCli,
  type CliModels,
  type RuntimeModelCli,
  type TrackerBinding,
  type SteeringDoc,
  type ProjectRepo,
} from '../services/projects';
import { trackersService, type TrackerConnection } from '../services/trackers';
import { agentsService } from '../services/agents';
import { GitRepoSelect } from '../components/GitRepoSelect';
import {
  trackerIdForGitProvider,
  getGitProviderService,
  gitProviderTerminology,
  type GitRepo,
  type GitTrackerProviderId,
} from '../services/gitProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { McpServersSection } from '../components/settings/McpServersSection';
import { SteeringDocsSection } from '../components/settings/SteeringDocsSection';
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
import { ArrowLeft, Trash2, X, AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { MigrateTrackerCard } from '@/components/MigrateTrackerCard';
import { JiraConnectButton } from '@/components/JiraConnectButton';
import { JiraProjectPickerDialog } from '@/components/JiraProjectPickerDialog';
import { useTrackerProviders } from '@/hooks/useTrackerProviders';
import { getTrackerProvider, TRACKER_PROVIDERS } from '@/lib/trackerProviders';

const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Full control: manage project, members, and settings',
  admin: 'Manage members and update the project repository',
  member: 'Collaborate on sprints and trigger agents',
};

const ROLE_BADGE: Record<ProjectRole, string> = {
  owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  admin: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  member: 'bg-muted text-muted-foreground border-transparent',
};

const AGENT_CLI_CONFIG: Record<AgentCli, { label: string; description: string }> = {
  kiro: {
    label: 'Kiro',
    description: 'AWS Kiro CLI — device-flow SSO authentication',
  },
  claude: {
    label: 'Claude Code',
    description: 'Anthropic Claude Code — AWS Bedrock authentication',
  },
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode CLI — AWS Bedrock authentication',
  },
};

const MODEL_CLI_LABELS: Record<RuntimeModelCli, string> = {
  kiro: 'Kiro',
  claude: 'Claude',
  opencode: 'OpenCode',
};

const MODEL_CLI_KEYS = Object.keys(MODEL_CLI_LABELS) as RuntimeModelCli[];

const MODEL_ID_HELP: Record<RuntimeModelCli, { label: string; url: string }> = {
  kiro: {
    label: 'Kiro model IDs',
    url: 'https://kiro.dev/docs/',
  },
  claude: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
  opencode: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
};

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

export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editGitRepo, setEditGitRepo] = useState('');
  const [saving, setSaving] = useState(false);

  // Tracker bindings — the source of truth for which trackers a project is
  // wired to. Replaces the legacy `issueIntegrationEnabled` boolean (#196).
  const [togglingTracker, setTogglingTracker] = useState(false);

  // Cross-project tracker connections (Jira Cloud, GitHub, …). Drives the
  // "Connect Jira Cloud" CTA and downstream picker flows. Phase 3 / #197.
  const [trackerConnections, setTrackerConnections] = useState<TrackerConnection[]>([]);
  // Operator OAuth-app config — flips the Connect CTA to disabled with a
  // helper hint when the deployment hasn't populated the secret yet.
  const { providers: trackerProviders } = useTrackerProviders();
  const [connectingJira, setConnectingJira] = useState(false);
  const [showJiraProjectPicker, setShowJiraProjectPicker] = useState(false);

  // Agent CLI state
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>('kiro');
  const [savingAgentCli, setSavingAgentCli] = useState(false);
  const [availableCliNames, setAvailableCliNames] = useState<AgentCli[]>(['kiro']);
  const [runtimeModelOverride, setRuntimeModelOverride] = useState<Record<AgentCli, boolean>>({
    kiro: true,
    claude: true,
    opencode: true,
  });
  const [editCliModels, setEditCliModels] = useState<CliModels>({});
  const [globalCliModels, setGlobalCliModels] = useState<CliModels>({});
  const [savingCliModels, setSavingCliModels] = useState(false);

  // Tracker-abstraction migration (#194 Phase 1). The card shows when the
  // project still uses the legacy issue_integration boolean and has no
  // HAS_TRACKER edge yet — i.e. it predates the abstraction or was created
  // by an OSS install that hasn't migrated.
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{
    sprintsApplied: number;
    projectsApplied: number;
  } | null>(null);

  // Repositories state
  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [selectedNewRepos, setSelectedNewRepos] = useState<string[]>([]);
  const [addingRepo, setAddingRepo] = useState(false);
  const [removingRepo, setRemovingRepo] = useState<string | null>(null);
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null);
  const [confirmRemoveRepo, setConfirmRemoveRepo] = useState<string | null>(null);

  // Add member state
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberUserId, setNewMemberUserId] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<ProjectRole>('member');
  const [addingMember, setAddingMember] = useState(false);
  const [cognitoUsers, setCognitoUsers] = useState<CognitoUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<CognitoUser | null>(null);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  // Role change confirmation
  const [confirmRoleChange, setConfirmRoleChange] = useState<{
    userId: string;
    newRole: ProjectRole;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // MCP servers state (raw JSON string; persistence handled by McpServersSection)
  const [mcpServers, setMcpServers] = useState('[]');

  // Steering docs state (persistence/upload handled by SteeringDocsSection)
  const [steeringDocs, setSteeringDocs] = useState<SteeringDoc[]>([]);

  const userRole = project?.userRole;
  const canManageMembers = userRole === 'owner' || userRole === 'admin';
  const canEditProject = userRole === 'owner' || userRole === 'admin';

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      const [proj, mems, conns] = await Promise.all([
        projectsService.get(projectId),
        projectsService.listMembers(projectId),
        trackersService.listConnections().catch(() => []),
      ]);
      setProject(proj);
      setEditName(proj.name);
      setEditGitRepo(proj.gitRepo);
      setEditAgentCli(proj.agentCli ?? 'kiro');
      setEditCliModels(proj.cliModels || {});
      setRepos(proj.repos ?? []);
      setMembers(Array.isArray(mems) ? mems : []);
      setTrackerConnections(Array.isArray(conns) ? conns : []);

      // Load MCP servers and steering docs in parallel (non-blocking)
      Promise.all([
        projectsService.getMcpServers(projectId).catch(() => ({ mcpServers: '[]' })),
        projectsService.getSteeringDocs(projectId).catch(() => ({ steeringDocs: [] })),
      ]).then(([mcpResp, docsResp]) => {
        setMcpServers(mcpResp.mcpServers ?? '[]');
        setSteeringDocs(docsResp.steeringDocs ?? []);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Load available CLI capabilities separately (non-blocking)
  useEffect(() => {
    agentsService
      .getCapabilities()
      .then((c) => {
        setAvailableCliNames(c.available);
        if (c.runtimeModelOverride) setRuntimeModelOverride(c.runtimeModelOverride);
      })
      .catch(() => {
        /* non-fatal — keep default ['kiro'] */
      });
  }, []);

  useEffect(() => {
    agentsService
      .getSettings()
      .then((settings) => setGlobalCliModels(settings.cliModels || {}))
      .catch(() => {
        /* non-fatal — placeholders fall back to generic defaults */
      });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const loadCognitoUsers = async () => {
    setLoadingUsers(true);
    try {
      const users = await projectsService.listCognitoUsers();
      // Filter out users who are already members
      const memberIds = new Set(members.map((m) => m.userId));
      setCognitoUsers(
        users.filter((u) => u.enabled && u.status === 'CONFIRMED' && !memberIds.has(u.userId)),
      );
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoadingUsers(false);
    }
  };

  const openAddMemberModal = () => {
    setShowAddMember(true);
    setSelectedUser(null);
    setNewMemberUserId('');
    setNewMemberEmail('');
    setUserSearch('');
    setNewMemberRole('member');
    loadCognitoUsers();
  };

  const selectUser = (user: CognitoUser) => {
    setSelectedUser(user);
    setNewMemberUserId(user.userId);
    setNewMemberEmail(user.email);
    setUserSearch('');
    setShowUserDropdown(false);
  };

  const clearSelectedUser = () => {
    setSelectedUser(null);
    setNewMemberUserId('');
    setNewMemberEmail('');
    setUserSearch('');
  };

  const filteredUsers = cognitoUsers.filter((u) => {
    if (!userSearch) return true;
    const q = userSearch.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  });

  // Add the git-issues tracker matching the project's git provider
  // (github-issues / gitlab-issues). Both reuse the project's git connection.
  const handleAddGitTracker = async (providerId: GitTrackerProviderId) => {
    if (!projectId || !project || !project.gitRepo) return;
    clearMessages();
    setTogglingTracker(true);
    try {
      const meta = TRACKER_PROVIDERS[providerId];
      await trackersService.addToProject(projectId, {
        provider: meta.id,
        instance: meta.instance,
        externalProjectKey: project.gitRepo,
        displayName: project.gitRepo,
      });
      await loadData();
      setSuccess(`${meta.displayName} integration enabled.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable tracker');
    } finally {
      setTogglingTracker(false);
    }
  };

  const handleConnectJira = async () => {
    clearMessages();
    setConnectingJira(true);
    try {
      const { url } = await trackersService.getAuthUrl(TRACKER_PROVIDERS['jira-cloud'].id);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Jira Cloud OAuth');
      setConnectingJira(false);
    }
  };

  // Triggered by the picker dialog once the user confirms a Jira project.
  const handleAddJiraBinding = async (chosen: { key: string; name: string }) => {
    if (!projectId) return;
    clearMessages();
    const jira = TRACKER_PROVIDERS['jira-cloud'];
    await trackersService.addToProject(projectId, {
      provider: jira.id,
      instance: jira.instance,
      externalProjectKey: chosen.key,
      displayName: chosen.name || chosen.key,
    });
    await loadData();
    setSuccess('Jira project bound to this collaborative project.');
  };

  const handleRemoveTracker = async (binding: TrackerBinding) => {
    if (!projectId) return;
    clearMessages();
    setTogglingTracker(true);
    try {
      await trackersService.removeFromProject(projectId, binding.id);
      await loadData();
      setSuccess('Tracker disconnected from this project.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove tracker');
    } finally {
      setTogglingTracker(false);
    }
  };

  const handleReconnectTracker = async (binding: TrackerBinding) => {
    clearMessages();
    try {
      // Store the return path so the OAuth callback redirects back here instead
      // of the create-project flow.
      sessionStorage.setItem('oauth_return_to', `/project/${projectId}/settings`);
      // Git-based trackers (github-issues / gitlab-issues) share the git
      // provider's OAuth connection — reconnect via the git auth flow.
      if (binding.provider === 'github-issues' || binding.provider === 'gitlab-issues') {
        const gitProvider = binding.provider === 'gitlab-issues' ? 'gitlab' : 'github';
        const { url } = await getGitProviderService(gitProvider).getAuthUrl();
        window.location.href = url;
        return;
      }
      // Standalone tracker providers (Jira) use the trackers auth endpoint.
      const { url } = await trackersService.getAuthUrl(binding.provider);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start reconnection');
    }
  };

  const handleMigrateTracker = async () => {
    if (!projectId) return;
    clearMessages();
    setMigrating(true);
    try {
      const result = await projectsService.migrateTracker(projectId);
      setMigrationResult({
        sprintsApplied: result.sprints.applied,
        projectsApplied: result.projects.applied,
      });
      // Reload so the project's `trackers` array reflects the new binding,
      // which dismisses the card on next render.
      await loadData();
      setSuccess('Migrated to the new tracker data model.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to migrate');
    } finally {
      setMigrating(false);
    }
  };

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !project) return;
    clearMessages();
    setSaving(true);
    try {
      const updates: {
        name?: string;
      } = {};
      if (editName !== project.name) updates.name = editName;
      if (Object.keys(updates).length === 0) {
        setSaving(false);
        return;
      }
      await projectsService.update(projectId, updates);
      setProject({ ...project, ...updates });
      invalidateProjects();
      setSuccess('Project settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAgentCli = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !project) return;
    clearMessages();
    if (editAgentCli === project.agentCli) return;
    setSavingAgentCli(true);
    try {
      await projectsService.update(projectId, { agentCli: editAgentCli });
      setProject({ ...project, agentCli: editAgentCli });
      invalidateProjects();
      setSuccess('Agent CLI updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update agent CLI');
    } finally {
      setSavingAgentCli(false);
    }
  };

  const updateCliModel = (cli: RuntimeModelCli, value: string) => {
    setEditCliModels((current) => ({ ...current, [cli]: value }));
  };

  const handleSaveCliModels = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !project) return;
    clearMessages();
    setSavingCliModels(true);
    try {
      const saved = await projectsService.update(projectId, { cliModels: editCliModels });
      const nextModels = saved.cliModels || editCliModels;
      setEditCliModels(nextModels);
      setProject({ ...project, cliModels: nextModels });
      setSuccess('Model override updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update model override');
    } finally {
      setSavingCliModels(false);
    }
  };

  const handleAddRepos = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || selectedNewRepos.length === 0) return;
    clearMessages();
    setAddingRepo(true);
    const results = await Promise.allSettled(
      selectedNewRepos.map((url) =>
        projectsService.addRepo(projectId, { url, provider: project?.gitProvider }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failedRepos = results
      .map((r, i) => (r.status === 'rejected' ? selectedNewRepos[i] : null))
      .filter((n): n is string => n !== null);
    await loadData();
    setAddingRepo(false);
    if (failedRepos.length === 0) {
      setSelectedNewRepos([]);
      setShowAddRepo(false);
      setSuccess(`${succeeded} repositor${succeeded === 1 ? 'y' : 'ies'} added`);
    } else {
      // Keep the dialog open with only the failed repos still selected so the
      // user can retry or deselect them; the error also renders in-dialog.
      setSelectedNewRepos(failedRepos);
      setError(
        succeeded > 0
          ? `${succeeded} added. Failed to add: ${failedRepos.join(', ')}`
          : `Failed to add: ${failedRepos.join(', ')}`,
      );
    }
  };

  const handleRemoveRepo = async (repoUrl: string) => {
    if (!projectId) return;
    setConfirmRemoveRepo(null);
    clearMessages();
    setRemovingRepo(repoUrl);
    try {
      await projectsService.removeRepo(projectId, repoUrl);
      setSuccess('Repository removed');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove repository');
    } finally {
      setRemovingRepo(null);
    }
  };

  const handleSetPrimaryRepo = async (repoUrl: string) => {
    if (!projectId) return;
    clearMessages();
    setSettingPrimary(repoUrl);
    try {
      await projectsService.update(projectId, { gitRepo: repoUrl });
      setEditGitRepo(repoUrl);
      setProject((prev) => (prev ? { ...prev, gitRepo: repoUrl } : prev));
      setSuccess('Primary repository updated');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set primary repository');
    } finally {
      setSettingPrimary(null);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId) return;
    clearMessages();
    setAddingMember(true);
    try {
      await projectsService.addMember(projectId, {
        userId: newMemberUserId,
        email: newMemberEmail,
        role: newMemberRole,
      });
      setShowAddMember(false);
      setNewMemberUserId('');
      setNewMemberEmail('');
      setNewMemberRole('member');
      setSelectedUser(null);
      setUserSearch('');
      setSuccess('Member added');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: ProjectRole) => {
    if (!projectId) return;
    clearMessages();
    try {
      await projectsService.updateMemberRole(projectId, userId, newRole);
      setConfirmRoleChange(null);
      setSuccess('Role updated');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!projectId) return;
    clearMessages();
    try {
      await projectsService.removeMember(projectId, userId);
      setConfirmRemove(null);
      setSuccess('Member removed');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleSaveMcpServers = async (value: string) => {
    if (!projectId) return;
    clearMessages();
    await projectsService.updateMcpServers(projectId, value);
    setSuccess('MCP servers saved');
  };

  const handleSaveSteeringMetadata = async (docs: Array<{ filename: string }>) => {
    if (!projectId) throw new Error('Missing projectId');
    return projectsService.updateSteeringDocs(projectId, docs);
  };

  const refreshSteeringDocs = async () => {
    if (!projectId) return;
    const refreshed = await projectsService.getSteeringDocs(projectId);
    setSteeringDocs(refreshed.steeringDocs ?? []);
  };

  const getAssignableRoles = (): ProjectRole[] => {
    if (userRole === 'owner') return ['owner', 'admin', 'member'];
    if (userRole === 'admin') return ['member'];
    return [];
  };

  if (!projectId) return <div className="p-6">Project not found</div>;

  return (
    <div className="h-full">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 -ml-2"
            onClick={() => navigate(`/project/${projectId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Project
          </Button>
          <div className="h-5 w-px bg-border" />
          <h1 className="text-xl font-semibold tracking-tight">Project Settings</h1>
          {userRole && (
            <Badge variant="outline" className={cn('text-[10px] ml-auto', ROLE_BADGE[userRole])}>
              {ROLE_LABELS[userRole]}
            </Badge>
          )}
        </div>

        {/* Messages */}
        {error && (
          <div className="bg-destructive/5 border border-destructive/20 text-destructive px-4 py-3 rounded-md mb-4 flex items-start justify-between gap-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 -mr-1 -mt-0.5 text-destructive hover:text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {success && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-4 py-3 rounded-md mb-4 flex items-start justify-between gap-3 text-sm">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{success}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 -mr-1 -mt-0.5"
              onClick={() => setSuccess(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-muted-foreground text-sm">Loading...</div>
        ) : (
          <>
            {project && (
              <MigrateTrackerCard
                project={project}
                canEditProject={canEditProject}
                migrating={migrating}
                migrationResult={migrationResult}
                onMigrate={handleMigrateTracker}
              />
            )}

            {/* General */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">General</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveProject} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="proj-name">Project Name</Label>
                    <Input
                      id="proj-name"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      disabled={!canEditProject || saving}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="proj-repo">
                      {gitProviderTerminology(project?.gitProvider ?? 'github').label} Repository
                    </Label>
                    <Input
                      id="proj-repo"
                      value={editGitRepo}
                      placeholder="owner/repo"
                      className="font-mono text-sm"
                      disabled
                      readOnly
                    />
                    <p className="text-xs text-muted-foreground">
                      Primary repository — managed in the Repositories section below
                    </p>
                  </div>
                  {canEditProject && (
                    <div className="flex justify-end pt-2">
                      <Button type="submit" size="sm" disabled={saving}>
                        {saving ? 'Saving...' : 'Save Changes'}
                      </Button>
                    </div>
                  )}
                </form>
              </CardContent>
            </Card>

            {/* Trackers — provider-agnostic issue trackers wired to this
                project. Manages the git-issues tracker matching the project's
                git provider (github-issues / gitlab-issues) plus Jira Cloud. */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Trackers</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Connect issue trackers so sprints can be started from their issues.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {(project?.trackers ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No trackers connected to this project.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {project?.trackers.map((b) => {
                      const isLegacy = b.id === 'legacy-github';
                      return (
                        <div
                          key={b.id}
                          className="flex items-center justify-between gap-3 border rounded-md p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {getTrackerProvider(b.provider).displayName}
                              {isLegacy && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  (legacy — migrate to manage)
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {b.displayName || b.externalProjectKey}
                            </p>
                          </div>
                          {canEditProject && !isLegacy && (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleReconnectTracker(b)}
                                disabled={togglingTracker}
                              >
                                Reconnect
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleRemoveTracker(b)}
                                disabled={togglingTracker}
                              >
                                Remove
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Add the git-issues tracker matching the project's git
                    provider (github-issues / gitlab-issues). One block — the
                    provider selects the tracker id + label. */}
                {(() => {
                  if (!canEditProject || !project?.gitRepo) return null;
                  if (project.gitProvider !== 'github' && project.gitProvider !== 'gitlab') {
                    return null;
                  }
                  const trackerId = trackerIdForGitProvider(project.gitProvider);
                  const meta = TRACKER_PROVIDERS[trackerId];
                  const alreadyBound = (project.trackers ?? []).some(
                    (b) => b.provider === meta.id && b.externalProjectKey === project.gitRepo,
                  );
                  if (alreadyBound) return null;
                  return (
                    <div className="flex justify-end pt-2">
                      <Button
                        size="sm"
                        onClick={() => handleAddGitTracker(trackerId)}
                        disabled={togglingTracker}
                      >
                        {togglingTracker
                          ? 'Saving…'
                          : `Add ${meta.displayName} for ${project.gitRepo}`}
                      </Button>
                    </div>
                  );
                })()}

                {canEditProject && (
                  <JiraConnectButton
                    jiraConnected={trackerConnections.some(
                      (c) => c.provider === TRACKER_PROVIDERS['jira-cloud'].id,
                    )}
                    jiraConfigured={
                      trackerProviders.find((p) => p.id === TRACKER_PROVIDERS['jira-cloud'].id)
                        ?.configured ?? false
                    }
                    togglingTracker={togglingTracker}
                    connectingJira={connectingJira}
                    onConnect={handleConnectJira}
                    onPickProject={() => {
                      clearMessages();
                      setShowJiraProjectPicker(true);
                    }}
                  />
                )}
              </CardContent>
            </Card>

            {/* Repositories */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Repositories ({repos.length})</CardTitle>
                  {canEditProject && (
                    <Button size="sm" onClick={() => setShowAddRepo(true)}>
                      + Add
                    </Button>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Additional repositories linked to this project. Role and tech stack are detected
                  automatically.
                </p>
              </CardHeader>
              <CardContent>
                {repos.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-3">
                    No repositories linked yet.
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {repos.map((repo) => (
                      <div key={repo.url} className="py-2.5 flex items-center gap-2">
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-sm font-mono truncate">{repo.url}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] h-4 shrink-0',
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
                        {canEditProject && (
                          <div className="flex items-center gap-1 shrink-0">
                            {repo.role !== 'primary' && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px] px-2"
                                onClick={() => handleSetPrimaryRepo(repo.url)}
                                disabled={removingRepo === repo.url || settingPrimary === repo.url}
                              >
                                {settingPrimary === repo.url ? '...' : 'Set as primary'}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirmRemoveRepo(repo.url)}
                              disabled={removingRepo === repo.url || settingPrimary === repo.url}
                              title="Remove repository"
                            >
                              {removingRepo === repo.url ? (
                                <span className="text-[10px]">...</span>
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
              </CardContent>
            </Card>

            {/* Agent CLI */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Agent</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Choose which AI agent CLI runs agents for this project. Only CLIs installed in the
                  current deployment are available.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveAgentCli}>
                  <div className="space-y-2">
                    {(
                      Object.entries(AGENT_CLI_CONFIG) as [
                        AgentCli,
                        { label: string; description: string },
                      ][]
                    ).map(([key, cfg]) => {
                      const isAvailable = availableCliNames.includes(key);
                      const isSelected = editAgentCli === key;
                      const isCurrent = project?.agentCli === key;
                      const isSelectable = isAvailable || isCurrent;
                      return (
                        <label
                          key={key}
                          className={cn(
                            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                            isSelected
                              ? 'border-primary bg-primary/5'
                              : isSelectable
                                ? 'border-border hover:bg-accent/40'
                                : 'border-border bg-muted/40 opacity-60 cursor-not-allowed',
                          )}
                        >
                          <input
                            type="radio"
                            name="agentCli"
                            value={key}
                            checked={isSelected}
                            disabled={!canEditProject || savingAgentCli || !isSelectable}
                            onChange={() => setEditAgentCli(key)}
                            className="mt-0.5 accent-primary"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium">{cfg.label}</span>
                              {!isAvailable && !isCurrent && (
                                <Badge variant="outline" className="text-[10px] h-4">
                                  not available
                                </Badge>
                              )}
                              {!isAvailable && isCurrent && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-4 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                                >
                                  no workers
                                </Badge>
                              )}
                              {isAvailable && isSelected && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-4 bg-primary/10 text-primary border-primary/20"
                                >
                                  active
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {cfg.description}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  {!canEditProject && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Only owners and admins can change the agent CLI
                    </p>
                  )}
                  {canEditProject && (
                    <div className="flex justify-end pt-3">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={savingAgentCli || editAgentCli === project?.agentCli}
                      >
                        {savingAgentCli ? 'Saving...' : 'Save Changes'}
                      </Button>
                    </div>
                  )}
                </form>
              </CardContent>
            </Card>

            {/* Model Override */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Model Override</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Optional project-specific model for the selected agent CLI. Empty uses the Admin
                  default.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveCliModels} className="space-y-3">
                  {MODEL_CLI_KEYS.map((cli) => {
                    const isSelected = editAgentCli === cli;
                    const isEditable = canEditProject && isSelected && runtimeModelOverride[cli];
                    return (
                      <div key={cli} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`model-${cli}`}>{MODEL_CLI_LABELS[cli]}</Label>
                            {isSelected && (
                              <Badge variant="outline" className="text-[10px] h-4">
                                selected
                              </Badge>
                            )}
                          </div>
                          <a
                            href={MODEL_ID_HELP[cli].url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            {MODEL_ID_HELP[cli].label}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <Input
                          id={`model-${cli}`}
                          value={editCliModels[cli] || ''}
                          onChange={(e) => updateCliModel(cli, e.target.value)}
                          placeholder={
                            globalCliModels[cli]
                              ? `Default: ${globalCliModels[cli]}`
                              : cli === 'opencode'
                                ? 'Default: amazon-bedrock/us.anthropic.claude-sonnet-4-6'
                                : cli === 'claude'
                                  ? 'Default: us.anthropic.claude-sonnet-4-6'
                                  : 'Default model'
                          }
                          className="font-mono text-sm"
                          disabled={!isEditable || savingCliModels}
                        />
                      </div>
                    );
                  })}
                  {!canEditProject && (
                    <p className="text-xs text-muted-foreground">
                      Only owners and admins can change model overrides
                    </p>
                  )}
                  {canEditProject && (
                    <div className="flex justify-end pt-2">
                      <Button type="submit" size="sm" disabled={savingCliModels}>
                        {savingCliModels ? 'Saving...' : 'Save Model'}
                      </Button>
                    </div>
                  )}
                </form>
              </CardContent>
            </Card>

            {/* MCP Servers */}
            <div className="mb-6">
              <McpServersSection
                value={mcpServers}
                onChange={setMcpServers}
                onSave={handleSaveMcpServers}
                canEdit={canEditProject}
                description="JSON array of MCP server definitions injected into every agent session for this project. These are merged with global MCP servers; when names collide, project-level entries take precedence over global ones."
              />
            </div>

            {/* Steering Rules */}
            <div className="mb-6">
              <SteeringDocsSection
                docs={steeringDocs}
                onSaveMetadata={handleSaveSteeringMetadata}
                onRefresh={refreshSteeringDocs}
                canEdit={canEditProject}
                description="Markdown documents loaded into the agent context for every phase in this project (coding standards, API reference, framework guidelines, etc.)."
                onSuccess={setSuccess}
                onError={setError}
                onClearMessages={clearMessages}
              />
            </div>

            {/* Members */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Members ({members.length})</CardTitle>
                  {canManageMembers && (
                    <Button size="sm" onClick={openAddMemberModal}>
                      + Add Member
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
                  {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
                    <div key={role} className="flex items-center gap-1">
                      <Badge
                        variant="outline"
                        className={cn('text-[10px] h-4', ROLE_BADGE[role as ProjectRole])}
                      >
                        {ROLE_LABELS[role as ProjectRole]}
                      </Badge>
                      <span>— {desc}</span>
                    </div>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border">
                  {members.map((member) => (
                    <div
                      key={member.userId}
                      className="py-3 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground shrink-0">
                          {(member.email || member.userId).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {member.email || member.userId}
                          </p>
                          <p className="text-xs text-muted-foreground/80 font-mono truncate">
                            {member.userId.substring(0, 12)}...
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {canManageMembers ? (
                          <select
                            value={member.role}
                            onChange={(e) => {
                              const newRole = e.target.value as ProjectRole;
                              if (newRole !== member.role) {
                                setConfirmRoleChange({ userId: member.userId, newRole });
                              }
                            }}
                            disabled={
                              userRole === 'admin' &&
                              (member.role === 'owner' || member.role === 'admin')
                            }
                            className={cn(
                              'text-xs h-7 rounded-md border border-input bg-background px-2 disabled:opacity-60',
                              ROLE_BADGE[member.role],
                            )}
                          >
                            {(userRole === 'owner' ? ['owner', 'admin', 'member'] : ['member']).map(
                              (r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r as ProjectRole]}
                                </option>
                              ),
                            )}
                            {userRole !== 'owner' && member.role !== 'member' && (
                              <option value={member.role} disabled>
                                {ROLE_LABELS[member.role]}
                              </option>
                            )}
                          </select>
                        ) : (
                          <Badge
                            variant="outline"
                            className={cn('text-[10px]', ROLE_BADGE[member.role])}
                          >
                            {ROLE_LABELS[member.role]}
                          </Badge>
                        )}
                        {canManageMembers &&
                          !(
                            userRole === 'admin' &&
                            (member.role === 'owner' || member.role === 'admin')
                          ) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirmRemove(member.userId)}
                              title="Remove member"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <JiraProjectPickerDialog
        open={showJiraProjectPicker}
        onOpenChange={setShowJiraProjectPicker}
        onConfirm={handleAddJiraBinding}
      />

      {/* Add Repos Dialog */}
      <Dialog
        open={showAddRepo}
        onOpenChange={(open) => {
          if (!addingRepo) {
            setShowAddRepo(open);
            if (!open) setSelectedNewRepos([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleAddRepos}>
            <DialogHeader>
              <DialogTitle>Add Repositories</DialogTitle>
              <DialogDescription>
                Select repositories to link to this project. Role and tech stack are detected
                automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-3">
              <GitRepoSelect
                provider={project?.gitProvider ?? 'github'}
                multiple
                value={selectedNewRepos}
                onChange={(selected: GitRepo[]) => {
                  setSelectedNewRepos(selected.map((r) => r.fullName));
                }}
                exclude={repos.map((r) => r.url)}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowAddRepo(false);
                  setSelectedNewRepos([]);
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

      {/* Add Member Dialog */}
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAddMember}>
            <DialogHeader>
              <DialogTitle>Add Member</DialogTitle>
              <DialogDescription>
                Pick a confirmed Cognito user and assign them a role on this project.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label>User</Label>
                {selectedUser ? (
                  <div className="flex items-center justify-between border rounded-md px-3 py-2 bg-muted/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0">
                        {(selectedUser.displayName || selectedUser.email).charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{selectedUser.email}</p>
                        {selectedUser.displayName && (
                          <p className="text-xs text-muted-foreground truncate">
                            {selectedUser.displayName}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 ml-2 text-muted-foreground"
                      onClick={clearSelectedUser}
                      disabled={addingMember}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div className="relative" ref={userDropdownRef}>
                    <Input
                      value={userSearch}
                      onChange={(e) => {
                        setUserSearch(e.target.value);
                        setShowUserDropdown(true);
                      }}
                      onFocus={() => setShowUserDropdown(true)}
                      placeholder={loadingUsers ? 'Loading users...' : 'Search by email or name...'}
                      disabled={addingMember || loadingUsers}
                    />
                    {showUserDropdown && !loadingUsers && (
                      <div className="absolute z-10 mt-1 w-full bg-popover text-popover-foreground border rounded-md shadow-md max-h-48 overflow-y-auto">
                        {filteredUsers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            {cognitoUsers.length === 0 ? 'No users available' : 'No matching users'}
                          </div>
                        ) : (
                          filteredUsers.map((u) => (
                            <button
                              key={u.userId}
                              type="button"
                              onClick={() => selectUser(u)}
                              className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 border-b last:border-b-0 border-border"
                            >
                              <div className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-medium shrink-0">
                                {(u.displayName || u.email).charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm truncate">{u.email}</p>
                                {u.displayName && (
                                  <p className="text-xs text-muted-foreground truncate">
                                    {u.displayName}
                                  </p>
                                )}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-member-role">Role</Label>
                <select
                  id="add-member-role"
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as ProjectRole)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  disabled={addingMember}
                >
                  {getAssignableRoles().map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]} - {ROLE_DESCRIPTIONS[r]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAddMember(false)}
                disabled={addingMember}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={addingMember || !selectedUser}>
                {addingMember ? 'Adding...' : 'Add Member'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirm Role Change */}
      <AlertDialog open={!!confirmRoleChange} onOpenChange={() => setConfirmRoleChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change Role</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRoleChange && (
                <>
                  Change this member's role to{' '}
                  <span className="font-semibold text-foreground">
                    {ROLE_LABELS[confirmRoleChange.newRole]}
                  </span>
                  ? {ROLE_DESCRIPTIONS[confirmRoleChange.newRole]}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmRoleChange &&
                handleRoleChange(confirmRoleChange.userId, confirmRoleChange.newRole)
              }
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Remove */}
      <AlertDialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this member from the project? They will lose access
              immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRemove && handleRemoveMember(confirmRemove)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmRemoveRepo} onOpenChange={() => setConfirmRemoveRepo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Repository</AlertDialogTitle>
            <AlertDialogDescription>
              Remove <span className="font-mono">{confirmRemoveRepo}</span> from this project?
              {repos.find((r) => r.url === confirmRemoveRepo)?.role === 'primary' &&
                repos.length > 1 &&
                ' This is the primary repository — the oldest remaining repository will be promoted to primary.'}
              {repos.length === 1 &&
                ' This is the last repository — the project will have no linked repository and sprints cannot run until one is added.'}
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
    </div>
  );
}
