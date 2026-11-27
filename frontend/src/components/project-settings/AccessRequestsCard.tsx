// Project Settings → Members: requests to join this space from Browse spaces.
// Owners only. Shown while there are requests waiting.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Check, UserPlus, X, XCircle } from 'lucide-react';
import { projectsService, type AccessRequest, type ProjectRole } from '@/services/projects';
import { SettingsCard } from '@/components/settings/SettingsCard';

interface Props {
  projectId: string;
  // Called after an approval so the member list can reload.
  onApproved: () => void;
  // Reloads the requests when it changes, for example after a direct add.
  reloadKey?: unknown;
}

export function AccessRequestsCard({ projectId, onApproved, reloadKey }: Props) {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [roles, setRoles] = useState<Record<string, ProjectRole>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await projectsService.listAccessRequests(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access requests');
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const decide = async (request: AccessRequest, decision: 'approve' | 'decline') => {
    setBusy(request.userId);
    setError(null);
    try {
      await projectsService.decideAccessRequest(
        projectId,
        request.userId,
        decision,
        decision === 'approve' ? roles[request.userId] || 'member' : undefined,
      );
      setRequests((current) => current.filter((r) => r.userId !== request.userId));
      if (decision === 'approve') onApproved();
    } catch (err) {
      await load();
      setError(err instanceof Error ? err.message : 'Failed to update the request');
    } finally {
      setBusy(null);
    }
  };

  if (requests.length === 0 && !error) return null;

  return (
    <SettingsCard
      icon={<UserPlus />}
      title="Access requests"
      badge={
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground">
          {requests.length} waiting
        </span>
      }
      description="People who found this space in Browse spaces and asked to join."
    >
      <div className="space-y-3">
        {error && (
          <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
            <XCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        <ul aria-label="Access requests" className="divide-y rounded-lg border">
          {requests.map((request) => {
            const who = request.email || request.userId;
            return (
              <li
                key={request.userId}
                className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{who}</p>
                  {request.message && (
                    <p className="text-xs text-muted-foreground">{request.message}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground/80">
                    Asked {new Date(request.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={roles[request.userId] || 'member'}
                    onValueChange={(value) =>
                      setRoles((current) => ({
                        ...current,
                        [request.userId]: value as ProjectRole,
                      }))
                    }
                    disabled={busy === request.userId}
                  >
                    <SelectTrigger
                      aria-label={`Role for ${who}`}
                      className="h-8 w-28 bg-background text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="owner">Owner</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={busy === request.userId}
                    onClick={() => decide(request, 'approve')}
                    aria-label={`Approve ${who}`}
                  >
                    <Check className="h-3.5 w-3.5" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 text-xs"
                    disabled={busy === request.userId}
                    onClick={() => decide(request, 'decline')}
                    aria-label={`Decline ${who}`}
                  >
                    <X className="h-3.5 w-3.5" /> Decline
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsCard>
  );
}
