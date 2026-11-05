import { useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { useNativeListingVersion } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import type { Project } from '@/services/projects';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { NativeIntentCreation } from '@/components/intent/NativeIntentCreation';
import { PlatformIntentCreation } from '@/components/intent/PlatformIntentCreation';

export default function NewIntentPage() {
  const { projectId } = useParams();
  const { project, loading } = useProjectCache(projectId ?? null);
  const location = useLocation();
  useNativeListingVersion();
  const formKey = location.state?.intentCreationKey ?? location.key;
  if (isSessionExpiryNotified()) return <p>Sign in to create or recover an intent.</p>;
  if (loading) return <Skeleton className="h-[400px] rounded-lg" />;
  if (!project) return <div className="text-sm text-destructive">Space not found</div>;
  return (
    <IntentCreation
      key={JSON.stringify([project.id, formKey, currentSessionEpoch()])}
      project={project}
      formKey={formKey}
    />
  );
}

function IntentCreation({ project, formKey }: { project: Project; formKey: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useSearchParams();
  const fromIntent = query.has('fromIntent') || Boolean(location.state?.fromIntentId);
  const [backend, setBackend] = useState<'platform' | 'native'>(() =>
    query.has('draftId') || (!fromIntent && query.get('backend') === 'native')
      ? 'native'
      : 'platform',
  );
  const [locked, setLocked] = useState(query.has('draftId'));
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const replaceQuery = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setQuery(next, { replace: true, state: { ...location.state, intentCreationKey: formKey } });
  };
  const fields = {
    project,
    title,
    prompt,
    onTitleChange: setTitle,
    onPromptChange: setPrompt,
    onLockedChange: setLocked,
  };
  return (
    <div className="h-full overflow-y-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => navigate(`/space/${project.id}`)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <div className="h-5 w-px bg-border" />
        <h1 className="text-xl font-semibold tracking-tight">New Intent</h1>
      </div>
      <div className="mx-auto max-w-2xl space-y-2">
        <Label htmlFor="intent-backend">Execution backend</Label>
        <select
          id="intent-backend"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={backend}
          disabled={locked || fromIntent}
          onChange={(event) => {
            if (locked || fromIntent) return;
            const next = event.target.value;
            if (next !== 'native' && next !== 'platform') return;
            setBackend(next);
            replaceQuery({ backend: next });
          }}
        >
          <option value="platform">Platform</option>
          <option value="native">Native AI-DLC</option>
        </select>
        <p className="text-sm text-muted-foreground">
          {backend === 'platform'
            ? 'Compose a collaborative plan using the platform workflow.'
            : 'Run a verified AI-DLC package with its own questions and approvals.'}
        </p>
      </div>
      {backend === 'native' ? (
        <NativeIntentCreation {...fields} query={query} replaceQuery={replaceQuery} />
      ) : (
        <PlatformIntentCreation {...fields} />
      )}
    </div>
  );
}
