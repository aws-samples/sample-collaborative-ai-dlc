import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function WorkProductsCard({
  actions,
  description,
  children,
}: {
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Work products</CardTitle>
          {actions}
        </div>
        {description}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}
