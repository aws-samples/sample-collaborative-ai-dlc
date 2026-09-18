import { cn } from '@/lib/utils';
import {
  GitHubIcon,
  GitLabIcon,
  BitbucketIcon,
  CodeCommitIcon,
} from '@/components/icons/git-providers';
import { repoDisplayName, repoWebUrl, type GitProvider } from '@/services/gitProvider';

interface RepoLinkProps {
  gitRepo: string;
  gitProvider: GitProvider;
  className?: string;
  iconClassName?: string;
  noLink?: boolean;
}

const PROVIDER_ICON: Record<GitProvider, typeof GitHubIcon> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  bitbucket: BitbucketIcon,
  codecommit: CodeCommitIcon,
};

export function GitRepoLink({
  gitRepo,
  gitProvider,
  className,
  iconClassName,
  noLink,
}: RepoLinkProps) {
  const Icon = PROVIDER_ICON[gitProvider] ?? GitHubIcon;
  const href = repoWebUrl(gitProvider, gitRepo);

  const content = (
    <>
      <Icon className={cn('h-3 w-3 shrink-0', iconClassName)} />
      <span className="truncate" title={gitRepo}>
        {repoDisplayName(gitProvider, gitRepo)}
      </span>
    </>
  );

  if (noLink || !href) {
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
