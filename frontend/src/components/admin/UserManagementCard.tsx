// Admin "User Management" card — lists every Cognito user and lets a platform
// admin grant/revoke the `platform-admin` role. The backend enforces the
// admin gate and rejects self-demotion (SELF_DEMOTION_FORBIDDEN), so the last
// administrator can never lock the platform out of its Admin page.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, XCircle, Loader2, Users, ShieldCheck } from 'lucide-react';
import { adminUsersService, type AdminUser } from '@/services/adminUsers';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/services/api';

export function UserManagementCard() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Username of the row whose role toggle is in flight (one at a time).
  const [togglingUsername, setTogglingUsername] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await adminUsersService.list();
      // Admins first, then alphabetically by display name/email.
      list.sort((a, b) => {
        if (a.platformAdmin !== b.platformAdmin) return a.platformAdmin ? -1 : 1;
        return (a.displayName || a.email).localeCompare(b.displayName || b.email);
      });
      setUsers(list);
    } catch (e) {
      console.error('Failed to load users:', e);
      setLoadError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q),
    );
  }, [users, filter]);

  const toggleAdmin = async (target: AdminUser) => {
    setTogglingUsername(target.username);
    setActionError(null);
    try {
      await adminUsersService.setPlatformAdmin(target.username, !target.platformAdmin);
      setUsers((prev) =>
        prev.map((u) =>
          u.username === target.username ? { ...u, platformAdmin: !target.platformAdmin } : u,
        ),
      );
    } catch (e) {
      console.error('Failed to update platform-admin role:', e);
      const body = e instanceof ApiError ? (e.body as { error?: string } | undefined) : undefined;
      setActionError(body?.error || (e instanceof Error ? e.message : 'Failed to update role'));
    } finally {
      setTogglingUsername(null);
    }
  };

  const isSelf = (u: AdminUser) => u.username === currentUser?.username;

  return (
    <Card>
      <CardHeader className="pb-3 pt-5 px-5">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          User Management
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Grant or revoke the <span className="font-medium">platform-admin</span> role. Admins can
          access this page and change platform-wide settings. Role changes take effect when the user
          signs in again (the role rides on their ID token). Users are created in the Cognito User
          Pool.
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : (
          <>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, email or username…"
              className="text-sm h-9"
            />
            {actionError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5 shrink-0" /> {actionError}
              </p>
            )}
            <div className="border rounded-md divide-y">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground px-3 py-4">No users match.</p>
              ) : (
                filtered.map((u) => (
                  <div key={u.username} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                        {u.displayName || u.email || u.username}
                        {isSelf(u) && (
                          <span className="text-[10px] text-muted-foreground font-normal">
                            (you)
                          </span>
                        )}
                        {!u.enabled && (
                          <span className="text-[10px] font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                            disabled
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">{u.email}</p>
                    </div>
                    {u.platformAdmin && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-agent-success shrink-0">
                        <ShieldCheck className="h-3.5 w-3.5" /> Platform admin
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant={u.platformAdmin ? 'outline' : 'default'}
                      className="gap-1.5 shrink-0"
                      disabled={togglingUsername !== null || (u.platformAdmin && isSelf(u))}
                      title={
                        u.platformAdmin && isSelf(u)
                          ? 'You cannot remove your own platform-admin role'
                          : undefined
                      }
                      onClick={() => toggleAdmin(u)}
                    >
                      {togglingUsername === u.username ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : u.platformAdmin ? (
                        <XCircle className="h-3.5 w-3.5" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      {u.platformAdmin ? 'Revoke admin' : 'Make admin'}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
