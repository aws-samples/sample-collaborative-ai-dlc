import { Link, useLocation } from 'react-router';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export default function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <EmptyState
        icon={Compass}
        headingLevel={1}
        title="This page doesn't exist"
        description={
          <>
            The address may be mistyped, or the page may have moved.
            <code className="mt-2 block break-all font-mono text-xs text-foreground/80">
              {pathname}
            </code>
          </>
        }
        action={
          <Button asChild>
            <Link to="/dashboard">Go to My work</Link>
          </Button>
        }
      />
    </div>
  );
}
