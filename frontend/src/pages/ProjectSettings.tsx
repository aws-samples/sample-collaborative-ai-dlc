import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  projectsService,
  type Project,
  type Member,
  type ProjectRole,
  type CognitoUser,
  type AgentCli,
  type ProjectRepo,
} from '../services/projects';
import { agentsService } from '../services/agents';
import { GitHubRepoSelect } from '../components/GitHubRepoSelect';
import type { GitHubRepo } from '../services/github';

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

const ROLE_COLORS: Record<ProjectRole, string> = {
  owner: 'bg-amber-100 text-amber-800',
  admin: 'bg-blue-100 text-blue-800',
  member: 'bg-gray-100 text-gray-700',
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

const REPO_ROLE_COLORS: Record<string, string> = {
  primary: 'bg-purple-100 text-purple-800',
  frontend: 'bg-cyan-100 text-cyan-800',
  backend: 'bg-green-100 text-green-800',
  api: 'bg-emerald-100 text-emerald-800',
  infra: 'bg-orange-100 text-orange-800',
  shared: 'bg-yellow-100 text-yellow-800',
  docs: 'bg-gray-100 text-gray-600',
  unknown: 'bg-gray-100 text-gray-500',
};

export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editGitRepo, setEditGitRepo] = useState('');
  const [saving, setSaving] = useState(false);

  // Agent CLI state
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>('kiro');
  const [savingAgentCli, setSavingAgentCli] = useState(false);
  const [availableCliNames, setAvailableCliNames] = useState<AgentCli[]>(['kiro']);

  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [selectedNewRepos, setSelectedNewRepos] = useState<string[]>([]);
  const [addingRepo, setAddingRepo] = useState(false);
  const [removingRepo, setRemovingRepo] = useState<string | null>(null);

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
      setEditAgentCli(proj.agentCli ?? 'kiro');
      setRepos(proj.repos ?? []);
      setMembers(Array.isArray(mems) ? mems : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Load available CLI capabilities separately (non-blocking)
  useEffect(() => {
    agentsService.getCapabilities()
      .then(c => setAvailableCliNames(c.available))
      .catch(() => { /* non-fatal — keep default ['kiro'] */ });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        userDropdownRef.current &&
        !userDropdownRef.current.contains(e.target as Node)
      ) {
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
        users.filter(
          (u) => u.enabled && u.status === 'CONFIRMED' && !memberIds.has(u.userId)
        )
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
    return (
      u.email.toLowerCase().includes(q) ||
      u.displayName.toLowerCase().includes(q)
    );
  });

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !project) return;
    clearMessages();
    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (editName !== project.name) updates.name = editName;
      if (editGitRepo !== project.gitRepo) updates.gitRepo = editGitRepo;
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

  const handleAddRepos = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || selectedNewRepos.length === 0) return;
    clearMessages();
    setAddingRepo(true);
    try {
      const results = await Promise.allSettled(
        selectedNewRepos.map(url => projectsService.addRepo(projectId, { url }))
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      setSelectedNewRepos([]);
      setShowAddRepo(false);
      if (failed > 0) {
        setSuccess(`${succeeded} added, ${failed} failed`);
      } else {
        setSuccess(`${succeeded} repositor${succeeded === 1 ? 'y' : 'ies'} added`);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repositories');
    } finally {
      setAddingRepo(false);
    }
  };

  const handleRemoveRepo = async (repoUrl: string) => {
    if (!projectId) return;
    clearMessages();
    setRemovingRepo(repoUrl);
    try {
      await projectsService.removeRepo(projectId, repoUrl);
      setRepos(prev => prev.filter(r => r.url !== repoUrl));
      setSuccess('Repository removed');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove repository');
    } finally {
      setRemovingRepo(null);
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

  // Determine which roles the current user can assign
  const getAssignableRoles = (): ProjectRole[] => {
    if (userRole === 'owner') return ['owner', 'admin', 'member'];
    if (userRole === 'admin') return ['member'];
    return [];
  };

  if (!projectId) return <div>Project not found</div>;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(`/project/${projectId}`)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="h-5 w-px bg-border" />
        <h1 className="text-lg font-bold tracking-tight">Project Settings</h1>
        {userRole && (
          <span className={`px-2 py-0.5 text-xs rounded font-medium ${ROLE_COLORS[userRole]}`}>
            {ROLE_LABELS[userRole]}
          </span>
        )}
      </div>

      <div>
        {/* Messages */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 flex justify-between items-center">
            {error}
            <button
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700"
            >
              x
            </button>
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded mb-4 flex justify-between items-center">
            {success}
            <button
              onClick={() => setSuccess(null)}
              className="text-green-500 hover:text-green-700"
            >
              x
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : (
          <>
            {/* Project Settings */}
            <div className="bg-white rounded-lg shadow px-5 py-4 mb-4">
              <h2 className="text-sm font-semibold mb-3">General</h2>
              <form onSubmit={handleSaveProject}>
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full border rounded px-2.5 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                      disabled={!canEditProject || saving}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Main Repository
                    </label>
                    {canEditProject ? (
                      <GitHubRepoSelect
                        value={editGitRepo}
                        onChange={(repo: GitHubRepo | null) => {
                          setEditGitRepo(repo ? repo.fullName : '');
                        }}
                      />
                    ) : (
                      <p className="text-sm font-mono text-gray-900 py-1.5">{editGitRepo || 'Not configured'}</p>
                    )}
                  </div>
                </div>
                {canEditProject && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )}
              </form>
            </div>

            <div className="bg-white rounded-lg shadow px-5 py-4 mb-4">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-sm font-semibold">Repositories ({repos.length})</h2>
                {canEditProject && (
                  <button
                    onClick={() => setShowAddRepo(true)}
                    className="px-2.5 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
                  >
                    + Add
                  </button>
                )}
              </div>
              {repos.length === 0 ? (
                <p className="text-xs text-gray-500 py-3 text-center">
                  No repositories linked yet.
                </p>
              ) : (
                <div className="divide-y">
                  {repos.map((repo) => (
                    <div key={repo.url} className="py-2 flex items-center gap-2">
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-sm font-mono text-gray-900 truncate">{repo.url}</span>
                        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded ${REPO_ROLE_COLORS[repo.role] || REPO_ROLE_COLORS.unknown}`}>
                          {repo.role}
                        </span>
                        {repo.detectedStack && (
                          <span className="shrink-0 text-[10px] text-gray-400">{repo.detectedStack}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {canEditProject && (
                          <button
                            onClick={() => handleRemoveRepo(repo.url)}
                            disabled={removingRepo === repo.url}
                            className="text-gray-300 hover:text-red-500 p-0.5 disabled:opacity-50"
                            title="Remove repository"
                          >
                            {removingRepo === repo.url ? (
                              <span className="text-[10px]">...</span>
                            ) : (
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Agent CLI */}
            <div className="bg-white rounded-lg shadow px-5 py-4 mb-4">
              <h2 className="text-sm font-semibold mb-1">Agent</h2>
              <p className="text-xs text-gray-500 mb-3">
                Choose which AI agent CLI runs agents for this project.
              </p>
              <form onSubmit={handleSaveAgentCli}>
                <div className="space-y-2">
                  {(Object.entries(AGENT_CLI_CONFIG) as [AgentCli, { label: string; description: string }][]).map(([key, cfg]) => {
                    const isAvailable = availableCliNames.includes(key);
                    const isSelected = editAgentCli === key;
                    const isCurrent = project?.agentCli === key;
                    const isSelectable = isAvailable || isCurrent;
                    return (
                      <label
                        key={key}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          isSelected
                            ? 'border-indigo-500 bg-indigo-50'
                            : isSelectable
                            ? 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            : 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <input
                          type="radio"
                          name="agentCli"
                          value={key}
                          checked={isSelected}
                          disabled={!canEditProject || savingAgentCli || !isSelectable}
                          onChange={() => setEditAgentCli(key)}
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-900">{cfg.label}</span>
                          <span className="text-xs text-gray-400 truncate">{cfg.description}</span>
                        </div>
                        {!isAvailable && !isCurrent && (
                          <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded shrink-0">unavailable</span>
                        )}
                        {!isAvailable && isCurrent && (
                          <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded shrink-0">no workers</span>
                        )}
                        {isAvailable && isSelected && (
                          <span className="text-[10px] text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded shrink-0">active</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {canEditProject && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="submit"
                      disabled={savingAgentCli || editAgentCli === project?.agentCli}
                      className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {savingAgentCli ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )}
              </form>
            </div>

            {/* Members */}
            <div className="bg-white rounded-lg shadow px-5 py-4">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-sm font-semibold">
                  Members ({members.length})
                </h2>
                {canManageMembers && (
                  <button
                    onClick={openAddMemberModal}
                    className="px-2.5 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
                  >
                    + Add
                  </button>
                )}
              </div>

              <div className="divide-y">
                {members.map((member) => (
                  <div
                    key={member.userId}
                    className="py-2 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-6 h-6 bg-gray-200 rounded-full flex items-center justify-center text-[10px] font-medium text-gray-600 shrink-0">
                        {(member.email || member.userId)
                          .charAt(0)
                          .toUpperCase()}
                      </div>
                      <span className="text-sm text-gray-900 truncate">
                        {member.email || member.userId}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {canManageMembers ? (
                        <select
                          value={member.role}
                          onChange={(e) => {
                            const newRole = e.target.value as ProjectRole;
                            if (newRole !== member.role) {
                              setConfirmRoleChange({
                                userId: member.userId,
                                newRole,
                              });
                            }
                          }}
                          disabled={
                            (userRole === 'admin' &&
                              (member.role === 'owner' ||
                                member.role === 'admin')) ||
                            false
                          }
                          className={`text-xs border rounded px-1.5 py-0.5 ${ROLE_COLORS[member.role]} disabled:opacity-60`}
                        >
                          {(userRole === 'owner'
                            ? ['owner', 'admin', 'member']
                            : ['member']
                          ).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r as ProjectRole]}
                            </option>
                          ))}
                          {userRole !== 'owner' &&
                            member.role !== 'member' && (
                              <option value={member.role} disabled>
                                {ROLE_LABELS[member.role]}
                              </option>
                            )}
                        </select>
                      ) : (
                        <span
                          className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${ROLE_COLORS[member.role]}`}
                        >
                          {ROLE_LABELS[member.role]}
                        </span>
                      )}
                      {canManageMembers &&
                        !(
                          userRole === 'admin' &&
                          (member.role === 'owner' || member.role === 'admin')
                        ) && (
                          <button
                            onClick={() => setConfirmRemove(member.userId)}
                            className="text-gray-300 hover:text-red-500 p-0.5"
                            title="Remove member"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {showAddRepo && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4">
            <h2 className="text-lg font-semibold mb-4">Add Repositories</h2>
            <form onSubmit={handleAddRepos}>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Repositories
                </label>
                <GitHubRepoSelect
                  multiple
                  value={selectedNewRepos}
                  onChange={(repos) => {
                    setSelectedNewRepos(repos.map(r => r.fullName));
                  }}
                  exclude={repos.map(r => r.url)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Role and tech stack are detected automatically.
                </p>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => { setShowAddRepo(false); setSelectedNewRepos([]); }}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                  disabled={addingRepo}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                  disabled={addingRepo || selectedNewRepos.length === 0}
                >
                  {addingRepo ? 'Adding...' : `Add ${selectedNewRepos.length || ''} Repositor${selectedNewRepos.length === 1 ? 'y' : 'ies'}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Member Modal */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold mb-4">Add Member</h2>
            <form onSubmit={handleAddMember}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    User
                  </label>
                  {selectedUser ? (
                    <div className="flex items-center justify-between border rounded px-3 py-2 bg-gray-50">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 bg-indigo-100 rounded-full flex items-center justify-center text-xs font-medium text-indigo-700 shrink-0">
                          {(
                            selectedUser.displayName ||
                            selectedUser.email
                          )
                            .charAt(0)
                            .toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {selectedUser.email}
                          </p>
                          {selectedUser.displayName && (
                            <p className="text-xs text-gray-500 truncate">
                              {selectedUser.displayName}
                            </p>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={clearSelectedUser}
                        className="text-gray-400 hover:text-gray-600 ml-2 shrink-0"
                        disabled={addingMember}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <div className="relative" ref={userDropdownRef}>
                      <input
                        type="text"
                        value={userSearch}
                        onChange={(e) => {
                          setUserSearch(e.target.value);
                          setShowUserDropdown(true);
                        }}
                        onFocus={() => setShowUserDropdown(true)}
                        className="w-full border rounded px-3 py-2 text-sm"
                        placeholder={
                          loadingUsers
                            ? 'Loading users...'
                            : 'Search by email or name...'
                        }
                        disabled={addingMember || loadingUsers}
                      />
                      {showUserDropdown && !loadingUsers && (
                        <div className="absolute z-10 mt-1 w-full bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                          {filteredUsers.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-gray-500">
                              {cognitoUsers.length === 0
                                ? 'No users available'
                                : 'No matching users'}
                            </div>
                          ) : (
                            filteredUsers.map((u) => (
                              <button
                                key={u.userId}
                                type="button"
                                onClick={() => selectUser(u)}
                                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 border-b last:border-b-0"
                              >
                                <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center text-xs font-medium text-gray-600 shrink-0">
                                  {(u.displayName || u.email)
                                    .charAt(0)
                                    .toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm text-gray-900 truncate">
                                    {u.email}
                                  </p>
                                  {u.displayName && (
                                    <p className="text-xs text-gray-500 truncate">
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
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Role
                  </label>
                  <select
                    value={newMemberRole}
                    onChange={(e) =>
                      setNewMemberRole(e.target.value as ProjectRole)
                    }
                    className="w-full border rounded px-3 py-2"
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
              <div className="flex justify-end gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => setShowAddMember(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                  disabled={addingMember}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                  disabled={addingMember || !selectedUser}
                >
                  {addingMember ? 'Adding...' : 'Add Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Role Change Modal */}
      {confirmRoleChange && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Change Role</h3>
            <p className="text-gray-600 mb-4">
              Change this member's role to{' '}
              <span className="font-semibold">
                {ROLE_LABELS[confirmRoleChange.newRole]}
              </span>
              ?
            </p>
            <p className="text-sm text-gray-500 mb-4">
              {ROLE_DESCRIPTIONS[confirmRoleChange.newRole]}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRoleChange(null)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  handleRoleChange(
                    confirmRoleChange.userId,
                    confirmRoleChange.newRole
                  )
                }
                className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Remove Modal */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Remove Member</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to remove this member from the project? They
              will lose access immediately.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveMember(confirmRemove)}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
