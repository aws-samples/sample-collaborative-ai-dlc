// Browse spaces: every space its Owners made discoverable, with its
// description and Owners, so people who are not members can ask to join.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Compass, RefreshCw, Search, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsService, type DiscoverableSpace } from '@/services/projects';
import { useAuth } from '@/contexts/AuthContext';

const MAX_MESSAGE_LENGTH = 500;

export default function BrowseSpaces() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [spaces, setSpaces] = useState<DiscoverableSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<DiscoverableSpace | null>(null);
  const [message, setMessage] = useState('');
  const [askError, setAskError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSpaces(await projectsService.listDiscoverable());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load spaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return spaces;
    return spaces.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.owners.some((o) => o.email.toLowerCase().includes(q)),
    );
  }, [spaces, search]);

  const setAccess = (id: string, access: DiscoverableSpace['access']) =>
    setSpaces((current) => current.map((s) => (s.id === id ? { ...s, access } : s)));

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!asking) return;
    setBusy(asking.id);
    setAskError(null);
    try {
      await projectsService.requestAccess(asking.id, message.trim() || undefined);
      setAccess(asking.id, 'pending');
      setAsking(null);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Failed to send the request');
      // The space may have changed (already requested, joined or hidden).
      projectsService
        .listDiscoverable()
        .then(setSpaces)
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (space: DiscoverableSpace) => {
    if (!user) return;
    setBusy(space.id);
    setError(null);
    try {
      await projectsService.withdrawAccessRequest(space.id, user.userId);
      setAccess(space.id, 'none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to withdraw the request');
      // The request may already have been decided: show where the user stands.
      projectsService
        .listDiscoverable()
        .then(setSpaces)
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Browse spaces</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Spaces you can ask to join. Their Owners decide who gets access.
          </p>
        </div>
        <Button variant="outline" onClick={load} className="gap-2" disabled={loading}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <div className="relative mb-4 max-w-md">
        <Search
          className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          aria-label="Search spaces"
          placeholder="Search by name, description or Owner"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {error && (
        <p role="alert" className="mb-4 flex items-center gap-1 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : shown.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Compass className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">
              {spaces.length === 0 ? 'No discoverable spaces yet' : 'No matching spaces'}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {spaces.length === 0
                ? 'Space Owners can list a space here from its settings.'
                : 'Try a different search.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul aria-label="Discoverable spaces" className="grid gap-3 md:grid-cols-2">
          {shown.map((space) => (
            <li key={space.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-base font-semibold">{space.name}</h2>
                    {space.access === 'member' && <Badge variant="secondary">Joined</Badge>}
                    {space.access === 'pending' && <Badge variant="outline">Requested</Badge>}
                  </div>
                  {space.description && (
                    <p className="text-sm text-muted-foreground">{space.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Owner{space.owners.length === 1 ? '' : 's'}:
                    </span>{' '}
                    {space.owners.map((o) => o.email || 'Unknown').join(', ') || 'None'}
                  </p>
                  <div className="mt-auto flex justify-end">
                    {space.access === 'member' ? (
                      <Button size="sm" onClick={() => navigate(`/space/${space.id}`)}>
                        Open
                      </Button>
                    ) : space.access === 'pending' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === space.id}
                        onClick={() => withdraw(space)}
                        aria-label={`Withdraw request for ${space.name}`}
                      >
                        Withdraw request
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy === space.id}
                        onClick={() => {
                          setAsking(space);
                          setMessage('');
                          setAskError(null);
                        }}
                        aria-label={`Request access to ${space.name}`}
                      >
                        Request access
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={!!asking}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submitRequest}>
            <DialogHeader>
              <DialogTitle>Request access</DialogTitle>
              <DialogDescription>
                Ask the Owners of {asking?.name} to add you. They see your email and your message.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 py-4">
              <Label htmlFor="access-request-message">Message (optional)</Label>
              <Textarea
                id="access-request-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={3}
                placeholder="Why you need access"
              />
              {askError && (
                <p role="alert" className="text-sm text-destructive">
                  {askError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAsking(null)}
                disabled={!!busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!!busy}>
                {busy ? 'Sending...' : 'Send request'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
