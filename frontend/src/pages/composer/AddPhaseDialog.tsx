import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

interface AddPhaseDialogProps {
  existingTopPaths: string[];
  onAdd: (phaseId: string, name: string, path: string) => void;
}

function toKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function nextTopPath(existingTopPaths: string[]): string {
  let max = 0;
  for (const p of existingTopPaths) {
    const n = Number.parseInt(p.split('.')[0], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(2, '0');
}

export function AddPhaseDialog({ existingTopPaths, onAdd }: AddPhaseDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const derivedId = toKebab(name);
  const path = nextTopPath(existingTopPaths);
  const valid = derivedId.length >= 2;

  const submit = () => {
    if (!valid) return;
    onAdd(derivedId, name.trim() || derivedId, path);
    setName('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add phase
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add phase</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="phase-name">Phase name</Label>
            <Input
              id="phase-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ideation"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            ID: <code className="rounded bg-muted px-1 py-0.5">{derivedId || '—'}</code> · path:{' '}
            <code className="rounded bg-muted px-1 py-0.5">{path}</code>
          </p>
        </div>
        <DialogFooter>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
