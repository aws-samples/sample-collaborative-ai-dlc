import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { useAuth } from '@/contexts/AuthContext';
import { useIntent } from '@/contexts/IntentContext';
import { useCollaborativeArtifactContent } from '@/hooks/useCollaborativeArtifactContent';
import { intentsService, type IntentArtifact } from '@/services/intents';
import { generateColor } from '@/utils/colors';

// Inline collaborative markdown editor for a v2 artifact (post-hoc document
// editing). Yjs doc `intent-artifact-{intentId}-{artifactId}` — live remote
// cursors, diff-based merges, auto-save (2 s debounce) through the PUT content
// endpoint; Done flushes a final save and leaves editing. The backend stamps
// edit provenance, marks the downstream closure stale and re-derives.

export function ArtifactContentEditor({
  artifact,
  onDone,
}: {
  artifact: IntentArtifact;
  onDone: () => void;
}) {
  const { projectId, intentId, reload } = useIntent();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  const [finishing, setFinishing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { content, contentText, initContent, synced, awareness, remoteUsers, flush } =
    useCollaborativeArtifactContent({
      projectId,
      intentId,
      artifactId: artifact.id,
      collaborationEpoch: artifact.collaborationEpoch,
      userName,
      userColor: generateColor(userName || artifact.id),
      enabled: true,
      readSaveVersion: async () => {
        const current = await intentsService.artifactEditState(projectId, intentId, artifact.id);
        if (current.collaborationEpoch !== (artifact.collaborationEpoch ?? null))
          throw new Error('Artifact was replaced — reload before editing');
        return current.editRevision;
      },
      onSaveError: (error) => {
        setSaveError(error instanceof Error ? error.message : 'Save failed');
      },
      onAutoSave: async (value, version) => {
        await intentsService.updateArtifactContent(
          projectId,
          intentId,
          artifact.id,
          value,
          artifact.collaborationEpoch ?? null,
          version ?? null,
        );
        setSaveError(null);
      },
    });

  // Seed the shared doc with the persisted content once synced and the body
  // has loaded (first editor wins; later joiners see the live state). A body
  // that is too large or failed to load is never seeded: saving an empty doc
  // would overwrite the real body.
  const unavailable = artifact.contentUnavailable ?? null;
  const contentLoaded = artifact.content !== undefined && !unavailable;
  const seededRef = useRef(false);
  useEffect(() => {
    seededRef.current = false;
  }, [artifact.id, artifact.collaborationEpoch]);
  useEffect(() => {
    if (!synced || !contentLoaded || seededRef.current) return;
    seededRef.current = true;
    initContent(artifact.content ?? '');
  }, [synced, contentLoaded, initContent, artifact.content]);

  const finish = async () => {
    setFinishing(true);
    try {
      await flush();
      await reload();
      onDone();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <CollaborativeTextarea
        yText={contentText}
        awareness={awareness}
        value={content}
        disabled={!synced || !contentLoaded}
        placeholder={
          unavailable
            ? 'Editing is unavailable'
            : !synced
              ? 'Connecting…'
              : contentLoaded
                ? 'Document content (markdown)…'
                : 'Loading…'
        }
        className="min-h-64 rounded-md border bg-background p-3 font-mono text-xs leading-relaxed"
        rows={18}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 gap-1.5"
          onClick={finish}
          disabled={finishing || !synced || !contentLoaded}
        >
          {finishing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Done
        </Button>
        {!synced && <span className="text-[11px] text-muted-foreground">Connecting…</span>}
        {unavailable === 'too_large' && (
          <span className="text-[11px] text-destructive">
            This document is too large to load here, so it can't be edited.
          </span>
        )}
        {unavailable === 'error' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
            The document couldn't be loaded.
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void reload()}
            >
              Retry
            </Button>
          </span>
        )}
        {remoteUsers.size > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {remoteUsers.size} other{remoteUsers.size > 1 ? 's' : ''} editing
          </span>
        )}
        {saveError && <span className="text-[11px] text-destructive">{saveError}</span>}
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          Auto-saves as you type · downstream artifacts get a “possibly stale” marker
        </span>
      </div>
    </div>
  );
}
