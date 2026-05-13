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
} from '../services/projects';
import { agentsService } from '../services/agents';

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
  const { user } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editGitRepo, setEditGitRepo] = useState('');
  const [editIssueIntegration, setEditIssueIntegration] = useState(false);
  const [saving, setSaving] = useState(false);

  // Agent CLI state
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>('kiro');
  const [savingAgentCli, setSavingAgentCli] = useState(false);
  const [availableCliNames, setAvailableCliNames] = useState<AgentCli[]>(['kiro']);

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
      setEditIssueIntegration(proj.issueIntegrationEnabled ?? false);
      setEditAgentCli(proj.agentCli ?? 'kiro');
      setMembers(Array.isArray(mems) ? mems : []);
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

  // Determine which roles the current user can assign
  const getAssignableRoles = (): ProjectRole[] => {
    if (userRole === 'owner') return ['owner', 'admin', 'member'];
    if (userRole === 'admin') return ['member'];
    return [];
  };

  if (!projectId) return <div>Project not found</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between h-16 items-center">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(`/project/${projectId}`)}
              className="text-gray-600 hover:text-gray-900 flex items-center"
            >
              <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back to Project
            </button>
            <div className="h-6 w-px bg-gray-300" />
            <h1 className="text-xl font-semibold">Project Settings</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-gray-700 text-sm">{user?.displayName || user?.email}</span>
            {userRole && (
              <span className={`px-2 py-0.5 text-xs rounded font-medium ${ROLE_COLORS[userRole]}`}>
                {ROLE_LABELS[userRole]}
              </span>
            )}
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Messages */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 flex justify-between items-center">
            {error}
            <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
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
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-lg font-semibold mb-4">General</h2>
              <form onSubmit={handleSaveProject}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full border rounded px-3 py-2 disabled:bg-gray-50 disabled:text-gray-500"
                      disabled={!canEditProject || saving}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      GitHub Repository
                    </label>
                    <input
                      type="text"
                      value={editGitRepo}
                      onChange={(e) => setEditGitRepo(e.target.value)}
                      placeholder="owner/repo"
                      className="w-full border rounded px-3 py-2 disabled:bg-gray-50 disabled:text-gray-500 font-mono text-sm"
                      disabled={!canEditProject || saving}
                    />
                    {!canEditProject && (
                      <p className="text-xs text-gray-400 mt-1">
                        Only owners and admins can change the repository
                      </p>
                    )}
                  </div>
                  {project?.gitProvider === 'github' && (
                    <div>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editIssueIntegration}
                          onChange={(e) => setEditIssueIntegration(e.target.checked)}
                          disabled={!canEditProject || saving}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-sm font-medium text-gray-700">
                            Enable GitHub issue integration
                          </span>
                          <span className="block text-xs text-gray-500">
                            Browse issues on the project page and start sprints from them.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
                {canEditProject && (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </form>
            </div>

            {/* Agent CLI */}
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-lg font-semibold mb-1">Agent</h2>
              <p className="text-sm text-gray-500 mb-4">
                Choose which AI agent CLI runs agents for this project. Only CLIs installed in the
                current deployment are available.
              </p>
              <form onSubmit={handleSaveAgentCli}>
                <div className="space-y-3">
                  {(
                    Object.entries(AGENT_CLI_CONFIG) as [
                      AgentCli,
                      { label: string; description: string },
                    ][]
                  ).map(([key, cfg]) => {
                    const isAvailable = availableCliNames.includes(key);
                    const isSelected = editAgentCli === key;
                    const isCurrent = project?.agentCli === key;
                    // Allow selecting the currently saved CLI even if not in availableClis
                    const isSelectable = isAvailable || isCurrent;
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
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
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">{cfg.label}</span>
                            {!isAvailable && !isCurrent && (
                              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                                not available
                              </span>
                            )}
                            {!isAvailable && isCurrent && (
                              <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                                no workers
                              </span>
                            )}
                            {isAvailable && isSelected && (
                              <span className="text-xs text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded">
                                active
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{cfg.description}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
                {!canEditProject && (
                  <p className="text-xs text-gray-400 mt-2">
                    Only owners and admins can change the agent CLI
                  </p>
                )}
                {canEditProject && (
                  <div className="mt-4 flex justify-end">
                    <button
                      type="submit"
                      disabled={savingAgentCli || editAgentCli === project?.agentCli}
                      className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {savingAgentCli ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </form>
            </div>

            {/* Members */}
            <div className="bg-white rounded-lg shadow p-6">
              {' '}
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold">Members ({members.length})</h2>
                {canManageMembers && (
                  <button
                    onClick={openAddMemberModal}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
                  >
                    + Add Member
                  </button>
                )}
              </div>
              {/* Role legend */}
              <div className="flex gap-4 mb-4 text-xs text-gray-500">
                {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
                  <div key={role} className="flex items-center gap-1">
                    <span
                      className={`px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[role as ProjectRole]}`}
                    >
                      {ROLE_LABELS[role as ProjectRole]}
                    </span>
                    <span>- {desc}</span>
                  </div>
                ))}
              </div>
              {/* Members list */}
              <div className="divide-y">
                {members.map((member) => (
                  <div key={member.userId} className="py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-sm font-medium text-gray-600">
                        {(member.email || member.userId).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {member.email || member.userId}
                        </p>
                        <p className="text-xs text-gray-400 font-mono">
                          {member.userId.substring(0, 12)}...
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
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
                            // Admins can't change owners or other admins
                            (userRole === 'admin' &&
                              (member.role === 'owner' || member.role === 'admin')) ||
                            // Nobody can edit their own role
                            false
                          }
                          className={`text-sm border rounded px-2 py-1 ${ROLE_COLORS[member.role]} disabled:opacity-60`}
                        >
                          {(userRole === 'owner' ? ['owner', 'admin', 'member'] : ['member']).map(
                            (r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r as ProjectRole]}
                              </option>
                            ),
                          )}
                          {/* If current value isn't in the options above, show it read-only */}
                          {userRole !== 'owner' && member.role !== 'member' && (
                            <option value={member.role} disabled>
                              {ROLE_LABELS[member.role]}
                            </option>
                          )}
                        </select>
                      ) : (
                        <span
                          className={`px-2 py-0.5 text-xs rounded font-medium ${ROLE_COLORS[member.role]}`}
                        >
                          {ROLE_LABELS[member.role]}
                        </span>
                      )}
                      {canManageMembers &&
                        // Admins can't remove owners or other admins
                        !(
                          userRole === 'admin' &&
                          (member.role === 'owner' || member.role === 'admin')
                        ) && (
                          <button
                            onClick={() => setConfirmRemove(member.userId)}
                            className="text-gray-400 hover:text-red-600 p-1"
                            title="Remove member"
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
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
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

      {/* Add Member Modal */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold mb-4">Add Member</h2>
            <form onSubmit={handleAddMember}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">User</label>
                  {selectedUser ? (
                    <div className="flex items-center justify-between border rounded px-3 py-2 bg-gray-50">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 bg-indigo-100 rounded-full flex items-center justify-center text-xs font-medium text-indigo-700 shrink-0">
                          {(selectedUser.displayName || selectedUser.email).charAt(0).toUpperCase()}
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
                          loadingUsers ? 'Loading users...' : 'Search by email or name...'
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
                                  {(u.displayName || u.email).charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm text-gray-900 truncate">{u.email}</p>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value as ProjectRole)}
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
              <span className="font-semibold">{ROLE_LABELS[confirmRoleChange.newRole]}</span>?
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
                  handleRoleChange(confirmRoleChange.userId, confirmRoleChange.newRole)
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
              Are you sure you want to remove this member from the project? They will lose access
              immediately.
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
