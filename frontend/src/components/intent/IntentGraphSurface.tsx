import { GraphCanvas, type GraphCanvasProps } from '@/components/graph/GraphCanvas';

export function IntentGraphSurface(props: Omit<GraphCanvasProps, 'title'>) {
  return (
    <section aria-label="Knowledge graph" className="h-full min-w-0 overflow-hidden">
      <GraphCanvas {...props} title="Knowledge graph" />
    </section>
  );
}
