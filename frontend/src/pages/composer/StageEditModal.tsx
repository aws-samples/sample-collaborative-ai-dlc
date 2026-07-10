import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Lock, Library } from 'lucide-react';
import { blocksService, type Block } from '@/services/blocks';
import {
  StageEditor,
  type StageForm,
  type StageReferenceOptions,
} from '@/components/blocks/StageEditor';

interface StageEditModalProps {
  stageId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function StageEditModal({ stageId, onClose, onSaved }: StageEditModalProps) {
  const navigate = useNavigate();
  const [form, setForm] = useState<StageForm>({});
  const [stageName, setStageName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [referenceOptions, setReferenceOptions] = useState<StageReferenceOptions>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stageId) return;
    setLoading(true);
    setError(null);
    blocksService
      .get('stage', stageId)
      .then((block) => {
        setReadOnly(block.readOnly);
        setStageName(block.name);
        const {
          id: _,
          blockId: _b,
          blockType: _t,
          tenantId: _tn,
          version: _v,
          readOnly: _r,
          hasBody: _h,
          bodyBytes: _bb,
          createdAt: _c,
          updatedAt: _u,
          name: _n,
          description: _d,
          ...rest
        } = block;
        setForm(rest as StageForm);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load stage'))
      .finally(() => setLoading(false));
  }, [stageId]);

  useEffect(() => {
    if (!stageId) return;
    const toOptions = (blocks: Block[]) =>
      blocks.map((block) => ({
        id: block.id,
        label: block.name,
        description: typeof block.description === 'string' ? block.description : undefined,
      }));
    Promise.all([
      blocksService.list('agent'),
      blocksService.list('artifact'),
      blocksService.list('sensor'),
      blocksService.list('stage'),
    ])
      .then(([agents, artifacts, sensors, stages]) =>
        setReferenceOptions({
          agents: toOptions(agents.blocks),
          artifacts: toOptions(artifacts.blocks),
          sensors: toOptions(sensors.blocks),
          stages: toOptions(stages.blocks).filter((stage) => stage.id !== stageId),
        }),
      )
      .catch(() => setReferenceOptions({}));
  }, [stageId]);

  const handleSave = async () => {
    if (!stageId || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      await blocksService.update('stage', stageId, { name: stageName, ...form });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={stageId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {stageName || 'Stage'}
            {readOnly && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Lock className="h-2.5 w-2.5" />
                SYSTEM
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && readOnly && (
          <div className="bg-muted/50 border rounded-md px-3 py-2 text-xs text-muted-foreground flex items-center gap-2 mb-2">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              This is a system stage — read-only. To customize its gates, create your own stage in
              the Block Library.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[10px] ml-auto shrink-0"
              onClick={() => {
                navigate('/blocks/stage');
                onClose();
              }}
            >
              <Library className="h-3 w-3" />
              Block Library
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {!loading && (
          <div className="flex-1 overflow-y-auto pr-1">
            <StageEditor
              value={form}
              onChange={setForm}
              disabled={readOnly}
              referenceOptions={referenceOptions}
            />
          </div>
        )}

        {!loading && !readOnly && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={handleSave}>
              {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
