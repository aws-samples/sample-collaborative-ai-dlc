import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2, Package, Search, Workflow as WorkflowIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BLOCK_TYPES, BLOCK_TYPE_LABELS, type BlockType } from '@/services/blocks';
import {
  aidlcReleasesService,
  releaseDisplayLabel,
  type ReleaseContents,
} from '@/services/aidlcReleases';

interface ReleaseContentsDialogProps {
  // The release to show; null keeps the dialog closed.
  releaseId: string | null;
  onClose: () => void;
  // The block type shown first.
  initialType?: BlockType;
}

// A read-only view of one registered AI-DLC release's catalog (issue #607):
// its workflow and its blocks by type, exactly as an intent pinned to it
// resolves them. Selecting a block opens it, read-only, in the block editor.
export function ReleaseContentsDialog({
  releaseId,
  onClose,
  initialType = 'agent',
}: ReleaseContentsDialogProps) {
  const navigate = useNavigate();
  const [contents, setContents] = useState<ReleaseContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<BlockType>(initialType);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!releaseId) return;
    let cancelled = false;
    setContents(null);
    setError(null);
    setQuery('');
    aidlcReleasesService
      .contents(releaseId)
      .then((next) => {
        if (!cancelled) setContents(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the release');
      });
    return () => {
      cancelled = true;
    };
  }, [releaseId]);

  const blocks = useMemo(() => contents?.blocks[activeType] ?? [], [contents, activeType]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? blocks.filter(
          (block) => block.id.toLowerCase().includes(q) || block.name.toLowerCase().includes(q),
        )
      : blocks;
  }, [blocks, query]);

  const workflow = contents?.workflow ?? null;
  const label = contents ? releaseDisplayLabel(contents.release) : (releaseId ?? '');

  return (
    <Dialog open={!!releaseId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            Release contents: {label}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] break-all">
            {releaseId}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !contents ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading release…
          </div>
        ) : (
          <div className="space-y-4">
            {workflow && (
              <div className="rounded-md border p-3 text-sm" data-testid="release-workflow">
                <div className="flex flex-wrap items-center gap-2">
                  <WorkflowIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{workflow.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{workflow.id}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {workflow.placements.length} stages · {workflow.phases.length} phases · scopes:{' '}
                  {workflow.scopeRefs.map((scope) => scope.scopeId).join(', ') || 'none'}
                </p>
              </div>
            )}

            <Tabs value={activeType} onValueChange={(value) => setActiveType(value as BlockType)}>
              <TabsList className="flex h-auto flex-wrap">
                {BLOCK_TYPES.map((type) => (
                  <TabsTrigger key={type} value={type}>
                    {BLOCK_TYPE_LABELS[type].plural} ({contents.blocks[type]?.length ?? 0})
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${BLOCK_TYPE_LABELS[activeType].plural.toLowerCase()}…`}
                aria-label="Search release blocks"
                className="h-9 pl-9"
              />
            </div>

            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {blocks.length === 0
                  ? `This release has no ${BLOCK_TYPE_LABELS[activeType].plural.toLowerCase()}.`
                  : 'No blocks match.'}
              </p>
            ) : (
              <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-md border">
                {visible.map((block) => (
                  <li key={block.id}>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-accent"
                      onClick={() => {
                        onClose();
                        navigate(
                          `/blocks/${activeType}/${encodeURIComponent(block.id)}?release=${encodeURIComponent(block.releaseId)}`,
                        );
                      }}
                    >
                      <span className="text-sm font-medium">{block.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {block.id}
                      </span>
                      {typeof block.description === 'string' && block.description && (
                        <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-1">
                          {block.description}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
