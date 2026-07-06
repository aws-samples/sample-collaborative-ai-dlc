import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  workflowsService,
  type WorkflowSummary,
  type CreateWorkflowInput,
} from '@/services/workflows';
import { DEFAULT_PHASE_NODES } from './composer/defaultPhases';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Plus, Trash2, Workflow as WorkflowIcon, Lock } from 'lucide-react';

// kebab-case, matching the backend id rule.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function WorkflowList() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowSummary | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await workflowsService.list();
      setWorkflows(data.workflows);
    } catch (error) {
      console.error('Failed to load workflows:', error);
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(confirmDelete.id);
    try {
      await workflowsService.delete(confirmDelete.id);
      setWorkflows(workflows.filter((w) => w.id !== confirmDelete.id));
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  };

  return (
    <div className="h-full">
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-end justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <WorkflowIcon className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Workflows</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Compose blocks into a tailored methodology
              </p>
            </div>
          </div>
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            New Workflow
          </Button>
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-5 w-2/3 mb-3" />
                  <Skeleton className="h-4 w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : workflows.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <WorkflowIcon className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">No workflows yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-sm">
                Create a workflow to arrange library blocks into your own phases and flow.
              </p>
              <Button onClick={() => setShowCreate(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                New Workflow
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {workflows.map((wf) => (
              <Card
                key={wf.id}
                className="group cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
                onClick={() => navigate(`/workflows/${wf.id}`)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-sm truncate">{wf.name}</h3>
                      <p className="text-[11px] text-muted-foreground/70 font-mono truncate">
                        {wf.id}
                      </p>
                    </div>
                    {wf.readOnly ? (
                      <Badge variant="outline" className="h-5 gap-1 text-[9px] shrink-0">
                        <Lock className="h-2.5 w-2.5" />
                        SYSTEM
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(wf);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                  {wf.objective && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {wf.objective}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                    <span>{wf.status}</span>
                    {wf.basedOn && <span>· forked from {wf.basedOn}</span>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateWorkflowDialog
          workflows={workflows}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/workflows/${id}`);
          }}
        />
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{confirmDelete?.name}</strong>? Its phase tree
              and placements are removed; the referenced library blocks are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={!!deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface CreateProps {
  workflows: WorkflowSummary[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

// Create blank, or fork an existing workflow (incl. the SYSTEM default).
function CreateWorkflowDialog({ workflows, onClose, onCreated }: CreateProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [basedOn, setBasedOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (!ID_RE.test(id)) return setError('Id must be kebab-case.');
    if (!name.trim()) return setError('Name is required.');
    setSaving(true);
    try {
      const input: CreateWorkflowInput = { id, name, objective };
      if (basedOn) input.basedOn = basedOn;
      const created = await workflowsService.create(input);
      await workflowsService.putPhases(created.id, DEFAULT_PHASE_NODES);
      onCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow');
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Workflow</DialogTitle>
          <DialogDescription>
            Start blank, or fork an existing workflow to reuse its phase tree and placements.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="grid gap-2">
            <Label>Id</Label>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-flow" />
          </div>
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Flow" />
          </div>
          <div className="grid gap-2">
            <Label>Objective</Label>
            <Input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="The end-to-end outcome this workflow delivers"
            />
          </div>
          <div className="grid gap-2">
            <Label>Fork from (optional)</Label>
            <select
              value={basedOn}
              onChange={(e) => setBasedOn(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">— Blank —</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.readOnly ? ' (SYSTEM)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
