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

  const { content, contentText, initContent, getContent, synced, awareness, remoteUsers } =
    useCollaborativeArtifactContent({
      projectId,
      intentId,
      artifactId: artifact.id,
      userName,
      userColor: generateColor(userName || artifact.id),
      enabled: true,
      onAutoSave: async (value) => {
        try {
          await intentsService.updateArtifactContent(projectId, intentId, artifact.id, value);
          setSaveError(null);
        } catch (err) {
          setSaveError(err instanceof Error ? err.message : 'Save failed');
          throw err;
        }
      },
    });

  // Seed the shared doc with the persisted content once synced (first editor
  // wins; later joiners see the live state).
  const seededRef = useRef(false);
  useEffect(() => {
    if (!synced || seededRef.current) return;
    seededRef.current = true;
    initContent(artifact.content ?? '');
  }, [synced, initContent, artifact.content]);

  const finish = async () => {
    setFinishing(true);
    try {
      const value = getContent();
      if (value.trim()) {
        await intentsService.updateArtifactContent(projectId, intentId, artifact.id, value);
      }
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
        disabled={!synced}
        placeholder={synced ? 'Document content (markdown)…' : 'Connecting…'}
        className="min-h-64 rounded-md border bg-background p-3 font-mono text-xs leading-relaxed"
        rows={18}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7 gap-1.5" onClick={finish} disabled={finishing || !synced}>
          {finishing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Done
        </Button>
        {!synced && <span className="text-[11px] text-muted-foreground">Connecting…</span>}
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
