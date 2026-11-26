import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { nativeIntentsService } from '@/services/nativeIntents';

export function NativePreparationLink({
  projectId,
  sourceId,
  packageJobId,
  bindingRevision,
}: {
  projectId: string;
  sourceId: string;
  packageJobId: string;
  bindingRevision: string;
}) {
  const [availableProject, setAvailableProject] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    nativeIntentsService
      .canPrepare(projectId)
      .then((enabled) => {
        if (active) setAvailableProject(enabled ? projectId : null);
      })
      .catch(() => {
        if (active) setAvailableProject(null);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  if (availableProject !== projectId) return null;
  const selection = new URLSearchParams({ sourceId, packageJobId, bindingRevision });
  return (
    <div className="space-y-1">
      <Link
        className="text-sm text-primary underline underline-offset-4"
        to={`/space/${encodeURIComponent(projectId)}/native-intent/new?${selection}`}
      >
        Create a native intent draft
      </Link>
      <p className="text-xs text-muted-foreground">
        Create a native draft with its own workspace. Preparation does not start the agent.
      </p>
    </div>
  );
}
