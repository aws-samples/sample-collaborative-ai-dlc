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
import { Plus, Trash2, Users, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  projectsService,
  type CognitoUser,
  type Member,
  type ProjectRole,
} from '@/services/projects';
import { SettingsCard } from '@/components/settings/SettingsCard';

const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Full control: manage space, members, and settings',
  admin: 'Manage members and update the space repository',
  member: 'Collaborate on sprints and trigger agents',
};

const ROLE_BADGE: Record<ProjectRole, string> = {
  owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  admin: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  member: 'bg-muted text-muted-foreground border-transparent',
};

const initials = (m: { email?: string; userId: string }) => {
  const source = m.email || m.userId;
  const parts = source
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};

interface Props {
  projectId: string;
  userRole: ProjectRole | undefined;
}

export function MembersTab({ projectId, userRole }: Props) {
  const canManageMembers = userRole === 'owner' || userRole === 'admin';

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add member dialog
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberRole, setNewMemberRole] = useState<ProjectRole>('member');
  const [addingMember, setAddingMember] = useState(false);
  const [cognitoUsers, setCognitoUsers] = useState<CognitoUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<CognitoUser | null>(null);
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
      const mems = await projectsService.listMembers(projectId);
      setMembers(Array.isArray(mems) ? mems : []);
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
    setUserSearch('');
    setNewMemberRole('member');
    loadCognitoUsers();
  };

  const filteredUsers = cognitoUsers.filter((u) => {
    if (!userSearch) return true;
    const q = userSearch.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  });

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    setError(null);
    setAddingMember(true);
    try {
      await projectsService.addMember(projectId, {
        userId: selectedUser.userId,
        email: selectedUser.email,
        role: newMemberRole,
      });
      setShowAddMember(false);
      setSelectedUser(null);
      setUserSearch('');
      setNewMemberRole('member');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: ProjectRole) => {
    setError(null);
    try {
      await projectsService.updateMemberRole(projectId, userId, newRole);
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
      setConfirmRemove(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const getAssignableRoles = (): ProjectRole[] => {
    if (userRole === 'owner') return ['owner', 'admin', 'member'];
    if (userRole === 'admin') return ['member'];
    return [];
  };

  return (
    <>
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
            <div className="divide-y rounded-lg border">
              {members.map((member) => (
                <div key={member.userId} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                    {initials(member)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member.email || member.userId}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                      {member.userId.substring(0, 12)}…
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
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
                          'h-7 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-60',
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
          )}

          {/* Role legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
            {Object.entries(ROLE_DESCRIPTIONS).map(([role, desc]) => (
              <div
                key={role}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <Badge
                  variant="outline"
                  className={cn('h-4 text-[10px]', ROLE_BADGE[role as ProjectRole])}
                >
                  {ROLE_LABELS[role as ProjectRole]}
                </Badge>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </SettingsCard>

      {/* Add Member Dialog */}
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleAddMember}>
            <DialogHeader>
              <DialogTitle>Add Member</DialogTitle>
              <DialogDescription>
                Pick a confirmed Cognito user and assign them a role on this space.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label>User</Label>
                {selectedUser ? (
                  <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {(selectedUser.displayName || selectedUser.email).charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{selectedUser.email}</p>
                        {selectedUser.displayName && (
                          <p className="truncate text-xs text-muted-foreground">
                            {selectedUser.displayName}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-2 h-6 w-6 text-muted-foreground"
                      onClick={() => {
                        setSelectedUser(null);
                        setUserSearch('');
                      }}
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
                      <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
                        {filteredUsers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            {cognitoUsers.length === 0 ? 'No users available' : 'No matching users'}
                          </div>
                        ) : (
                          filteredUsers.map((u) => (
                            <button
                              key={u.userId}
                              type="button"
                              onClick={() => {
                                setSelectedUser(u);
                                setUserSearch('');
                                setShowUserDropdown(false);
                              }}
                              className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-accent"
                            >
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                                {(u.displayName || u.email).charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm">{u.email}</p>
                                {u.displayName && (
                                  <p className="truncate text-xs text-muted-foreground">
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
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
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
              Are you sure you want to remove this member from the space? They will lose access
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
    </>
  );
}
