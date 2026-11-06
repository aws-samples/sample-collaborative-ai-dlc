import type { Project } from '@/services/projects';
import { Label } from '@/components/ui/label';

export const nativeApplicationRepositories = (repos: Project['repos']) =>
  (repos ?? []).filter((repo) => ['github', 'gitlab', 'bitbucket'].includes(repo.provider));
export const nativeRepositoryKey = (repo: NonNullable<Project['repos']>[number]) =>
  JSON.stringify([repo.provider, repo.url]);

export function NativeApplicationSourcePicker({
  repos,
  value,
  disabled,
  onChange,
}: {
  repos: Project['repos'];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const supported = nativeApplicationRepositories(repos);
  return (
    <div className="space-y-2">
      <Label htmlFor="native-application-source">Application repository</Label>
      <select
        id="native-application-source"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          Select a connected repository
        </option>
        {supported.map((repo) => (
          <option key={nativeRepositoryKey(repo)} value={nativeRepositoryKey(repo)}>
            {repo.url} ({repo.provider})
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {supported.length
          ? 'One repository is used for this execution. Its default branch and exact commit are captured at Start.'
          : 'An owner or administrator must connect a GitHub, GitLab or Bitbucket repository to this space.'}
      </p>
    </div>
  );
}
