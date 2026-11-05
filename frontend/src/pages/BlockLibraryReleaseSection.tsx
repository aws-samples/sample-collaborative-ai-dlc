import { useNavigate } from 'react-router';
import { Package } from 'lucide-react';
import type { Block, BlockType } from '@/services/blocks';
import type { BlockLibraryRelease } from '@/hooks/useBlockLibraryRelease';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

interface BlockLibraryReleaseSectionProps {
  activeType: BlockType;
  pluralLabel: string;
  searchQuery: string;
  libraryBlocks: Block[];
  release: BlockLibraryRelease | null;
  error: string | null;
  requestedRelease: string | null;
  authoringQuery: string;
}

export function BlockLibraryReleaseSection({
  activeType,
  pluralLabel,
  searchQuery,
  libraryBlocks,
  release,
  error,
  requestedRelease,
  authoringQuery,
}: BlockLibraryReleaseSectionProps) {
  const navigate = useNavigate();
  const query = searchQuery.toLowerCase();
  const visibleBlocks = (release?.blocks ?? []).filter(
    (block) => block.name.toLowerCase().includes(query) || block.id.toLowerCase().includes(query),
  );
  const libraryIds = new Set(
    libraryBlocks.filter((block) => !block.readOnly).map((block) => block.id),
  );
  const releaseQuery = release ? `?release=${encodeURIComponent(release.releaseId)}` : '';

  return (
    <>
      {error && (
        <p className="mt-8 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {release && (
        <section
          className="mt-10"
          aria-labelledby="release-blocks-heading"
          data-testid="release-blocks"
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <h2 id="release-blocks-heading" className="text-base font-semibold">
              {pluralLabel} in {release.label}
              {release.stable ? ' (stable)' : ''}
              {release.selectedForAuthoring ? ' · selected for authoring' : ''}
            </h2>
            <span className="font-mono text-[11px] text-muted-foreground break-all">
              {release.releaseId}
            </span>
            {requestedRelease && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => navigate(`/blocks/${activeType}`)}
              >
                Back to the stable release
              </Button>
            )}
            {release.selectedForAuthoring && activeType === 'stage' && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={() => navigate(`/blocks/stage/new${authoringQuery}`)}
              >
                Create a stage with this version&apos;s blocks
              </Button>
            )}
          </div>
          <p className="mb-4 max-w-3xl text-xs text-muted-foreground">
            {release.stable
              ? 'New intents pin this release: they run these blocks in place of the SYSTEM baseline, and a library block with the same id replaces the release’s. Release blocks are read-only.'
              : 'Intents pinned to this release run these blocks in place of the SYSTEM baseline. Release blocks are read-only.'}
          </p>
          {visibleBlocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {release.blocks.length === 0
                ? `This release has no ${pluralLabel.toLowerCase()}.`
                : `No ${pluralLabel.toLowerCase()} in this release match "${searchQuery}".`}
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {visibleBlocks.map((block) => (
                <Card
                  key={block.id}
                  className="cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
                  onClick={() =>
                    navigate(`/blocks/${activeType}/${encodeURIComponent(block.id)}${releaseQuery}`)
                  }
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-sm truncate">{block.name}</h3>
                        <p className="text-[11px] text-muted-foreground/70 font-mono truncate">
                          {block.id}
                        </p>
                      </div>
                      <Badge variant="outline" className="h-5 gap-1 text-[9px] shrink-0">
                        <Package className="h-2.5 w-2.5" />
                        RELEASE
                      </Badge>
                    </div>
                    {typeof block.description === 'string' && block.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                        {block.description}
                      </p>
                    )}
                    {libraryIds.has(block.id) && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        Replaced by the library block with this id
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
