import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  blocksService,
  BLOCK_TYPES,
  BLOCK_TYPE_LABELS,
  type Block,
  type BlockType,
} from '@/services/blocks';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Plus, Trash2, Blocks as BlocksIcon, Search, Lock } from 'lucide-react';

const isBlockType = (v: string | undefined): v is BlockType =>
  !!v && (BLOCK_TYPES as readonly string[]).includes(v);

export default function BlockLibrary() {
  const navigate = useNavigate();
  const { type: typeParam } = useParams<{ type: string }>();
  const activeType: BlockType = isBlockType(typeParam) ? typeParam : 'stage';

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Block | null>(null);

  const loadBlocks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await blocksService.list(activeType);
      setBlocks(data.blocks);
    } catch (error) {
      console.error('Failed to load blocks:', error);
      setBlocks([]);
    } finally {
      setLoading(false);
    }
  }, [activeType]);

  useEffect(() => {
    loadBlocks();
  }, [loadBlocks]);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(confirmDelete.id);
    try {
      await blocksService.delete(activeType, confirmDelete.id);
      setBlocks(blocks.filter((b) => b.id !== confirmDelete.id));
    } catch (error) {
      console.error('Failed to delete block:', error);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  };

  const filtered = blocks.filter(
    (b) =>
      b.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.id.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const labels = BLOCK_TYPE_LABELS[activeType];

  return (
    <div className="h-full">
      <div>
        {/* Header */}
        <div className="flex items-end justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <BlocksIcon className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Block Library</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Reusable stages, scopes, agents, artifacts, sensors, and rules
              </p>
            </div>
          </div>
          <Button onClick={() => navigate(`/blocks/${activeType}/new`)} className="gap-2">
            <Plus className="h-4 w-4" />
            New {labels.singular}
          </Button>
        </div>

        {/* Type tabs */}
        <Tabs value={activeType} className="mb-6">
          <TabsList className="flex-wrap h-auto">
            {BLOCK_TYPES.map((t) => (
              <TabsTrigger key={t} value={t} onClick={() => navigate(`/blocks/${t}`)}>
                {BLOCK_TYPE_LABELS[t].plural}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Search */}
        <div className="relative flex-1 max-w-sm mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${labels.plural.toLowerCase()}...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {/* Content */}
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
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <BlocksIcon className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">
                {blocks.length === 0
                  ? `No ${labels.plural.toLowerCase()} yet`
                  : `No ${labels.plural.toLowerCase()} match "${searchQuery}"`}
              </h3>
              {blocks.length === 0 && (
                <>
                  <p className="text-sm text-muted-foreground mb-6 text-center max-w-sm">
                    Create a {labels.singular.toLowerCase()} to add it to the shared library.
                  </p>
                  <Button onClick={() => navigate(`/blocks/${activeType}/new`)} className="gap-2">
                    <Plus className="h-4 w-4" />
                    New {labels.singular}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((block) => (
              <Card
                key={block.id}
                className="group cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
                onClick={() => navigate(`/blocks/${activeType}/${block.id}`)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-sm truncate">{block.name}</h3>
                      <p className="text-[11px] text-muted-foreground/70 font-mono truncate">
                        {block.id}
                      </p>
                    </div>
                    {block.readOnly ? (
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
                          setConfirmDelete(block);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                  {typeof block.description === 'string' && block.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {block.description}
                    </p>
                  )}
                  <div className="text-[11px] text-muted-foreground/60">v{block.version}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {labels.singular}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{confirmDelete?.name}</strong>? This removes
              every version and cannot be undone.
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
