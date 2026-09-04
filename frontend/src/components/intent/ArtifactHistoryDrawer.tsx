import { useEffect, useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import { useIntent } from '@/contexts/IntentContext';
import { cn } from '@/lib/utils';
import {
  intentsService,
  type ArtifactVersion,
  type ArtifactVersionSummary,
  type ArtifactVersions,
  type IntentArtifact,
} from '@/services/intents';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleString() : 'Unknown time';

export function ArtifactHistoryDrawer({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  if ((artifact.versionCount ?? 0) < 1) return null;
  return <ArtifactHistoryDrawerContent artifact={artifact} className={className} />;
}

function ArtifactHistoryDrawerContent({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  const { projectId, intentId } = useIntent();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ArtifactVersions | null>(null);
  const [selectedId, setSelectedId] = useState('current');
  const [selectedVersion, setSelectedVersion] = useState<ArtifactVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionCount = artifact.versionCount!;

  useEffect(() => {
    if (!open || history) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    intentsService
      .artifactVersions(projectId, intentId, artifact.id)
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, history, intentId, open, projectId]);

  const selectVersion = async (version: ArtifactVersionSummary) => {
    setSelectedId(version.versionId);
    if (version.current) {
      setSelectedVersion(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSelectedVersion(
        await intentsService.artifactVersion(projectId, intentId, artifact.id, version.versionId),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load version');
    } finally {
      setLoading(false);
    }
  };

  const selectedSummary =
    selectedId === 'current'
      ? history?.current
      : history?.versions.find((version) => version.versionId === selectedId);
  const content = selectedId === 'current' ? artifact.content : selectedVersion?.content;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-7 w-7 shrink-0', className)}
        title="Artifact history"
        aria-label={`History for ${artifact.title || artifact.id}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <History className="h-3.5 w-3.5" />
      </Button>
      <SheetContent className="flex w-full flex-col p-0 sm:max-w-3xl">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle className="text-base">{artifact.title || artifact.id}</SheetTitle>
          <SheetDescription>
            Generation {artifact.generation ?? 1} with {versionCount} archived version
            {versionCount === 1 ? '' : 's'}
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,220px)_minmax(0,1fr)]">
          <ScrollArea className="border-r">
            <div className="space-y-1 p-2">
              {history && (
                <>
                  {history.current && (
                    <VersionButton
                      version={history.current}
                      selected={selectedId === 'current'}
                      onClick={() => selectVersion(history.current!)}
                    />
                  )}
                  {history.versions.map((version) => (
                    <VersionButton
                      key={version.versionId}
                      version={version}
                      selected={selectedId === version.versionId}
                      onClick={() => selectVersion(version)}
                    />
                  ))}
                </>
              )}
            </div>
          </ScrollArea>
          <ScrollArea>
            <div className="px-5 py-4">
              {loading && !content && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Loading version
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              {selectedSummary && (
                <div className="mb-4 border-b pb-3">
                  <p className="text-sm font-medium">
                    {selectedSummary.current
                      ? `Current generation ${selectedSummary.generation}`
                      : `Generation ${selectedSummary.generation}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedSummary.current
                      ? formatDate(selectedSummary.createdAt)
                      : `Archived ${formatDate(selectedSummary.archivedAt)}`}
                    {selectedSummary.actor ? ` by ${selectedSummary.actor}` : ''}
                  </p>
                  {selectedSummary.restartReason && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {selectedSummary.restartReason}
                    </p>
                  )}
                </div>
              )}
              {content ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ArtifactMarkdown content={content} />
                </div>
              ) : (
                !loading && <p className="text-sm text-muted-foreground">No content recorded.</p>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function VersionButton({
  version,
  selected,
  onClick,
}: {
  version: ArtifactVersionSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted',
        selected && 'bg-muted',
      )}
      onClick={onClick}
    >
      <span className="block font-medium">
        {version.current ? 'Current' : `Generation ${version.generation}`}
      </span>
      <span className="mt-0.5 block text-muted-foreground">
        {formatDate(version.current ? version.createdAt : version.archivedAt)}
      </span>
      {version.unitSlug && (
        <span className="mt-0.5 block truncate text-muted-foreground">{version.unitSlug}</span>
      )}
    </button>
  );
}
