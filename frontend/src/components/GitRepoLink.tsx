import { cn } from '@/lib/utils';
import { GitHubIcon, GitLabIcon } from '@/components/icons/git-providers';
import type { GitProvider } from '@/services/gitProvider';

interface RepoLinkProps {
  gitRepo: string;
  gitProvider: GitProvider;
  className?: string;
  iconClassName?: string;
  noLink?: boolean;
}

const PROVIDER_URL: Record<GitProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

const PROVIDER_ICON: Record<GitProvider, typeof GitHubIcon> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
};

export function GitRepoLink({
  gitRepo,
  gitProvider,
  className,
  iconClassName,
  noLink,
}: RepoLinkProps) {
  const Icon = PROVIDER_ICON[gitProvider];
  const href = `${PROVIDER_URL[gitProvider]}/${gitRepo}`;

  const content = (
    <>
      <Icon className={cn('h-3 w-3 shrink-0', iconClassName)} />
      <span className="truncate">{gitRepo}</span>
    </>
  );

  if (noLink) {
    return (
      <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1', className)}>
        {content}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex min-w-0 max-w-full items-center gap-1 hover:underline', className)}
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </a>
  );
}
