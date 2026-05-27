import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  projectsService,
  type Project,
  type Member,
  type ProjectRole,
  type CognitoUser,
  type AgentCli,
  type SteeringDoc,
} from '../services/projects';
import { agentsService } from '../services/agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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
import { ArrowLeft, Trash2, X, AlertCircle, CheckCircle2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Full control: manage project, members, and settings',
  admin: 'Manage members and update GitHub repository',
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
    description: 'AWS Kiro CLI — API key authentication',
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

export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [editName, setEditName] = useState('');
  const [editGitRepo, setEditGitRepo] = useState('');
  const [editIssueIntegration, setEditIssueIntegration] = useState(false);
  const [saving, setSaving] = useState(false);

  const [editAgentCli, setEditAgentCli] = useState<AgentCli>('kiro');
  const [savingAgentCli, setSavingAgentCli] = useState(false);
  const [availableCliNames, setAvailableCliNames] = useState<AgentCli[]>(['kiro']);

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

  const [confirmRoleChange, setConfirmRoleChange] = useState<{
    userId: string;
    newRole: ProjectRole;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // MCP servers state
  const [mcpServers, setMcpServers] = useState('[]');
  const [mcpError, setMcpError] = useState('');
  const [savingMcp, setSavingMcp] = useState(false);

  // Steering docs state
  const [steeringDocs, setSteeringDocs] = useState<SteeringDoc[]>([]);
  const [savingDocs, setSavingDocs] = useState(false);

  const userRole = project?.userRole;
  const canManageMembers = userRole === 'owner' || userRole === 'admin';
  const canEditProject = userRole === 'owner' || userRole === 'admin';

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      const [proj, mems] = await Promise.all([
        projectsService.get(projectId),
        projectsService.listMembers(projectId),
      ]);
      setProject(proj);
      setEditName(proj.name);
      setEditGitRepo(proj.gitRepo);
      setEditIssueIntegration(proj.issueIntegrationEnabled ?? false);
      setEditAgentCli(proj.agentCli ?? 'kiro');
      setMembers(Array.isArray(mems) ? mems : []);

      // Load MCP servers and steering docs in parallel (non-blocking)
      Promise.all([
        projectsService.getMcpServers(projectId).catch(() => ({ mcpServers: '[]' })),
        projectsService.getSteeringDocs(projectId).catch(() => ({ steeringDocs: [] })),
      ]).then(async ([mcpResp, docsResp]) => {
        setMcpServers(mcpResp.mcpServers ?? '[]');
        const docs = docsResp.steeringDocs ?? [];
        // Eagerly fetch content from each doc's presigned downloadUrl so the
        // editor shows the saved content. Without this, an unchanged Save
        // would upload empty strings and overwrite the S3 objects.
        const docsWithContent = await Promise.all(
          docs.map(async (doc) => {
            if (!doc.downloadUrl) return { ...doc, content: '' };
            try {
              const resp = await fetch(doc.downloadUrl);
              if (!resp.ok) return { ...doc, content: '' };
              const content = await resp.text();
              return { ...doc, content };
            } catch {
              return { ...doc, content: '' };
            }
          }),
        );
        setSteeringDocs(docsWithContent);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    agentsService
      .getCapabilities()
      .then((c) => setAvailableCliNames(c.available))
      .catch(() => {
        /* non-fatal — keep default ['kiro'] */
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

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !project) return;
    clearMessages();
    setSaving(true);
    try {
      const updates: {
        name?: string;
        gitRepo?: string;
        issueIntegrationEnabled?: boolean;
      } = {};
      if (editName !== project.name) updates.name = editName;
      if (editGitRepo !== project.gitRepo) updates.gitRepo = editGitRepo;
      if (editIssueIntegration !== (project.issueIntegrationEnabled ?? false)) {
        updates.issueIntegrationEnabled = editIssueIntegration;
      }
      if (Object.keys(updates).length === 0) {
        setSaving(false);
        return;
      }
      await projectsService.update(projectId, updates);
      setProject({ ...project, ...updates });
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
      setSuccess('Agent CLI updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update agent CLI');
    } finally {
      setSavingAgentCli(false);
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

  const handleSaveMcpServers = async () => {
    if (!projectId) return;
    clearMessages();
    setMcpError('');
    try {
      JSON.parse(mcpServers);
    } catch {
      setMcpError('Must be a valid JSON array');
      return;
    }
    setSavingMcp(true);
    try {
      await projectsService.updateMcpServers(projectId, mcpServers);
      setSuccess('MCP servers saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save MCP servers');
    } finally {
      setSavingMcp(false);
    }
  };

  const handleAddSteeringDoc = () => {
    if (steeringDocs.length >= 20) return;
    setSteeringDocs([...steeringDocs, { filename: '', s3Key: '', content: '' }]);
  };

  const handleUpdateSteeringDoc = (idx: number, field: keyof SteeringDoc, value: string) => {
    const updated = steeringDocs.map((d, i) => (i === idx ? { ...d, [field]: value } : d));
    setSteeringDocs(updated);
  };

  const handleRemoveSteeringDoc = (idx: number) => {
    setSteeringDocs(steeringDocs.filter((_, i) => i !== idx));
  };

  const handleSaveSteeringDocs = async () => {
    if (!projectId) return;
    clearMessages();
    // Validate: all docs need a .md filename
    for (const doc of steeringDocs) {
      if (!doc.filename.endsWith('.md')) {
        setError('All steering document filenames must end with .md');
        return;
      }
    }
    setSavingDocs(true);
    try {
      const resp = await projectsService.updateSteeringDocs(
        projectId,
        steeringDocs.map((d) => ({ filename: d.filename })),
      );
      // Upload content to S3 via presigned URLs for docs that have content
      if (resp.uploadUrls && resp.uploadUrls.length > 0) {
        await Promise.all(
          resp.uploadUrls.map(async (uu) => {
            const doc = steeringDocs.find((d) => d.filename === uu.filename);
            if (!doc?.content) return;
            await fetch(uu.uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'text/markdown' },
              body: doc.content,
            });
          }),
        );
      }
      // Refresh metadata from the server (s3Keys, fresh downloadUrls) but
      // preserve the user's just-typed content so the editor doesn't blank
      // out after Save.
      const refreshed = await projectsService.getSteeringDocs(projectId);
      const refreshedDocs = (refreshed.steeringDocs ?? []).map((rd) => {
        const local = steeringDocs.find((d) => d.filename === rd.filename);
        return { ...rd, content: local?.content ?? '' };
      });
      setSteeringDocs(refreshedDocs);
      setSuccess('Steering rules saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save steering rules');
    } finally {
      setSavingDocs(false);
    }
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
                    <Label htmlFor="proj-repo">GitHub Repository</Label>
                    <Input
                      id="proj-repo"
                      value={editGitRepo}
                      onChange={(e) => setEditGitRepo(e.target.value)}
                      placeholder="owner/repo"
                      className="font-mono text-sm"
                      disabled={!canEditProject || saving}
                    />
                    {!canEditProject && (
                      <p className="text-xs text-muted-foreground">
                        Only owners and admins can change the repository
                      </p>
                    )}
                  </div>
                  {project?.gitProvider === 'github' && (
                    <div className="flex items-start justify-between gap-4 pt-1">
                      <div className="space-y-0.5">
                        <Label htmlFor="proj-issues" className="text-sm">
                          Enable GitHub issue integration
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Browse issues on the project page and start sprints from them.
                        </p>
                      </div>
                      <Switch
                        id="proj-issues"
                        checked={editIssueIntegration}
                        onCheckedChange={setEditIssueIntegration}
                        disabled={!canEditProject || saving}
                      />
                    </div>
                  )}
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

            {/* MCP Servers */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">MCP Servers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  JSON array of MCP server definitions injected into every agent session for this
                  project. These are merged with global MCP servers; when names collide,
                  project-level entries take precedence over global ones.
                </p>
                <Textarea
                  value={mcpServers}
                  onChange={(e) => {
                    setMcpServers(e.target.value);
                    setMcpError('');
                  }}
                  className={cn(
                    'font-mono text-xs min-h-[120px] resize-y',
                    mcpError && 'border-destructive focus-visible:ring-destructive',
                  )}
                  spellCheck={false}
                  disabled={!canEditProject}
                  placeholder='[{"name":"my-tool","command":"npx","args":["-y","my-mcp-server"]}]'
                />
                {mcpError && (
                  <p className="text-[11px] text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 shrink-0" /> {mcpError}
                  </p>
                )}
                {canEditProject && (
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleSaveMcpServers} disabled={savingMcp}>
                      {savingMcp ? 'Saving...' : 'Save MCP Servers'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Steering Rules */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Steering Rules</CardTitle>
                  {canEditProject && steeringDocs.length < 20 && (
                    <Button size="sm" variant="outline" onClick={handleAddSteeringDoc}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add Document
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Markdown documents loaded into the agent context for every phase in this project
                  (coding standards, API reference, framework guidelines, etc.). Maximum 20
                  documents.
                </p>
                {steeringDocs.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No steering rules configured.
                  </p>
                )}
                {steeringDocs.map((doc, idx) => (
                  <div key={idx} className="border rounded-md p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={doc.filename}
                        onChange={(e) => handleUpdateSteeringDoc(idx, 'filename', e.target.value)}
                        placeholder="filename.md"
                        className="font-mono text-xs h-7 flex-1"
                        disabled={!canEditProject}
                      />
                      {canEditProject && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => handleRemoveSteeringDoc(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={doc.content ?? ''}
                      onChange={(e) => handleUpdateSteeringDoc(idx, 'content', e.target.value)}
                      placeholder="Enter Markdown content..."
                      className="font-mono text-xs min-h-[80px] resize-y"
                      disabled={!canEditProject}
                    />
                  </div>
                ))}
                {canEditProject && steeringDocs.length > 0 && (
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleSaveSteeringDocs} disabled={savingDocs}>
                      {savingDocs ? 'Saving...' : 'Save Steering Rules'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

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
    </div>
  );
}
