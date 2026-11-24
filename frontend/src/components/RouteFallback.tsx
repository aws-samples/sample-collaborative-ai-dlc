import { Skeleton } from '@/components/ui/skeleton';

/** Route-transition placeholder shaped like a page: header bar plus three content rows. */
export function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading page"
      className="flex min-h-0 flex-1 flex-col gap-6 p-6"
    >
      <span className="sr-only">Loading page</span>
      <div data-skeleton="header" className="flex items-center justify-between gap-4">
        <Skeleton decorative className="h-8 w-1/3 max-w-sm" />
        <Skeleton decorative className="h-8 w-24" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} decorative data-skeleton="row" className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
