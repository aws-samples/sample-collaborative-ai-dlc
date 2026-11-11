import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Lock, Library, Package } from 'lucide-react';
import { blocksService, type Block } from '@/services/blocks';
import { aidlcReleasesService } from '@/services/aidlcReleases';
import {
  StageEditor,
  type StageForm,
  type StageReferenceOptions,
} from '@/components/blocks/StageEditor';
import { loadStageReferenceOptions } from '@/components/blocks/stageReferenceOptions';

// A release-origin stage is the release's immutable copy, which the live
// library may not have or may hold differently under the same id.
const loadStage = (stageId: string, stageReleaseId: string | null): Promise<Block> =>
  stageReleaseId
    ? aidlcReleasesService.block(stageReleaseId, 'stage', stageId).then((detail) => detail.block)
    : blocksService.get('stage', stageId);

interface StageEditModalProps {
  stageId: string | null;
  // The release the composer resolved this stage from; null for a library stage.
  stageReleaseId?: string | null;
  libraryReleaseId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function StageEditModal({
  stageId,
  stageReleaseId = null,
  libraryReleaseId = null,
  onClose,
  onSaved,
}: StageEditModalProps) {
  const navigate = useNavigate();
  const [form, setForm] = useState<StageForm>({});
  const [stageName, setStageName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [referenceOptions, setReferenceOptions] = useState<StageReferenceOptions>({});
  const [referenceOptionsLoading, setReferenceOptionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // A stage or reference catalog that could not be loaded blocks editing; a
  // failed save does not, so the member can correct the form and retry.
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!stageId) return;
    setLoading(true);
    setError(null);
    setSaveError(null);
    loadStage(stageId, stageReleaseId)
      .then((block) => {
        setReadOnly(Boolean(stageReleaseId) || block.readOnly);
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
          source: _s,
          releaseId: _rel,
          ...rest
        } = block;
        setForm(rest as StageForm);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load stage'))
      .finally(() => setLoading(false));
  }, [stageId, stageReleaseId]);

  useEffect(() => {
    if (!stageId) return;
    setError(null);
    setReferenceOptionsLoading(Boolean(libraryReleaseId));
    loadStageReferenceOptions(stageId, libraryReleaseId)
      .then(({ options }) => setReferenceOptions(options))
      .catch((e) => {
        setReferenceOptions({});
        // Without a selected version the pickers only offer suggestions; they
        // stay empty and typed ids still save.
        if (!libraryReleaseId) return;
        setError(
          e instanceof Error
            ? `The selected AI-DLC version could not be loaded: ${e.message}`
            : 'The selected AI-DLC version could not be loaded.',
        );
      })
      .finally(() => setReferenceOptionsLoading(false));
  }, [stageId, libraryReleaseId]);

  const handleSave = async () => {
    if (!stageId || readOnly || referenceOptionsLoading || error) return;
    setSaving(true);
    setSaveError(null);
    try {
      await blocksService.update('stage', stageId, { name: stageName, ...form });
      onSaved();
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
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
            {stageReleaseId ? (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Package className="h-2.5 w-2.5" />
                Release
              </Badge>
            ) : (
              readOnly && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Lock className="h-2.5 w-2.5" />
                  SYSTEM
                </Badge>
              )
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
              {stageReleaseId
                ? 'This stage is part of the selected AI-DLC release — read-only. To customize it, create a stage with the same id in the Block Library.'
                : 'This is a system stage — read-only. To customize its gates, create your own stage in the Block Library.'}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[10px] ml-auto shrink-0"
              onClick={() => {
                navigate(
                  `/blocks/stage${libraryReleaseId ? `?libraryRelease=${encodeURIComponent(libraryReleaseId)}` : ''}`,
                );
                onClose();
              }}
            >
              <Library className="h-3 w-3" />
              Block Library
            </Button>
          </div>
        )}

        {(error ?? saveError) && <p className="text-xs text-destructive">{error ?? saveError}</p>}

        {!loading && (
          <div className="flex-1 overflow-y-auto pr-1">
            <StageEditor
              value={form}
              onChange={setForm}
              disabled={readOnly || referenceOptionsLoading || Boolean(error)}
              referenceOptions={referenceOptions}
            />
          </div>
        )}

        {!loading && !readOnly && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving || referenceOptionsLoading || Boolean(error)}
              onClick={handleSave}
            >
              {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
