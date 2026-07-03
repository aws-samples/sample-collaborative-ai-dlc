import { useIntent } from '@/contexts/IntentContext';
import { KnowledgeGraph } from '@/components/intent/KnowledgeGraph';
import { Skeleton } from '@/components/ui/skeleton';

export default function IntentGraphPage() {
  const { detail, loading } = useIntent();

  if (loading && !detail) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-4">
        <h1 className="text-lg font-bold tracking-tight">Knowledge graph</h1>
        <div className="min-h-[calc(100vh-16rem)]">
          <KnowledgeGraph />
        </div>
      </div>
    </div>
  );
}
