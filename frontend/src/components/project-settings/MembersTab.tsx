import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
// Project Settings → Members tab: member list with role management and the
// add-member flow. Self-contained — loads members and the Cognito user
// directory itself; the page only provides projectId and the viewer's role.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  Building2,
  Pencil,
  Plus,
  Trash2,
  UserKey,
  UserRound,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  projectsService,
  type AssignableUser,
  type BusinessRole,
  type Member,
  type ProjectRole,
} from '@/services/projects';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { businessRoleIcon } from './businessRoleIcons';
import { StageResponsibilitiesTable } from '@/components/stage-responsibilities/StageResponsibilitiesTable';

const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Owner',
  member: 'Member',
  viewer: 'Viewer',
};

const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Full control: manage space, members, and settings',
  member: 'Create intents, answer questions, and collaborate',
  viewer: 'Read space content, questions, discussions, and history',
};

const BusinessRoleIcon = ({ id }: { id: string }) => {
  const Icon = businessRoleIcon(id);
  return <Icon aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />;
};

const initials = (m: { email?: string; userId: string }) => {
  const source = m.email || m.userId;
  const parts = source
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};

const identityLabel = (user: AssignableUser) =>
  user.identitySource === 'sso' ? user.identityProvider || 'Enterprise SSO' : 'Cognito account';

const sameRoles = (a: string[], b: string[]) => {
  const sortedA = a.toSorted();
  const sortedB = b.toSorted();
  return sortedA.length === sortedB.length && sortedA.every((role, i) => role === sortedB[i]);
};

interface Props {
  projectId: string;
  userRole: ProjectRole | undefined;
}

export function MembersTab({ projectId, userRole }: Props) {
  return <MembersTabContent key={projectId} projectId={projectId} userRole={userRole} />;
}

function MembersTabContent({ projectId, userRole }: Props) {
  const { canManage } = useSpacePermissions();
  const canManageMembers = canManage ?? userRole === 'owner';

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [businessRoles, setBusinessRoles] = useState<BusinessRole[]>([]);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [draftRoles, setDraftRoles] = useState<string[]>([]);
  const [draftExcluded, setDraftExcluded] = useState<string[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [responsibilitiesVersion, setResponsibilitiesVersion] = useState(0);

  // Add member dialog
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberRole, setNewMemberRole] = useState<ProjectRole>('member');
  const [addingMember, setAddingMember] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<AssignableUser[]>([]);
  const [addMemberError, setAddMemberError] = useState<string | null>(null);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  // Confirmations
  const [confirmRoleChange, setConfirmRoleChange] = useState<{
    userId: string;
    newRole: ProjectRole;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mems, catalog] = await Promise.all([
        projectsService.listMembers(projectId),
        projectsService.listBusinessRoles(projectId),
      ]);
      setMembers(Array.isArray(mems) ? mems : []);
      setBusinessRoles(catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadAssignableUsers = async () => {
    setLoadingUsers(true);
    try {
      const users = await projectsService.listAssignableUsers();
      // The backend has already applied local confirmation and federated
      // admission rules. The picker only removes existing project members.
      const memberIds = new Set(members.map((m) => m.userId));
      setAssignableUsers(users.filter((u) => !memberIds.has(u.userId)));
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoadingUsers(false);
    }
  };

  const openAddMemberModal = () => {
    setShowAddMember(true);
    setSelectedUsers([]);
    setAddMemberError(null);
    setUserSearch('');
    setNewMemberRole('member');
    loadAssignableUsers();
  };

  const selectedUserIds = new Set(selectedUsers.map((u) => u.userId));
  const filteredUsers = assignableUsers.filter((u) => {
    if (selectedUserIds.has(u.userId)) return false;
    if (!userSearch) return true;
    const q = userSearch.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  });
  // Nothing typed and nothing left to offer: every available identity is selected.
  const allUsersSelected = !userSearch && assignableUsers.length > 0 && filteredUsers.length === 0;

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedUsers.length === 0) return;
    setError(null);
    setAddMemberError(null);
    setAddingMember(true);
    // The API adds one member per request. Each selected identity is added in
    // turn; any that fail stay selected so the Owner can see why and retry.
    const failed: { user: AssignableUser; message: string }[] = [];
    try {
      for (const user of selectedUsers) {
        try {
          const added = await projectsService.addMember(projectId, {
            userId: user.userId,
            email: user.email,
            role: newMemberRole,
          });
          setMembers((current) => [...current, added]);
        } catch (err) {
          failed.push({
            user,
            message: err instanceof Error ? err.message : 'Failed to add member',
          });
        }
      }
      const failedIds = new Set(failed.map(({ user }) => user.userId));
      if (failed.length < selectedUsers.length) {
        setResponsibilitiesVersion((version) => version + 1);
        setAssignableUsers((current) =>
          current.filter((u) => !selectedUserIds.has(u.userId) || failedIds.has(u.userId)),
        );
      }
      if (failed.length === 0) {
        setShowAddMember(false);
        setSelectedUsers([]);
        setUserSearch('');
        setNewMemberRole('member');
      } else {
        setSelectedUsers(failed.map(({ user }) => user));
        setAddMemberError(
          selectedUsers.length === 1
            ? failed[0].message
            : `Could not add ${failed.length} of ${selectedUsers.length}: ${failed
                .map(({ user, message }) => `${user.email} (${message})`)
                .join('; ')}`,
        );
      }
      if (failed.length < selectedUsers.length) await load();
    } finally {
      setAddingMember(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: ProjectRole) => {
    setError(null);
    try {
      await projectsService.updateMemberRole(projectId, userId, newRole);
      setMembers((current) =>
        current.map((member) => (member.userId === userId ? { ...member, role: newRole } : member)),
      );
      setResponsibilitiesVersion((version) => version + 1);
      setConfirmRoleChange(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setError(null);
    try {
      await projectsService.removeMember(projectId, userId);
      setMembers((current) => current.filter((member) => member.userId !== userId));
      setResponsibilitiesVersion((version) => version + 1);
      setConfirmRemove(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const applyUpdatedMember = (updated: Member) =>
    setMembers((current) =>
      current.map((member) =>
        member.userId === updated.userId ? { ...member, ...updated } : member,
      ),
    );

  const handleSaveBusinessRoles = async () => {
    if (!editingMember || !canManageMembers || savingRoles) return;
    setSavingRoles(true);
    setRolesError(null);
    let memberChanged = false;
    // Local additions and SSO exclusions are separate contracts with separate
    // audit entries, so the save issues one request per changed list.
    try {
      if (!sameRoles(draftRoles, editingMember.localRoles || [])) {
        applyUpdatedMember(
          await projectsService.updateMemberBusinessRoles(
            projectId,
            editingMember.userId,
            draftRoles,
          ),
        );
        memberChanged = true;
      }
      if (!sameRoles(draftExcluded, editingMember.excludedRoles || [])) {
        applyUpdatedMember(
          await projectsService.updateMemberExcludedRoles(
            projectId,
            editingMember.userId,
            draftExcluded,
          ),
        );
        memberChanged = true;
      }
      setEditingMember(null);
    } catch (err) {
      setRolesError(err instanceof Error ? err.message : 'Failed to save business roles');
      await load();
    } finally {
      if (memberChanged) setResponsibilitiesVersion((version) => version + 1);
      setSavingRoles(false);
    }
  };

  const roleName = (id: string) => businessRoles.find((role) => role.id === id)?.name || id;
  // Becoming a Viewer keeps business roles but stops them from applying, so
  // the confirmation says so explicitly.
  const viewerDemotionMessage = ({ userId, newRole }: { userId: string; newRole: ProjectRole }) => {
    const member = members.find((candidate) => candidate.userId === userId);
    if (newRole !== 'viewer' || !member || member.role === 'viewer') return null;
    const roles = member.effectiveRoles ?? member.localRoles ?? [];
    return `Viewers can read space content, questions, discussions, and history, but cannot decide or contribute to any stage.${
      roles.length
        ? ` Their business roles (${roles.map(roleName).join(', ')}) stay assigned and apply again if they become a Member or Owner.`
        : ''
    }`;
  };
  // A Viewer keeps their business roles, but they do not apply while the
  // member is a Viewer: show them as inactive rather than hiding them.
  const roleChips = (roles: string[], inactive = false) =>
    roles.length ? (
      <>
        {roles.map((id) => (
          <Badge
            key={id}
            variant="outline"
            className={
              inactive
                ? 'gap-1 border-dashed bg-background text-xs font-normal text-muted-foreground opacity-70'
                : 'gap-1 bg-background text-xs font-normal'
            }
          >
            <BusinessRoleIcon id={id} />
            {roleName(id)}
          </Badge>
        ))}
        {inactive && (
          <span className="self-center text-xs text-muted-foreground">Inactive while Viewer</span>
        )}
      </>
    ) : (
      <span className="text-xs text-muted-foreground">No business roles</span>
    );

  return (
    <div className="space-y-6">
      <SettingsCard
        icon={<Users />}
        title="Members"
        badge={
          !loading && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground">
              {members.length} member{members.length === 1 ? '' : 's'}
            </span>
          )
        }
        description="Who can access this space and what they're allowed to do."
        headerAction={
          canManageMembers && (
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={openAddMemberModal}>
              <Plus className="h-3.5 w-3.5" /> Add Member
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

          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[640px] text-left">
                <thead className="bg-muted/40 text-[13px] text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3.5 py-2 font-medium">
                      Member
                    </th>
                    <th scope="col" className="px-3.5 py-2 font-medium">
                      Business roles
                    </th>
                    <th scope="col" className="px-3.5 py-2 font-medium">
                      Space access
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {members.map((member) => (
                    <tr key={member.userId}>
                      <td className="px-3.5 py-2.5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                            {initials(member)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {member.email || member.userId}
                            </p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                              {member.userId.substring(0, 12)}…
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3.5 py-2.5">
                        {canManageMembers ? (
                          <button
                            type="button"
                            aria-label={`Edit business roles for ${member.email || member.userId}`}
                            className="group flex w-full items-center gap-2 rounded-md bg-muted/50 p-2 text-left hover:bg-muted focus-visible:outline-ring"
                            onClick={() => {
                              setEditingMember(member);
                              setDraftRoles([...(member.localRoles || [])]);
                              setDraftExcluded([...(member.excludedRoles || [])]);
                              setRolesError(null);
                            }}
                          >
                            <span className="flex flex-1 flex-wrap gap-1">
                              {roleChips(
                                member.effectiveRoles ?? member.localRoles ?? [],
                                member.role === 'viewer',
                              )}
                            </span>
                            <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                          </button>
                        ) : (
                          <div className="flex flex-wrap gap-1 rounded-md bg-muted/50 p-2">
                            {roleChips(
                              member.effectiveRoles ?? member.localRoles ?? [],
                              member.role === 'viewer',
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5">
                        <div className="flex items-center gap-2">
                          {canManageMembers ? (
                            <Select
                              value={member.role}
                              onValueChange={(value) => {
                                const newRole = value as ProjectRole;
                                if (newRole !== member.role) {
                                  setConfirmRoleChange({
                                    userId: member.userId,
                                    newRole,
                                  });
                                }
                              }}
                            >
                              <SelectTrigger
                                aria-label={`Space access for ${member.email || member.userId}`}
                                className="h-8 w-28 bg-background text-xs"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(['owner', 'member', 'viewer'] as const).map((role) => (
                                  <SelectItem key={role} value={role}>
                                    {ROLE_LABELS[role]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-transparent bg-muted text-[10px] text-muted-foreground"
                            >
                              {ROLE_LABELS[member.role]}
                            </Badge>
                          )}
                          {canManageMembers && (
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Business roles describe responsibilities for now. They do not grant space access or
            restrict actions. Only Space Owners can change them.
          </p>

          {/* Role legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
            {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
              <div
                key={role}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <Badge
                  variant="outline"
                  className="h-4 border-transparent bg-muted text-[10px] text-muted-foreground"
                >
                  {ROLE_LABELS[role as ProjectRole]}
                </Badge>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<UserKey />}
        title="Stage responsibilities"
        description="Decision Makers and Contributors for this space's workflow."
      >
        <StageResponsibilitiesTable
          projectId={projectId}
          refreshVersion={responsibilitiesVersion}
          members={loading ? undefined : members}
        />
      </SettingsCard>

      <Dialog
        open={!!editingMember && canManageMembers}
        onOpenChange={(open) => {
          if (!open && !savingRoles) setEditingMember(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit business roles</DialogTitle>
            <DialogDescription>
              Responsibilities in this space for {editingMember?.email || editingMember?.userId}.
              Business roles do not change Owner or Member access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Persisted exclusions stay editable even when the role is no longer
                received from SSO; hiding them would leave a dormant exclusion in
                place with no way to restore it. */}
            {new Set([...(editingMember?.ssoRoles ?? []), ...draftExcluded]).size > 0 && (
              <div className="space-y-2">
                <Label>Company roles (from SSO)</Label>
                <div className="flex flex-wrap gap-2">
                  {[...new Set([...(editingMember?.ssoRoles ?? []), ...draftExcluded])]
                    .toSorted()
                    .map((id) => {
                      const excluded = draftExcluded.includes(id);
                      const inherited = (editingMember?.ssoRoles ?? []).includes(id);
                      return (
                        <Badge
                          key={id}
                          variant="outline"
                          className={`gap-1 font-normal ${excluded ? 'bg-muted/30 text-muted-foreground line-through' : 'bg-muted/50'}`}
                        >
                          <BusinessRoleIcon id={id} />
                          {roleName(id)}
                          {!inherited && (
                            <span className="text-[10px] no-underline">
                              (not currently received)
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label={
                              excluded ? `Restore ${roleName(id)}` : `Exclude ${roleName(id)}`
                            }
                            className="rounded-sm px-1 py-0.5 text-[10px] font-medium no-underline hover:bg-muted"
                            disabled={savingRoles}
                            onClick={() =>
                              setDraftExcluded((current) =>
                                excluded
                                  ? current.filter((role) => role !== id)
                                  : [...current, id].toSorted(),
                              )
                            }
                          >
                            {excluded ? 'Restore' : 'Exclude'}
                          </button>
                        </Badge>
                      );
                    })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Excluding an inherited role applies to this space only. The company groups and the
                  central mapping stay the same.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="business-role-select">Roles added in this space</Label>
              <Select
                value=""
                disabled={savingRoles || draftRoles.length === businessRoles.length}
                onValueChange={(id) =>
                  setDraftRoles((current) => [...new Set([...current, id])].toSorted())
                }
              >
                <SelectTrigger id="business-role-select" className="bg-background">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {businessRoles
                    .filter(({ id }) => !draftRoles.includes(id))
                    .map(({ id, name }) => (
                      <SelectItem key={id} value={id}>
                        <span className="flex items-center gap-2">
                          <BusinessRoleIcon id={id} />
                          {name}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2">
                {draftRoles.length ? (
                  draftRoles.map((id) => (
                    <Badge key={id} variant="outline" className="gap-1 bg-muted/50 font-normal">
                      <BusinessRoleIcon id={id} />
                      {roleName(id)}
                      <button
                        type="button"
                        aria-label={`Remove ${roleName(id)}`}
                        className="rounded-sm p-1 hover:bg-muted"
                        disabled={savingRoles}
                        onClick={() =>
                          setDraftRoles((current) => current.filter((role) => role !== id))
                        }
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">No roles added in this space.</p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Roles in this space</Label>
              <div className="flex flex-wrap gap-1 rounded-md bg-muted/50 p-2">
                {roleChips(
                  [
                    ...new Set([
                      ...(editingMember?.ssoRoles ?? []).filter(
                        (id) => !draftExcluded.includes(id),
                      ),
                      ...draftRoles,
                    ]),
                  ].toSorted(),
                )}
              </div>
            </div>
            {rolesError && (
              <p role="alert" className="text-sm text-destructive">
                {rolesError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={savingRoles} onClick={() => setEditingMember(null)}>
              Cancel
            </Button>
            <Button disabled={savingRoles} onClick={handleSaveBusinessRoles}>
              {savingRoles ? 'Saving...' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAddMember}>
            <DialogHeader>
              <DialogTitle>Add Member</DialogTitle>
              <DialogDescription>
                Pick one or more available identities and assign them a role on this space.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="add-member-user-search">Users</Label>
                {selectedUsers.length > 0 && (
                  <ul aria-label="Selected users" className="max-h-48 space-y-1.5 overflow-y-auto">
                    {selectedUsers.map((u) => (
                      <li
                        key={u.userId}
                        className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                            {(u.displayName || u.email).charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{u.email}</p>
                            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                              {u.identitySource === 'sso' ? (
                                <Building2 className="h-3 w-3 shrink-0" />
                              ) : (
                                <UserRound className="h-3 w-3 shrink-0" />
                              )}
                              <span className="truncate">
                                {u.displayName
                                  ? `${u.displayName} · ${identityLabel(u)}`
                                  : identityLabel(u)}
                              </span>
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${u.email} (${identityLabel(u)})`}
                          className="ml-2 h-6 w-6 text-muted-foreground"
                          onClick={() =>
                            setSelectedUsers((current) =>
                              current.filter((s) => s.userId !== u.userId),
                            )
                          }
                          disabled={addingMember}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="relative" ref={userDropdownRef}>
                  <Input
                    id="add-member-user-search"
                    value={userSearch}
                    onChange={(e) => {
                      setUserSearch(e.target.value);
                      setShowUserDropdown(true);
                    }}
                    onFocus={() => setShowUserDropdown(true)}
                    placeholder={loadingUsers ? 'Loading users...' : 'Search by email or name...'}
                    disabled={addingMember || loadingUsers}
                  />
                  {showUserDropdown && !loadingUsers && !addingMember && !allUsersSelected && (
                    <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
                      {filteredUsers.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">
                          {assignableUsers.length === 0
                            ? 'No users available'
                            : 'No matching users'}
                        </div>
                      ) : (
                        filteredUsers.map((u) => (
                          <button
                            key={u.userId}
                            type="button"
                            onClick={() => {
                              // Keep the list open so several identities can be picked in a row.
                              setSelectedUsers((current) => [...current, u]);
                              setUserSearch('');
                            }}
                            className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-accent"
                          >
                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                              {(u.displayName || u.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm">{u.email}</p>
                              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                                {u.identitySource === 'sso' ? (
                                  <Building2 className="h-3 w-3 shrink-0" />
                                ) : (
                                  <UserRound className="h-3 w-3 shrink-0" />
                                )}
                                <span className="truncate">
                                  {u.displayName
                                    ? `${u.displayName} · ${identityLabel(u)}`
                                    : identityLabel(u)}
                                </span>
                              </p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-member-role">Role</Label>
                <Select
                  value={newMemberRole}
                  onValueChange={(value) => setNewMemberRole(value as ProjectRole)}
                  disabled={addingMember}
                >
                  <SelectTrigger id="add-member-role" className="h-8 bg-background text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['owner', 'member', 'viewer'] as const).map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[newMemberRole]}</p>
              </div>
              {addMemberError && (
                <p role="alert" className="text-sm text-destructive">
                  {addMemberError}
                </p>
              )}
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
              <Button type="submit" disabled={addingMember || selectedUsers.length === 0}>
                {addingMember
                  ? 'Adding...'
                  : selectedUsers.length > 1
                    ? `Add ${selectedUsers.length} Members`
                    : 'Add Member'}
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
                  ?{' '}
                  {viewerDemotionMessage(confirmRoleChange) ??
                    ROLE_DESCRIPTIONS[confirmRoleChange.newRole]}
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
              This member will lose access to the space; existing realtime connections expire within
              ten minutes.
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
